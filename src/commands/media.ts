// Measuring downloaded files, and what repeats across a niche: hashtags,
// sounds and lengths. Everything here reads the local database and local
// files only; nothing spends a backend request.

import { existsSync } from "node:fs";
import type { Command } from "commander";
import { z } from "zod";
import { bold, danger, dim, muted, ok, warn } from "../cligentic/platform/style.js";
import type { Context } from "../context.js";
import {
  AGGREGATE_SORTS,
  type AggregateSort,
  audioStats,
  durationStats,
  type GroupStats,
  tagStats,
} from "../core/aggregate.js";
import { sinceCutoff } from "../core/filters.js";
import { type ProbeItem, probeVideos } from "../core/probe.js";
import { MIN_VIDEOS_FOR_OUTLIER, rankVideos } from "../core/ranking.js";
import { isSafeShortcode } from "../core/targets.js";
import { normalizeUsername, type RankedVideo } from "../core/types.js";
import { defineCommand, flags } from "../lib/command.js";
import { compact, duration, multiple } from "../lib/format.js";
import { type Meta, type NextStep, oneLine } from "../lib/output.js";
import { type Column, printTable } from "../lib/table.js";

const note = (text: string): void => {
  process.stderr.write(`${muted(text)}\n`);
};

// --- ig video probe ----------------------------------------------------------

const ProbeItemSchema = z.object({
  id: z.string(),
  shortcode: z.string(),
  creatorUsername: z.string(),
  status: z.enum(["measured", "skipped", "missing-file", "failed"]),
  reason: z.string().nullable().describe("Why it was skipped, missing or failed"),
  path: z.string().nullable().describe("The file that was, or should have been, measured"),
  durationSec: z.number().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
});

const probe = defineCommand({
  id: "video.probe",
  summary: "Measure duration and dimensions of downloaded videos",
  description:
    "Runs ffprobe on files already on disk and stores duration, width and height.\n" +
    "No network. Only videos missing a value are measured unless --all.\n" +
    "`ig video download` measures new files by itself; this fills in older ones.",
  input: z.object({
    niche: flags.niche,
    creator: z.string().optional().describe("Only this creator"),
    all: z.boolean().default(false).describe("Measure again even if already measured"),
  }),
  output: z.object({
    measured: z.number().int(),
    skipped: z.number().int().describe("Already measured"),
    missingFile: z.number().int().describe("Marked as downloaded but the file is gone"),
    failed: z.number().int().describe("ffprobe could not read the file"),
    items: z.array(ProbeItemSchema),
  }),
  network: false,
  writes: "local",
  configure: (cmd) =>
    cmd
      .option("--niche <slug>", "only this niche")
      .option("--creator <username>", "only this creator")
      .option("--all", "measure again even if already measured"),
  handler: async (input, ctx) => {
    if (input.niche) ctx.store.getNiche(input.niche);
    const creator = input.creator
      ? ctx.store.getCreator(normalizeUsername(input.creator))
      : undefined;
    const scope =
      (input.niche ? ` --niche ${input.niche}` : "") +
      (creator ? ` --creator ${creator.username}` : "");
    const videos =
      creator && input.niche && !creator.niches.includes(input.niche)
        ? []
        : ctx.store.listVideos({
            niche: input.niche,
            creatorId: creator?.id,
            downloaded: true,
          });

    const summary = await probeVideos(
      { store: ctx.store, log: ctx.log },
      { videos, all: input.all },
    );

    const nextSteps: NextStep[] = [];
    if (videos.length === 0) {
      nextSteps.push({
        command: `ig video download --top 10${scope}`,
        description: "nothing is downloaded in this scope; downloading also measures",
      });
    }
    const gone = summary.items.find(
      (i) => i.status === "missing-file" && isSafeShortcode(i.shortcode),
    );
    if (gone) {
      nextSteps.push({
        command: `ig video download ${gone.shortcode} --force`,
        description: "download a missing file again",
      });
    }
    if (summary.measured > 0 || summary.skipped > 0) {
      const slug = input.niche ?? creator?.niches[0] ?? ctx.store.listNiches()[0]?.slug;
      if (slug) {
        nextSteps.push({
          command: `ig niche durations ${slug}`,
          description: "which lengths perform best in this niche",
        });
      }
    }
    return { data: summary, meta: { downloadedVideos: videos.length }, nextSteps };
  },
  human: (data) => {
    if (data.items.length === 0) {
      note("No downloaded videos in this scope.");
      return;
    }
    const label: Record<ProbeItem["status"], string> = {
      measured: ok("measured"),
      skipped: muted("skipped"),
      "missing-file": warn("missing file"),
      failed: danger("failed"),
    };
    // Already-measured rows are only counted: a long list of them says nothing.
    const shown = data.items.filter((i) => i.status !== "skipped");
    if (shown.length > 0) {
      printTable(
        shown,
        [
          { header: "", cell: (i) => label[i.status] },
          {
            header: "VIDEO",
            cell: (i) => `${oneLine(i.creatorUsername)}/${oneLine(i.shortcode)}`,
            maxWidth: 40,
          },
          {
            header: "LEN",
            align: "right",
            cell: (i) => (i.durationSec === null ? dim("–") : duration(i.durationSec)),
          },
          {
            header: "SIZE",
            align: "right",
            cell: (i) => (i.width && i.height ? `${i.width}x${i.height}` : dim("–")),
          },
          {
            header: "DETAIL",
            cell: (i) => (i.status === "measured" ? dim("–") : oneLine(i.reason) || dim("–")),
            maxWidth: 70,
          },
        ],
        "",
      );
      process.stdout.write("\n");
    }
    process.stdout.write(
      `${[
        `${data.measured} measured`,
        `${data.skipped} already measured`,
        data.missingFile > 0
          ? warn(`${data.missingFile} missing file`)
          : `${data.missingFile} missing file`,
        data.failed > 0 ? danger(`${data.failed} failed`) : "0 failed",
      ].join(", ")}\n`,
    );
  },
});

