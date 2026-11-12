import { isAbsolute, relative } from "node:path";
import { z } from "zod";
import { bold, danger, dim, muted, ok, warn } from "../cligentic/platform/style.js";
import type { Context } from "../context.js";
import { CAPTIONS_FLAG_HELP } from "../core/captions.js";
import { type DownloadRequest, type DownloadSummary, downloadVideos } from "../core/download.js";
import {
  addFilterOptions,
  checkFilters,
  filterFlags,
  filterFlagsText,
  filterVideos,
  hasDurationFilter,
  hasFilters,
  sinceCutoff,
  usedFilterFlags,
  type VideoFilters,
} from "../core/filters.js";
import { MIN_VIDEOS_FOR_OUTLIER, rankVideos, sortVideos } from "../core/ranking.js";
import { refreshCreator } from "../core/refresh.js";
import { isSafeShortcode, uniqueTargets } from "../core/targets.js";
import { computeVelocities, DEFAULT_WINDOW, parseWindow } from "../core/trends.js";
import {
  normalizeUsername,
  type RankedVideo,
  RankedVideoSchema,
  SortKey,
  type StoredCreator,
  StoredVideoSchema,
  type Video,
  VideoSchema,
} from "../core/types.js";
import { defineCommand, flags } from "../lib/command.js";
import { IgError } from "../lib/errors.js";
import { ago, bytes, compact, duration, multiple, percent } from "../lib/format.js";
import { type Meta, type NextStep, oneLine } from "../lib/output.js";
import { type Column, printTable } from "../lib/table.js";

// --- ranking shared by `video top` and `video download --top` ----------------

export type TopSelection = {
  niche?: string;
  creator?: string;
  sort: SortKey;
  limit: number;
  since?: string;
  minPlays?: number;
  perCreator?: number;
} & VideoFilters;

export type TopResult = {
  videos: RankedVideo[];
  /** Explains the ranking, so a null `outlierScore` does not look like a bug. */
  meta: {
    sort: SortKey;
    videosConsidered: number;
    creatorsConsidered: number;
    creatorsBelowOutlierMinimum: number;
    outlierMinimumVideos: number;
    /** With a duration filter: videos it could not judge because nothing measured them. */
    withoutDuration?: number;
  };
  /** Where to get data when the scope holds no videos at all. */
  emptySteps: NextStep[];
};

/**
 * Ranks over every stored video of the creators in scope (the median needs
 * the full set) and only then filters, sorts and cuts.
 */
export function selectTop(ctx: Context, sel: TopSelection): TopResult {
  // Bad input fails before any work, including on an empty database.
  const cutoff = sinceCutoff(sel.since);
  checkFilters(sel);
  if (sel.niche) ctx.store.getNiche(sel.niche);

  let creators: StoredCreator[];
  if (sel.creator) {
    const one = ctx.store.getCreator(normalizeUsername(sel.creator));
    creators = sel.niche && !one.niches.includes(sel.niche) ? [] : [one];
  } else {
    creators = ctx.store.listCreators({ niche: sel.niche });
  }

  const all =
    creators.length === 0
      ? []
      : ctx.store.listVideos({
          creatorId: sel.creator ? creators[0]?.id : undefined,
          niche: sel.niche,
        });
  const ranked = rankVideos(
    all,
    new Map(creators.map((c) => [c.id, { followers: c.followers }])),
    computeVelocities(
      all,
      ctx.store.listVideoSnapshots({
        creatorId: sel.creator ? creators[0]?.id : undefined,
        niche: sel.niche,
      }),
      parseWindow(DEFAULT_WINDOW),
    ),
  );

  const withPlays = new Map<string, number>();
  for (const v of all) {
    if (v.plays !== null) withPlays.set(v.creatorId, (withPlays.get(v.creatorId) ?? 0) + 1);
  }

  let videos = ranked;
  if (cutoff !== null) {
    videos = videos.filter((v) => v.takenAt !== null && Date.parse(v.takenAt) >= cutoff);
  }
  const withoutDuration = hasDurationFilter(sel)
    ? filterVideos(videos, { ...sel, minDuration: undefined, maxDuration: undefined }).filter(
        (v) => v.durationSec === null,
      ).length
    : undefined;
  videos = filterVideos(videos, sel);
  if (sel.minPlays !== undefined) {
    const min = sel.minPlays;
    videos = videos.filter((v) => v.plays !== null && v.plays >= min);
  }
  videos = sortVideos(videos, sel.sort);
  if (sel.perCreator !== undefined) {
    const cap = sel.perCreator;
    const taken = new Map<string, number>();
    videos = videos.filter((v) => {
      const n = (taken.get(v.creatorId) ?? 0) + 1;
      taken.set(v.creatorId, n);
      return n <= cap;
    });
  }

  const emptySteps: NextStep[] = [];
  if (all.length === 0) {
    if (sel.creator) {
      emptySteps.push({
        command: `ig creator get ${normalizeUsername(sel.creator)} --refresh`,
        description: "fetch this creator's reels",
      });
    }
    if (sel.niche || !sel.creator) {
      const slug = sel.niche ?? ctx.store.listNiches()[0]?.slug ?? "<slug>";
      emptySteps.push({
        command: `ig niche refresh ${slug}`,
        description: "fetch reels for every creator in the niche",
      });
    }
    if (!sel.niche && !sel.creator) {
      emptySteps.push({
        command: "ig creator get <username> --refresh",
        description: "fetch one tracked creator's reels",
      });
    }
  }

  return {
    videos: videos.slice(0, sel.limit),
    meta: {
      sort: sel.sort,
      videosConsidered: all.length,
      creatorsConsidered: creators.length,
      creatorsBelowOutlierMinimum: creators.filter(
        (c) => (withPlays.get(c.id) ?? 0) < MIN_VIDEOS_FOR_OUTLIER,
      ).length,
      outlierMinimumVideos: MIN_VIDEOS_FOR_OUTLIER,
      ...(withoutDuration ? { withoutDuration } : {}),
    },
    emptySteps,
  };
}

