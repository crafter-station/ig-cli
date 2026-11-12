// How reels are made: editing pace and key frames, measured from downloaded
// files with ffmpeg. The commands stay thin; the work is in core/analyze.ts.

import { z } from "zod";
import { bold, danger, dim, muted, warn } from "../cligentic/platform/style.js";
import {
  AnalysisSchema,
  type AnalyzeDeps,
  type AnalyzeItem,
  AudioFactsSchema,
  analyzeVideos,
  DEFAULT_FRAME_WIDTH,
  DEFAULT_MAX_FRAMES,
  DEFAULT_MIN_GAP_SEC,
  DEFAULT_THRESHOLD,
  FrameSchema,
  missingTools,
  readFramesIndex,
} from "../core/analyze.js";
import { median, rankVideos } from "../core/ranking.js";
import { findStoredVideo, isSafeShortcode } from "../core/targets.js";
import type { RankedVideo } from "../core/types.js";
import { defineCommand, flags } from "../lib/command.js";
import { IgError } from "../lib/errors.js";
import { compact, duration, multiple } from "../lib/format.js";
import { type NextStep, oneLine } from "../lib/output.js";
import { printTable, renderRecord } from "../lib/table.js";
import { addSelectionOptions, resolveSelection, selectionFlags } from "./selection.js";

/** Tests replace the ffmpeg runner here; the CLI leaves it empty. */
export const analyzeSeams: { deps: Partial<AnalyzeDeps> } = { deps: {} };

const seconds = (n: number | null | undefined): string =>
  n === null || n === undefined ? "–" : `${n < 10 ? n.toFixed(1) : Math.round(n)}s`;

/**
 * One character per slice of the video; a bar where at least one cut falls.
 *   0:00 ────│──│─│───── 0:13
 */
export function timeline(cutTimes: number[], durationSec: number | null, width = 48): string {
  if (durationSec === null || durationSec <= 0) return "";
  const cells = new Array<string>(width).fill("─");
  for (const t of cutTimes) {
    const i = Math.min(width - 1, Math.max(0, Math.floor((t / durationSec) * width)));
    cells[i] = "│";
  }
  return cells.join("");
}

function requireTools(): void {
  const missing = missingTools(analyzeSeams.deps);
  if (missing.length > 0) {
    throw new IgError("UNSUPPORTED", `${missing.join(" and ")} not found on PATH.`, {
      hint: "Install ffmpeg (https://ffmpeg.org/download.html), then check with `ig doctor`.",
    });
  }
}

// --- video analyze -----------------------------------------------------------

const AnalyzeItemSchema = z.object({
  id: z.string().nullable(),
  shortcode: z.string(),
  creatorUsername: z.string().nullable(),
  status: z.enum(["analyzed", "skipped", "not-downloaded", "failed"]),
  reason: z.string().nullable().describe("Why it was skipped, not analyzed or failed"),
  analysis: AnalysisSchema.nullable().describe("Present when analyzed or skipped"),
});

