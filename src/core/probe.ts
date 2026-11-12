// Measuring downloaded files with ffprobe: duration and display dimensions.
// Local files only, never the network. The binary sits behind an injectable
// seam, as yt-dlp does in download.ts, so tests need no ffprobe.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { hasCommand } from "../cligentic/platform/detect.js";
import type { Store } from "../db/store.js";
import { IgError } from "../lib/errors.js";
import { duration as formatDuration } from "../lib/format.js";
import { oneLine } from "../lib/output.js";
import type { StoredVideo } from "./types.js";

export type MediaInfo = {
  durationSec: number | null;
  width: number | null;
  height: number | null;
};

export type ProbeDeps = {
  /** Whether ffprobe can be run at all. */
  hasFfprobe: () => boolean;
  /** Measures one local file. Rejects when it is not a readable video. */
  ffprobe: (path: string) => Promise<MediaInfo>;
};

export const FFPROBE_HINT =
  "Install ffmpeg (ffprobe ships with it, https://ffmpeg.org/download.html), then run `ig video probe`.";

const FFPROBE_TIMEOUT_MS = 60_000;

const positive = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Reads ffprobe's `-of json` output. Width and height are what a viewer
 * sees: a stream stored sideways (rotation ±90) has them swapped back.
 */
export function parseFfprobe(json: string): MediaInfo {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    throw new Error("ffprobe returned output that is not JSON");
  }
  const root = (doc !== null && typeof doc === "object" ? doc : {}) as Record<string, unknown>;
  const stream = (Array.isArray(root.streams) ? root.streams[0] : undefined) as
    | Record<string, unknown>
    | undefined;
  if (!stream || typeof stream !== "object") throw new Error("the file has no video stream");

  const format = (root.format ?? {}) as Record<string, unknown>;
  const seconds = positive(format.duration) ?? positive(stream.duration);

  let rotation = 0;
  const sideData = Array.isArray(stream.side_data_list) ? stream.side_data_list : [];
  for (const entry of sideData as Record<string, unknown>[]) {
    const value = Number(entry?.rotation);
    if (Number.isFinite(value) && value !== 0) rotation = value;
  }
  if (rotation === 0) {
    const tag = Number((stream.tags as Record<string, unknown> | undefined)?.rotate);
    if (Number.isFinite(tag)) rotation = tag;
  }
  const sideways = Math.abs(Math.round(rotation)) % 180 === 90;

  const w = positive(stream.width);
  const h = positive(stream.height);
  const width = w === null ? null : Math.round(w);
  const height = h === null ? null : Math.round(h);
  return {
    durationSec: seconds === null ? null : Math.round(seconds * 1000) / 1000,
    width: sideways ? height : width,
    height: sideways ? width : height,
  };
}

/** Runs ffprobe with an argument array, never a shell string. */
export function runFfprobe(path: string): Promise<MediaInfo> {
  return new Promise((done, fail) => {
    const child = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,duration:stream_side_data=rotation:stream_tags=rotate:format=duration",
        "-of",
        "json",
        // Absolute, so a path can never be read as an option.
        resolve(path),
      ],
      {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: FFPROBE_TIMEOUT_MS,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-2000);
    });
    child.on("error", fail);
    child.on("close", (code) => {
      if (code !== 0) {
        const last = stderr.trim().split(/\r?\n/).pop();
        return fail(new Error(last || `ffprobe exited with code ${code}`));
      }
      try {
        done(parseFfprobe(stdout));
      } catch (err) {
        fail(err);
      }
    });
  });
}

export const probeDefaults: ProbeDeps = {
  hasFfprobe: () => hasCommand("ffprobe"),
  ffprobe: runFfprobe,
};

export type ProbeItem = {
  id: string;
  shortcode: string;
  creatorUsername: string;
  status: "measured" | "skipped" | "missing-file" | "failed";
  reason: string | null;
  path: string | null;
  durationSec: number | null;
  width: number | null;
  height: number | null;
};

export type ProbeSummary = {
  measured: number;
  skipped: number;
  missingFile: number;
  failed: number;
  items: ProbeItem[];
};

/** True while the duration or a dimension is still unknown. */
export function needsProbe(v: StoredVideo): boolean {
  return v.durationSec === null || v.width === null || v.height === null;
}

const message = (err: unknown): string => oneLine(err instanceof Error ? err.message : String(err));

/**
 * Measures the local files of `videos` and stores the result. Reads disk
 * only. One bad file fails one item; the batch goes on.
 */
export async function probeVideos(
  env: { store: Store; log: (message: string) => void },
  request: { videos: StoredVideo[]; all: boolean },
  overrides: Partial<ProbeDeps> = {},
): Promise<ProbeSummary> {
  const deps: ProbeDeps = { ...probeDefaults, ...overrides };
  const summary: ProbeSummary = { measured: 0, skipped: 0, missingFile: 0, failed: 0, items: [] };

  const plan = request.videos.map((video) => {
    const present = video.localPath !== null && existsSync(video.localPath);
    const action: ProbeItem["status"] = !present
      ? "missing-file"
      : !request.all && !needsProbe(video)
        ? "skipped"
        : "measured";
    return { video, action };
  });
  const todo = plan.filter((p) => p.action === "measured").length;
  if (todo > 0 && !deps.hasFfprobe()) {
    throw new IgError("UNSUPPORTED", "ffprobe is not installed, so files cannot be measured.", {
      hint: FFPROBE_HINT,
    });
  }

  let position = 0;
  for (const { video, action } of plan) {
    const base = {
      id: video.id,
      shortcode: video.shortcode,
      creatorUsername: video.creatorUsername,
      path: video.localPath,
      durationSec: video.durationSec,
      width: video.width,
      height: video.height,
    };
    if (action === "missing-file") {
      summary.missingFile++;
      summary.items.push({
        ...base,
        status: "missing-file",
        reason:
          video.localPath === null
            ? "not downloaded"
            : "the downloaded file is no longer on disk; download it again",
      });
      continue;
    }
    if (action === "skipped") {
      summary.skipped++;
      summary.items.push({
        ...base,
        status: "skipped",
        reason: "already measured; use --all to measure again",
      });
      continue;
    }

    position++;
    const who = `${position}/${todo} ${video.creatorUsername}/${video.shortcode}`;
    try {
      const info = await deps.ffprobe(video.localPath as string);
      env.store.setVideoMedia(video.id, info);
      summary.measured++;
      summary.items.push({
        ...base,
        status: "measured",
        reason: null,
        // A null measurement leaves the stored value in place.
        durationSec: info.durationSec ?? video.durationSec,
        width: info.width ?? video.width,
        height: info.height ?? video.height,
      });
      const size =
        info.width !== null && info.height !== null ? `${info.width}x${info.height}` : "–";
      env.log(`${who} ${formatDuration(info.durationSec)} ${size}`);
    } catch (err) {
      const reason = message(err);
      summary.failed++;
      summary.items.push({ ...base, status: "failed", reason });
      env.log(`${who} failed: ${reason}`);
    }
  }
  return summary;
}
