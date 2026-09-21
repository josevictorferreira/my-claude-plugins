#!/usr/bin/env node
// Summarize the last assistant reply and play it as speech.
//
//   speak.mjs           manual /speak — second run stops playback
//   speak.mjs --auto    Stop hook — no-op unless TTS_AUTO_SPEAK is on
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { findCommand, veloxPost, wav } from "./velox.mjs";

const TTS_MODEL = () => process.env.TTS_MODEL || "voice";
const TTS_VOICE = () => process.env.TTS_VOICE || "geffen_32";
const SUMMARY_MODEL = () => process.env.TTS_SUMMARY_MODEL || "deepseek-v4-flash";
const TTS_LANGUAGE = () => process.env.TTS_LANGUAGE || "pt-BR";
const AUTO_SPEAK = () => /^(1|true|yes|on)$/i.test(process.env.TTS_AUTO_SPEAK || "");

// /v1/audio/speech rejects input above 4096 chars; stay under it.
const MAX_SPEECH_CHARS = 4000;

const SUMMARY_PROMPT =
  "Summarize the assistant message below for text-to-speech in 2-3 plain " +
  "spoken sentences. No markdown, no code, no lists, no file paths.";

const PLAYERS = {
  mpv: ["--no-video", "--really-quiet"],
  ffplay: ["-nodisp", "-autoexit", "-loglevel", "quiet"],
  "pw-play": [],
};

const STATE_DIR = join(tmpdir(), "claude-voice-" + (process.getuid?.() ?? 0));
const PID_FILE = join(STATE_DIR, "play.pid");
const LOG_FILE = join(STATE_DIR, "speak.log");

// --- transcript -------------------------------------------------------------

/** Newest transcript of the current project, as Claude Code names the directory. */
function currentTranscript() {
  const slug = process.cwd().replace(/[^a-zA-Z0-9]/g, "-");
  const dir = join(homedir(), ".claude", "projects", slug);
  if (!existsSync(dir)) throw "no transcript directory for " + process.cwd();
  const newest = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!newest) throw "no transcript found for " + process.cwd();
  return newest;
}

/** Latest assistant text on the main thread, with the uuid that keys its cache entry. */
function lastAssistantMessage(path) {
  const lines = readFileSync(path, "utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue; // partially flushed line
    }
    // Subagent replies are not what the user just read on screen.
    if (entry?.type !== "assistant" || entry.isSidechain) continue;
    const content = entry.message?.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n").trim()
        : "";
    if (text) return { id: entry.uuid || createHash("sha1").update(text).digest("hex"), text };
  }
  return undefined;
}

// --- velox ------------------------------------------------------------------

async function summarize(text) {
  const response = await veloxPost("/v1/chat/completions", {
    json: {
      model: SUMMARY_MODEL(),
      messages: [
        { role: "system", content: SUMMARY_PROMPT + " Write the summary in " + TTS_LANGUAGE() + "." },
        { role: "user", content: text.slice(0, 20000) },
      ],
      max_tokens: 200,
    },
  });
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw "summarizer returned no text";
  return content.trim().slice(0, MAX_SPEECH_CHARS);
}

async function synthesize(input) {
  const response = await veloxPost("/v1/audio/speech", {
    json: {
      model: TTS_MODEL(),
      input,
      voice: TTS_VOICE(),
      response_format: "wav",
      language: TTS_LANGUAGE(),
    },
  });
  return Buffer.from(await response.arrayBuffer());
}

// --- playback ---------------------------------------------------------------

/** Kill a running playback group, if any. Returns whether one was running. */
function stopPlayback() {
  if (!existsSync(PID_FILE)) return false;
  const pid = Number(readFileSync(PID_FILE, "utf8").trim());
  unlinkSync(PID_FILE);
  if (!pid) return false;
  try {
    process.kill(-pid, "SIGTERM"); // detached child leads its own group
    return true;
  } catch {
    return false; // already gone
  }
}

