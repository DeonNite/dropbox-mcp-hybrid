import { AppError } from "./app-error.js";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

async function parseResponseBody(response: Response): Promise<JsonValue | string | null> {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return text;
  }
}

export async function requestJson<T>(url: string, init: RequestInit, label: string): Promise<T> {
  const response = await fetch(url, init);
  const payload = await parseResponseBody(response);

  if (!response.ok) {
    const detail =
      typeof payload === "string"
        ? payload
        : payload && typeof payload === "object"
          ? JSON.stringify(payload)
          : "No response body";

    throw new AppError(502, `${label} failed with ${response.status}: ${detail}`, {
      expose: true
    });
  }

  return payload as T;
}

export async function requestVoid(url: string, init: RequestInit, label: string): Promise<void> {
  const response = await fetch(url, init);
  const payload = await parseResponseBody(response);

  if (!response.ok) {
    const detail =
      typeof payload === "string"
        ? payload
        : payload && typeof payload === "object"
          ? JSON.stringify(payload)
          : "No response body";

    throw new AppError(502, `${label} failed with ${response.status}: ${detail}`, {
      expose: true
    });
  }
}