function printAnalysis(item: AnalyzeItem): void {
  const who = `${oneLine(item.creatorUsername) || "?"}/${oneLine(item.shortcode)}`;
  const a = item.analysis;
  if (!a) {
    const label = item.status === "failed" ? danger("failed") : warn(item.status);
    process.stdout.write(`${bold(who)}  ${label}  ${oneLine(item.reason)}\n`);
    return;
  }
  const size = a.width && a.height ? ` · ${a.width}x${a.height}` : "";
  const tag = item.status === "skipped" ? `  ${muted("(already analyzed)")}` : "";
  process.stdout.write(`${bold(who)}  ${muted(`${duration(a.durationSec)}${size}`)}${tag}\n`);

  const pace =
    a.cuts === 0
      ? "no cuts: one continuous shot"
      : `${bold(String(a.cuts))} cuts · ${bold(String(a.cutsPerMin ?? "–"))}/min · ` +
        `shots avg ${seconds(a.avgShotSec)}, median ${seconds(a.medianShotSec)} · ` +
        `opening holds ${bold(seconds(a.firstShotSec))}`;
  const bar = timeline(a.cutTimes, a.durationSec);
  const audio = !a.audio.hasAudio
    ? "no audio stream"
    : a.audio.meanVolumeDb === null
      ? "could not be measured"
      : `${a.audio.meanVolumeDb} dB mean · ${
          a.audio.silenceRatio === null ? "–" : `${Math.round(a.audio.silenceRatio * 100)}%`
        } silence`;
  const pairs: [string, string][] = [["pace", pace]];
  if (bar) pairs.push(["cuts", `${muted("0:00")} ${bar} ${muted(duration(a.durationSec))}`]);
  pairs.push(["audio", audio], ["frames", `${a.frames.length} in ${a.framesDir}`]);
  if (a.sheet) pairs.push(["sheet", a.sheet]);
  process.stdout.write(
    `${renderRecord(pairs)
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n")}\n`,
  );
}

