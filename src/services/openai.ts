import { z } from "zod";

import { AppError } from "../lib/app-error.js";
import { dropboxMcpAllowedTools, env } from "../env.js";
import type { DropboxService } from "./dropbox.js";
import type { StagedUploadRecord, StagedUploadStore } from "./staged-upload-store.js";

const uploadFunctionArgsSchema = z.object({
  staged_upload_id: z.string().min(1),
  dropbox_path: z.string().min(1)
});

interface OpenAIResponse {
  id: string;
  status?: string;
  model?: string;
  error?: {
    message?: string;
    type?: string;
    code?: string;
    param?: string;
  } | null;
  output: OpenAIOutputItem[];
}

type OpenAIOutputItem =
  | {
      type: "message";
      role: "assistant";
      content: Array<{
        type: "output_text";
        text: string;
      }>;
    }
  | {
      type: "function_call";
      call_id: string;
      name: string;
      arguments: string;
    }
  | {
      type: string;
      [key: string]: unknown;
    };

interface ChatOptions {
  message: string;
  previousResponseId?: string;
  stagedUpload?: StagedUploadRecord | null;
}

export interface ChatResult {
  responseId: string;
  text: string;
  consumedStagedUploadIds: string[];
}

export interface OpenAIDiagnostics {
  api: {
    ok: boolean;
    configuredModel: string;
    resolvedModel?: string;
    error?: string;
  };
  dropboxMcp: {
    attempted: boolean;
    ok: boolean;
    error?: string;
    outputTypes?: string[];
  };
}

export class OpenAIService {
  constructor(
    private readonly dropboxService: DropboxService,
    private readonly stagedUploadStore: StagedUploadStore
  ) {}