// --- niche aggregations ------------------------------------------------------

type Scope = {
  slug: string;
  /** Ranked over every stored video of the niche, then cut by --since. */
  videos: RankedVideo[];
  videosInNiche: number;
};

/**
 * Outlier scores need each creator's full set, so ranking happens before the
 * `--since` cut, exactly as in `ig video top`.
 */
function nicheScope(ctx: Context, slug: string, since: string | undefined): Scope {
  const cutoff = sinceCutoff(since);
  const niche = ctx.store.getNiche(slug);
  const creators = ctx.store.listCreators({ niche: niche.slug });
  const all = creators.length === 0 ? [] : ctx.store.listVideos({ niche: niche.slug });
  const ranked = rankVideos(all, new Map(creators.map((c) => [c.id, { followers: c.followers }])));
  const videos =
    cutoff === null
      ? ranked
      : ranked.filter((v) => v.takenAt !== null && Date.parse(v.takenAt) >= (cutoff as number));
  return { slug: niche.slug, videos, videosInNiche: all.length };
}

const sinceFlag = (since: string | undefined): string => (since ? ` --since ${since.trim()}` : "");

/** Where to get data when the niche, or the window, holds no videos at all. */
function emptyScopeSteps(scope: Scope, since: string | undefined): NextStep[] {
  if (scope.videosInNiche === 0) {
    return [
      {
        command: `ig niche refresh ${scope.slug}`,
        description: "this niche has no stored videos; fetch reels for its creators",
      },
    ];
  }
  if (scope.videos.length === 0 && since) {
    return [
      {
        command: `ig niche refresh ${scope.slug}`,
        description: `no stored video is newer than ${oneLine(since)}; fetch recent reels or widen --since`,
      },
    ];
  }
  return [];
}

const StatsShape = {
  videos: z.number().int().describe("Videos in this group"),
  creators: z.number().int().describe("Distinct creators in this group"),
  medianPlays: z.number().nullable().describe("Median plays of the group. Null without counts"),
  medianOutlier: z
    .number()
    .nullable()
    .describe(
      "Median outlier score of the group: 1.0 is a usual video for its creator. Null when no video has a score",
    ),
  bestShortcode: z
    .string()
    .nullable()
    .describe("The group's video with the highest outlier score, or most plays without scores"),
  bestCreator: z.string().nullable(),
  bestPlays: z.number().int().nullable(),
  bestOutlier: z.number().nullable(),
};

