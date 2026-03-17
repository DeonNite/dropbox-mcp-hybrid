import fs from "node:fs/promises";
import path from "node:path";

import type { Express } from "express";

export interface StagedUploadRecord {
  id: string;
  originalName: string;
  storedName: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

export class StagedUploadStore {
  constructor(private readonly dirPath: string) {}

  get directoryPath(): string {
    return this.dirPath;
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dirPath, { recursive: true });
  }

  async create(record: StagedUploadRecord): Promise<void> {
    await this.init();
    await fs.writeFile(this.metadataPath(record.id), JSON.stringify(record, null, 2), "utf8");
  }

  async get(id: string): Promise<StagedUploadRecord | null> {
    try {
      const raw = await fs.readFile(this.metadataPath(id), "utf8");
      return JSON.parse(raw) as StagedUploadRecord;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;

      if (nodeError.code === "ENOENT") {
        return null;
      }

      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    const record = await this.get(id);

    if (!record) {
      return;
    }

    await Promise.allSettled([
      fs.unlink(this.filePath(record.storedName)),
      fs.unlink(this.metadataPath(record.id))
    ]);
  }

  async purgeExpired(maxAgeHours = 24): Promise<void> {
    await this.init();
    const files = await fs.readdir(this.dirPath);
    const now = Date.now();

    await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map(async (file) => {
          const id = file.replace(/\.json$/, "");
          const record = await this.get(id);

          if (!record) {
            return;
          }

          const ageMs = now - new Date(record.createdAt).getTime();
          const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

          if (ageMs > maxAgeMs) {
            await this.remove(id);
          }
        })
    );
  }

  toRecord(id: string, file: Express.Multer.File): StagedUploadRecord {
    return {
      id,
      originalName: file.originalname,
      storedName: file.filename,
      mimeType: file.mimetype || "application/octet-stream",
      size: file.size,
      createdAt: new Date().toISOString()
    };
  }

  filePath(storedName: string): string {
    return path.join(this.dirPath, storedName);
  }

  metadataPath(id: string): string {
    return path.join(this.dirPath, `${id}.json`);
  }
}
