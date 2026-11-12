// Transcribing downloaded reels. The commands stay thin; everything that
// touches ffmpeg, a temp directory or an engine is here, behind injectable
// seams so tests need no binaries and no network.
//
// Rules:
//   1. Only a file already on disk is transcribed. Nothing here talks to Instagram.
//   2. The engine never sees the mp4: ffmpeg extracts a small mono 16 kHz file
//      into a temp directory that is removed afterwards, also on failure.
//   3. A video without an audio stream, or without speech, gets an empty
//      transcript stored, so it is not sent again on every run.
//   4. With an API engine the audio leaves this machine. The plan (how many
//      videos, how many minutes) is known before the first upload.
//   5. A rejected key, an exhausted quota or a missing binary ends the batch at
//      once. Anything else fails one video and the batch goes on.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasCommand } from "../cligentic/platform/detect.js";
import type { Store } from "../db/store.js";
import type { Config } from "../lib/config.js";
import { type ErrorCode, IgError } from "../lib/errors.js";
import { errorLine as message, oneLine } from "../lib/output.js";
import { createElevenLabsEngine, elevenlabsAvailability } from "../transcribe/elevenlabs.js";
import { createOpenAiEngine, openaiAvailability } from "../transcribe/openai.js";
import {
  ENGINE_NAMES,
  type Engine,
  type EngineAvailability,
  type EngineName,
  type Env,
} from "../transcribe/types.js";
import { createWhisperCppEngine, whisperCppAvailability } from "../transcribe/whisper-cpp.js";
import { lastLine, type MediaProbe, probeFile, type Runner, runTool } from "./ffmpeg.js";
import { findStoredVideo } from "./targets.js";
import type { StoredVideo, TranscriptSegment } from "./types.js";

export type EngineChoice = EngineName | "auto";

/**
 * The order `auto` tries engines in. Local whisper first: it is free and the
 * audio stays on this machine. Then the paid APIs, by whichever key is set;
 * ElevenLabs before OpenAI because its word-level timestamps give a more
 * exact hook than Whisper's sentence-long segments.
 */
export const AUTO_ORDER: readonly EngineName[] = ["whisper-cpp", "elevenlabs", "openai"];

export type TranscribeDeps = {
  /** Environment the engines read their keys and overrides from. */
  env: Env;
  hasCommand: (name: string) => boolean;
  /** Runs ffmpeg or ffprobe with an argument array. Rejects only when it cannot start. */
  run: Runner;
  makeTempDir: () => string;
  removeDir: (dir: string) => void;
  exists: (path: string) => boolean;
  availability: (config: Config, env: Env) => EngineAvailability[];
  createEngine: (name: EngineName, config: Config, env: Env) => Engine;
};

export function engineAvailability(config: Config, env: Env): EngineAvailability[] {
  const all: Record<EngineName, () => EngineAvailability> = {
    "whisper-cpp": () => whisperCppAvailability(config, env),
    elevenlabs: () => elevenlabsAvailability(config, env),
    openai: () => openaiAvailability(config, env),
  };
  return AUTO_ORDER.map((name) => all[name]());
}

function createEngine(name: EngineName, config: Config, env: Env): Engine {
  switch (name) {
    case "whisper-cpp":
      return createWhisperCppEngine(config, env);
    case "elevenlabs":
      return createElevenLabsEngine(config, env);
    case "openai":
      return createOpenAiEngine(config, env);
  }
}

const defaults: TranscribeDeps = {
  env: process.env,
  hasCommand,
  run: runTool,
  makeTempDir: () => mkdtempSync(join(tmpdir(), "ig-cli-audio-")),
  removeDir: (dir) => rmSync(dir, { recursive: true, force: true }),
  exists: existsSync,
  availability: engineAvailability,
  createEngine,
};

export function transcribeDeps(overrides: Partial<TranscribeDeps> = {}): TranscribeDeps {
  return { ...defaults, ...overrides };
}

/**
 * The engine to use: the one asked for, else `transcribeEngine` from config,
 * and for `auto` the first usable one in `AUTO_ORDER`. An unusable choice is an
 * error that says why and how to fix it; it never falls through to an engine
 * that would upload audio the user did not ask to upload.
 */