const aggregateInput = (minVideos: number) =>
  z.object({
    slug: z.string(),
    sort: z
      .enum(AGGREGATE_SORTS)
      .default("videos")
      .describe("videos: most used. outlier: best median outlier score. creators. plays: median"),
    minVideos: z.coerce
      .number()
      .int()
      .min(1)
      .default(minVideos)
      .describe("Drop groups with fewer videos than this"),
    limit: flags.limit(30),
    since: z.string().optional().describe("Only videos newer than this: 30d, 12h, 2w or a date"),
  });

const aggregateOptions = (minVideos: number) => (cmd: Command) =>
  cmd
    .argument("<slug>")
    .option("--sort <key>", "videos | outlier | creators | plays (default videos)")
    .option("--min-videos <n>", `drop groups with fewer videos (default ${minVideos})`)
    .option("--limit <n>", "maximum results (default 30)")
    .option("--since <when>", "only videos newer than 30d, 12h, 2w or a date");

function statColumns<T extends GroupStats>(sort: AggregateSort | null): Column<T>[] {
  const head = (name: string, key: AggregateSort) => (sort === key ? `${name} ↓` : name);
  const strong = (text: string, key: AggregateSort) =>
    text === "–" ? dim(text) : sort === key ? bold(text) : text;
  return [
    {
      header: head("VIDEOS", "videos"),
      align: "right",
      cell: (r) => strong(String(r.videos), "videos"),
    },
    {
      header: head("CREATORS", "creators"),
      align: "right",
      cell: (r) => strong(String(r.creators), "creators"),
    },
    {
      header: head("MED PLAYS", "plays"),
      align: "right",
      cell: (r) =>
        strong(compact(r.medianPlays === null ? null : Math.round(r.medianPlays)), "plays"),
    },
    {
      header: head("MED OUTLIER", "outlier"),
      align: "right",
      cell: (r) => strong(multiple(r.medianOutlier), "outlier"),
    },
    {
      header: "BEST VIDEO",
      cell: (r) =>
        r.bestShortcode === null
          ? dim("–")
          : `${oneLine(r.bestCreator)}/${oneLine(r.bestShortcode)}${
              r.bestOutlier !== null
                ? muted(` ${multiple(r.bestOutlier)}`)
                : r.bestPlays !== null
                  ? muted(` ${compact(r.bestPlays)} plays`)
                  : ""
            }`,
      maxWidth: 44,
    },
  ];
}

/** Says why every outlier column is empty, so a dash does not look like a bug. */
function outlierNote(rows: GroupStats[]): void {
  if (rows.length > 0 && rows.every((r) => r.medianOutlier === null)) {
    note(
      `No outlier scores: a creator needs at least ${MIN_VIDEOS_FOR_OUTLIER} videos with play counts.`,
    );
  }
}

const TagRowSchema = z.object({
  tag: z.string().describe("Lowercase, without #"),
  ...StatsShape,
});

const tags = defineCommand({
  id: "niche.tags",
  summary: "Hashtags used in a niche and how the videos using them performed",
  description:
    "Reads the local database only. Hashtags come from stored captions. Medians\n" +
    "are used so one viral reel cannot carry a tag; the outlier score is relative\n" +
    "to each creator's own usual plays.",
  input: aggregateInput(1),
  output: z.array(TagRowSchema),
  network: false,
  writes: "none",
  configure: aggregateOptions(1),
  args: ([slug]) => ({ slug }),
  handler: async (input, ctx) => {
    const scope = nicheScope(ctx, input.slug, input.since);
    const result = tagStats(scope.videos, input);
    const nextSteps = emptyScopeSteps(scope, input.since);
    const first = result.rows[0];
    if (first) {
      nextSteps.push({
        command: `ig video top --niche ${scope.slug} --hashtag ${first.tag}${sinceFlag(input.since)}`,
        description: "the best videos using this hashtag",
      });
    } else if (result.belowMinVideos > 0) {
      nextSteps.push({
        command: `ig niche tags ${scope.slug} --min-videos 1${sinceFlag(input.since)}`,
        description: `${result.belowMinVideos} hashtag(s) are used by fewer than ${input.minVideos} videos`,
      });
    }
    return {
      data: result.rows,
      meta: {
        sort: input.sort,
        videosConsidered: scope.videos.length,
        videosWithHashtags: result.videosWithData,
        hashtags: result.groups,
        belowMinVideos: result.belowMinVideos,
      },
      nextSteps,
    };
  },
  human: (data, _ctx, meta) => {
    const sort = z.enum(AGGREGATE_SORTS).catch("videos").parse(meta.sort);
    printTable(
      data,
      [
        { header: "HASHTAG", cell: (r) => `#${oneLine(r.tag)}`, maxWidth: 32 },
        ...statColumns(sort),
      ],
      emptyMessage(meta, {
        none: "No stored caption in this scope uses a hashtag.",
        below: "hashtag(s)",
      }),
    );
    outlierNote(data);
    if (data.length > 0) {
      note(
        `${meta.videosWithHashtags} of ${meta.videosConsidered} videos use a hashtag · ${meta.hashtags} distinct`,
      );
    }
  },
});

