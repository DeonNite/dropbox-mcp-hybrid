import { Router } from "express";

import type { DropboxService } from "../services/dropbox.js";
import type { OpenAIService } from "../services/openai.js";

export function createDiagnosticsRouter(
  openAIService: OpenAIService,
  dropboxService: DropboxService
): Router {
  const router = Router();

  router.get("/", async (_request, response, next) => {
    try {
      const dropbox = await dropboxService.getConnectionStatus();
      const mcpAccessToken = dropbox.connected ? await dropboxService.getValidAccessToken() : undefined;
      const openai = await openAIService.runDiagnostics(mcpAccessToken);

      response.json({
        openai,
        dropbox
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
