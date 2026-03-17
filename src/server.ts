import fs from "node:fs/promises";
import path from "node:path";

import express from "express";

import { env, paths } from "./env.js";
import { AppError, getErrorMessage } from "./lib/app-error.js";
import { createAuthRouter } from "./routes/auth.js";
import { createChatRouter } from "./routes/chat.js";
import { createDiagnosticsRouter } from "./routes/diagnostics.js";
import { createUploadsRouter } from "./routes/uploads.js";
import { DropboxService } from "./services/dropbox.js";
import { OpenAIService } from "./services/openai.js";
import { StagedUploadStore } from "./services/staged-upload-store.js";
import { TokenStore } from "./services/token-store.js";

async function bootstrap(): Promise<void> {
  await fs.mkdir(paths.dataDir, { recursive: true });
  await fs.mkdir(paths.stagedUploadDir, { recursive: true });

  const tokenStore = new TokenStore(paths.dropboxTokenFile);
  const stagedUploadStore = new StagedUploadStore(paths.stagedUploadDir);
  const dropboxService = new DropboxService(tokenStore);
  const openAIService = new OpenAIService(dropboxService, stagedUploadStore);

  await stagedUploadStore.init();
  await stagedUploadStore.purgeExpired();

  const app = express();

  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));

  app.use("/api/auth", createAuthRouter(dropboxService));
  app.use("/api/diagnostics", createDiagnosticsRouter(openAIService, dropboxService));
  app.use("/api/uploads", createUploadsRouter(stagedUploadStore));
  app.use("/api/chat", createChatRouter(openAIService, stagedUploadStore, dropboxService));
  app.use(express.static(path.join(paths.root, "public")));

  app.get("*", (_request, response) => {
    response.sendFile(path.join(paths.root, "public", "index.html"));
  });

  app.use(
    (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction
    ) => {
      const statusCode = error instanceof AppError ? error.statusCode : 500;
      const message =
        error instanceof AppError && error.expose
          ? error.message
          : statusCode < 500
            ? getErrorMessage(error)
            : "Internal server error";

      if (!(error instanceof AppError)) {
        console.error(error);
      }

      response.status(statusCode).json({
        error: message
      });
    }
  );

  app.listen(env.PORT, () => {
    console.log(`Dropbox MCP app listening on ${env.APP_URL}`);
  });
}

bootstrap().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