function emptyMessage(meta: Meta, text: { none: string; below: string }): string {
  if (Number(meta.videosConsidered ?? 0) === 0) return "No videos stored in this scope yet.";
  if (Number(meta.belowMinVideos ?? 0) > 0) {
    return `All ${meta.belowMinVideos} ${text.below} are below --min-videos.`;
  }
  return text.none;
}

const AudioRowSchema = z.object({
  id: z.string().nullable().describe("Instagram audio id"),
  title: z.string().nullable().describe("Untrusted third-party text"),
  artist: z.string().nullable().describe("Untrusted third-party text"),
  isOriginal: z
    .boolean()
    .nullable()
    .describe("True when a creator recorded the sound, false for licensed music"),
  ...StatsShape,
});

const audio = defineCommand({
  id: "niche.audio",
  summary: "Sounds that repeat across a niche and how the videos using them performed",
  description:
    "Reads the local database only. By default a sound must be used by at least\n" +
    "2 videos: a creator's own original audio is otherwise one row per reel.\n" +
    "Audio is stored when reels are fetched; videos stored before that have none\n" +
    "until the niche is refreshed.",
  input: aggregateInput(2),
  output: z.array(AudioRowSchema),
  network: false,
  writes: "none",
  configure: aggregateOptions(2),
  args: ([slug]) => ({ slug }),
  handler: async (input, ctx) => {
    const scope = nicheScope(ctx, input.slug, input.since);
    const result = audioStats(scope.videos, input);
    const nextSteps = emptyScopeSteps(scope, input.since);
    const first = result.rows[0];
    if (scope.videos.length > 0 && result.videosWithData === 0) {
      nextSteps.push({
        command: `ig niche refresh ${scope.slug} --force`,
        description: "no stored video has audio data yet; fetching reels again records it",
      });
    } else if (first) {
      const term =
        first.id && isSafeShortcode(first.id)
          ? first.id
          : first.title && /^[\p{L}\p{N} _-]+$/u.test(first.title)
            ? JSON.stringify(first.title)
            : null;
      if (term) {
        nextSteps.push({
          command: `ig video top --niche ${scope.slug} --audio ${term}${sinceFlag(input.since)}`,
          description: "the best videos using this sound",
        });
      }
    } else if (result.belowMinVideos > 0) {
      nextSteps.push({
        command: `ig niche audio ${scope.slug} --min-videos 1${sinceFlag(input.since)}`,
        description: `no sound is used by ${input.minVideos} or more videos; list all ${result.belowMinVideos}`,
      });
    }
    return {
      data: result.rows,
      meta: {
        sort: input.sort,
        videosConsidered: scope.videos.length,
        videosWithAudio: result.videosWithData,
        sounds: result.groups,
        belowMinVideos: result.belowMinVideos,
      },
      nextSteps,
    };
  },
  human: (data, _ctx, meta) => {
    const sort = z.enum(AGGREGATE_SORTS).catch("videos").parse(meta.sort);
    printTable(
      data,
      [
        {
          header: "SOUND",
          cell: (r) => oneLine(r.title) || (r.id ? muted(`id ${oneLine(r.id)}`) : dim("–")),
          maxWidth: 34,
        },
        { header: "ARTIST", cell: (r) => oneLine(r.artist) || dim("–"), maxWidth: 22 },
        {
          header: "KIND",
          cell: (r) =>
            r.isOriginal === null ? dim("–") : r.isOriginal ? "original" : muted("music"),
        },
        ...statColumns(sort),
      ],
      emptyMessage(meta, {
        none: "No stored video in this scope has audio data yet. It is recorded when reels are fetched.",
        below: "sound(s)",
      }),
    );
    outlierNote(data);
    const considered = Number(meta.videosConsidered ?? 0);
    const withAudio = Number(meta.videosWithAudio ?? 0);
    if (considered > 0 && withAudio > 0 && withAudio < considered) {
      note(
        `${withAudio} of ${considered} videos have audio data; the rest were stored without it.`,
      );
    }
  },
});