/** The filter flags of a selection, as they would be typed. */
function selectionFlags(sel: Omit<TopSelection, "limit">): string {
  const parts: string[] = [];
  if (sel.niche) parts.push(`--niche ${sel.niche}`);
  if (sel.creator) parts.push(`--creator ${normalizeUsername(sel.creator)}`);
  if (sel.sort !== "outlier") parts.push(`--sort ${sel.sort}`);
  if (sel.since) parts.push(`--since ${sel.since.trim()}`);
  if (sel.perCreator !== undefined) parts.push(`--per-creator ${sel.perCreator}`);
  return `${parts.length ? ` ${parts.join(" ")}` : ""}${filterFlagsText(sel)}`;
}

// --- human views -------------------------------------------------------------

/** The value the eye should land on. A missing value stays quiet. */
const emphasize = (text: string): string => (text === "–" ? dim(text) : bold(text));
const quiet = (text: string): string => (text === "–" ? dim(text) : text);

function metricColumn<T extends Video>(
  header: string,
  value: (row: T) => string,
  sorted = false,
): Column<T> {
  return {
    header: sorted ? `${header} ↓` : header,
    align: "right",
    cell: (row) => (sorted ? emphasize(value(row)) : quiet(value(row))),
  };
}

/**
 * A table of videos. When every row is the same creator the name is printed
 * once as a heading instead of on every row. Captions are third-party text
 * and always pass through `oneLine`.
 */
function printVideos<T extends Video>(
  rows: T[],
  opts: { metrics: Column<T>[]; extra?: Column<T>[]; empty: string; ageSorted?: boolean },
): void {
  const first = rows[0];
  const single =
    first !== undefined && rows.every((r) => r.creatorUsername === first.creatorUsername);
  if (single) {
    const noun = rows.length === 1 ? "reel" : "reels";
    process.stdout.write(
      `${bold(`@${oneLine(first.creatorUsername)}`)} ${muted(`· ${rows.length} ${noun}`)}\n`,
    );
  }
  const columns: Column<T>[] = [
    { header: "#", align: "right", cell: (_row, i) => muted(String(i + 1)) },
    ...(single
      ? []
      : [{ header: "CREATOR", cell: (r: T) => oneLine(r.creatorUsername), maxWidth: 24 }]),
    ...opts.metrics,
    {
      header: opts.ageSorted ? "AGE ↓" : "AGE",
      align: "right",
      cell: (r) => (r.takenAt ? ago(r.takenAt) : dim("–")),
    },
    // The browser backend never learns a duration; a column of dashes says nothing.
    ...(rows.some((r) => r.durationSec !== null)
      ? [
          {
            header: "LEN",
            align: "right",
            cell: (r) => quiet(duration(r.durationSec)),
          } satisfies Column<T>,
        ]
      : []),
    ...(opts.extra ?? []),
    { header: "CAPTION", cell: (r) => oneLine(r.caption) || dim("–"), maxWidth: 44 },
    { header: "LINK", cell: (r) => muted(oneLine(r.url)) },
  ];
  printTable(rows, columns, opts.empty);
}

