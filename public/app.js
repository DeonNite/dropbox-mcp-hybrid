const elements = {
  banner: document.getElementById("banner"),
  messages: document.getElementById("messages"),
  statusPill: document.getElementById("status-pill"),
  accountSummary: document.getElementById("account-summary"),
  scopeSummary: document.getElementById("scope-summary"),
  connectButton: document.getElementById("connect-button"),
  disconnectButton: document.getElementById("disconnect-button"),
  diagnosticsButton: document.getElementById("diagnostics-button"),
  diagnosticsSummary: document.getElementById("diagnostics-summary"),
  stagingForm: document.getElementById("staging-form"),
  fileInput: document.getElementById("file-input"),
  stagedFileCard: document.getElementById("staged-file-card"),
  pathHintInput: document.getElementById("path-hint-input"),
  chatForm: document.getElementById("chat-form"),
  messageInput: document.getElementById("message-input"),
  sendButton: document.getElementById("send-button")
};

const state = {
  connected: false,
  previousResponseId: null,
  stagedUpload: null,
  pending: false
};

function setBanner(message, type = "info") {
  if (!message) {
    elements.banner.className = "banner hidden";
    elements.banner.textContent = "";
    return;
  }

  elements.banner.textContent = message;
  elements.banner.className = `banner ${type}`;
}

function appendMessage(role, text) {
  const message = document.createElement("div");
  message.className = `message ${role}`;
  message.textContent = text;
  elements.messages.appendChild(message);
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function renderStatus(status) {
  state.connected = Boolean(status.connected);

  elements.statusPill.textContent = status.connected
    ? "Dropbox connected"
    : "Dropbox disconnected";
  elements.statusPill.className = `status-pill ${
    status.connected ? "connected" : "disconnected"
  }`;

  if (status.connected && status.account) {
    const email = status.account.email ? ` (${status.account.email})` : "";
    const capabilities = status.capabilities || {};
    const capabilitySummary = [
      capabilities.mcpRead ? "MCP read ready" : "MCP read blocked",
      capabilities.upload ? "upload ready" : "upload blocked"
    ].join(" · ");

    elements.accountSummary.textContent = `Connected as ${status.account.name}${email}. ${capabilitySummary}.`;
    elements.disconnectButton.classList.remove("hidden");
  } else {
    elements.accountSummary.textContent =
      status.error ||
      "Connect your Dropbox account to unlock remote MCP browsing and uploads.";
    elements.disconnectButton.classList.add("hidden");
  }

  renderScopeSummary(status);
}

function renderScopeSummary(status) {
  const warnings = Array.isArray(status.warnings) ? status.warnings : [];
  const missingScopes = Array.isArray(status.missingScopes) ? status.missingScopes : [];
  const scopes = Array.isArray(status.scopes) ? status.scopes : [];
  const lines = [];

  if (scopes.length > 0) {
    lines.push(`<p><strong>Granted scopes</strong>: ${scopes.join(", ")}</p>`);
  }

  if (missingScopes.length > 0) {
    lines.push(`<p><strong>Missing scopes</strong>: ${missingScopes.join(", ")}</p>`);
  }

  if (status.capabilities) {
    lines.push(
      `<p><strong>Capabilities</strong>: MCP read ${status.capabilities.mcpRead ? "ready" : "blocked"} · Upload ${status.capabilities.upload ? "ready" : "blocked"}</p>`
    );
  }

  warnings.forEach((warning) => {
    lines.push(`<p>${warning}</p>`);
  });

  if (lines.length === 0) {
    elements.scopeSummary.classList.add("hidden");
    elements.scopeSummary.innerHTML = "";
    return;
  }

  elements.scopeSummary.innerHTML = lines.join("");
  elements.scopeSummary.classList.remove("hidden");
}

function renderStagedUpload() {
  if (!state.stagedUpload) {
    elements.stagedFileCard.classList.add("hidden");
    elements.stagedFileCard.innerHTML = "";
    return;
  }

  const upload = state.stagedUpload;
  const sizeLabel = new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1
  }).format(upload.size);

  elements.stagedFileCard.innerHTML = `
    <div class="staged-meta">
      <div class="staged-name">${upload.originalName}</div>
      <div>${upload.mimeType || "application/octet-stream"} · ${sizeLabel} bytes</div>
      <div class="staged-id">${upload.id}</div>
    </div>
  `;
  elements.stagedFileCard.classList.remove("hidden");
}

function setPending(pending) {
  state.pending = pending;
  elements.sendButton.disabled = pending;
  elements.connectButton.disabled = pending;
  elements.diagnosticsButton.disabled = pending;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({ error: "Invalid JSON response" }));

  if (!response.ok) {
    throw new Error(payload.error || `Request failed with ${response.status}`);
  }

  return payload;
}

async function loadStatus() {
  try {
    const status = await fetchJson("/api/auth/status");
    renderStatus(status);
  } catch (error) {
    renderStatus({ connected: false, error: error.message });
  }
}