export function resolveEngine(
  config: Config,
  requested: EngineChoice | undefined,
  deps: TranscribeDeps,
): Engine {
  const choice = requested ?? config.transcribeEngine;
  const available = deps.availability(config, deps.env);
  if (choice !== "auto") {
    const state = available.find((a) => a.name === choice);
    if (!state?.usable) {
      throw new IgError(
        state?.local === false ? "AUTH_REQUIRED" : "BACKEND_UNAVAILABLE",
        `The ${choice} transcription engine is not usable: ${state?.detail ?? "unknown engine"}.`,
        { hint: state?.hint ?? "Run `ig doctor`.", details: { engines: available } },
      );
    }
    return deps.createEngine(choice, config, deps.env);
  }
  const first = available.find((a) => a.usable);
  if (!first) {
    throw new IgError(
      "BACKEND_UNAVAILABLE",
      `No transcription engine is usable: ${available.map((a) => `${a.name}: ${a.detail}`).join("; ")}.`,
      {
        hint: "Install whisper.cpp and set a model (`ig config set whisperModel <path>`), or set ELEVENLABS_API_KEY or OPENAI_API_KEY. `ig doctor` shows each engine.",
        details: { engines: available },
      },
    );
  }
  return deps.createEngine(first.name, config, deps.env);
}

export function isEngineName(value: string): value is EngineName {
  return (ENGINE_NAMES as readonly string[]).includes(value);
}

// --- ffmpeg -----------------------------------------------------------------

/** The first audio stream as mono 16 kHz, which is what every engine wants. */
export async function extractAudio(
  videoPath: string,
  dir: string,
  format: Engine["audioFormat"],
  deps: TranscribeDeps,
): Promise<string> {
  const out = join(dir, `audio.${format}`);
  const result = await deps.run("ffmpeg", [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    videoPath,
    "-map",
    "0:a:0",
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    format === "wav" ? "pcm_s16le" : "flac",
    out,
  ]);
  if (result.code !== 0 || !deps.exists(out)) {
    throw new Error(
      `ffmpeg could not extract the audio: ${lastLine(result.stderr) || "no output"}`,
    );
  }
  return out;
}

// --- hook -------------------------------------------------------------------

/**
 * What is said in the opening: the text of the segments that start within the
 * first `seconds`. Null when nothing is said that early. A segment that starts
 * in the window is kept whole, so the hook is never cut mid-sentence.
 */
export function hookOf(segments: TranscriptSegment[], seconds: number): string | null {
  const text = segments
    .filter((s) => s.start < seconds)
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text === "" ? null : text;
}

// --- batch ------------------------------------------------------------------

export type TranscribeStatus =
  | "transcribed"
  | "no-speech"
  | "skipped"
  | "failed"
  | "would-transcribe";

export type TranscribeItem = {
  id: string | null;
  shortcode: string;
  creatorUsername: string | null;
  status: TranscribeStatus;
  reason: string | null;
  durationSec: number | null;
  language: string | null;
  hook: string | null;
  words: number | null;
};

export type TranscribeSummary = {
  engine: EngineName;
  model: string | null;
  /** True when the engine uploads audio to a provider. */
  uploadsAudio: boolean;
  dryRun: boolean;
  transcribed: number;
  noSpeech: number;
  skipped: number;
  failed: number;
  /** Videos left for another run because of --limit. */
  overLimit: number;
  /** Audio handed to the engine, or that would be with --dry-run. */
  audioSeconds: number;
  audioMinutes: number;
  /** Shortcodes that have no file on disk yet. */
  notDownloaded: string[];
  items: TranscribeItem[];
};

export type TranscribeRequest = {
  /** Stored videos (from a selection) or raw targets: media id, shortcode or reel URL. */
  targets: (StoredVideo | string)[];
  engine: Engine;
  force: boolean;
  dryRun: boolean;
  language?: string;
  hookSeconds: number;
  /** At most this many videos are transcribed in this run. */
  limit?: number;
};

export type TranscribeEnv = {
  store: Store;
  /** Progress lines. Goes to stderr; silent in machine mode. */
  log: (message: string) => void;
};