function storedMetrics<T extends Video>(): Column<T>[] {
  return [
    metricColumn("PLAYS", (r) => compact(r.plays)),
    metricColumn("LIKES", (r) => compact(r.likes)),
    metricColumn("COMMENTS", (r) => compact(r.comments)),
  ];
}

function rankedMetrics(sort: SortKey): Column<RankedVideo>[] {
  const plays = (sorted = false) =>
    metricColumn<RankedVideo>("PLAYS", (r) => compact(r.plays), sorted);
  const outlier = (sorted = false) =>
    metricColumn<RankedVideo>("OUTLIER", (r) => multiple(r.outlierScore), sorted);
  switch (sort) {
    case "outlier":
      return [outlier(true), plays()];
    case "plays":
      return [plays(true), outlier()];
    case "engagement":
      return [metricColumn("ENGAGEMENT", (r) => percent(r.engagementRate), true), plays()];
    case "likes":
      return [metricColumn("LIKES", (r) => compact(r.likes), true), plays()];
    case "comments":
      return [metricColumn("COMMENTS", (r) => compact(r.comments), true), plays()];
    case "recent":
      return [plays(), outlier()];
    case "velocity":
      return [
        metricColumn("VELOCITY", (r) => multiple(r.velocityScore), true),
        metricColumn("PLAYS/DAY", (r) =>
          compact(r.velocity === null ? null : Math.round(r.velocity)),
        ),
        plays(),
      ];
  }
}

function printDownload(data: DownloadSummary): void {
  if (data.items.length === 0) {
    process.stderr.write(`${muted("Nothing to download.")}\n`);
    return;
  }
  const label = {
    downloaded: ok("downloaded"),
    skipped: muted("skipped"),
    failed: danger("failed"),
    "would-download": warn("would download"),
  };
  printTable(
    data.items,
    [
      { header: "", cell: (i) => label[i.status] },
      {
        header: "VIDEO",
        cell: (i) => `${oneLine(i.creatorUsername) || "?"}/${oneLine(i.shortcode)}`,
        maxWidth: 40,
      },
      {
        header: "SIZE",
        align: "right",
        cell: (i) => (i.bytes === null ? dim("–") : bytes(i.bytes)),
      },
      {
        header: "DETAIL",
        cell: (i) =>
          i.status === "failed" || i.path === null
            ? oneLine(i.reason) || dim("–")
            : inside(data.dir, i.path),
      },
    ],
    "Nothing to download.",
  );
  const planned = data.items.filter((i) => i.status === "would-download").length;
  const counts = [
    planned > 0 ? `${planned} would download` : `${data.downloaded} downloaded`,
    `${data.skipped} skipped`,
    data.failed > 0 ? danger(`${data.failed} failed`) : "0 failed",
  ].join(", ");
  const size = data.downloaded > 0 ? ` ${muted("·")} ${bytes(data.bytes)}` : "";
  process.stdout.write(`\n${counts}${size} ${muted("·")} ${data.dir}\n`);
  for (const warning of new Set(data.warnings)) {
    process.stderr.write(`${warn("note")} ${oneLine(warning)}\n`);
  }
}

/** The directory is printed once in the total; rows show the path below it. */
function inside(dir: string, path: string): string {
  const rel = relative(dir, path);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? path : rel;
}

// --- commands ----------------------------------------------------------------