const analyze = defineCommand({
  id: "video.analyze",
  summary: "Measure how downloaded reels are edited and export key frames",
  description:
    "Runs ffmpeg on files already on disk; no request to Instagram. Counts hard\n" +
    "cuts (editing pace), measures shot lengths and how long the opening shot\n" +
    "holds, and exports JPEG key frames to <mediaDir>/frames/<shortcode>/ with a\n" +
    "frames.json index: the first frame, one after each cut, evenly spaced ones\n" +
    "when cuts are few. Open the frames (or the --sheet contact sheet) to see the\n" +
    "format. Dissolves are not counted as cuts; jump cuts inside the same framing\n" +
    "are partly missed at the default threshold (try --threshold 0.2).\n" +
    "Give shortcodes, or select: --top N (ranked), --niche / --creator (every\n" +
    "downloaded video in scope), --all-downloaded.",
  input: z.object({
    ...selectionFlags,
    force: flags.force.describe("Analyze again even if already analyzed"),
    threshold: z.coerce
      .number()
      .min(0.01)
      .max(0.99)
      .default(DEFAULT_THRESHOLD)
      .describe("Scene score (0 to 1) a frame must exceed to count as a cut. Lower finds more"),
    minGap: z.coerce
      .number()
      .min(0)
      .max(10)
      .default(DEFAULT_MIN_GAP_SEC)
      .describe("Seconds. Detections closer than this count as one cut"),
    maxFrames: z.coerce.number().int().min(1).max(60).default(DEFAULT_MAX_FRAMES),
    frameWidth: z.coerce
      .number()
      .int()
      .min(64)
      .max(2160)
      .default(DEFAULT_FRAME_WIDTH)
      .describe("Maximum frame width in pixels. Never upscales"),
    sheet: z.boolean().default(false).describe("Also tile the frames into one sheet.jpg"),
  }),
  output: z.object({
    analyzed: z.number().int(),
    skipped: z.number().int(),
    notDownloaded: z.number().int(),
    failed: z.number().int(),
    items: z.array(AnalyzeItemSchema),
  }),
  network: false,
  writes: "local",
  configure: (cmd) =>
    addSelectionOptions(cmd)
      .option("--force", "analyze again even if already analyzed")
      .option("--threshold <score>", `scene score for a cut, 0 to 1 (default ${DEFAULT_THRESHOLD})`)
      .option(
        "--min-gap <sec>",
        `merge detections closer than this (default ${DEFAULT_MIN_GAP_SEC})`,
      )
      .option("--max-frames <n>", `key frames per video (default ${DEFAULT_MAX_FRAMES})`)
      .option("--frame-width <px>", `maximum frame width (default ${DEFAULT_FRAME_WIDTH})`)
      .option("--sheet", "also tile the frames into one contact sheet"),
  args: ([targets]) => ({ targets }),
  handler: async (input, ctx) => {
    const { targets, emptySteps, scope } = resolveSelection(ctx, input, "analyze");
    const nextSteps: NextStep[] = [...emptySteps];
    if (targets.length === 0 && input.targets.length === 0 && input.top === undefined) {
      nextSteps.push({
        command: `ig video download --top 10${scope}`,
        description: "nothing is downloaded in this scope yet",
      });
    }

    if (targets.length > 0) requireTools();
    const summary = await analyzeVideos(
      { store: ctx.store, mediaDir: ctx.mediaDir, log: ctx.log },
      {
        targets,
        force: input.force,
        options: {
          threshold: input.threshold,
          minGapSec: input.minGap,
          maxFrames: input.maxFrames,
          frameWidth: input.frameWidth,
          sheet: input.sheet,
        },
      },
      analyzeSeams.deps,
    );

    // Every item failing is a failure, not a success envelope with bad news inside.
    if (summary.items.length > 0 && summary.failed === summary.items.length) {
      const first = summary.items[0];
      throw new IgError(
        "ANALYSIS_FAILED",
        summary.failed === 1
          ? `Could not analyze ${first?.shortcode}: ${first?.reason}`
          : `None of the ${summary.failed} videos could be analyzed. First reason: ${first?.reason}`,
        {
          hint: "Check `ig doctor` for ffmpeg. The reason for each video is in details.items.",
          details: { ...summary },
        },
      );
    }

    const missing = summary.items
      .filter((i) => i.status === "not-downloaded" && isSafeShortcode(i.shortcode))
      .map((i) => i.shortcode);
    if (missing.length > 0) {
      const shown = missing.slice(0, 20);
      nextSteps.push({
        command: `ig video download ${shown.join(" ")}`,
        description:
          missing.length > shown.length
            ? `download first (${missing.length} are not on disk), then analyze again`
            : "download first, then analyze again",
      });
    }
    const done = summary.items.find((i) => i.analysis && isSafeShortcode(i.shortcode));
    if (done) {
      nextSteps.push({
        command: `ig video frames ${done.shortcode}`,
        description: "list the key frames to look at",
      });
      if (input.niche) {
        nextSteps.push({
          command: `ig niche pace ${input.niche}`,
          description: "editing pace against performance",
        });
      }
    }
    if (summary.failed > 0) {
      nextSteps.push({ command: "ig doctor", description: "check ffmpeg and ffprobe" });
    }
    return { data: summary, nextSteps };
  },
  human: (data) => {
    if (data.items.length === 0) {
      process.stderr.write(`${muted("Nothing to analyze.")}\n`);
      return;
    }
    for (const [i, item] of data.items.entries()) {
      if (i > 0) process.stdout.write("\n");
      printAnalysis(item);
    }
    if (data.items.length > 1) {
      const counts = [
        `${data.analyzed} analyzed`,
        `${data.skipped} skipped`,
        `${data.notDownloaded} not downloaded`,
        data.failed > 0 ? danger(`${data.failed} failed`) : "0 failed",
      ].join(", ");
      process.stdout.write(`\n${counts}\n`);
    }
  },
});

// --- video frames ------------------------------------------------------------