/**
 * Play files in order, detached, and record the group id so a later run can
 * stop it. Returning immediately is what makes /speak a toggle: the command
 * finishes while the audio is still playing.
 */
async function playDetached(files) {
  const { cmd, args } = await findCommand(process.env.TTS_PLAYER, PLAYERS, "TTS_PLAYER").catch((err) => {
    throw typeof err === "string" && err.startsWith("none found") ? "no audio player found (tried mpv, ffplay, pw-play)" : err;
  });
  const script = files.map((f) => [cmd, ...args, f].map((p) => "'" + p.replaceAll("'", "'\\''") + "'").join(" ")).join("; ");
  const child = spawn("sh", ["-c", script], { detached: true, stdio: "ignore" });
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
}

/** Rising 120 ms chime (700 Hz -> 1050 Hz), written once per machine boot. */
function chimeFile() {
  const path = join(STATE_DIR, "alert.wav");
  if (existsSync(path)) return path;
  const sampleRate = 44100;
  const numSamples = Math.floor(sampleRate * 0.12);
  const pcm = Buffer.alloc(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    const env = Math.sin((Math.PI * i) / numSamples);
    const freq = 700 + 350 * (i / numSamples);
    const sample = Math.sin(2 * Math.PI * freq * (i / sampleRate)) * env * 0.25 * 32767;
    pcm.writeInt16LE(Math.floor(sample), i * 2);
  }
  writeFileSync(path, wav(pcm, sampleRate));
  return path;
}

// --- main -------------------------------------------------------------------

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

async function speak({ transcriptPath, auto }) {
  const msg = lastAssistantMessage(transcriptPath);
  if (!msg) throw "no assistant message yet";

  const key = [msg.id, TTS_MODEL(), TTS_VOICE(), SUMMARY_MODEL(), TTS_LANGUAGE()].join(":");
  const file = join(STATE_DIR, createHash("sha1").update(key).digest("hex") + ".wav");

  let cached = existsSync(file);
  if (!cached) {
    writeFileSync(file, await synthesize(await summarize(msg.text)));
  }

  await playDetached(auto ? [chimeFile(), file] : [file]);
  return cached ? "speaking (cached)" : "speaking";
}

async function main() {
  const auto = process.argv.includes("--auto");
  mkdirSync(STATE_DIR, { recursive: true });

  // SessionEnd: silence anything still playing and drop the cached audio.
  if (process.argv.includes("--cleanup")) {
    stopPlayback();
    for (const f of readdirSync(STATE_DIR).filter((f) => f.endsWith(".wav"))) {
      try {
        unlinkSync(join(STATE_DIR, f));
      } catch {
        // Best effort.
      }
    }
    return;
  }

  if (!auto) {
    // A second /speak stops playback instead of queueing another one.
    if (stopPlayback()) return console.log("tts: stopped");
    console.log("tts: " + (await speak({ transcriptPath: currentTranscript(), auto: false })));
    return;
  }

  if (!AUTO_SPEAK()) return;
  const hook = JSON.parse((await readStdin()) || "{}");
  if (hook.stop_hook_active) return; // already inside a Stop-hook continuation

  // The Stop hook is awaited, so summarizing here would stall the session.
  // Hand the work to a detached copy and let the hook return at once.
  if (!process.env.CLAUDE_VOICE_DETACHED) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--auto"], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env, CLAUDE_VOICE_DETACHED: "1" },
    });
    child.stdin.end(JSON.stringify(hook));
    child.unref();
    return;
  }

  stopPlayback(); // a new reply supersedes whatever is still playing
  await speak({ transcriptPath: hook.transcript_path || currentTranscript(), auto: true });
}

main().catch((err) => {
  const message = "tts: " + String(err?.message || err);
  if (process.argv.includes("--auto")) {
    // Nothing is watching a hook's output; leave a trail instead.
    try {
      appendFileSync(LOG_FILE, new Date().toISOString() + " " + message + "\n");
    } catch {
      // Best effort.
    }
    process.exit(0);
  }
  console.error(message);
  process.exit(1);
});
