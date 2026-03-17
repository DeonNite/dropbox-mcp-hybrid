import { randomUUID } from "node:crypto";
import path from "node:path";

import { Router } from "express";
import multer from "multer";

import { AppError } from "../lib/app-error.js";
import type { StagedUploadStore } from "../services/staged-upload-store.js";

export function createUploadsRouter(stagedUploadStore: StagedUploadStore): Router {
  const router = Router();

  const storage = multer.diskStorage({
    destination: (_request, _file, callback) => {
      callback(null, stagedUploadStore.directoryPath);
    },
    filename: (_request, file, callback) => {
      const id = randomUUID();
      const ext = path.extname(file.originalname);
      callback(null, `${id}${ext}`);
    }
  });

  const upload = multer({
    storage,
    limits: {
      fileSize: 1024 * 1024 * 1024
    }
  });

  router.post("/stage", upload.single("file"), async (request, response, next) => {
    try {
      if (!request.file) {
        throw new AppError(400, "No file was uploaded.");
      }

      const id = path.basename(request.file.filename, path.extname(request.file.filename));
      const record = stagedUploadStore.toRecord(id, request.file);

      await stagedUploadStore.create(record);

      response.json({
        ok: true,
        stagedUpload: record
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