const list = defineCommand({
  id: "video.list",
  summary: "List a tracked creator's stored reels, newest first",
  input: z.object({
    creator: z.string().describe("Username, @handle or profile URL"),
    limit: flags.limit(20),
    refresh: z.boolean().default(false).describe("Fetch the latest reels first"),
    backend: flags.backend,
    force: flags.force.describe("Refresh even if refreshed recently"),
    captions: z.boolean().default(false).describe(`With --refresh: ${CAPTIONS_FLAG_HELP}`),
    ...filterFlags,
  }),
  output: z.array(StoredVideoSchema),
  network: true,
  writes: "local",
  configure: (cmd) =>
    addFilterOptions(
      cmd
        .argument("<creator>")
        .option("--limit <n>", "maximum results (default 20)")
        .option("--refresh", "fetch the latest reels first")
        .option("--backend <name>", "browser | hiker")
        .option("--force", "refresh even if refreshed recently")
        .option("--captions", `with --refresh: ${CAPTIONS_FLAG_HELP}`),
    ),
  args: ([creator]) => ({ creator }),
  handler: async (input, ctx) => {
    checkFilters(input);
    if (input.force && !input.refresh) {
      throw new IgError("INVALID_INPUT", "--force only applies together with --refresh.", {
        hint: `Run \`ig video list ${normalizeUsername(input.creator)} --refresh --force\`.`,
      });
    }
    if (input.captions && !input.refresh) {
      throw new IgError("INVALID_INPUT", "--captions only applies together with --refresh.", {
        hint: `Run \`ig video list ${normalizeUsername(input.creator)} --refresh --captions\`, or \`ig video captions --creator ${normalizeUsername(input.creator)}\` to fill stored reels only.`,
      });
    }
    const creator = ctx.store.getCreator(normalizeUsername(input.creator));
    const meta: Meta = {};
    if (input.refresh) {
      const backend = await ctx.backend(input.backend);
      const outcome = await refreshCreator(ctx, backend, creator, {
        reels: Math.max(input.limit, 15),
        force: input.force,
        captions: input.captions,
      });
      meta.refresh = {
        status: outcome.status,
        reason: outcome.reason,
        newVideos: outcome.newVideos,
        totalVideos: outcome.totalVideos,
        ...(outcome.captions ? { captions: outcome.captions } : {}),
      };
      if (outcome.captions) {
        const c = outcome.captions;
        ctx.log(
          `Captions: ${c.filled} filled with ${c.requests} extra request(s), ${c.missing} reel(s) still without.`,
        );
      }
      if (outcome.status === "skipped") ctx.log(`Not refreshed: ${outcome.reason}`);
    }
    // Filters apply before the limit, so `--limit 5` means five matches.
    const stored = ctx.store.listVideos({
      creatorId: creator.id,
      limit: hasFilters(input) ? undefined : input.limit,
    });
    const videos = filterVideos(stored, input).slice(0, input.limit);
    if (videos.length === 0 && stored.length > 0) meta.filteredOut = stored.length;
    const nextSteps: NextStep[] =
      videos.length === 0
        ? [
            meta.filteredOut
              ? {
                  command: `ig video list ${creator.username}`,
                  description: `all ${stored.length} stored reels, without the filters`,
                }
              : {
                  command: `ig video list ${creator.username} --refresh`,
                  description: "fetch this creator's latest reels",
                },
          ]
        : [
            {
              command: `ig video top --creator ${creator.username}`,
              description: "what performed best for this creator",
            },
          ];
    return { data: videos, meta, nextSteps };
  },
  human: (data, _ctx, meta) =>
    printVideos(data, {
      metrics: storedMetrics(),
      ageSorted: true,
      empty: meta.filteredOut
        ? `None of this creator's ${meta.filteredOut} stored reels match these filters.`
        : "No reels stored for this creator. Add --refresh to fetch them.",
    }),
});

