#!/usr/bin/env node
// Record from the microphone, transcribe through Velox, put the text on the
// clipboard. Recording ends on its own once you stop talking.
import { spawn } from "node:child_process";
import { findCommand, veloxPost, wav } from "./velox.mjs";

// Velox renamed the elevenlabs-stt combo: "scribe" (what the pi extension still
// sends) now 404s, "stt-1" is the live alias.
const STT_MODEL = () => process.env.STT_MODEL || "stt-1";
const STT_LANGUAGE = () => process.env.STT_LANGUAGE || "";
const STT_MAX_SECONDS = () => Number(process.env.STT_MAX_SECONDS) || 120;
const STT_SILENCE_MS = () => Number(process.env.STT_SILENCE_MS) || 2000;
const STT_LEADIN_SECONDS = () => Number(process.env.STT_LEADIN_SECONDS) || 10;

const SAMPLE_RATE = 16000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2; // s16 mono
const MIN_SPEECH_BYTES = BYTES_PER_SECOND / 2; // 0.5 s
const SPEECH_RMS = 250; // ~0.8 % full scale

/** Recorders must write raw s16le mono 16 kHz PCM to stdout. */
const RECORDERS = {
  "pw-record": ["--raw", "--rate", "16000", "--channels", "1", "--format", "s16", "-"],
  ffmpeg: ["-loglevel", "quiet", "-f", "pulse", "-i", "default", "-ac", "1", "-ar", "16000", "-f", "s16le", "-"],
};

const CLIPBOARDS = {
  "wl-copy": [],
  xclip: ["-selection", "clipboard"],
  xsel: ["--clipboard", "--input"],
  pbcopy: [],
};

/** RMS of one PCM chunk, used to tell speech from room noise. */
function rms(chunk) {
  let sum = 0;
  let count = 0;
  for (let i = 0; i + 1 < chunk.length; i += 2) {
    const sample = chunk.readInt16LE(i);
    sum += sample * sample;
    count++;
  }
  return count ? Math.sqrt(sum / count) : 0;
}

function ms(bytes) {
  return (bytes / BYTES_PER_SECOND) * 1000;
}

/**
 * Record until the speaker falls silent for STT_SILENCE_MS, or the cap is hit.
 * Claude Code runs this as one blocking command, so there is no second
 * keypress to stop it — the pause is the stop signal.
 */
async function record() {
  const { cmd, args } = await findCommand(process.env.STT_RECORDER, RECORDERS, "STT_RECORDER").catch((err) => {
    throw typeof err === "string" && err.startsWith("none found") ? "no audio recorder found (tried pw-record, ffmpeg)" : err;
  });

  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    const chunks = [];
    let totalBytes = 0;
    let speechBytes = 0;
    let silenceBytes = 0;
    let hadSpeech = false;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(cap);
      clearTimeout(leadin);
      proc.kill("SIGINT");
      setTimeout(() => proc.kill("SIGKILL"), 2000).unref();
      resolve({ pcm: Buffer.concat(chunks), speechBytes, seconds: totalBytes / BYTES_PER_SECOND });
    };

    const cap = setTimeout(finish, STT_MAX_SECONDS() * 1000);
    // Without this, invoking /dictate and saying nothing blocks for the full cap.
    const leadin = setTimeout(() => {
      if (!hadSpeech) finish();
    }, STT_LEADIN_SECONDS() * 1000);

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(cap);
      clearTimeout(leadin);
      reject("recorder " + cmd + " failed to start: " + String(err));
    });

    proc.stdout.on("data", (chunk) => {
      chunks.push(chunk);
      totalBytes += chunk.length;
      if (rms(chunk) >= SPEECH_RMS) {
        hadSpeech = true;
        speechBytes += chunk.length;
        silenceBytes = 0;
      } else {
        silenceBytes += chunk.length;
      }
      if (hadSpeech && ms(silenceBytes) >= STT_SILENCE_MS()) finish();
    });

    proc.on("close", finish);
  });
}

async function transcribe(buf) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buf)], { type: "audio/wav" }), "clip.wav");
  form.append("model", STT_MODEL());
  const language = STT_LANGUAGE();
  if (language) form.append("language", language);

  const response = await veloxPost("/v1/audio/transcriptions", { form });
  const data = await response.json();
  return String(data?.text ?? "").trim();
}

/** Copy to the system clipboard. Returns the tool used, or undefined. */
async function copyToClipboard(text) {
  let tool;
  try {
    tool = await findCommand(process.env.STT_CLIPBOARD, CLIPBOARDS, "STT_CLIPBOARD");
  } catch {
    return undefined;
  }
  return new Promise((resolve) => {
    const proc = spawn(tool.cmd, tool.args, { stdio: ["pipe", "ignore", "ignore"], detached: tool.cmd === "wl-copy" });
    proc.on("error", () => resolve(undefined));
    // wl-copy owns the selection until it is replaced, so it must outlive us.
    proc.on("spawn", () => {
      proc.stdin.end(text);
      if (tool.cmd === "wl-copy") {
        proc.unref();
        resolve(tool.cmd);
      } else {
        proc.on("close", (code) => resolve(code === 0 ? tool.cmd : undefined));
      }
    });
  });
}

async function main() {
  if (!process.env.VELOX_API_KEY) throw "VELOX_API_KEY is not set";

  const { pcm, speechBytes, seconds } = await record();
  if (speechBytes < MIN_SPEECH_BYTES) throw "nothing recorded";

  const text = await transcribe(wav(pcm, SAMPLE_RATE));
  if (!text) throw "nothing recorded";

  const copied = await copyToClipboard(text);
  console.log(text);
  console.log();
  console.log(
    copied
      ? `[${seconds.toFixed(1)}s — copied to the clipboard, press ctrl+v to paste]`
      : `[${seconds.toFixed(1)}s — no clipboard tool found (tried wl-copy, xclip, xsel, pbcopy)]`,
  );
}

main().catch((err) => {
  console.error("stt: " + String(err?.message || err));
  process.exit(1);
});
