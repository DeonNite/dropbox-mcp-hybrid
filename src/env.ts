import path from "node:path";

import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  OPENAI_MODEL: z.string().min(1).default("gpt-5"),
  DROPBOX_APP_KEY: z.string().min(1, "DROPBOX_APP_KEY is required"),
  DROPBOX_APP_SECRET: z.string().min(1, "DROPBOX_APP_SECRET is required"),
  APP_URL: z.string().url("APP_URL must be a valid URL"),
  PORT: z.coerce.number().int().positive().default(3000)
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const messages = parsed.error.issues.map((issue) => issue.message).join("\n");
  throw new Error(`Invalid environment:\n${messages}`);
}

export const env = {
  ...parsed.data,
  APP_URL: parsed.data.APP_URL.replace(/\/+$/, "")
};

export const paths = {
  root: process.cwd(),
  dataDir: path.join(process.cwd(), "data"),
  stagedUploadDir: path.join(process.cwd(), "data", "staged-uploads"),
  dropboxTokenFile: path.join(process.cwd(), "data", "dropbox-token.json")
};

export const dropboxScopes = [
  "account_info.read",
  "files.content.read",
  "files.content.write",
  "files.metadata.read"
];

export const dropboxMcpAllowedTools = [
  "ListFolder",
  "GetFileMetadata",
  "GetFileContent",
  "GetUsageAndQuota",
  "Search"
];

export const dropboxMcpRequiredScopes = [
  "files.content.read",
  "files.metadata.read"
];

export const dropboxUploadRequiredScopes = ["files.content.write"];
