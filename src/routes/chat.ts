import { Router } from "express";
import { z } from "zod";

import { AppError } from "../lib/app-error.js";
import type { OpenAIService } from "../services/openai.js";
import type { StagedUploadStore } from "../services/staged-upload-store.js";
import type { DropboxService } from "../services/dropbox.js";

const chatRequestSchema = z.object({
  message: z.string().min(1),
  previousResponseId: z.string().min(1).nullish(),
  stagedUploadId: z.string().min(1).nullish()
});

export function createChatRouter(
  openAIService: OpenAIService,
  stagedUploadStore: StagedUploadStore,
  dropboxService: DropboxService
): Router {
  const router = Router();

  router.post("/", async (request, response, next) => {
    try {
      const body = chatRequestSchema.parse(request.body);

      if (!(await dropboxService.isConnected())) {
        throw new AppError(401, "Connect Dropbox before starting a chat session.");
      }

      const stagedUpload = body.stagedUploadId
        ? await stagedUploadStore.get(body.stagedUploadId)
        : null;

      const result = await openAIService.runChat({
        message: body.message,
        ...(body.previousResponseId ? { previousResponseId: body.previousResponseId } : {}),
        stagedUpload
      });

      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
