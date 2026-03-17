# Dropbox MCP Hybrid Assistant

This scaffold gives you a minimal local web app that:

- uses Dropbox's remote MCP server for read-oriented actions
- uses the Dropbox HTTP API for uploads and other writes
- uses OpenAI Responses API as the LLM orchestration layer

The split is intentional. Dropbox's MCP integration is currently documented around read tools such as listing folders, search, metadata lookup, file-content retrieval, and quota inspection. Upload is handled through the direct Dropbox API.

## What is included

- TypeScript + Express backend
- Dropbox OAuth code-flow integration with refresh-token storage
- staged local file uploads on disk before the model decides whether to upload them to Dropbox
- OpenAI Responses API chat route using:
  - remote MCP tool: `https://mcp.dropbox.com/mcp`
  - custom function tool: `upload_file_to_dropbox`
- small browser UI in `public/`

## Required Dropbox App Setup

Create or update your Dropbox app so it has at least these scopes:

- `account_info.read`
- `files.metadata.read`
- `files.content.read`
- `files.content.write`

Use `Scoped access`, and for the simplest prototype use `Full Dropbox`.

Set the Dropbox redirect URI to:

```text
http://localhost:3000/api/auth/dropbox/callback
```

If you change the local URL or port, update both Dropbox and your `.env`.

## Environment

Your current `.env` already has:

- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`

Add:

```env
APP_URL=http://localhost:3000
PORT=3000
```

You can use `.env.example` as the reference shape.

## Install and Run

```bash
npm install
npm run dev
```

Then open:

```text
http://localhost:3000
```

## How the flow works

1. The browser stages a local file to `data/staged-uploads/`.
2. The user asks the assistant to browse Dropbox, read Dropbox content, or upload the staged file.
3. The backend calls OpenAI Responses API.
4. For read operations, the model uses Dropbox MCP.
5. For writes, the model calls `upload_file_to_dropbox`.
6. The backend executes the upload with the Dropbox HTTP API and feeds the tool result back into the model.

## Diagnosing Connection Problems

This scaffold now exposes a manual diagnostics check from the UI:

- `OpenAI API`: runs a minimal Responses API request with your configured key and model
- `Dropbox connection`: shows granted scopes, missing scopes, and whether MCP read/upload are likely ready
- `Dropbox MCP`: when Dropbox is connected, runs a small live MCP probe through the Responses API

If the diagnostics show `Dropbox MCP failed with 401`, the usual causes are:

- the Dropbox OAuth flow never completed
- the app's redirect URI does not exactly match `APP_URL`
- the Dropbox app is missing required scopes
- you changed scopes in the Dropbox app console but did not reconnect Dropbox afterward

## Project Structure

- `src/server.ts`: app bootstrap and route mounting
- `src/routes/auth.ts`: Dropbox OAuth and connection status
- `src/routes/uploads.ts`: stage local files
- `src/routes/chat.ts`: chat endpoint
- `src/services/dropbox.ts`: OAuth refresh + Dropbox uploads
- `src/services/openai.ts`: Responses API loop with MCP + function tools
- `src/services/staged-upload-store.ts`: metadata and staged-file persistence

## Current Constraints

- token storage is file-based in `data/dropbox-token.json`
- staged files are also stored locally under `data/`
- the UI is single-user and local-first
- no database or per-user auth layer is included yet

That is enough for a solid local prototype, but not yet production hardening.

## Good Next Steps

- move Dropbox tokens into encrypted storage
- add per-user sessions and a database-backed token model
- add upload-session resume support
- log MCP tool calls and upload tool calls for auditing
- stream OpenAI responses to the browser instead of waiting for the final text