const frames = defineCommand({
  id: "video.frames",
  summary: "Where a video's key frames are and what each one shows",
  description:
    "Reads the frames.json written by `ig video analyze`. Open the listed JPEGs\n" +
    "(or the contact sheet, which tiles them left to right, top to bottom in the\n" +
    "same order) to see the format of the video.",
  input: z.object({
    video: z.string().describe("Video id, shortcode or reel URL"),
  }),
  output: z.object({
    id: z.string(),
    shortcode: z.string(),
    creatorUsername: z.string(),
    url: z.string(),
    analyzedAt: z.string().nullable(),
    durationSec: z.number().nullable(),
    cuts: z.number().int(),
    cutsPerMin: z.number().nullable(),
    firstShotSec: z.number().nullable(),
    audio: AudioFactsSchema,
    framesDir: z.string(),
    sheet: z.string().nullable().describe("Contact sheet path, when one was made with --sheet"),
    frames: z.array(FrameSchema),
  }),
  network: false,
  writes: "none",
  configure: (cmd) => cmd.argument("<video>", "video id, shortcode or reel URL"),
  args: ([video]) => ({ video }),
  handler: async (input, ctx) => {
    const { video, shortcode } = findStoredVideo(ctx.store, input.video);
    if (!video) {
      throw new IgError("NOT_FOUND", `No stored video matches ${oneLine(input.video)}.`, {
        hint:
          shortcode && isSafeShortcode(shortcode)
            ? `Run \`ig video download ${shortcode}\`, then \`ig video analyze ${shortcode}\`.`
            : "Give a stored video id, a shortcode or a reel URL.",
      });
    }
    const index = video.framesDir ? readFramesIndex(video.framesDir) : null;
    if (!index) {
      const downloaded = video.localPath !== null;
      throw new IgError(
        "NOT_FOUND",
        video.analyzedAt
          ? `The frames of ${video.shortcode} are no longer on disk.`
          : `${video.shortcode} has not been analyzed yet.`,
        {
          hint: downloaded
            ? `Run \`ig video analyze ${video.shortcode}${video.analyzedAt ? " --force" : ""}\`.`
            : `Run \`ig video download ${video.shortcode}\`, then \`ig video analyze ${video.shortcode}\`.`,
        },
      );
    }
    const nextSteps: NextStep[] = index.sheet
      ? []
      : [
          {
            command: `ig video analyze ${video.shortcode} --sheet`,
            description: "tile these frames into one contact sheet",
          },
        ];
    return {
      data: {
        id: video.id,
        shortcode: video.shortcode,
        creatorUsername: video.creatorUsername,
        url: video.url,
        analyzedAt: video.analyzedAt ?? index.analyzedAt,
        durationSec: index.durationSec,
        cuts: index.cuts,
        cutsPerMin: index.cutsPerMin,
        firstShotSec: index.firstShotSec,
        audio: index.audio,
        framesDir: index.framesDir,
        sheet: index.sheet,
        frames: index.frames,
      },
      nextSteps,
    };
  },
  human: (data) => {
    const pace =
      data.cuts === 0
        ? "no cuts"
        : `${data.cuts} cuts · ${data.cutsPerMin ?? "–"}/min · opening holds ${seconds(data.firstShotSec)}`;
    process.stdout.write(
      `${bold(`${oneLine(data.creatorUsername)}/${oneLine(data.shortcode)}`)}  ${muted(
        `${duration(data.durationSec)} · ${pace}`,
      )}\n`,
    );
    const why = {
      first: "first frame",
      cut: "after a cut",
      interval: "evenly spaced",
    } as const;
    printTable(
      data.frames,
      [
        { header: "#", align: "right", cell: (_f, i) => muted(String(i + 1)) },
        { header: "AT", align: "right", cell: (f) => `${f.timeSec.toFixed(1)}s` },
        { header: "SHOT", align: "right", cell: (f) => String(f.shot) },
        { header: "WHY", cell: (f) => why[f.reason] },
        { header: "FILE", cell: (f) => f.path },
      ],
      "No frames.",
    );
    if (data.sheet) process.stdout.write(`\n${muted("sheet")}  ${data.sheet}\n`);
  },
});

// --- niche pace --------------------------------------------------------------

type Range = { label: string; min: number; max: number };