const BATCH_ENDING: ReadonlySet<ErrorCode> = new Set([
  "AUTH_REQUIRED",
  "RATE_LIMITED",
  "BACKEND_UNAVAILABLE",
  "UNSUPPORTED",
  "BUDGET_EXHAUSTED",
]);

/** Retrying these on the next video only repeats the failure, or costs money. */
function stopsBatch(err: unknown): err is IgError {
  return err instanceof IgError && BATCH_ENDING.has(err.code);
}

const minutes = (seconds: number): number => Math.round((seconds / 60) * 100) / 100;

const countWords = (text: string): number => (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;

type Pending = { index: number; video: StoredVideo; path: string; probe: MediaProbe | null };

export async function transcribeVideos(
  env: TranscribeEnv,
  request: TranscribeRequest,
  overrides: Partial<TranscribeDeps> = {},
): Promise<TranscribeSummary> {
  const deps = transcribeDeps(overrides);
  const { engine } = request;
  const summary: TranscribeSummary = {
    engine: engine.name,
    model: null,
    uploadsAudio: !engine.local,
    dryRun: request.dryRun,
    transcribed: 0,
    noSpeech: 0,
    skipped: 0,
    failed: 0,
    overLimit: 0,
    audioSeconds: 0,
    audioMinutes: 0,
    notDownloaded: [],
    items: [],
  };

  if (!deps.hasCommand("ffmpeg") || !deps.hasCommand("ffprobe")) {
    throw new IgError("BACKEND_UNAVAILABLE", "ffmpeg and ffprobe are needed to read the audio.", {
      hint: "Install ffmpeg (https://ffmpeg.org/download.html) and make sure it is on PATH.",
    });
  }

  // --- plan: decide every video's fate before anything is uploaded ----------
  const pending: Pending[] = [];
  const seen = new Set<string>();
  for (const target of request.targets) {
    let video: StoredVideo | null;
    if (typeof target === "string") {
      const { shortcode, video: found } = findStoredVideo(env.store, target);
      video = found;
      if (!video) {
        const known = shortcode ?? oneLine(target);
        summary.items.push({
          ...blank({ id: null, shortcode: known, creatorUsername: null }),
          status: "failed",
          reason: shortcode
            ? "not in the local database; download it first"
            : "not a stored video id, and not a shortcode or reel URL",
        });
        if (shortcode) summary.notDownloaded.push(shortcode);
        continue;
      }
    } else {
      video = target;
    }
    if (seen.has(video.id)) continue;
    seen.add(video.id);

    const base = blank(video);
    if (!video.localPath || !deps.exists(video.localPath)) {
      summary.notDownloaded.push(video.shortcode);
      summary.items.push({
        ...base,
        status: "skipped",
        reason: video.localPath
          ? "the downloaded file is gone; download it again"
          : "not downloaded; only downloaded videos can be transcribed",
      });
      continue;
    }
    if (video.hasTranscript && !request.force) {
      summary.items.push({
        ...base,
        status: "skipped",
        reason: "already transcribed; use --force to redo",
      });
      continue;
    }
    if (request.limit !== undefined && pending.length >= request.limit) {
      summary.overLimit++;
      continue;
    }
    // The duration is needed up front to say how much audio will be sent.
    let probe: MediaProbe | null = null;
    try {
      probe = await probeFile(video.localPath, deps.run);
    } catch {
      // Left for the transcription step, which reports the failure per video.
    }
    const durationSec = probe?.durationSec ?? video.durationSec;
    const index =
      summary.items.push({
        ...base,
        durationSec,
        status: "would-transcribe",
        reason:
          probe?.hasAudio === false
            ? "no audio stream: an empty transcript is stored and nothing is sent"
            : null,
      }) - 1;
    pending.push({ index, video, path: video.localPath, probe });
    if (probe?.hasAudio !== false) summary.audioSeconds += durationSec ?? 0;
  }
  summary.audioMinutes = minutes(summary.audioSeconds);
  summary.skipped = summary.items.filter((i) => i.status === "skipped").length;
  summary.failed = summary.items.filter((i) => i.status === "failed").length;

  if (request.dryRun || pending.length === 0) return summary;

  const noun = pending.length === 1 ? "video" : "videos";
  env.log(
    engine.local
      ? `Transcribing ${pending.length} ${noun} (${summary.audioMinutes} min) locally with ${engine.name}.`
      : `Uploading the audio of ${pending.length} ${noun} (${summary.audioMinutes} min) to ${engine.name}.`,
  );

  // --- run -------------------------------------------------------------------
  let sentSeconds = 0;
  for (const [n, job] of pending.entries()) {
    const item = summary.items[job.index] as TranscribeItem;
    try {
      const done = await transcribeOne(env, request, job, deps);
      Object.assign(item, done.item);
      if (done.model) summary.model = done.model;
      if (done.sent) sentSeconds += item.durationSec ?? 0;
    } catch (err) {
      if (stopsBatch(err)) {
        // What was planned but never ran is not reported as done or as failed.
        const left = pending.slice(n);
        const leftIndexes = new Set(left.map((p) => p.index));
        summary.items = summary.items.filter((_, i) => !leftIndexes.has(i));
        finish(summary, sentSeconds);
        throw new IgError(err.code, err.message, {
          hint: err.hint,
          details: { ...err.details, progress: summary, remaining: left.length },
          cause: err,
        });
      }
      item.status = "failed";
      item.reason = message(err);
    }
    env.log(
      `${n + 1}/${pending.length} ${item.creatorUsername ?? "?"}/${item.shortcode} ${
        item.reason ? `${item.status}: ${item.reason}` : item.status
      }`,
    );
  }
  finish(summary, sentSeconds);
  return summary;
}

function blank(video: {
  id: string | null;
  shortcode: string;
  creatorUsername: string | null;
  durationSec?: number | null;
}): TranscribeItem {
  return {
    id: video.id,
    shortcode: video.shortcode,
    creatorUsername: video.creatorUsername,
    status: "skipped",
    reason: null,
    durationSec: video.durationSec ?? null,
    language: null,
    hook: null,
    words: null,
  };
}

function finish(summary: TranscribeSummary, sentSeconds: number): void {
  const count = (status: TranscribeStatus) =>
    summary.items.filter((i) => i.status === status).length;
  summary.transcribed = count("transcribed");
  summary.noSpeech = count("no-speech");
  summary.skipped = count("skipped");
  summary.failed = count("failed");
  summary.audioSeconds = Math.round(sentSeconds * 100) / 100;
  summary.audioMinutes = minutes(sentSeconds);
}

async function transcribeOne(
  env: TranscribeEnv,
  request: TranscribeRequest,
  job: Pending,
  deps: TranscribeDeps,
): Promise<{ item: Partial<TranscribeItem>; model: string | null; sent: boolean }> {
  const { video, path } = job;
  const { engine } = request;
  const probe = job.probe ?? (await probeFile(path, deps.run));
  if (probe.durationSec !== null && video.durationSec === null) {
    env.store.setVideoMedia(video.id, { durationSec: probe.durationSec });
  }

  if (!probe.hasAudio) {
    // Nothing was sent anywhere, so no engine is credited with it.
    env.store.saveTranscript({
      videoId: video.id,
      language: null,
      text: "",
      hook: null,
      segments: [],
      engine: "none",
      model: null,
    });
    return {
      item: { status: "no-speech", reason: "the file has no audio stream", words: 0 },
      model: null,
      sent: false,
    };
  }

  const dir = deps.makeTempDir();
  try {
    const audio = await extractAudio(path, dir, engine.audioFormat, deps);
    const result = await engine.transcribe(audio, { language: request.language });
    const segments = result.segments
      .map((s) => ({ start: s.start, end: s.end, text: s.text.trim() }))
      .filter((s) => s.text !== "");
    const text = result.text.trim();
    const hook = hookOf(segments, request.hookSeconds);
    const language = text === "" ? null : (result.language ?? request.language ?? null);
    env.store.saveTranscript({
      videoId: video.id,
      language,
      text,
      hook,
      segments,
      engine: engine.name,
      model: result.model,
    });
    const item: Partial<TranscribeItem> =
      text === ""
        ? { status: "no-speech", reason: "no speech detected", words: 0 }
        : { status: "transcribed", reason: null, language, hook, words: countWords(text) };
    return { item, model: result.model, sent: true };
  } finally {
    deps.removeDir(dir);
  }
}