const DurationRowSchema = z.object({
  bucket: z.string().describe("<15s, 15-30s, 30-60s, 60-90s or >90s"),
  minSec: z.number().describe("Inclusive"),
  maxSec: z.number().nullable().describe("Exclusive. Null for the open-ended last bucket"),
  ...StatsShape,
});

const durations = defineCommand({
  id: "niche.durations",
  summary: "Performance by video length in a niche",
  description:
    "Reads the local database only. Every bucket is always listed, empty or not.\n" +
    "Only videos with a known duration count: the browser backend does not report\n" +
    "one, so it is measured from the downloaded file (`ig video probe`).\n" +
    "`meta.withoutDuration` says how many videos are left out.",
  input: z.object({
    slug: z.string(),
    since: z.string().optional().describe("Only videos newer than this: 30d, 12h, 2w or a date"),
  }),
  output: z.array(DurationRowSchema),
  network: false,
  writes: "none",
  configure: (cmd) =>
    cmd
      .argument("<slug>")
      .option("--since <when>", "only videos newer than 30d, 12h, 2w or a date"),
  args: ([slug]) => ({ slug }),
  handler: async (input, ctx) => {
    const scope = nicheScope(ctx, input.slug, input.since);
    const result = durationStats(scope.videos, existsSync);
    const nextSteps = emptyScopeSteps(scope, input.since);
    if (result.withoutDurationDownloaded > 0) {
      nextSteps.push({
        command: `ig video probe --niche ${scope.slug}`,
        description: `measure ${result.withoutDurationDownloaded} downloaded video(s) that have no duration yet`,
      });
    }
    const notDownloaded = result.withoutDuration - result.withoutDurationDownloaded;
    if (notDownloaded > 0) {
      nextSteps.push({
        command: `ig video download --top ${Math.min(notDownloaded, 20)} --niche ${scope.slug}${sinceFlag(input.since)}`,
        description: `${notDownloaded} video(s) have no duration and no file on disk; downloading measures a video`,
      });
    }
    // The bucket that does best for its creators, if enough videos back it.
    const winner = [...result.rows]
      .filter((r) => r.videos >= MIN_VIDEOS_FOR_OUTLIER && r.medianOutlier !== null)
      .sort((a, b) => (b.medianOutlier as number) - (a.medianOutlier as number))[0];
    if (winner) {
      nextSteps.push({
        command: `ig video top --niche ${scope.slug} --min-duration ${winner.minSec}${
          winner.maxSec === null ? "" : ` --max-duration ${winner.maxSec}`
        }${sinceFlag(input.since)}`,
        description: `the best videos of the strongest length (${winner.bucket})`,
      });
    }
    return {
      data: result.rows,
      meta: {
        videosConsidered: scope.videos.length,
        withDuration: result.withDuration,
        withoutDuration: result.withoutDuration,
        withoutDurationDownloaded: result.withoutDurationDownloaded,
      },
      nextSteps,
    };
  },
  human: (data, _ctx, meta) => {
    const considered = Number(meta.videosConsidered ?? 0);
    const without = Number(meta.withoutDuration ?? 0);
    if (considered === 0) {
      note("No videos stored in this scope yet.");
      return;
    }
    if (Number(meta.withDuration ?? 0) === 0) {
      note(`None of the ${considered} videos in this scope has a measured duration yet.`);
    } else {
      printTable(
        data,
        [
          { header: "LENGTH", cell: (r) => (r.videos === 0 ? dim(r.bucket) : bold(r.bucket)) },
          ...statColumns<(typeof data)[number]>(null),
        ],
        "",
      );
      outlierNote(data.filter((r) => r.videos > 0));
    }
    if (without > 0) {
      const onDisk = Number(meta.withoutDurationDownloaded ?? 0);
      note(
        `${without} of ${considered} videos have no measured duration and are not counted` +
          (onDisk > 0
            ? ` (${onDisk} downloaded: run \`ig video probe\`).`
            : " (download them to measure: `ig video download`)."),
      );
    }
  },
});

export const mediaCommands = [probe, tags, audio, durations];
