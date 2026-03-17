import { randomUUID } from "node:crypto";

import { Router } from "express";

import { env } from "../env.js";
import type { DropboxService } from "../services/dropbox.js";

export function createAuthRouter(dropboxService: DropboxService): Router {
  const router = Router();
  const pendingStates = new Map<string, number>();

  const cleanupStates = (): void => {
    const now = Date.now();

    for (const [state, expiresAt] of pendingStates.entries()) {
      if (expiresAt <= now) {
        pendingStates.delete(state);
      }
    }
  };

  router.get("/status", async (_request, response, next) => {
    try {
      const status = await dropboxService.getConnectionStatus();
      response.json(status);
    } catch (error) {
      next(error);
    }
  });

  router.get("/dropbox/start", (request, response) => {
    cleanupStates();

    const state = randomUUID();
    pendingStates.set(state, Date.now() + 10 * 60 * 1000);

    const authUrl = dropboxService.getAuthorizationUrl(state);

    // Browser navigations usually advertise */*, so content negotiation is unreliable here.
    // Only return JSON when explicitly requested for debugging.
    if (request.query.mode === "json") {
      response.json({ authUrl });
      return;
    }

    response.redirect(authUrl);
  });

  router.get("/dropbox/callback", async (request, response) => {
    cleanupStates();

    const code = typeof request.query.code === "string" ? request.query.code : null;
    const state = typeof request.query.state === "string" ? request.query.state : null;
    const error = typeof request.query.error_description === "string"
      ? request.query.error_description
      : typeof request.query.error === "string"
        ? request.query.error
        : null;

    if (error) {
      response.redirect(`${env.APP_URL}/?dropbox=error&message=${encodeURIComponent(error)}`);
      return;
    }

    if (!code || !state || !pendingStates.has(state)) {
      response.redirect(
        `${env.APP_URL}/?dropbox=error&message=${encodeURIComponent("Invalid or expired Dropbox OAuth state.")}`
      );
      return;
    }

    pendingStates.delete(state);

    try {
      await dropboxService.connectWithCode(code);
      response.redirect(`${env.APP_URL}/?dropbox=connected`);
    } catch (oauthError) {
      const message = oauthError instanceof Error ? oauthError.message : "Dropbox OAuth failed.";
      response.redirect(`${env.APP_URL}/?dropbox=error&message=${encodeURIComponent(message)}`);
    }
  });

  router.post("/dropbox/disconnect", async (_request, response, next) => {
    try {
      await dropboxService.disconnect();
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
