// How a downloaded reel is made, read from the file alone with ffmpeg. No
// model is involved: this measures editing pace (hard cuts) and a few audio
// facts, and exports key frames a vision-capable agent can look at to name
// the format (talking head, overhead shot, text on screen...).
//
// What the numbers mean, and what they do not:
//   - A "cut" is a frame whose ffmpeg scene score exceeds the threshold: an
//     abrupt change of most of the picture. Hard cuts between different shots
//     score 0.3 to 1.0. Jump cuts inside the same framing score about 0.2 to
//     0.3 and are partly missed at the default. Dissolves and slow fades never
//     produce one high-scoring frame and are not counted at all.
//   - Audio: mean volume and the share of the duration below a noise floor.
//     It tells "sound throughout" from "mostly quiet". It cannot tell speech
//     from music.
//
// Everything that touches a child process goes through an injectable runner
// that takes an argument array, never a shell string, so tests need no ffmpeg.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { atomicWriteJson } from "../cligentic/foundation/atomic-write.js";
import { hasCommand } from "../cligentic/platform/detect.js";
import type { Store } from "../db/store.js";
import { oneLine } from "../lib/output.js";
import { median } from "./ranking.js";
import { parseShortcode, type StoredVideo } from "./types.js";

// --- defaults ----------------------------------------------------------------

/**
 * ffmpeg's documentation calls 0.3 to 0.5 the sane range. Measured on a real
 * fast-edited reel, hard cuts scored 0.33 to 0.74 and in-shot motion at most
 * 0.16, so 0.4 (the value most often quoted) misses real cuts and 0.3 does not.
 */
export const DEFAULT_THRESHOLD = 0.3;
/** Detections closer than this to the last kept cut are the same event. */
export const DEFAULT_MIN_GAP_SEC = 0.25;
export const DEFAULT_MAX_FRAMES = 12;
export const DEFAULT_FRAME_WIDTH = 540;
/** Fewer cuts than this still yield this many frames, evenly spaced. */
export const MIN_FRAMES = 4;
/** A frame is taken this long after its cut, past any blended frame. */
const AFTER_CUT_SEC = 0.2;
/** Audio quieter than this for at least SILENCE_MIN_SEC counts as silence. */
export const SILENCE_NOISE_DB = -40;
export const SILENCE_MIN_SEC = 0.4;
const SHEET_CELL_WIDTH = 270;

export const FRAMES_INDEX = "frames.json";
export const SHEET_FILE = "sheet.jpg";

// --- shapes ------------------------------------------------------------------

export const FrameSchema = z.object({
  file: z.string().describe("File name inside framesDir"),
  path: z.string().describe("Absolute path of the JPEG"),
  timeSec: z.number().describe("Position in the video"),
  reason: z
    .enum(["first", "cut", "interval"])
    .describe(
      "first: the opening frame. cut: just after a detected cut. interval: evenly spaced filler",
    ),
  shot: z.number().int().describe("1-based number of the shot the frame belongs to"),
});
export type Frame = z.infer<typeof FrameSchema>;

export const AudioFactsSchema = z.object({
  hasAudio: z.boolean().describe("The file has an audio stream"),
  meanVolumeDb: z.number().nullable().describe("Mean volume in dBFS. Closer to 0 is louder"),
  maxVolumeDb: z.number().nullable(),
  silenceSec: z.number().nullable().describe("Total time below the noise floor"),
  silenceRatio: z
    .number()
    .nullable()
    .describe(
      "Share of the duration that is silence, 0 to 1. Near 0: voice or music throughout. It cannot tell which",
    ),
});
export type AudioFacts = z.infer<typeof AudioFactsSchema>;

