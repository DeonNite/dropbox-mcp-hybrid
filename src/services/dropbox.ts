import fs from "node:fs/promises";
import { URLSearchParams } from "node:url";

import { AppError } from "../lib/app-error.js";
import { requestJson, requestVoid } from "../lib/http.js";
import {
  dropboxMcpRequiredScopes,
  dropboxScopes,
  dropboxUploadRequiredScopes,
  env
} from "../env.js";
import type { StagedUploadRecord } from "./staged-upload-store.js";
import type { DropboxTokenRecord, TokenStore } from "./token-store.js";

const DROPBOX_API_BASE = "https://api.dropboxapi.com/2";
const DROPBOX_CONTENT_API_BASE = "https://content.dropboxapi.com/2";
const DROPBOX_OAUTH_BASE = "https://api.dropboxapi.com/oauth2";
const SIMPLE_UPLOAD_LIMIT_BYTES = 150 * 1024 * 1024;
const CHUNK_SIZE = 8 * 1024 * 1024;

interface DropboxTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  account_id?: string;
  uid?: string;
}

interface DropboxAccountResponse {
  account_id: string;
  name: {
    display_name: string;
  };
  email?: string;
}

interface DropboxUploadSessionStartResponse {
  session_id: string;
}

export interface DropboxConnectionStatus {
  connected: boolean;
  account?: { name: string; email?: string };
  scopes: string[];
  missingScopes: string[];
  warnings: string[];
  capabilities: {
    account: boolean;
    mcpRead: boolean;
    upload: boolean;
  };
  error?: string;
}

export interface DropboxUploadResult {
  id: string;
  name: string;
  path_display?: string;
  path_lower?: string;
  size: number;
  temporary_link?: string;
}

export class DropboxService {
  constructor(private readonly tokenStore: TokenStore) {}

  getAuthorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: env.DROPBOX_APP_KEY,
      response_type: "code",
      token_access_type: "offline",
      redirect_uri: this.redirectUri,
      state,
      scope: dropboxScopes.join(" ")
    });

    return `https://www.dropbox.com/oauth2/authorize?${params.toString()}`;
  }

  async connectWithCode(code: string): Promise<void> {
    const response = await this.requestToken(
      new URLSearchParams({
        code,
        grant_type: "authorization_code",
        client_id: env.DROPBOX_APP_KEY,
        client_secret: env.DROPBOX_APP_SECRET,
        redirect_uri: this.redirectUri
      }),
      "Dropbox OAuth code exchange"
    );

    this.assertRequiredScopes(response.scope);

    if (!response.refresh_token) {
      throw new AppError(
        502,
        "Dropbox did not return a refresh token. Verify token_access_type=offline and reconnect.",
        { expose: true }
      );
    }

    await this.tokenStore.write(this.toTokenRecord(response, response.refresh_token));
  }

  async disconnect(): Promise<void> {
    await this.tokenStore.clear();
  }

  async isConnected(): Promise<boolean> {
    const record = await this.tokenStore.read();
    return Boolean(record?.refreshToken);
  }

  async getConnectionStatus(): Promise<DropboxConnectionStatus> {
    const tokenRecord = await this.tokenStore.read();

    if (!tokenRecord) {
      return {
        connected: false,
        scopes: [],
        missingScopes: dropboxScopes,
        warnings: [],
        capabilities: {
          account: false,
          mcpRead: false,
          upload: false
        }
      };
    }

    const scopes = this.parseScopes(tokenRecord.scope);
    const warnings: string[] = [];

    if (!tokenRecord.scope) {
      warnings.push(
        "Stored Dropbox token does not include scope metadata. Reconnect Dropbox if MCP or upload access still fails."
      );
    }

    const missingScopes = tokenRecord.scope
      ? this.findMissingScopes(scopes, dropboxScopes)
      : [];

    try {
      const account = await this.getCurrentAccount();
      return {
        connected: true,
        account: {
          name: account.name.display_name,
          ...(account.email ? { email: account.email } : {})
        },
        scopes,
        missingScopes,
        warnings,
        capabilities: {
          account: true,
          mcpRead: this.findMissingScopes(scopes, dropboxMcpRequiredScopes).length === 0,
          upload: this.findMissingScopes(scopes, dropboxUploadRequiredScopes).length === 0
        }
      };
    } catch (error) {
      return {
        connected: false,
        scopes,
        missingScopes,
        warnings,
        capabilities: {
          account: false,
          mcpRead: this.findMissingScopes(scopes, dropboxMcpRequiredScopes).length === 0,
          upload: this.findMissingScopes(scopes, dropboxUploadRequiredScopes).length === 0
        },
        error: error instanceof Error ? error.message : "Unable to validate Dropbox connection"
      };
    }
  }

  async getValidAccessToken(): Promise<string> {
    const existing = await this.tokenStore.read();

    if (!existing?.refreshToken) {
      throw new AppError(401, "Dropbox is not connected yet.");
    }

    const now = Date.now();
    const refreshBufferMs = 60_000;

    if (existing.accessToken && existing.accessTokenExpiresAt > now + refreshBufferMs) {
      return existing.accessToken;
    }

    const refreshed = await this.requestToken(
      new URLSearchParams({
        refresh_token: existing.refreshToken,
        grant_type: "refresh_token",
        client_id: env.DROPBOX_APP_KEY,
        client_secret: env.DROPBOX_APP_SECRET
      }),
      "Dropbox token refresh"
    );

    const nextRecord = this.toTokenRecord(refreshed, existing.refreshToken);
    await this.tokenStore.write({
      accessToken: nextRecord.accessToken,
      accessTokenExpiresAt: nextRecord.accessTokenExpiresAt,
      refreshToken: nextRecord.refreshToken,
      ...(refreshed.account_id ?? existing.accountId
        ? { accountId: refreshed.account_id ?? existing.accountId }
        : {}),
      ...(refreshed.uid ?? existing.uid ? { uid: refreshed.uid ?? existing.uid } : {}),
      ...(refreshed.scope ?? existing.scope ? { scope: refreshed.scope ?? existing.scope } : {})
    });

    return nextRecord.accessToken;
  }

  async uploadStagedFile(
    stagedUpload: StagedUploadRecord,
    requestedDropboxPath: string,
    stagedFilePath: string
  ): Promise<DropboxUploadResult> {
    const accessToken = await this.getValidAccessToken();
    const normalizedPath = this.normalizeDropboxPath(requestedDropboxPath, stagedUpload.originalName);

    const metadata =
      stagedUpload.size <= SIMPLE_UPLOAD_LIMIT_BYTES
        ? await this.uploadSimpleFile(accessToken, stagedFilePath, normalizedPath)
        : await this.uploadFileInSession(accessToken, stagedFilePath, normalizedPath, stagedUpload.size);

    const temporary_link = await this.getTemporaryLink(accessToken, metadata.path_display ?? normalizedPath);

    return {
      ...metadata,
      ...(temporary_link ? { temporary_link } : {})
    };
  }

  private async getCurrentAccount(): Promise<DropboxAccountResponse> {
    const accessToken = await this.getValidAccessToken();

    return requestJson<DropboxAccountResponse>(
      `${DROPBOX_API_BASE}/users/get_current_account`,
      {
        method: "POST",
        headers: this.jsonHeaders(accessToken),
        body: "null"
      },
      "Dropbox get_current_account"
    );
  }

  private async uploadSimpleFile(
    accessToken: string,
    filePath: string,
    dropboxPath: string
  ): Promise<DropboxUploadResult> {
    const bytes = await fs.readFile(filePath);

    return requestJson<DropboxUploadResult>(
      `${DROPBOX_CONTENT_API_BASE}/files/upload`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": JSON.stringify({
            path: dropboxPath,
            mode: "add",
            autorename: true,
            mute: false
          })
        },
        body: bytes
      },
      "Dropbox files/upload"
    );
  }

  private async uploadFileInSession(
    accessToken: string,
    filePath: string,
    dropboxPath: string,
    fileSize: number
  ): Promise<DropboxUploadResult> {
    const handle = await fs.open(filePath, "r");

    try {
      let offset = 0;
      let sessionId: string | null = null;

      while (offset < fileSize) {
        const remaining = fileSize - offset;
        const chunkLength = Math.min(CHUNK_SIZE, remaining);
        const buffer = Buffer.allocUnsafe(chunkLength);
        const { bytesRead } = await handle.read(buffer, 0, chunkLength, offset);
        const chunk = buffer.subarray(0, bytesRead);

        if (!sessionId) {
          const start = await requestJson<DropboxUploadSessionStartResponse>(
            `${DROPBOX_CONTENT_API_BASE}/files/upload_session/start`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/octet-stream",
                "Dropbox-API-Arg": JSON.stringify({ close: false })
              },
              body: chunk
            },
            "Dropbox upload_session/start"
          );

          sessionId = start.session_id;
        } else if (offset + bytesRead < fileSize) {
          await requestVoid(
            `${DROPBOX_CONTENT_API_BASE}/files/upload_session/append_v2`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/octet-stream",
                "Dropbox-API-Arg": JSON.stringify({
                  cursor: {
                    session_id: sessionId,
                    offset
                  },
                  close: false
                })
              },
              body: chunk
            },
            "Dropbox upload_session/append_v2"
          );
        } else {
          return requestJson<DropboxUploadResult>(
            `${DROPBOX_CONTENT_API_BASE}/files/upload_session/finish`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/octet-stream",
                "Dropbox-API-Arg": JSON.stringify({
                  cursor: {
                    session_id: sessionId,
                    offset
                  },
                  commit: {
                    path: dropboxPath,
                    mode: "add",
                    autorename: true,
                    mute: false
                  }
                })
              },
              body: chunk
            },
            "Dropbox upload_session/finish"
          );
        }

        offset += bytesRead;
      }
    } finally {
      await handle.close();
    }

    throw new AppError(500, "Dropbox upload session did not finish successfully.");
  }

  private async getTemporaryLink(accessToken: string, path: string): Promise<string | undefined> {
    try {
      const response = await requestJson<{ link: string }>(
        `${DROPBOX_API_BASE}/files/get_temporary_link`,
        {
          method: "POST",
          headers: this.jsonHeaders(accessToken),
          body: JSON.stringify({ path })
        },
        "Dropbox get_temporary_link"
      );

      return response.link;
    } catch {
      return undefined;
    }
  }

  private async requestToken(
    params: URLSearchParams,
    label: string
  ): Promise<DropboxTokenResponse> {
    return requestJson<DropboxTokenResponse>(
      `${DROPBOX_OAUTH_BASE}/token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: params
      },
      label
    );
  }

  private toTokenRecord(response: DropboxTokenResponse, refreshToken: string): DropboxTokenRecord {
    const expiresAt = Date.now() + response.expires_in * 1000;

    return {
      accessToken: response.access_token,
      accessTokenExpiresAt: expiresAt,
      refreshToken,
      ...(response.account_id ? { accountId: response.account_id } : {}),
      ...(response.scope ? { scope: response.scope } : {}),
      ...(response.uid ? { uid: response.uid } : {})
    };
  }

  private normalizeDropboxPath(requestedPath: string, originalName: string): string {
    const trimmed = requestedPath.trim();

    if (!trimmed) {
      return `/${originalName}`;
    }

    const normalized = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;

    if (normalized === "/") {
      return `/${originalName}`;
    }

    if (normalized.endsWith("/")) {
      return `${normalized}${originalName}`;
    }

    return normalized;
  }

  private jsonHeaders(accessToken: string): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    };
  }

  private get redirectUri(): string {
    return `${env.APP_URL}/api/auth/dropbox/callback`;
  }

  private parseScopes(scope: string | undefined): string[] {
    if (!scope) {
      return [];
    }

    return scope
      .split(/\s+/)
      .map((value) => value.trim())
      .filter(Boolean)
      .sort();
  }

  private findMissingScopes(grantedScopes: string[], requiredScopes: string[]): string[] {
    const granted = new Set(grantedScopes);
    return requiredScopes.filter((scope) => !granted.has(scope));
  }

  private assertRequiredScopes(scope: string | undefined): void {
    if (!scope) {
      return;
    }

    const grantedScopes = this.parseScopes(scope);
    const missingScopes = this.findMissingScopes(grantedScopes, dropboxScopes);

    if (missingScopes.length === 0) {
      return;
    }

    throw new AppError(
      400,
      `Dropbox authorized successfully, but the token is missing required scopes: ${missingScopes.join(", ")}. Enable those scopes in the Dropbox app console, then reconnect Dropbox.`,
      { expose: true }
    );
  }
}
