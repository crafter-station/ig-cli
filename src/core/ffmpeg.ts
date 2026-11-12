// The one place that runs ffmpeg and ffprobe, and the one reading of what
// ffprobe says about a file. Every caller (download, probe, analyze,
// transcribe) takes the runner as an injectable seam, so tests need no binary.

import { spawn, spawnSync } from "node:child_process";
import { hasCommand } from "../cligentic/platform/detect.js";
import { round } from "../lib/math.js";
import { oneLine } from "../lib/output.js";

export type Tool = "ffmpeg" | "ffprobe";
export type RunResult = { code: number | null; stdout: string; stderr: string };
/** Resolves with the exit code, also a non-zero one. Rejects only when the tool cannot start. */
export type Runner = (tool: Tool, args: string[]) => Promise<RunResult>;

/** ffprobe only reads headers here; ffmpeg may decode a whole video. */
const TIMEOUT_MS: Record<Tool, number> = { ffprobe: 60_000, ffmpeg: 10 * 60_000 };
const MAX_OUTPUT = 8 * 1024 * 1024;

/** Spawns the tool with an argument array, never a shell string. Nothing in a path is interpreted. */
export function runTool(tool: Tool, args: string[]): Promise<RunResult> {
  return new Promise((done, fail) => {
    const child = spawn(tool, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: TIMEOUT_MS[tool],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_OUTPUT) stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-MAX_OUTPUT);
    });
    child.on("error", fail);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

/** What to do when ffmpeg or ffprobe is missing. One wording for every command. */
export const FFMPEG_HINT =
  "Install ffmpeg (ffprobe ships with it, https://ffmpeg.org/download.html) and make sure it is on PATH. `ig doctor` shows what was found.";

/** Whether the tool can be found on PATH. */
export function hasTool(tool: Tool): boolean {
  return hasCommand(tool);
}

/** First line of `<tool> -version`, shortened, or null when it cannot run. For `ig doctor`. */
export function toolVersion(tool: Tool): string | null {
  try {
    const out = spawnSync(tool, ["-version"], {
      shell: false,
      windowsHide: true,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (out.status !== 0 || !out.stdout) return null;
    const match = out.stdout.match(/version\s+(\S+)/);
    return match?.[1] ?? "found on PATH";
  } catch {
    return null;
  }
}

/** The last line a tool printed: the one that explains a failure. */
export const lastLine = (text: string): string => oneLine(text.trim().split(/\r?\n/).pop() ?? "");

/** Runs the tool and throws `<tool> failed: <its last line>` on a non-zero exit. */
export async function mustRun(run: Runner, tool: Tool, args: string[]): Promise<RunResult> {
  const result = await run(tool, args);
  if (result.code !== 0) {
    throw new Error(`${tool} failed: ${lastLine(result.stderr) || `exit code ${result.code}`}`);
  }
  return result;
}

// --- probing a file ------------------------------------------------------------

export type MediaProbe = {
  durationSec: number | null;
  /** As a viewer sees it: a stream stored sideways has width and height swapped back. */
  width: number | null;
  height: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
};

/** The file follows `-i`, so a path can never be read as an option. */
export function probeArgs(file: string): string[] {
  return ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-i", file];
}

const positive = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Reads ffprobe's JSON. A missing or nonsensical value is null, never zero.
 * The container duration wins over the stream's. Cover art in an audio file
 * is a video stream to ffprobe; it is not a video here.
 */
export function parseProbe(json: string): MediaProbe {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    throw new Error("ffprobe returned output that is not JSON");
  }
  const root = (doc !== null && typeof doc === "object" ? doc : {}) as Record<string, unknown>;
  const streams = (Array.isArray(root.streams) ? root.streams : []).filter(
    (s): s is Record<string, unknown> => s !== null && typeof s === "object",
  );
  const video = streams.find(
    (s) =>
      s.codec_type === "video" &&
      (s.disposition as Record<string, unknown> | undefined)?.attached_pic !== 1,
  );
  const format = (root.format ?? {}) as Record<string, unknown>;
  const seconds = positive(format.duration) ?? positive(video?.duration);

  let rotation = 0;
  const sideData = Array.isArray(video?.side_data_list) ? video.side_data_list : [];
  for (const entry of sideData as Record<string, unknown>[]) {
    const value = Number(entry?.rotation);
    if (Number.isFinite(value) && value !== 0) rotation = value;
  }
  if (rotation === 0) {
    const tag = Number((video?.tags as Record<string, unknown> | undefined)?.rotate);
    if (Number.isFinite(tag)) rotation = tag;
  }
  const sideways = Math.abs(Math.round(rotation)) % 180 === 90;

  const w = positive(video?.width);
  const h = positive(video?.height);
  const width = w === null ? null : Math.round(w);
  const height = h === null ? null : Math.round(h);
  return {
    durationSec: seconds === null ? null : round(seconds, 3),
    width: sideways ? height : width,
    height: sideways ? width : height,
    hasVideo: video !== undefined,
    hasAudio: streams.some((s) => s.codec_type === "audio"),
  };
}

/** Measures one local file. Rejects when ffprobe cannot read it. */
export async function probeFile(file: string, run: Runner = runTool): Promise<MediaProbe> {
  return parseProbe((await mustRun(run, "ffprobe", probeArgs(file))).stdout);
}