async function stageFile(event) {
  event.preventDefault();

  const file = elements.fileInput.files?.[0];

  if (!file) {
    setBanner("Choose a file before staging it.", "error");
    return;
  }

  const formData = new FormData();
  formData.append("file", file);

  try {
    setPending(true);
    const result = await fetchJson("/api/uploads/stage", {
      method: "POST",
      body: formData
    });

    state.stagedUpload = result.stagedUpload;
    renderStagedUpload();
    setBanner(`Staged ${result.stagedUpload.originalName}. Ask the assistant to upload it.`, "info");
  } catch (error) {
    setBanner(error.message, "error");
  } finally {
    setPending(false);
    elements.fileInput.value = "";
  }
}

async function sendMessage(event) {
  event.preventDefault();

  const rawMessage = elements.messageInput.value.trim();

  if (!rawMessage) {
    return;
  }

  const pathHint = elements.pathHintInput.value.trim();
  const message = pathHint ? `${rawMessage}\n\nPreferred Dropbox path: ${pathHint}` : rawMessage;

  appendMessage("user", rawMessage);
  elements.messageInput.value = "";
  setBanner("", "info");

  try {
    setPending(true);
    const result = await fetchJson("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message,
        previousResponseId: state.previousResponseId,
        stagedUploadId: state.stagedUpload?.id || undefined
      })
    });

    state.previousResponseId = result.responseId;
    appendMessage("assistant", result.text);

    if (
      state.stagedUpload &&
      Array.isArray(result.consumedStagedUploadIds) &&
      result.consumedStagedUploadIds.includes(state.stagedUpload.id)
    ) {
      state.stagedUpload = null;
      renderStagedUpload();
    }
  } catch (error) {
    appendMessage("assistant", error.message);
  } finally {
    setPending(false);
  }
}

function applyQueryBanner() {
  const params = new URLSearchParams(window.location.search);
  const dropboxState = params.get("dropbox");
  const message = params.get("message");

  if (dropboxState === "connected") {
    setBanner("Dropbox connected. You can browse with MCP and upload staged files.", "info");
  } else if (dropboxState === "error") {
    setBanner(message || "Dropbox OAuth failed.", "error");
  }

  if (dropboxState) {
    history.replaceState({}, "", window.location.pathname);
  }
}

async function disconnectDropbox() {
  try {
    setPending(true);
    await fetchJson("/api/auth/dropbox/disconnect", {
      method: "POST"
    });
    state.previousResponseId = null;
    setBanner("Dropbox disconnected.", "info");
    await loadStatus();
  } catch (error) {
    setBanner(error.message, "error");
  } finally {
    setPending(false);
  }
}

async function runDiagnostics() {
  try {
    setPending(true);
    elements.diagnosticsSummary.classList.add("hidden");
    elements.diagnosticsSummary.innerHTML = "";

    const result = await fetchJson("/api/diagnostics");
    const lines = [];

    if (result.openai?.api) {
      const api = result.openai.api;
      lines.push(
        `<p><strong>OpenAI API</strong>: ${api.ok ? "ok" : "failed"}${api.resolvedModel ? ` (${api.resolvedModel})` : ""}</p>`
      );

      if (api.error) {
        lines.push(`<p>${api.error}</p>`);
      }
    }

    if (result.openai?.dropboxMcp) {
      const mcp = result.openai.dropboxMcp;

      if (!mcp.attempted) {
        lines.push("<p><strong>Dropbox MCP</strong>: skipped until Dropbox is connected.</p>");
      } else {
        lines.push(`<p><strong>Dropbox MCP</strong>: ${mcp.ok ? "ok" : "failed"}</p>`);

        if (Array.isArray(mcp.outputTypes) && mcp.outputTypes.length > 0) {
          lines.push(`<p>Output types: ${mcp.outputTypes.join(", ")}</p>`);
        }

        if (mcp.error) {
          lines.push(`<p>${mcp.error}</p>`);
        }
      }
    }

    elements.diagnosticsSummary.innerHTML = lines.join("");
    elements.diagnosticsSummary.classList.remove("hidden");
  } catch (error) {
    elements.diagnosticsSummary.innerHTML = `<p>${error.message}</p>`;
    elements.diagnosticsSummary.classList.remove("hidden");
  } finally {
    setPending(false);
  }
}

function boot() {
  appendMessage(
    "assistant",
    "Connect Dropbox, stage a file if you want to upload one, then ask me to search, read, or upload."
  );

  elements.connectButton.addEventListener("click", () => {
    window.location.href = "/api/auth/dropbox/start";
  });

  elements.diagnosticsButton.addEventListener("click", runDiagnostics);
  elements.disconnectButton.addEventListener("click", disconnectDropbox);
  elements.stagingForm.addEventListener("submit", stageFile);
  elements.chatForm.addEventListener("submit", sendMessage);

  applyQueryBanner();
  void loadStatus();
}

boot();
