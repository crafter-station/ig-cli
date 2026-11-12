// Measuring downloaded files with ffprobe: duration and display dimensions.
// Local files only, never the network. The binary sits behind an injectable
// seam, as yt-dlp does in download.ts, so tests need no ffprobe.

import { existsSync } from "node:fs";
import type { Store } from "../db/store.js";
import { IgError } from "../lib/errors.js";
import { duration as formatDuration } from "../lib/format.js";
import { errorLine } from "../lib/output.js";
import { hasTool, type MediaProbe, probeFile, type Runner } from "./ffmpeg.js";
import type { StoredVideo } from "./types.js";

/** What is stored about a file: duration and display dimensions. */
export type MediaInfo = Pick<MediaProbe, "durationSec" | "width" | "height">;

export type ProbeDeps = {
  /** Whether ffprobe can be run at all. */
  hasFfprobe: () => boolean;
  /** Measures one local file. Rejects when it is not a readable video. */
  ffprobe: (path: string) => Promise<MediaInfo>;
};

export const FFPROBE_HINT =
  "Install ffmpeg (ffprobe ships with it, https://ffmpeg.org/download.html), then run `ig video probe`.";

/** The part of a probe that is stored. Throws when the file is not a video. */
export function toMediaInfo(probe: MediaProbe): MediaInfo {
  if (!probe.hasVideo) throw new Error("the file has no video stream");
  return { durationSec: probe.durationSec, width: probe.width, height: probe.height };
}

/** Duration and display dimensions of one local video file. */
export async function measureFile(path: string, run?: Runner): Promise<MediaInfo> {
  return toMediaInfo(await probeFile(path, run));
}

export const probeDefaults: ProbeDeps = {
  hasFfprobe: () => hasTool("ffprobe"),
  ffprobe: (path) => measureFile(path),
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
      const reason = errorLine(err);
      summary.failed++;
      summary.items.push({ ...base, status: "failed", reason });
      env.log(`${who} failed: ${reason}`);
    }
  }
  return summary;
}