const top = defineCommand({
  id: "video.top",
  summary: "Rank stored videos: what performed best",
  description:
    "Reads the local database only. The default order, `outlier`, is plays divided\n" +
    "by that creator's median plays: what did unusually well for them, regardless\n" +
    "of account size. Run `ig niche refresh` first for current numbers.",
  input: z.object({
    niche: flags.niche,
    creator: z.string().optional().describe("Only this creator"),
    sort: SortKey.default("outlier"),
    limit: flags.limit(20),
    since: z.string().optional().describe("Only videos newer than this: 30d, 12h, 2w or a date"),
    minPlays: z.coerce.number().int().min(0).optional(),
    perCreator: z.coerce
      .number()
      .int()
      .min(1)
      .optional()
      .describe("At most this many videos per creator"),
    ...filterFlags,
  }),
  output: z.array(RankedVideoSchema),
  network: false,
  writes: "none",
  configure: (cmd) =>
    addFilterOptions(cmd)
      .option("--niche <slug>", "only this niche")
      .option("--creator <username>", "only this creator")
      .option("--sort <key>", "outlier | plays | engagement | likes | comments | recent | velocity")
      .option("--limit <n>", "maximum results (default 20)")
      .option("--since <when>", "only videos newer than 30d, 12h, 2w or a date")
      .option("--min-plays <n>", "drop videos below this")
      .option("--per-creator <n>", "at most this many videos per creator"),
  handler: async (input, ctx) => {
    const result = selectTop(ctx, input);
    const nextSteps: NextStep[] =
      result.videos.length > 0
        ? [
            {
              command: `ig video download --top ${Math.min(result.videos.length, 5)}${selectionFlags(input)}`,
              description: "download the best of these",
            },
          ]
        : [...result.emptySteps];
    if (result.meta.withoutDuration) {
      const scope = `${input.niche ? ` --niche ${input.niche}` : ""}${input.creator ? ` --creator ${normalizeUsername(input.creator)}` : ""}`;
      nextSteps.push({
        command: `ig video probe${scope}`,
        description: `${result.meta.withoutDuration} video(s) have no measured duration; measure the downloaded ones`,
      });
    }
    return { data: result.videos, meta: result.meta, nextSteps };
  },
  human: (data, _ctx, meta) => {
    const sort = SortKey.catch("outlier").parse(meta.sort);
    const considered = Number(meta.videosConsidered ?? 0);
    printVideos(data, {
      metrics: rankedMetrics(sort),
      ageSorted: sort === "recent",
      empty:
        considered === 0
          ? "No videos stored in this scope yet."
          : `None of the ${considered} stored videos match these filters.`,
    });
    const below = Number(meta.creatorsBelowOutlierMinimum ?? 0);
    if (data.length > 0 && below > 0 && (sort === "outlier" || sort === "plays")) {
      process.stderr.write(
        `${muted(
          `${below} of ${meta.creatorsConsidered} creators have fewer than ${MIN_VIDEOS_FOR_OUTLIER} videos with play counts, so they get no outlier score.`,
        )}\n`,
      );
    }
  },
});

const search = defineCommand({
  id: "video.search",
  summary: "Full-text search over stored captions",
  description:
    "Searches the local database, not Instagram. All words must match; accents\n" +
    "are ignored. To find new reels on Instagram use `ig video discover`.",
  input: z.object({
    query: z.string().min(1),
    niche: flags.niche,
    limit: flags.limit(20),
    ...filterFlags,
  }),
  output: z.array(StoredVideoSchema),
  network: false,
  writes: "none",
  configure: (cmd) =>
    addFilterOptions(
      cmd
        .argument("<query>")
        .option("--niche <slug>", "only this niche")
        .option("--limit <n>", "maximum results (default 20)"),
    ),
  args: ([query]) => ({ query }),
  handler: async (input, ctx) => {
    checkFilters(input);
    if (!/[\p{L}\p{N}_]/u.test(input.query)) {
      throw new IgError("INVALID_INPUT", "The query has no searchable word.", {
        hint: 'Search for words from a caption, e.g. `ig video search "pasta receta"`.',
      });
    }
    // Filters apply before the limit, so the search reads deeper when one is set.
    const matches = ctx.store.searchVideos(input.query, {
      niche: input.niche,
      limit: hasFilters(input) ? 500 : input.limit,
    });
    const videos = filterVideos(matches, input).slice(0, input.limit);
    const meta: Meta = {};
    if (videos.length === 0 && matches.length > 0) meta.filteredOut = matches.length;
    const words = (input.query.match(/[\p{L}\p{N}_]+/gu) ?? []).join(" ");
    const nextSteps: NextStep[] =
      videos.length === 0
        ? [
            {
              command: `ig video discover "${words}"`,
              description: "search Instagram instead of the local database",
            },
          ]
        : [];
    return { data: videos, meta, nextSteps };
  },
  human: (data, _ctx, meta) =>
    printVideos(data, {
      metrics: storedMetrics(),
      empty: meta.filteredOut
        ? `${meta.filteredOut} stored caption(s) match that query, but none pass these filters.`
        : "No stored caption matches every word of that query.",
    }),
});