  async runChat(options: ChatOptions): Promise<ChatResult> {
    const accessToken = await this.dropboxService.getValidAccessToken();
    const consumedStagedUploadIds = new Set<string>();

    const basePayload = {
      model: env.OPENAI_MODEL,
      instructions: this.buildInstructions(Boolean(options.stagedUpload)),
      tools: this.buildTools(accessToken, options.stagedUpload)
    };

    let response = await this.createResponse({
      ...basePayload,
      previous_response_id: options.previousResponseId,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: this.buildUserInput(options.message, options.stagedUpload)
            }
          ]
        }
      ]
    });

    while (true) {
      const functionCalls = response.output.filter(
        (item): item is Extract<OpenAIOutputItem, { type: "function_call" }> =>
          item.type === "function_call"
      );

      if (functionCalls.length === 0) {
        return {
          responseId: response.id,
          text: this.extractOutputText(response),
          consumedStagedUploadIds: [...consumedStagedUploadIds]
        };
      }

      const functionOutputs = await Promise.all(
        functionCalls.map(async (functionCall) => {
          const output = await this.executeFunctionCall(functionCall, options.stagedUpload);

          if (output.ok) {
            consumedStagedUploadIds.add(output.staged_upload_id);
            await this.stagedUploadStore.remove(output.staged_upload_id);
          }

          return {
            type: "function_call_output",
            call_id: functionCall.call_id,
            output: JSON.stringify(output)
          };
        })
      );

      response = await this.createResponse({
        ...basePayload,
        previous_response_id: response.id,
        input: functionOutputs
      });
    }
  }

  async runDiagnostics(dropboxAccessToken?: string): Promise<OpenAIDiagnostics> {
    const apiPayload = {
      model: env.OPENAI_MODEL,
      input: "Reply with the single word OK."
    };

    const apiResponse = await this.requestResponse(apiPayload);
    const apiBody = apiResponse.body && typeof apiResponse.body === "object"
      ? (apiResponse.body as Partial<OpenAIResponse>)
      : null;

    const diagnostics: OpenAIDiagnostics = {
      api: {
        ok: apiResponse.ok,
        configuredModel: env.OPENAI_MODEL,
        ...(apiBody?.model ? { resolvedModel: apiBody.model } : {}),
        ...(!apiResponse.ok ? { error: this.describeErrorPayload(apiResponse.status, apiResponse.body) } : {})
      },
      dropboxMcp: {
        attempted: Boolean(dropboxAccessToken),
        ok: false
      }
    };

    if (!dropboxAccessToken) {
      return diagnostics;
    }

    const mcpPayload = {
      model: env.OPENAI_MODEL,
      instructions: "Use the Dropbox MCP tool to answer this request.",
      input: "Use Dropbox MCP to list the root folder.",
      tools: [
        {
          type: "mcp",
          server_label: "dropbox",
          server_url: "https://mcp.dropbox.com/mcp",
          authorization: dropboxAccessToken,
          allowed_tools: ["ListFolder"],
          require_approval: "never"
        }
      ],
      max_output_tokens: 120
    };

    const mcpResponse = await this.requestResponse(mcpPayload);
    const mcpBody = mcpResponse.body && typeof mcpResponse.body === "object"
      ? (mcpResponse.body as Partial<OpenAIResponse>)
      : null;

    diagnostics.dropboxMcp = {
      attempted: true,
      ok: mcpResponse.ok,
      ...(Array.isArray(mcpBody?.output)
        ? { outputTypes: mcpBody.output.map((item) => item.type) }
        : {}),
      ...(!mcpResponse.ok ? { error: this.describeErrorPayload(mcpResponse.status, mcpResponse.body) } : {})
    };

    return diagnostics;
  }

  private async executeFunctionCall(
    functionCall: Extract<OpenAIOutputItem, { type: "function_call" }>,
    stagedUpload: StagedUploadRecord | null | undefined
  ): Promise<
    | ({
        ok: true;
        staged_upload_id: string;
      } & Awaited<ReturnType<DropboxService["uploadStagedFile"]>>)
    | {
        ok: false;
        error: string;
        staged_upload_id: string;
      }
  > {
    if (functionCall.name !== "upload_file_to_dropbox") {
      return {
        ok: false,
        staged_upload_id: "unknown",
        error: `Unsupported function call: ${functionCall.name}`
      };
    }

    let parsedJson: unknown;

    try {
      parsedJson = JSON.parse(functionCall.arguments);
    } catch {
      return {
        ok: false,
        staged_upload_id: "unknown",
        error: "The upload tool arguments were not valid JSON."
      };
    }

    const parsedArgs = uploadFunctionArgsSchema.safeParse(parsedJson);

    if (!parsedArgs.success) {
      return {
        ok: false,
        staged_upload_id: "unknown",
        error: "The upload tool arguments were invalid."
      };
    }

    const args = parsedArgs.data;
    const uploadRecord =
      stagedUpload && stagedUpload.id === args.staged_upload_id
        ? stagedUpload
        : await this.stagedUploadStore.get(args.staged_upload_id);

    if (!uploadRecord) {
      return {
        ok: false,
        staged_upload_id: args.staged_upload_id,
        error: "The staged upload could not be found. Ask the user to attach the file again."
      };
    }

    try {
      const uploaded = await this.dropboxService.uploadStagedFile(
        uploadRecord,
        args.dropbox_path,
        this.stagedUploadStore.filePath(uploadRecord.storedName)
      );

      return {
        ok: true,
        staged_upload_id: args.staged_upload_id,
        ...uploaded
      };
    } catch (error) {
      return {
        ok: false,
        staged_upload_id: args.staged_upload_id,
        error: error instanceof Error ? error.message : "The Dropbox upload failed."
      };
    }
  }

  private async createResponse(payload: Record<string, unknown>): Promise<OpenAIResponse> {
    const result = await this.requestResponse(payload);

    if (!result.ok) {
      throw new AppError(502, this.describeErrorPayload(result.status, result.body), {
        expose: true
      });
    }

    const response = result.body as OpenAIResponse;

    if (response.error?.message) {
      throw new AppError(502, `OpenAI Responses API returned an error: ${response.error.message}`, {
        expose: true
      });
    }

    return response;
  }

  private buildTools(accessToken: string, stagedUpload?: StagedUploadRecord | null): unknown[] {
    const tools: unknown[] = [
      {
        type: "mcp",
        server_label: "dropbox",
        server_url: "https://mcp.dropbox.com/mcp",
        authorization: accessToken,
        allowed_tools: dropboxMcpAllowedTools,
        require_approval: "never",
        server_description:
          "Dropbox MCP server for listing, searching, and reading content from the connected Dropbox account."
      }
    ];

    if (stagedUpload) {
      tools.push({
        type: "function",
        name: "upload_file_to_dropbox",
        description:
          "Upload a staged local file from the current session into Dropbox. Use this only when the user explicitly wants to upload or save the attached file.",
        strict: true,
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            staged_upload_id: {
              type: "string",
              description: "The staged upload identifier for the file attached in the current session."
            },
            dropbox_path: {
              type: "string",
              description:
                "The target Dropbox path. Pass either a folder path ending in / or a full file path."
            }
          },
          required: ["staged_upload_id", "dropbox_path"]
        }
      });
    }

    return tools;
  }

  private buildInstructions(hasStagedUpload: boolean): string {
    const uploadRules = hasStagedUpload
      ? [
          "A staged local file is available in this turn.",
          "Use upload_file_to_dropbox only if the user explicitly asks to upload, save, or move that staged file into Dropbox.",
          "Never claim an upload succeeded unless the tool returns ok: true.",
          "If the Dropbox destination is unclear, ask one brief clarifying question instead of guessing."
        ]
      : [
          "No staged local file is attached in this turn.",
          "If the user asks to upload a local file, tell them to attach or stage a file first."
        ];

    return [
      "You are a Dropbox assistant for a web app that combines Dropbox MCP with a direct Dropbox upload function.",
      "Use Dropbox MCP for read operations such as listing folders, searching, checking metadata, or reading file contents.",
      "Do not invent Dropbox files, folder names, or upload identifiers.",
      ...uploadRules,
      "Keep responses concise and action-oriented."
    ].join("\n");
  }

  private buildUserInput(message: string, stagedUpload?: StagedUploadRecord | null): string {
    if (!stagedUpload) {
      return message.trim();
    }

    return [
      message.trim(),
      "",
      "Staged upload available for this turn:",
      `- staged_upload_id: ${stagedUpload.id}`,
      `- original_filename: ${stagedUpload.originalName}`,
      `- mime_type: ${stagedUpload.mimeType}`,
      `- bytes: ${stagedUpload.size}`,
      "",
      "If you use the upload tool, reference the exact staged_upload_id above."
    ].join("\n");
  }

  private extractOutputText(response: OpenAIResponse): string {
    const texts = response.output
      .filter((item): item is Extract<OpenAIOutputItem, { type: "message" }> => item.type === "message")
      .flatMap((item) => item.content)
      .filter((content) => content.type === "output_text")
      .map((content) => content.text.trim())
      .filter(Boolean);

    if (texts.length === 0) {
      const outputTypes = response.output.map((item) => item.type).join(", ") || "none";
      throw new AppError(
        502,
        `OpenAI returned no assistant message. Output item types: ${outputTypes}.`,
        { expose: true }
      );
    }

    return texts.join("\n\n");
  }

  private async requestResponse(
    payload: Record<string, unknown>
  ): Promise<{ status: number; ok: boolean; body: unknown }> {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    let body: unknown = null;

    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    return {
      status: response.status,
      ok: response.ok,
      body
    };
  }

  private describeErrorPayload(status: number, payload: unknown): string {
    if (payload && typeof payload === "object" && "error" in payload) {
      const error = (payload as { error?: { message?: string; type?: string; code?: string } }).error;

      if (error?.message) {
        return `OpenAI Responses API failed with ${status}: ${error.message}`;
      }
    }

    if (typeof payload === "string" && payload.trim()) {
      return `OpenAI Responses API failed with ${status}: ${payload}`;
    }

    if (payload && typeof payload === "object") {
      return `OpenAI Responses API failed with ${status}: ${JSON.stringify(payload)}`;
    }

    return `OpenAI Responses API failed with ${status}.`;
  }
}
