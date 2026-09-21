import { access } from "node:fs/promises";
import { join } from "node:path";
import { constants } from "node:fs";

const DEFAULT_API_URL = "https://velox.josevictor.me";

export function apiUrl() {
  return (process.env.VELOX_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
}

/** POST to a Velox endpoint. Returns the Response or throws a string. */
export async function veloxPost(path, { json, form, signal }) {
  const key = process.env.VELOX_API_KEY;
  if (!key) throw "VELOX_API_KEY is not set";

  const headers = { Authorization: "Bearer " + key };
  if (json) headers["Content-Type"] = "application/json";

  let response;
  try {
    response = await fetch(apiUrl() + path, {
      method: "POST",
      headers,
      body: json ? JSON.stringify(json) : form,
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw "aborted";
    throw "request failed: " + String(err);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    // Errors come back as an OpenAI-shaped { error: { message } } envelope.
    let message = errText;
    try {
      message = JSON.parse(errText)?.error?.message || errText;
    } catch {
      // Not JSON — relay the raw body.
    }
    throw "HTTP " + response.status + ": " + message;
  }
  return response;
}

export async function canExecute(bin) {
  for (const dir of (process.env.PATH || "").split(":")) {
    if (!dir) continue;
    try {
      await access(join(dir, bin), constants.X_OK);
      return true;
    } catch {
      // Not in this dir — keep looking.
    }
  }
  return false;
}

/** Resolve a command: env override (whitespace-split), else first available candidate. */
export async function findCommand(override, candidates, label) {
  if (override) {
    const parts = override.split(/\s+/).filter(Boolean);
    if (parts.length === 0) throw label + " is set but empty";
    return { cmd: parts[0], args: parts.slice(1) };
  }
  for (const [cmd, args] of Object.entries(candidates)) {
    if (await canExecute(cmd)) return { cmd, args };
  }
  throw "none found (tried " + Object.keys(candidates).join(", ") + ")";
}

/** Wrap raw s16le mono PCM in a 44-byte WAV header. */
export function wav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