/** Lower bound inclusive, upper exclusive. */
const CUT_RATE_BUCKETS: Range[] = [
  { label: "no cuts", min: 0, max: 0.0001 },
  { label: "under 10/min", min: 0.0001, max: 10 },
  { label: "10 to 20/min", min: 10, max: 20 },
  { label: "20 to 40/min", min: 20, max: 40 },
  { label: "40/min and up", min: 40, max: Number.POSITIVE_INFINITY },
];
const FIRST_SHOT_BUCKETS: Range[] = [
  { label: "under 1s", min: 0, max: 1 },
  { label: "1 to 2s", min: 1, max: 2 },
  { label: "2 to 4s", min: 2, max: 4 },
  { label: "4 to 8s", min: 4, max: 8 },
  { label: "8s and up", min: 8, max: Number.POSITIVE_INFINITY },
];

const BucketSchema = z.object({
  label: z.string(),
  videos: z.number().int(),
  medianPlays: z.number().nullable(),
  medianOutlierScore: z
    .number()
    .nullable()
    .describe("Median of plays / creator median plays. Above 1 means better than usual"),
  best: z.string().nullable().describe("Shortcode of the best performing video in the bucket"),
});
type Bucket = z.infer<typeof BucketSchema>;

function bucketize(
  rows: { video: RankedVideo; value: number | null }[],
  ranges: Range[],
): Bucket[] {
  return ranges.map((range) => {
    const inside = rows
      .filter((r) => r.value !== null && r.value >= range.min && r.value < range.max)
      .map((r) => r.video);
    const numbers = (pick: (v: RankedVideo) => number | null): number[] =>
      inside.map(pick).filter((n): n is number => n !== null);
    const best = [...inside].sort(
      (a, b) =>
        (b.outlierScore ?? -1) - (a.outlierScore ?? -1) || (b.plays ?? -1) - (a.plays ?? -1),
    )[0];
    return {
      label: range.label,
      videos: inside.length,
      medianPlays: median(numbers((v) => v.plays)),
      medianOutlierScore: median(numbers((v) => v.outlierScore)),
      best: best?.shortcode ?? null,
    };
  });
}

function printBuckets(title: string, buckets: Bucket[]): void {
  process.stdout.write(`${bold(title)}\n`);
  printTable(
    buckets,
    [
      { header: "", cell: (b) => (b.videos === 0 ? dim(b.label) : b.label) },
      {
        header: "VIDEOS",
        align: "right",
        cell: (b) => (b.videos === 0 ? dim("0") : String(b.videos)),
      },
      {
        header: "MEDIAN PLAYS",
        align: "right",
        cell: (b) => (b.medianPlays === null ? dim("–") : compact(Math.round(b.medianPlays))),
      },
      {
        header: "MEDIAN OUTLIER",
        align: "right",
        cell: (b) =>
          b.medianOutlierScore === null ? dim("–") : bold(multiple(b.medianOutlierScore)),
      },
      { header: "BEST", cell: (b) => (b.best ? muted(oneLine(b.best)) : dim("–")) },
    ],
    "No analyzed videos.",
  );
}

/** Below this many analyzed videos the table is an anecdote, and says so. */
const MIN_FOR_PATTERN = 10;

