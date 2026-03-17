import fs from "node:fs/promises";
import path from "node:path";

export interface DropboxTokenRecord {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  accountId?: string;
  scope?: string;
  uid?: string;
}

export class TokenStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<DropboxTokenRecord | null> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return JSON.parse(raw) as DropboxTokenRecord;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;

      if (nodeError.code === "ENOENT") {
        return null;
      }

      throw error;
    }
  }

  async write(record: DropboxTokenRecord): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(record, null, 2), {
      encoding: "utf8",
      mode: 0o600
    });
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.filePath);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;

      if (nodeError.code !== "ENOENT") {
        throw error;
      }
    }
  }
}