export const AnalysisSchema = z.object({
  durationSec: z.number().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  cuts: z.number().int().describe("Hard cuts detected. Dissolves are not counted"),
  cutsPerMin: z.number().nullable().describe("Editing pace. Higher is faster"),
  cutTimes: z.array(z.number()).describe("Seconds at which each cut happens"),
  avgShotSec: z.number().nullable().describe("Mean shot length"),
  medianShotSec: z.number().nullable(),
  firstShotSec: z
    .number()
    .nullable()
    .describe("How long the opening shot holds before the first cut"),
  audio: AudioFactsSchema,
  framesDir: z.string().describe("Directory holding the frames and frames.json"),
  frames: z.array(FrameSchema),
  sheet: z.string().nullable().describe("Contact sheet of all frames, in reading order"),
  threshold: z.number().describe("Scene score a frame had to exceed to count as a cut"),
  minGapSec: z.number(),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

/** What frames.json holds: the analysis plus which video it belongs to. */
export const FramesIndexSchema = AnalysisSchema.extend({
  version: z.literal(1),
  videoId: z.string().nullable(),
  shortcode: z.string(),
  source: z.string().describe("The analyzed file"),
  analyzedAt: z.string(),
});
export type FramesIndex = z.infer<typeof FramesIndexSchema>;

export type AnalyzeOptions = {
  threshold: number;
  minGapSec: number;
  maxFrames: number;
  frameWidth: number;
  sheet: boolean;
};

export const DEFAULT_OPTIONS: AnalyzeOptions = {
  threshold: DEFAULT_THRESHOLD,
  minGapSec: DEFAULT_MIN_GAP_SEC,
  maxFrames: DEFAULT_MAX_FRAMES,
  frameWidth: DEFAULT_FRAME_WIDTH,
  sheet: false,
};

// --- running ffmpeg ----------------------------------------------------------

export type Tool = "ffmpeg" | "ffprobe";
export type RunResult = { code: number | null; stdout: string; stderr: string };
export type Runner = (tool: Tool, args: string[]) => Promise<RunResult>;

export type AnalyzeDeps = {
  run: Runner;
  hasTool: (tool: Tool) => boolean;
};

const RUN_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT = 8 * 1024 * 1024;

/** Spawns the tool with an argument array. Nothing in a path is interpreted. */
export function runTool(tool: Tool, args: string[]): Promise<RunResult> {
  return new Promise((done, fail) => {
    const child = spawn(tool, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: RUN_TIMEOUT_MS,
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

const defaults: AnalyzeDeps = { run: runTool, hasTool: (tool) => hasCommand(tool) };

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

const lastLine = (text: string): string => oneLine(text.trim().split(/\r?\n/).pop() ?? "");

async function must(deps: AnalyzeDeps, tool: Tool, args: string[]): Promise<RunResult> {
  const result = await deps.run(tool, args);
  if (result.code !== 0) {
    throw new Error(`${tool} failed: ${lastLine(result.stderr) || `exit code ${result.code}`}`);
  }
  return result;
}

const QUIET = ["-hide_banner", "-nostdin", "-loglevel", "error"];
const round = (n: number, digits = 2): number => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

// --- ffprobe -----------------------------------------------------------------

export type MediaInfo = {
  durationSec: number | null;
  width: number | null;
  height: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
};

export function probeArgs(file: string): string[] {
  return ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-i", file];
}

const positive = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Reads ffprobe's JSON. A stream rotated by 90 degrees reports the size as displayed. */
export function parseProbe(json: string): MediaInfo {
  let doc: { format?: Record<string, unknown>; streams?: Record<string, unknown>[] };
  try {
    doc = JSON.parse(json);
  } catch {
    throw new Error("ffprobe did not return JSON");
  }
  const streams = Array.isArray(doc.streams) ? doc.streams : [];
  // Cover art in an audio file is a video stream too; it is not a video.
  const video = streams.find(
    (s) =>
      s.codec_type === "video" &&
      (s.disposition as Record<string, unknown> | undefined)?.attached_pic !== 1,
  );
  const audio = streams.some((s) => s.codec_type === "audio");
  let width = video ? positive(video.width) : null;
  let height = video ? positive(video.height) : null;
  const sideData = Array.isArray(video?.side_data_list)
    ? (video.side_data_list as Record<string, unknown>[])
    : [];
  const rotation = Number(
    sideData.find((d) => d.rotation !== undefined)?.rotation ??
      (video?.tags as Record<string, unknown> | undefined)?.rotate ??
      0,
  );
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  const duration = positive(doc.format?.duration) ?? positive(video?.duration);
  return {
    durationSec: duration === null ? null : round(duration, 3),
    width: width === null ? null : Math.round(width),
    height: height === null ? null : Math.round(height),
    hasVideo: video !== undefined,
    hasAudio: audio,
  };
}

export async function probeMedia(
  file: string,
  overrides: Partial<AnalyzeDeps> = {},
): Promise<MediaInfo> {
  const deps = { ...defaults, ...overrides };
  return parseProbe((await must(deps, "ffprobe", probeArgs(file))).stdout);
}

// --- cuts --------------------------------------------------------------------

export type Detection = { timeSec: number; score: number };

export function sceneArgs(file: string, threshold: number): string[] {
  // `metadata=print:file=-` writes one block per selected frame to stdout.
  const filter = `select='gt(scene,${threshold.toFixed(3)})',metadata=print:file=-`;
  return [...QUIET, "-i", file, "-an", "-sn", "-dn", "-vf", filter, "-f", "null", "-"];
}

/**
 * Parses blocks of
 *   frame:0    pts:60000   pts_time:2
 *   lavfi.scene_score=0.738012
 * Also accepts showinfo-style lines, where only `pts_time:` is present.
 */
export function parseScenes(output: string): Detection[] {
  const found: Detection[] = [];
  let pending: number | null = null;
  const flush = (score: number) => {
    if (pending !== null) found.push({ timeSec: round(pending, 3), score: round(score, 3) });
    pending = null;
  };
  for (const line of output.split(/\r?\n/)) {
    const time = line.match(/pts_time:\s*(-?[0-9.]+)/);
    if (time) {
      // A second timestamp without a score in between: keep the first anyway.
      if (pending !== null) flush(Number.NaN);
      const t = Number(time[1]);
      pending = Number.isFinite(t) ? t : null;
      continue;
    }
    const score = line.match(/scene_score=([0-9.]+)/);
    if (score) flush(Number(score[1]));
  }
  if (pending !== null) flush(Number.NaN);
  return found.filter((d) => d.timeSec > 0).sort((a, b) => a.timeSec - b.timeSec);
}

/**
 * Collapses detections closer than `minGapSec` to the last kept one. A flash
 * or a whip transition scores high on several neighbouring frames and is one
 * event; the first frame of the burst marks it.
 */
export function mergeCuts(detections: Detection[], minGapSec: number): number[] {
  const kept: number[] = [];
  for (const d of detections) {
    const last = kept[kept.length - 1];
    if (last === undefined || d.timeSec - last >= minGapSec) kept.push(d.timeSec);
  }
  return kept;
}

export type ShotStats = {
  cuts: number;
  cutsPerMin: number | null;
  avgShotSec: number | null;
  medianShotSec: number | null;
  firstShotSec: number | null;
};

/** Pace figures from cut timestamps. Without a duration only the count is known. */
export function shotStats(cutTimes: number[], durationSec: number | null): ShotStats {
  const cuts = cutTimes.length;
  if (durationSec === null || durationSec <= 0) {
    return {
      cuts,
      cutsPerMin: null,
      avgShotSec: null,
      medianShotSec: null,
      firstShotSec: cutTimes[0] ?? null,
    };
  }
  const edges = [0, ...cutTimes.filter((t) => t < durationSec), durationSec];
  const shots = edges.slice(1).map((end, i) => end - (edges[i] as number));
  const med = median(shots);
  return {
    cuts,
    cutsPerMin: round((cuts / durationSec) * 60, 1),
    avgShotSec: round(durationSec / shots.length),
    medianShotSec: med === null ? null : round(med),
    firstShotSec: round(shots[0] ?? durationSec),
  };
}

// --- frames ------------------------------------------------------------------

export type FramePick = { timeSec: number; reason: Frame["reason"]; shot: number };

/** `count` items spread evenly over `items`, always including the first and the last. */
function spread<T>(items: T[], count: number): T[] {
  if (count <= 0) return [];
  if (items.length <= count) return items;
  if (count === 1) return items.slice(0, 1);
  const out: T[] = [];
  for (let i = 0; i < count; i++) {
    out.push(items[Math.round((i * (items.length - 1)) / (count - 1))] as T);
  }
  return out;
}

/**
 * Which moments to export: the first frame (what the viewer sees before
 * anything moves), one frame shortly after each cut up to the cap, and evenly
 * spaced frames when cuts are too few to show how the video develops.
 */
export function pickFrames(
  durationSec: number | null,
  cutTimes: number[],
  opts: { maxFrames: number; minFrames?: number },
): FramePick[] {
  const max = Math.max(1, Math.floor(opts.maxFrames));
  const end = durationSec !== null && durationSec > 0 ? durationSec : null;
  const lastUsable = end === null ? Number.POSITIVE_INFINITY : Math.max(0, end - 0.1);
  const shotAt = (t: number): number => 1 + cutTimes.filter((c) => c <= t).length;

  const picks: FramePick[] = [{ timeSec: 0, reason: "first", shot: 1 }];

  const afterCuts = cutTimes.map((cut, i) => {
    const next = cutTimes[i + 1] ?? end ?? cut + 2 * AFTER_CUT_SEC;
    const t = Math.min(cut + Math.min(AFTER_CUT_SEC, Math.max(0, next - cut) / 2), lastUsable);
    return { timeSec: round(t, 3), reason: "cut" as const, shot: i + 2 };
  });
  picks.push(...spread(afterCuts, max - 1));

  const min = Math.min(opts.minFrames ?? MIN_FRAMES, max);
  // Fillers go to the middle of the longest stretch without a frame, so they
  // never land on top of a cut frame and a long closing shot gets covered.
  while (picks.length < min && end !== null) {
    const times = [...picks.map((p) => p.timeSec).sort((a, b) => a - b), end];
    let from = 0;
    let gap = 0;
    for (let i = 0; i + 1 < times.length; i++) {
      const width = (times[i + 1] as number) - (times[i] as number);
      if (width > gap + 1e-9) {
        gap = width;
        from = times[i] as number;
      }
    }
    if (gap < 0.6) break;
    const t = round(Math.min(from + gap / 2, lastUsable), 3);
    picks.push({ timeSec: t, reason: "interval", shot: shotAt(t) });
  }
  return picks.sort((a, b) => a.timeSec - b.timeSec);
}

export const frameName = (index: number): string =>
  `frame-${String(index + 1).padStart(2, "0")}.jpg`;

export function frameArgs(file: string, timeSec: number, width: number, out: string): string[] {
  return [
    ...QUIET,
    "-y",
    "-ss",
    timeSec.toFixed(3),
    "-i",
    file,
    "-an",
    "-sn",
    "-dn",
    "-frames:v",
    "1",
    // Never upscale: a 360 px source stays 360 px.
    "-vf",
    `scale='min(${Math.floor(width)},iw)':-2`,
    "-q:v",
    "4",
    // Without this a `%` in the path would be read as a sequence pattern.
    "-update",
    "1",
    out,
  ];
}

export function sheetLayout(count: number): { cols: number; rows: number } {
  const cols = count <= 4 ? Math.max(1, count) : count <= 12 ? 4 : count <= 20 ? 5 : 6;
  return { cols, rows: Math.max(1, Math.ceil(count / cols)) };
}

export function sheetArgs(frames: string[], out: string): string[] {
  const { cols, rows } = sheetLayout(frames.length);
  const inputs = frames.flatMap((f) => ["-pattern_type", "none", "-i", f]);
  const labels = frames.map((_, i) => `[${i}:v]`).join("");
  const filter =
    `${labels}concat=n=${frames.length}:v=1:a=0,scale=${SHEET_CELL_WIDTH}:-2,` +
    `tile=${cols}x${rows}:padding=6:margin=6[sheet]`;
  return [
    ...QUIET,
    "-y",
    ...inputs,
    "-filter_complex",
    filter,
    "-map",
    "[sheet]",
    "-frames:v",
    "1",
    "-q:v",
    "4",
    "-update",
    "1",
    out,
  ];
}

/** Our own files in a frames directory. Nothing else in it is ever removed. */
function clearFrames(dir: string): void {
  for (let i = 0; i < 99; i++) rmSync(join(dir, frameName(i)), { force: true });
  rmSync(join(dir, SHEET_FILE), { force: true });
  rmSync(join(dir, FRAMES_INDEX), { force: true });
}

async function exportFrames(
  deps: AnalyzeDeps,
  file: string,
  dir: string,
  picks: FramePick[],
  width: number,
): Promise<Frame[]> {
  const frames: Frame[] = [];
  let lastError = "";
  for (const pick of picks) {
    const name = frameName(frames.length);
    const path = join(dir, name);
    const result = await deps.run("ffmpeg", frameArgs(file, pick.timeSec, width, path));
    // A timestamp past the last frame exits 0 and writes nothing: skip it.
    if (result.code !== 0 || !existsSync(path)) {
      lastError = lastLine(result.stderr) || lastError;
      rmSync(path, { force: true });
      continue;
    }
    frames.push({ file: name, path, ...pick });
  }
  if (frames.length === 0) {
    throw new Error(`ffmpeg exported no frame${lastError ? `: ${lastError}` : ""}`);
  }
  return frames;
}

/** Tiles the frames into one image. Returns its path, or null if ffmpeg could not. */
async function buildSheet(deps: AnalyzeDeps, dir: string, frames: Frame[]): Promise<string | null> {
  const out = join(dir, SHEET_FILE);
  const result = await deps.run(
    "ffmpeg",
    sheetArgs(
      frames.map((f) => f.path),
      out,
    ),
  );
  if (result.code !== 0 || !existsSync(out)) {
    rmSync(out, { force: true });
    return null;
  }
  return out;
}

// --- audio -------------------------------------------------------------------

export function audioArgs(file: string): string[] {
  const filter = `silencedetect=noise=${SILENCE_NOISE_DB}dB:d=${SILENCE_MIN_SEC},volumedetect`;
  // Both filters report at log level info, on stderr.
  return [
    "-hide_banner",
    "-nostdin",
    "-nostats",
    "-i",
    file,
    "-vn",
    "-sn",
    "-dn",
    "-af",
    filter,
    "-f",
    "null",
    "-",
  ];
}

export function parseAudio(stderr: string, durationSec: number | null): AudioFacts {
  const number = (re: RegExp): number | null => {
    const m = stderr.match(re);
    const n = m ? Number(m[1]) : Number.NaN;
    return Number.isFinite(n) ? n : null;
  };
  let silence = 0;
  for (const m of stderr.matchAll(/silence_duration:\s*([0-9.]+)/g)) silence += Number(m[1]);
  const mean = number(/mean_volume:\s*(-?[0-9.]+)\s*dB/);
  const max = number(/max_volume:\s*(-?[0-9.]+)\s*dB/);
  // Neither filter reported anything: unknown, not "no silence".
  const measured = /mean_volume:|silence_duration:/.test(stderr);
  const known = durationSec !== null && durationSec > 0;
  const silenceSec = known ? Math.min(silence, durationSec) : silence;
  return {
    hasAudio: true,
    meanVolumeDb: mean,
    maxVolumeDb: max,
    silenceSec: measured ? round(silenceSec) : null,
    silenceRatio: measured && known ? round(silenceSec / durationSec, 3) : null,
  };
}

const NO_AUDIO: AudioFacts = {
  hasAudio: false,
  meanVolumeDb: null,
  maxVolumeDb: null,
  silenceSec: null,
  silenceRatio: null,
};

/** Never fails the analysis: audio that cannot be measured is reported as unknown. */
async function measureAudio(
  deps: AnalyzeDeps,
  file: string,
  media: MediaInfo,
): Promise<AudioFacts> {
  if (!media.hasAudio) return NO_AUDIO;
  try {
    const result = await deps.run("ffmpeg", audioArgs(file));
    if (result.code !== 0) return { ...NO_AUDIO, hasAudio: true };
    return parseAudio(result.stderr, media.durationSec);
  } catch {
    return { ...NO_AUDIO, hasAudio: true };
  }
}

// --- one file ----------------------------------------------------------------

/**
 * Analyzes one file and writes frames, the optional sheet and frames.json
 * into `framesDir`. Knows nothing about the database.
 */
export async function analyzeFile(
  file: string,
  framesDir: string,
  identity: { videoId: string | null; shortcode: string },
  options: Partial<AnalyzeOptions> = {},
  overrides: Partial<AnalyzeDeps> = {},
): Promise<FramesIndex> {
  const deps = { ...defaults, ...overrides };
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const dir = resolve(framesDir);

  const media = parseProbe((await must(deps, "ffprobe", probeArgs(file))).stdout);
  if (!media.hasVideo) throw new Error("the file has no video stream");

  const scenes = await must(deps, "ffmpeg", sceneArgs(file, opts.threshold));
  const cutTimes = mergeCuts(parseScenes(scenes.stdout), opts.minGapSec);
  const stats = shotStats(cutTimes, media.durationSec);
  const audio = await measureAudio(deps, file, media);

  mkdirSync(dir, { recursive: true });
  clearFrames(dir);
  const picks = pickFrames(media.durationSec, cutTimes, { maxFrames: opts.maxFrames });
  const frames = await exportFrames(deps, file, dir, picks, opts.frameWidth);
  const sheet = opts.sheet ? await buildSheet(deps, dir, frames) : null;

  const index: FramesIndex = {
    version: 1,
    videoId: identity.videoId,
    shortcode: identity.shortcode,
    source: file,
    analyzedAt: new Date().toISOString(),
    durationSec: media.durationSec,
    width: media.width,
    height: media.height,
    ...stats,
    cutTimes,
    audio,
    framesDir: dir,
    frames,
    sheet,
    threshold: opts.threshold,
    minGapSec: opts.minGapSec,
  };
  atomicWriteJson(join(dir, FRAMES_INDEX), index);
  return index;
}

/**
 * Reads frames.json. Paths are rebuilt from the directory it was found in, so
 * a media directory that was moved still resolves. Null when absent or invalid.
 */
export function readFramesIndex(framesDir: string): FramesIndex | null {
  const dir = resolve(framesDir);
  try {
    const parsed = FramesIndexSchema.safeParse(
      JSON.parse(readFileSync(join(dir, FRAMES_INDEX), "utf8")),
    );
    if (!parsed.success) return null;
    const index = parsed.data;
    return {
      ...index,
      framesDir: dir,
      frames: index.frames.map((f) => ({ ...f, path: join(dir, safeSegment(f.file)) })),
      sheet: index.sheet && existsSync(join(dir, SHEET_FILE)) ? join(dir, SHEET_FILE) : null,
    };
  } catch {
    return null;
  }
}

// --- a batch of stored videos ------------------------------------------------

/** Shortcodes come from upstream; never let one steer the path. */
function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_");
  return /^\.*$/.test(cleaned) ? "_" : cleaned;
}

export function framesDirFor(mediaDir: string, shortcode: string): string {
  return join(resolve(mediaDir), "frames", safeSegment(shortcode));
}

export type AnalyzeStatus = "analyzed" | "skipped" | "not-downloaded" | "failed";

export type AnalyzeItem = {
  id: string | null;
  shortcode: string;
  creatorUsername: string | null;
  status: AnalyzeStatus;
  reason: string | null;
  analysis: Analysis | null;
};

export type AnalyzeSummary = {
  analyzed: number;
  skipped: number;
  notDownloaded: number;
  failed: number;
  items: AnalyzeItem[];
};

export type AnalyzeEnv = {
  store: Store;
  mediaDir: string;
  /** Progress lines. Goes to stderr; silent in machine mode. */
  log: (message: string) => void;
};

export type AnalyzeRequest = {
  /** Stored videos (from a selection) or raw targets: media id, shortcode or reel URL. */
  targets: (StoredVideo | string)[];
  force: boolean;
  options?: Partial<AnalyzeOptions>;
};

const toAnalysis = (index: FramesIndex): Analysis => AnalysisSchema.parse(index);
const errorText = (err: unknown): string =>
  oneLine(err instanceof Error ? err.message : String(err));

/**
 * Analyzes stored videos one after another. Only files already on disk are
 * touched; nothing here makes a network request. One failure does not stop
 * the batch.
 */
export async function analyzeVideos(
  env: AnalyzeEnv,
  request: AnalyzeRequest,
  overrides: Partial<AnalyzeDeps> = {},
): Promise<AnalyzeSummary> {
  const deps = { ...defaults, ...overrides };
  const opts = { ...DEFAULT_OPTIONS, ...request.options };
  const summary: AnalyzeSummary = {
    analyzed: 0,
    skipped: 0,
    notDownloaded: 0,
    failed: 0,
    items: [],
  };

  const one = async (target: StoredVideo | string): Promise<AnalyzeItem> => {
    let video: StoredVideo | null;
    if (typeof target === "string") {
      const shortcode = parseShortcode(target);
      video =
        env.store.findVideo(target.trim()) ?? (shortcode ? env.store.findVideo(shortcode) : null);
      if (!video) {
        return {
          id: null,
          shortcode: shortcode ?? oneLine(target),
          creatorUsername: null,
          status: shortcode ? "not-downloaded" : "failed",
          reason: shortcode
            ? "not stored locally; download it first"
            : "not a stored video id, and not a shortcode or reel URL",
          analysis: null,
        };
      }
    } else {
      video = target;
    }
    const base = {
      id: video.id,
      shortcode: video.shortcode,
      creatorUsername: video.creatorUsername,
    };
    if (!video.localPath || !existsSync(video.localPath)) {
      return {
        ...base,
        status: "not-downloaded",
        reason: video.localPath
          ? "the downloaded file is gone; download it again"
          : "not downloaded yet",
        analysis: null,
      };
    }

    const dir = framesDirFor(env.mediaDir, video.shortcode);
    if (!request.force && video.analyzedAt) {
      const stored = readFramesIndex(video.framesDir ?? dir);
      if (stored?.frames.every((f) => existsSync(f.path))) {
        // A sheet asked for later is built from the frames already there.
        if (opts.sheet && !stored.sheet) {
          stored.sheet = await buildSheet(deps, stored.framesDir, stored.frames).catch(() => null);
          if (stored.sheet) atomicWriteJson(join(stored.framesDir, FRAMES_INDEX), stored);
        }
        return {
          ...base,
          status: "skipped",
          reason: "already analyzed; use --force to analyze again",
          analysis: toAnalysis(stored),
        };
      }
    }

    try {
      const index = await analyzeFile(
        video.localPath,
        dir,
        { videoId: video.id, shortcode: video.shortcode },
        opts,
        deps,
      );
      if (video.durationSec === null || video.width === null || video.height === null) {
        env.store.setVideoMedia(video.id, {
          durationSec: video.durationSec === null ? index.durationSec : null,
          width: video.width === null ? index.width : null,
          height: video.height === null ? index.height : null,
        });
      }
      env.store.setVideoAnalysis(video.id, {
        cuts: index.cuts,
        cutsPerMin: index.cutsPerMin,
        framesDir: index.framesDir,
      });
      return { ...base, status: "analyzed", reason: null, analysis: toAnalysis(index) };
    } catch (err) {
      return { ...base, status: "failed", reason: errorText(err), analysis: null };
    }
  };

  const total = request.targets.length;
  for (const [i, target] of request.targets.entries()) {
    const item = await one(target);
    summary.items.push(item);
    if (item.status === "analyzed") summary.analyzed++;
    else if (item.status === "skipped") summary.skipped++;
    else if (item.status === "not-downloaded") summary.notDownloaded++;
    else summary.failed++;
    const who = `${item.creatorUsername ?? "?"}/${item.shortcode}`;
    const outcome = item.analysis
      ? `${item.status}: ${item.analysis.cuts} cuts, ${item.analysis.frames.length} frames`
      : `${item.status}: ${item.reason}`;
    env.log(`${i + 1}/${total} ${who} ${outcome}`);
  }
  return summary;
}

/** Whether both tools can be found. Checked once before a batch, not per video. */
export function missingTools(overrides: Partial<AnalyzeDeps> = {}): Tool[] {
  const deps = { ...defaults, ...overrides };
  return (["ffmpeg", "ffprobe"] as const).filter((tool) => !deps.hasTool(tool));
}