const discover = defineCommand({
  id: "video.discover",
  summary: "Find reels on Instagram by keyword or hashtag",
  description:
    "Lists reels only; nothing is stored. Add an interesting author with\n" +
    "`ig creator add`, or fetch one reel with `ig video download <url>`.",
  input: z.object({
    query: z.string().min(1),
    hashtag: z.boolean().default(false).describe("Treat the query as a hashtag"),
    limit: flags.limit(30, 200),
    backend: flags.backend,
  }),
  output: z.array(
    VideoSchema.extend({
      creatorTracked: z.boolean().describe("The author is already tracked locally"),
    }),
  ),
  network: true,
  writes: "none",
  configure: (cmd) =>
    cmd
      .argument("<query>", "keyword, or a hashtag with --hashtag")
      .option("--hashtag", "treat the query as a hashtag")
      .option("--limit <n>", "maximum results (default 30)")
      .option("--backend <name>", "browser | hiker"),
  args: ([query]) => ({ query }),
  handler: async (input, ctx) => {
    const term = input.hashtag ? input.query.trim().replace(/^#+/, "") : input.query.trim();
    if (term === "") {
      throw new IgError("INVALID_INPUT", "The query is empty.", {
        hint: "Give a keyword, or a tag with --hashtag: `ig video discover recetas --hashtag`.",
      });
    }
    const backend = await ctx.backend(input.backend);
    const found = input.hashtag
      ? await backend.hashtagReels(term, { limit: input.limit })
      : await backend.searchReels(term, { limit: input.limit });
    const tracked = new Map<string, boolean>();
    const data = found.slice(0, input.limit).map((v) => {
      if (!tracked.has(v.creatorId)) {
        tracked.set(v.creatorId, ctx.store.findCreator(v.creatorId) !== null);
      }
      return { ...v, creatorTracked: tracked.get(v.creatorId) === true };
    });
    // Usernames come from upstream; only well-formed ones go into a command.
    const untracked = [
      ...new Set(data.filter((v) => !v.creatorTracked).map((v) => v.creatorUsername)),
    ].filter((u) => /^[A-Za-z0-9._]+$/.test(u));
    const nextSteps: NextStep[] = [];
    if (untracked.length > 0) {
      nextSteps.push({
        command: `ig creator add ${untracked.slice(0, 3).join(" ")}`,
        description:
          untracked.length > 3
            ? `track authors found here (${untracked.length} are not tracked yet)`
            : "track the authors found here",
      });
    }
    const firstReel = data.find((v) => isSafeShortcode(v.shortcode));
    if (firstReel) {
      nextSteps.push({
        command: `ig video download ${firstReel.shortcode}`,
        description: "fetch one of these reels",
      });
    }
    return {
      data,
      meta: { source: input.hashtag ? `hashtag:${term}` : `reels:${term}` },
      nextSteps,
    };
  },
  human: (data) =>
    printVideos(data, {
      metrics: [
        metricColumn("PLAYS", (r) => compact(r.plays)),
        metricColumn("LIKES", (r) => compact(r.likes)),
      ],
      extra: [{ header: "TRACKED", cell: (r) => (r.creatorTracked ? ok("yes") : dim("no")) }],
      empty: "Instagram returned no reels for that query.",
    }),
});

export const DownloadItemSchema = z.object({
  id: z.string().nullable(),
  shortcode: z.string(),
  creatorUsername: z.string().nullable(),
  status: z.enum(["downloaded", "skipped", "failed", "would-download"]),
  reason: z.string().nullable().describe("Why it was skipped or failed"),
  path: z.string().nullable().describe("Absolute path of the file"),
  bytes: z.number().int().nullable(),
});

const download = defineCommand({
  id: "video.download",
  summary: "Download videos as mp4",
  description:
    "Give ids, shortcodes or URLs, or select from the database with --top.\n" +
    "Files go to <mediaDir>/<username>/<shortcode>.mp4. A video already on disk\n" +
    "is skipped unless --force. Video URLs expire, so a stale one is re-fetched\n" +
    "from the backend (one request).",
  input: z.object({
    targets: z.array(z.string()).default([]).describe("Video ids, shortcodes or reel URLs"),
    top: z.coerce.number().int().min(1).max(500).optional().describe("Download the top N instead"),
    niche: flags.niche.describe("With --top: only this niche"),
    creator: z.string().optional().describe("With --top: only this creator"),
    sort: SortKey.default("outlier").describe("With --top: ranking"),
    since: z.string().optional().describe("With --top: only videos newer than this"),
    perCreator: z.coerce.number().int().min(1).optional().describe("With --top: cap per creator"),
    ...filterFlags,
    out: z.string().optional().describe("Directory to write to. Defaults to mediaDir"),
    backend: flags.backend,
    force: flags.force.describe("Download again even if the file exists"),
    dryRun: flags.dryRun,
  }),
  output: z.object({
    downloaded: z.number().int(),
    skipped: z.number().int(),
    failed: z.number().int(),
    bytes: z.number().int(),
    dir: z.string(),
    items: z.array(DownloadItemSchema),
    measured: z
      .number()
      .int()
      .describe("Files whose duration and dimensions were read with ffprobe in this run"),
    warnings: z.array(z.string()).describe("Things that did not stop the run, e.g. no ffprobe"),
  }),
  network: true,
  writes: "local",
  configure: (cmd) =>
    addFilterOptions(cmd, "with --top: ")
      .argument("[targets...]", "video ids, shortcodes or reel URLs")
      .option("--top <n>", "download the top N stored videos instead")
      .option("--niche <slug>", "with --top: only this niche")
      .option("--creator <username>", "with --top: only this creator")
      .option(
        "--sort <key>",
        "with --top: outlier | plays | engagement | likes | comments | recent | velocity",
      )
      .option("--since <when>", "with --top: only videos newer than 30d, 12h, 2w or a date")
      .option("--per-creator <n>", "with --top: at most this many per creator")
      .option("--out <dir>", "directory to write to")
      .option("--backend <name>", "browser | hiker")
      .option("--force", "download again even if the file exists")
      .option("--dry-run", "list what would be downloaded"),
  args: ([targets]) => ({ targets }),
  handler: async (input, ctx) => {
    const example =
      "Run `ig video download <shortcode-or-url>...` or `ig video download --top 10 --niche <slug>`.";
    if (input.targets.length > 0 && input.top !== undefined) {
      throw new IgError("INVALID_INPUT", "Give either targets or --top, not both.", {
        hint: example,
      });
    }
    if (input.targets.length === 0 && input.top === undefined) {
      throw new IgError("INVALID_INPUT", "Nothing to download: give targets or --top <n>.", {
        hint: example,
      });
    }
    if (input.top === undefined) {
      const stray = [
        input.niche !== undefined && "--niche",
        input.creator !== undefined && "--creator",
        input.since !== undefined && "--since",
        input.perCreator !== undefined && "--per-creator",
        ...usedFilterFlags(input),
      ].filter((f) => f !== false);
      if (stray.length > 0) {
        throw new IgError("INVALID_INPUT", `${stray.join(", ")} only applies with --top.`, {
          hint: example,
        });
      }
    }

    const dir = input.out ?? ctx.mediaDir;
    let targets: DownloadRequest["targets"];
    let emptySteps: NextStep[] = [];
    if (input.top !== undefined) {
      const selection = selectTop(ctx, { ...input, limit: input.top });
      targets = selection.videos;
      emptySteps = selection.emptySteps;
    } else {
      targets = uniqueTargets(input.targets);
    }

    const summary = await downloadVideos(
      { store: ctx.store, log: ctx.log, backend: () => ctx.backend(input.backend) },
      { targets, dir, force: input.force, dryRun: input.dryRun },
    );

    // Every item failing is a failure, not a success envelope with bad news inside.
    if (summary.items.length > 0 && summary.failed === summary.items.length) {
      const first = summary.items[0];
      throw new IgError(
        "DOWNLOAD_FAILED",
        summary.failed === 1
          ? `Could not download ${first?.shortcode}: ${first?.reason}`
          : `None of the ${summary.failed} videos could be downloaded. First reason: ${first?.reason}`,
        {
          hint: "Check `ig auth status` and `ig doctor`. The reason for each video is in details.items.",
          details: { ...summary },
        },
      );
    }

    const nextSteps: NextStep[] = [...emptySteps];
    if (input.dryRun && summary.items.some((i) => i.status === "would-download")) {
      const what =
        input.top !== undefined
          ? `--top ${input.top}${selectionFlags(input)}`
          : summary.items
              .filter((i) => i.status === "would-download")
              .map((i) => i.shortcode)
              .join(" ");
      nextSteps.push({ command: `ig video download ${what}`, description: "run it for real" });
    }
    if (summary.failed > 0) {
      nextSteps.push({
        command: "ig doctor",
        description: "check the backend and the yt-dlp fallback",
      });
    }
    return { data: summary, nextSteps };
  },
  human: (data) => printDownload(data),
});

export const videoCommands = [list, top, search, discover, download];