const pace = defineCommand({
  id: "niche.pace",
  summary: "Editing pace against performance across a niche",
  description:
    "Reads the local database only. Groups the niche's analyzed videos by cuts\n" +
    "per minute and by how long the opening shot holds, with the median plays\n" +
    "and median outlier score of each group. Correlation over a few videos is a\n" +
    "hint, not a finding. Videos are analyzed with `ig video analyze`.",
  input: z.object({
    slug: z.string().describe("Niche slug"),
  }),
  output: z.object({
    niche: z.string(),
    videos: z.number().int().describe("Videos stored for the niche"),
    downloaded: z.number().int(),
    analyzed: z.number().int(),
    notAnalyzed: z.number().int().describe("Downloaded but not analyzed yet"),
    notDownloaded: z.number().int(),
    medianCutsPerMin: z.number().nullable(),
    medianFirstShotSec: z.number().nullable(),
    cutsPerMin: z.array(BucketSchema),
    firstShot: z.array(BucketSchema),
  }),
  network: false,
  writes: "none",
  configure: (cmd) => cmd.argument("<slug>"),
  args: ([slug]) => ({ slug }),
  handler: async (input, ctx) => {
    const niche = ctx.store.getNiche(input.slug);
    const creators = ctx.store.listCreators({ niche: niche.slug });
    const all = creators.length === 0 ? [] : ctx.store.listVideos({ niche: niche.slug });
    // Ranked over every stored video: the creator median needs the full set.
    const ranked = rankVideos(
      all,
      new Map(creators.map((c) => [c.id, { followers: c.followers }])),
    );
    const analyzed = ranked.filter((v) => v.analyzedAt !== null && v.cuts !== null);
    const downloaded = all.filter((v) => v.localPath !== null).length;
    const notAnalyzed = all.filter((v) => v.localPath !== null && v.analyzedAt === null).length;

    let firstShotUnknown = 0;
    const firstShots = analyzed.map((video) => {
      // Only cuts and cuts per minute are columns; the rest is in frames.json.
      const index = video.framesDir ? readFramesIndex(video.framesDir) : null;
      const value = index?.firstShotSec ?? (video.cuts === 0 ? video.durationSec : null);
      if (value === null) firstShotUnknown++;
      return { video, value };
    });
    const rates = analyzed.map((video) => ({ video, value: video.cutsPerMin }));
    const known = (rows: { value: number | null }[]): number[] =>
      rows.map((r) => r.value).filter((n): n is number => n !== null);

    const nextSteps: NextStep[] = [];
    if (notAnalyzed > 0) {
      nextSteps.push({
        command: `ig video analyze --niche ${niche.slug}`,
        description: `analyze the ${notAnalyzed} downloaded video(s) not analyzed yet`,
      });
    }
    if (all.length - downloaded > 0) {
      nextSteps.push({
        command: `ig video download --top 10 --niche ${niche.slug}`,
        description: "download more of the niche's best videos to analyze",
      });
    }
    if (all.length === 0) {
      nextSteps.push({
        command: `ig niche refresh ${niche.slug}`,
        description: "fetch reels for every creator in the niche",
      });
    }
    return {
      data: {
        niche: niche.slug,
        videos: all.length,
        downloaded,
        analyzed: analyzed.length,
        notAnalyzed,
        notDownloaded: all.length - downloaded,
        medianCutsPerMin: median(known(rates)),
        medianFirstShotSec: median(known(firstShots)),
        cutsPerMin: bucketize(rates, CUT_RATE_BUCKETS),
        firstShot: bucketize(firstShots, FIRST_SHOT_BUCKETS),
      },
      meta: {
        firstShotUnknown,
        minimumForPattern: MIN_FOR_PATTERN,
        ...(analyzed.length < MIN_FOR_PATTERN
          ? {
              note: `Only ${analyzed.length} analyzed video(s): too few to read a pattern from.`,
            }
          : {}),
      },
      nextSteps,
    };
  },
  human: (data, _ctx, meta) => {
    process.stdout.write(
      `${bold(data.niche)} ${muted(
        `· ${data.analyzed} analyzed of ${data.videos} videos (${data.downloaded} downloaded)`,
      )}\n`,
    );
    if (data.analyzed === 0) {
      process.stderr.write(`${muted("No analyzed videos in this niche yet.")}\n`);
      return;
    }
    process.stdout.write(
      `${muted("median")} ${data.medianCutsPerMin ?? "–"} cuts/min ${muted("· opening holds")} ${seconds(
        data.medianFirstShotSec,
      )}\n\n`,
    );
    printBuckets("Cuts per minute", data.cutsPerMin);
    process.stdout.write("\n");
    printBuckets("Opening shot", data.firstShot);
    if (typeof meta.note === "string") process.stderr.write(`\n${warn(meta.note)}\n`);
    else
      process.stderr.write(
        `\n${muted("Outlier above 1.0x means better than the creator's usual.")}\n`,
      );
  },
});

export const analyzeCommands = [analyze, frames, pace];
