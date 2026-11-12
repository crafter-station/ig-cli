// Trends: what is growing now and how a creator or a video evolved. Everything
// here reads the metric snapshots that refreshes have already stored; no
// command in this file makes a request.

import { z } from "zod";
import { bold, dim, muted, ok, warn } from "../cligentic/platform/style.js";
import type { Context } from "../context.js";
import { median, rankVideos } from "../core/ranking.js";
import { findStoredVideo, isSafeShortcode } from "../core/targets.js";
import {
  computeVelocities,
  creatorHistory,
  DEFAULT_WINDOW,
  followerGrowth,
  localTimeZone,
  MIN_SPAN_HOURS,
  parseWindow,
  postingCadence,
  videoHistory,
  WEEKDAYS,
} from "../core/trends.js";
import {
  normalizeUsername,
  RankedVideoSchema,
  type StoredCreator,
  StoredCreatorSchema,
  StoredVideoSchema,
  VelocityFieldsSchema,
} from "../core/types.js";
import { defineCommand, flags } from "../lib/command.js";
import { IgError } from "../lib/errors.js";
import { ago, compact, multiple, percent } from "../lib/format.js";
import { round } from "../lib/math.js";
import { type NextStep, oneLine } from "../lib/output.js";
import { type Column, printTable, renderRecord } from "../lib/table.js";

// --- shared schemas ----------------------------------------------------------------

const isoDate = z.string().describe("ISO 8601 UTC timestamp");

const VelocityDetailSchema = VelocityFieldsSchema.extend({
  playsPerDay: z
    .number()
    .nullable()
    .describe(
      "Plays gained per day between two snapshots (spanFrom to spanTo). Null with fewer than two usable snapshots. 0 when the count went down",
    ),
  lifetimePlaysPerDay: z
    .number()
    .nullable()
    .describe("Plays divided by the video's age when they were counted. The fallback measure"),
  playsGained: z
    .number()
    .int()
    .nullable()
    .describe("Plays gained over the span. Negative when Instagram's count went down"),
  spanFrom: isoDate
    .nullable()
    .describe("Start of the span the velocity was measured over. For lifetime: the publish date"),
  spanTo: isoDate.nullable().describe("End of the span: when the newest play count was read"),
  spanHours: z.number().nullable(),
  snapshots: z.number().int().describe("Metric snapshots stored for this video"),
  creatorMedianVelocity: z
    .number()
    .nullable()
    .describe("Median plays/day over this creator's measurable videos"),
});

const TrendingVideoSchema = RankedVideoSchema.extend(VelocityDetailSchema.shape);
type TrendingVideo = z.infer<typeof TrendingVideoSchema>;

const windowFlag = z
  .string()
  .default(DEFAULT_WINDOW)
  .describe("How far back to measure growth: 12h, 7d, 2w or a date");

// --- human formatting ----------------------------------------------------------------

const DASH = "–";
const quiet = (text: string): string => (text === DASH ? dim(text) : text);
const emphasize = (text: string): string => (text === DASH ? dim(text) : bold(text));

function signed(n: number | null | undefined): string {
  if (n === null || n === undefined) return DASH;
  if (n === 0) return "0";
  return `${n > 0 ? "+" : "-"}${compact(Math.abs(n))}`;
}

/** A change, colored by direction. */
function change(n: number | null | undefined): string {
  const text = signed(n);
  if (n === null || n === undefined || n === 0) return quiet(text);
  return n > 0 ? ok(text) : warn(text);
}

function perDay(n: number | null | undefined): string {
  if (n === null || n === undefined) return DASH;
  const abs = Math.abs(n);
  return abs >= 100 || abs === 0 ? compact(Math.round(n)) : String(round(n, 1));
}

function span(hours: number | null | undefined): string {
  if (hours === null || hours === undefined) return DASH;
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${round(hours, 1)}h`;
  return `${round(hours / 24, 1)}d`;
}

/** Local wall-clock time, minute precision. The JSON output keeps UTC. */
function localStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return DASH;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const note = (text: string): void => {
  process.stderr.write(`${muted(text)}\n`);
};

const right = <T>(header: string, cell: (row: T) => string): Column<T> => ({
  header,
  align: "right",
  cell,
});

// --- video trending -------------------------------------------------------------------

const TRENDING_SORT = ["score", "plays-per-day"] as const;

/** Stored videos of the scope and the creators they belong to. */
function scope(
  ctx: Context,
  sel: { niche?: string; creator?: string },
): { creators: StoredCreator[]; creatorId: string | undefined } {
  if (sel.niche) ctx.store.getNiche(sel.niche);
  if (sel.creator) {
    const one = ctx.store.getCreator(normalizeUsername(sel.creator));
    const inScope = !sel.niche || one.niches.includes(sel.niche);
    return { creators: inScope ? [one] : [], creatorId: one.id };
  }
  return { creators: ctx.store.listCreators({ niche: sel.niche }), creatorId: undefined };
}

/** Every stored video of the scope with its velocity. Empty when the scope has no creators. */
function velocitiesInScope(
  ctx: Context,
  sel: { niche?: string; creator?: string },
  windowMs: number,
): { creators: StoredCreator[]; videos: TrendingVideo[] } {
  const { creators, creatorId } = scope(ctx, sel);
  if (creators.length === 0) return { creators, videos: [] };
  const all = ctx.store.listVideos({ creatorId, niche: sel.niche });
  const velocities = computeVelocities(
    all,
    ctx.store.listVideoSnapshots({ creatorId, niche: sel.niche }),
    windowMs,
  );
  const ranked = rankVideos(
    all,
    new Map(creators.map((c) => [c.id, { followers: c.followers }])),
    velocities,
  );
  const videos = ranked.flatMap((v) => {
    const velocity = velocities.get(v.id);
    return velocity ? [{ ...v, ...velocity }] : [];
  });
  return { creators, videos };
}

const trending = defineCommand({
  id: "video.trending",
  summary: "Videos gaining plays fastest right now",
  description:
    "Reads the local database only. Velocity is plays gained per day between the\n" +
    "newest snapshot of a video and the latest one at least --window older (or the\n" +
    "oldest one, when the history is shorter). A video with a single snapshot falls\n" +
    "back to lifetime plays / age. The default order is the velocity score: the\n" +
    "video's plays/day divided by that creator's median plays/day. Each refresh\n" +
    "stores one snapshot, so refresh on different days to get real growth.",
  input: z.object({
    niche: flags.niche,
    creator: z.string().optional().describe("Only this creator"),
    window: windowFlag,
    sort: z
      .enum(TRENDING_SORT)
      .default("score")
      .describe("score: relative to the creator's median. plays-per-day: raw rate"),
    limit: flags.limit(20),
    minPlays: z.coerce.number().int().min(0).optional().describe("Drop videos below this"),
    perCreator: z.coerce
      .number()
      .int()
      .min(1)
      .optional()
      .describe("At most this many videos per creator"),
  }),
  output: z.array(TrendingVideoSchema),
  network: false,
  writes: "none",
  configure: (cmd) =>
    cmd
      .option("--niche <slug>", "only this niche")
      .option("--creator <username>", "only this creator")
      .option("--window <when>", `measure growth over 12h, 7d, 2w... (default ${DEFAULT_WINDOW})`)
      .option("--sort <key>", "score | plays-per-day")
      .option("--limit <n>", "maximum results (default 20)")
      .option("--min-plays <n>", "drop videos below this")
      .option("--per-creator <n>", "at most this many videos per creator"),
  handler: async (input, ctx) => {
    const windowMs = parseWindow(input.window);
    const { creators, videos: all } = velocitiesInScope(ctx, input, windowMs);

    let candidates = all;
    if (input.minPlays !== undefined) {
      const min = input.minPlays;
      candidates = candidates.filter((v) => v.plays !== null && v.plays >= min);
    }
    const count = (test: (v: TrendingVideo) => boolean): number => candidates.filter(test).length;

    const raw = (v: TrendingVideo): number => v.velocity ?? -1;
    let rows = candidates
      .filter((v) => v.velocity !== null)
      .sort((a, b) => {
        if (input.sort === "plays-per-day") return raw(b) - raw(a);
        // Videos without a score sort last, by raw rate.
        if (a.velocityScore === null && b.velocityScore === null) return raw(b) - raw(a);
        if (a.velocityScore === null) return 1;
        if (b.velocityScore === null) return -1;
        return b.velocityScore - a.velocityScore || raw(b) - raw(a);
      });
    if (input.perCreator !== undefined) {
      const cap = input.perCreator;
      const taken = new Map<string, number>();
      rows = rows.filter((v) => {
        const n = (taken.get(v.creatorId) ?? 0) + 1;
        taken.set(v.creatorId, n);
        return n <= cap;
      });
    }
    rows = rows.slice(0, input.limit);

    const singleSnapshot = count((v) => v.snapshots <= 1);
    const slug = input.niche ?? ctx.store.listNiches()[0]?.slug ?? "<slug>";
    const refreshCommand = input.creator
      ? `ig creator get ${normalizeUsername(input.creator)} --refresh`
      : `ig niche refresh ${slug}`;
    const meta = {
      sort: input.sort,
      window: input.window.trim(),
      windowHours: round(windowMs / 3_600_000),
      minSpanHours: MIN_SPAN_HOURS,
      creatorsConsidered: creators.length,
      videosConsidered: all.length,
      candidates: candidates.length,
      measuredOverWindow: count((v) => v.velocityBasis === "window"),
      lifetimeFallback: count((v) => v.velocityBasis === "lifetime"),
      unmeasurable: count((v) => v.velocityBasis === null),
      singleSnapshot,
      note:
        singleSnapshot > 0
          ? `${singleSnapshot} of ${candidates.length} candidate videos have a single snapshot, so no growth can be measured for them yet (lifetime plays / age is used instead). Run \`${refreshCommand}\` again on a later day to measure growth.`
          : null,
    };

    const nextSteps: NextStep[] = [];
    if (all.length === 0) {
      nextSteps.push({ command: refreshCommand, description: "fetch reels and a first snapshot" });
    } else if (singleSnapshot > 0) {
      nextSteps.push({
        command: refreshCommand,
        description: "on a later day: a second snapshot is what makes velocity meaningful",
      });
    }
    const first = rows.find((v) => isSafeShortcode(v.shortcode));
    if (first) {
      nextSteps.push({
        command: `ig video history ${first.shortcode}`,
        description: "the snapshot series behind the top row",
      });
    }
    return { data: rows, meta, nextSteps };
  },
  human: (data, _ctx, meta) => {
    const byRate = meta.sort === "plays-per-day";
    const mark = (header: string, on: boolean) => (on ? `${header} ↓` : header);
    const single =
      data[0] !== undefined && data.every((r) => r.creatorUsername === data[0]?.creatorUsername);
    if (single && data[0]) {
      process.stdout.write(`${bold(`@${oneLine(data[0].creatorUsername)}`)}\n`);
    }
    const considered = Number(meta.videosConsidered ?? 0);
    printTable(
      data,
      [
        { header: "#", align: "right", cell: (_r, i) => muted(String(i + 1)) },
        ...(single
          ? []
          : [
              {
                header: "CREATOR",
                cell: (r: TrendingVideo) => oneLine(r.creatorUsername),
                maxWidth: 24,
              },
            ]),
        right(mark("SCORE", !byRate), (r) =>
          byRate ? quiet(multiple(r.velocityScore)) : emphasize(multiple(r.velocityScore)),
        ),
        right(mark("PLAYS/DAY", byRate), (r) =>
          byRate ? emphasize(perDay(r.velocity)) : perDay(r.velocity),
        ),
        right("GAINED", (r) => change(r.playsGained)),
        right("OVER", (r) => quiet(span(r.spanHours))),
        {
          header: "BASIS",
          cell: (r) => (r.velocityBasis === "window" ? "window" : dim("lifetime")),
        },
        right("PLAYS", (r) => quiet(compact(r.plays))),
        right("AGE", (r) => (r.takenAt ? ago(r.takenAt) : dim(DASH))),
        { header: "CAPTION", cell: (r) => oneLine(r.caption) || dim(DASH), maxWidth: 40 },
        { header: "LINK", cell: (r) => muted(oneLine(r.url)) },
      ],
      considered === 0
        ? "No videos stored in this scope yet."
        : "No stored video in this scope has a measurable velocity (play counts hidden, or no publish date and a single snapshot).",
    );
    if (data.length > 0) {
      note(
        `\nwindow ${meta.window}: ${meta.measuredOverWindow} of ${meta.candidates} candidate videos measured between two snapshots, ${meta.lifetimeFallback} on lifetime plays / age.`,
      );
    }
    if (typeof meta.note === "string") process.stderr.write(`${warn("note")} ${meta.note}\n`);
  },
});

// --- video history --------------------------------------------------------------------

const VideoHistoryRowSchema = z.object({
  takenAt: isoDate.describe("When this snapshot was recorded"),
  plays: z.number().int().nullable(),
  likes: z.number().int().nullable(),
  comments: z.number().int().nullable(),
  playsDelta: z.number().int().nullable().describe("Change since the previous snapshot"),
  likesDelta: z.number().int().nullable(),
  commentsDelta: z.number().int().nullable(),
  hoursSincePrevious: z.number().nullable(),
  playsPerDay: z
    .number()
    .nullable()
    .describe(
      `Rate since the previous snapshot. Null when they are less than ${MIN_SPAN_HOURS}h apart`,
    ),
});

const videoHistoryCmd = defineCommand({
  id: "video.history",
  summary: "How one video's plays, likes and comments evolved",
  description:
    "Reads the local database only: one row per refresh that saw the video,\n" +
    "oldest first, with the change and the plays/day since the previous row.",
  input: z.object({
    video: z.string().describe("Shortcode, media id or reel URL"),
    window: windowFlag,
    limit: flags.limit(50).describe("Show the latest N snapshots"),
  }),
  output: z.object({
    video: StoredVideoSchema.pick({
      id: true,
      shortcode: true,
      url: true,
      creatorUsername: true,
      caption: true,
      takenAt: true,
      plays: true,
      likes: true,
      comments: true,
    }),
    velocity: VelocityDetailSchema.describe("The same numbers `ig video trending` ranks by"),
    totalSnapshots: z.number().int(),
    snapshots: z.array(VideoHistoryRowSchema).describe("Oldest first"),
  }),
  network: false,
  writes: "none",
  configure: (cmd) =>
    cmd
      .argument("<video>", "shortcode, media id or reel URL")
      .option("--window <when>", `window for the velocity summary (default ${DEFAULT_WINDOW})`)
      .option("--limit <n>", "show the latest N snapshots (default 50)"),
  args: ([video]) => ({ video }),
  handler: async (input, ctx) => {
    const windowMs = parseWindow(input.window);
    const { video } = findStoredVideo(ctx.store, input.video);
    if (!video) {
      throw new IgError("NOT_FOUND", `No stored video matches ${oneLine(input.video)}.`, {
        hint: "History exists only for stored videos. List them with `ig video list <creator>`.",
      });
    }
    // The score needs the creator's other videos, exactly as in `video trending`.
    const velocity = computeVelocities(
      ctx.store.listVideos({ creatorId: video.creatorId }),
      ctx.store.listVideoSnapshots({ creatorId: video.creatorId }),
      windowMs,
    ).get(video.id);
    const rows = videoHistory(ctx.store.videoSnapshots(video.id));
    if (!velocity) throw new IgError("INTERNAL", `No velocity computed for ${video.shortcode}.`);

    const nextSteps: NextStep[] = [];
    if (rows.length < 2) {
      nextSteps.push({
        command: `ig creator get ${video.creatorUsername} --refresh`,
        description: "on a later day: a second snapshot shows the growth",
      });
    }
    nextSteps.push({
      command: `ig video trending --creator ${video.creatorUsername}`,
      description: "this creator's fastest-growing videos",
    });
    return {
      data: {
        video: {
          id: video.id,
          shortcode: video.shortcode,
          url: video.url,
          creatorUsername: video.creatorUsername,
          caption: video.caption,
          takenAt: video.takenAt,
          plays: video.plays,
          likes: video.likes,
          comments: video.comments,
        },
        velocity,
        totalSnapshots: rows.length,
        snapshots: rows.slice(-input.limit),
      },
      meta: { window: input.window.trim(), minSpanHours: MIN_SPAN_HOURS },
      nextSteps,
    };
  },
  human: (data, _ctx, meta) => {
    const v = data.video;
    const caption = oneLine(v.caption);
    process.stdout.write(
      `${bold(`@${oneLine(v.creatorUsername)}`)} ${muted("·")} ${oneLine(v.shortcode)} ${muted(
        `· published ${v.takenAt ? ago(v.takenAt) : "at an unknown date"}`,
      )}\n`,
    );
    if (caption) {
      process.stdout.write(
        `${muted(caption.length > 100 ? `${caption.slice(0, 99)}…` : caption)}\n`,
      );
    }
    process.stdout.write("\n");
    printTable(
      data.snapshots,
      [
        { header: "SNAPSHOT", cell: (r) => localStamp(r.takenAt) },
        right("PLAYS", (r) => quiet(compact(r.plays))),
        right("Δ", (r) => change(r.playsDelta)),
        right("PLAYS/DAY", (r) => quiet(perDay(r.playsPerDay))),
        right("AFTER", (r) => quiet(span(r.hoursSincePrevious))),
        right("LIKES", (r) => quiet(compact(r.likes))),
        right("Δ", (r) => change(r.likesDelta)),
        right("COMMENTS", (r) => quiet(compact(r.comments))),
        right("Δ", (r) => change(r.commentsDelta)),
      ],
      "No snapshots stored for this video.",
    );
    if (data.totalSnapshots > data.snapshots.length) {
      note(`${data.snapshots.length} latest shown of ${data.totalSnapshots}`);
    }
    const vel = data.velocity;
    const pairs: [string, string][] = [];
    if (vel.velocityBasis === "window") {
      pairs.push([
        `window ${meta.window}`,
        `${signed(vel.playsGained)} plays over ${span(vel.spanHours)} = ${bold(perDay(vel.playsPerDay))}/day`,
      ]);
    }
    if (vel.lifetimePlaysPerDay !== null) {
      pairs.push(["lifetime", `${perDay(vel.lifetimePlaysPerDay)}/day since it was published`]);
    }
    if (vel.velocityScore !== null) {
      pairs.push([
        "score",
        `${multiple(vel.velocityScore)} this creator's median of ${perDay(vel.creatorMedianVelocity)}/day (${vel.velocityBasis} basis)`,
      ]);
    }
    if (pairs.length > 0) process.stdout.write(`\n${renderRecord(pairs)}\n`);
    if (vel.playsGained !== null && vel.playsGained < 0) {
      note("The play count went down over the window; the rate is reported as 0.");
    }
    if (data.totalSnapshots < 2) {
      process.stderr.write(
        `${warn("note")} ${data.totalSnapshots} snapshot(s): growth needs two at different times. Run \`ig creator get ${oneLine(v.creatorUsername)} --refresh\` again on a later day.\n`,
      );
    } else if (vel.velocityBasis !== "window") {
      note(
        `The snapshots are less than ${MIN_SPAN_HOURS}h apart or carry no play counts, so no growth rate is derived from them.`,
      );
    }
  },
});

// --- creator history -------------------------------------------------------------------

const CreatorHistoryRowSchema = z.object({
  takenAt: isoDate.describe("When this snapshot was recorded"),
  followers: z.number().int().nullable(),
  following: z.number().int().nullable(),
  mediaCount: z.number().int().nullable(),
  followersDelta: z.number().int().nullable().describe("Change since the previous snapshot"),
  followingDelta: z.number().int().nullable(),
  mediaCountDelta: z.number().int().nullable(),
  hoursSincePrevious: z.number().nullable(),
  followersPerDay: z
    .number()
    .nullable()
    .describe(
      `Rate since the previous snapshot. Null when they are less than ${MIN_SPAN_HOURS}h apart`,
    ),
});

const FollowerGrowthSchema = z.object({
  followersGained: z.number().int().nullable(),
  followersPerDay: z.number().nullable(),
  followerGrowthRate: z
    .number()
    .nullable()
    .describe("Gained divided by the followers at the start of the span. 0.05 is +5%"),
  spanFrom: isoDate.nullable(),
  spanTo: isoDate.nullable(),
  spanHours: z.number().nullable(),
});

const CadenceSchema = z.object({
  timeZone: z.string().describe("IANA zone of this machine; weekday and hour are in it"),
  videos: z.number().int().describe("Stored videos with a publish date; the only input"),
  oldestAt: isoDate.nullable(),
  newestAt: isoDate.nullable(),
  postsPerWeek4w: z.number().nullable().describe("Videos per week over the last 4 weeks"),
  postsPerWeek12w: z.number().nullable().describe("Videos per week over the last 12 weeks"),
  covers4w: z
    .boolean()
    .describe("False when stored videos do not reach back 4 weeks; the rate then covers less"),
  covers12w: z.boolean(),
  medianGapHours: z.number().nullable().describe("Median time between consecutive posts"),
  topWeekday: z.enum(WEEKDAYS).nullable().describe("Most common posting weekday"),
  topWeekdayCount: z.number().int(),
  topHour: z.number().int().nullable().describe("Most common posting hour, 0-23"),
  topHourCount: z.number().int(),
  byWeekday: z.array(z.number().int()).describe("Posts per weekday, Sunday first"),
  byHour: z.array(z.number().int()).describe("Posts per hour of the day, 0 first"),
});

const creatorHistoryCmd = defineCommand({
  id: "creator.history",
  summary: "A creator's follower growth and posting cadence over time",
  description:
    "Reads the local database only: one row per refresh of the profile, oldest\n" +
    "first, and a posting cadence computed from the stored videos' publish dates.\n" +
    "Weekday and hour are in this machine's time zone, named in the output.",
  input: z.object({
    username: z.string().describe("Username, @handle or profile URL"),
    window: windowFlag,
    limit: flags.limit(30).describe("Show the latest N snapshots"),
  }),
  output: z.object({
    creator: StoredCreatorSchema.pick({
      id: true,
      username: true,
      url: true,
      followers: true,
      following: true,
      mediaCount: true,
      videoCount: true,
    }),
    growth: FollowerGrowthSchema.describe("Follower change over --window"),
    cadence: CadenceSchema,
    totalSnapshots: z.number().int(),
    snapshots: z.array(CreatorHistoryRowSchema).describe("Oldest first"),
  }),
  network: false,
  writes: "none",
  configure: (cmd) =>
    cmd
      .argument("<username>")
      .option("--window <when>", `window for the growth summary (default ${DEFAULT_WINDOW})`)
      .option("--limit <n>", "show the latest N snapshots (default 30)"),
  args: ([username]) => ({ username }),
  handler: async (input, ctx) => {
    const windowMs = parseWindow(input.window);
    const creator = ctx.store.getCreator(normalizeUsername(input.username));
    const snapshots = ctx.store.creatorSnapshots(creator.id);
    const rows = creatorHistory(snapshots);
    const videos = ctx.store.listVideos({ creatorId: creator.id });
    const cadence = postingCadence(
      videos.map((v) => v.takenAt),
      { now: Date.now(), timeZone: localTimeZone() },
    );
    const nextSteps: NextStep[] = [];
    if (rows.length < 2 || videos.length === 0) {
      nextSteps.push({
        command: `ig creator get ${creator.username} --refresh`,
        description:
          rows.length < 2
            ? "on a later day: a second snapshot shows the growth"
            : "fetch this creator's reels",
      });
    }
    nextSteps.push({
      command: `ig video trending --creator ${creator.username}`,
      description: "their fastest-growing videos",
    });
    return {
      data: {
        creator: {
          id: creator.id,
          username: creator.username,
          url: creator.url,
          followers: creator.followers,
          following: creator.following,
          mediaCount: creator.mediaCount,
          videoCount: creator.videoCount,
        },
        growth: followerGrowth(snapshots, windowMs),
        cadence,
        totalSnapshots: rows.length,
        snapshots: rows.slice(-input.limit),
      },
      meta: { window: input.window.trim(), minSpanHours: MIN_SPAN_HOURS },
      nextSteps,
    };
  },
  human: (data, _ctx, meta) => {
    const c = data.creator;
    process.stdout.write(
      `${bold(`@${oneLine(c.username)}`)} ${muted(
        `· ${compact(c.followers)} followers · ${data.totalSnapshots} snapshot(s)`,
      )}\n\n`,
    );
    printTable(
      data.snapshots,
      [
        { header: "SNAPSHOT", cell: (r) => localStamp(r.takenAt) },
        right("FOLLOWERS", (r) => quiet(compact(r.followers))),
        right("Δ", (r) => change(r.followersDelta)),
        right("PER DAY", (r) => quiet(perDay(r.followersPerDay))),
        right("AFTER", (r) => quiet(span(r.hoursSincePrevious))),
        right("FOLLOWING", (r) => quiet(compact(r.following))),
        right("Δ", (r) => change(r.followingDelta)),
        right("POSTS", (r) => quiet(compact(r.mediaCount))),
        right("Δ", (r) => change(r.mediaCountDelta)),
      ],
      "No profile snapshots stored for this creator.",
    );
    if (data.totalSnapshots > data.snapshots.length) {
      note(`${data.snapshots.length} latest shown of ${data.totalSnapshots}`);
    }

    const g = data.growth;
    const k = data.cadence;
    const pairs: [string, string][] = [];
    if (g.followersGained !== null) {
      const rate = g.followerGrowthRate === null ? "" : ` (${percent(g.followerGrowthRate, 2)})`;
      pairs.push([
        `window ${meta.window}`,
        `${signed(g.followersGained)} followers${rate} over ${span(g.spanHours)} = ${bold(perDay(g.followersPerDay))}/day`,
      ]);
    }
    if (k.videos > 0) {
      const partial = (covers: boolean) =>
        covers ? "" : muted(` (stored reels start ${k.oldestAt ? ago(k.oldestAt) : DASH})`);
      pairs.push(
        ["posts / week", `${k.postsPerWeek4w ?? DASH} over the last 4 weeks${partial(k.covers4w)}`],
        ["", `${k.postsPerWeek12w ?? DASH} over the last 12 weeks${partial(k.covers12w)}`],
        [
          "median gap",
          k.medianGapHours === null ? dim(DASH) : `${span(k.medianGapHours)} between posts`,
        ],
        [
          "usual slot",
          `${k.topWeekday ?? DASH} (${k.topWeekdayCount} of ${k.videos}) · ${String(k.topHour ?? 0).padStart(2, "0")}:00 (${k.topHourCount} of ${k.videos})`,
        ],
        ["time zone", k.timeZone],
        ["based on", `${k.videos} stored reel(s) with a publish date`],
      );
    }
    if (pairs.length > 0) process.stdout.write(`\n${renderRecord(pairs)}\n`);
    if (k.videos === 0) note("No stored reels with a publish date, so no posting cadence.");
    if (data.totalSnapshots < 2) {
      process.stderr.write(
        `${warn("note")} ${data.totalSnapshots} profile snapshot(s): follower growth needs two at different times. Run \`ig creator get ${oneLine(c.username)} --refresh\` again on a later day.\n`,
      );
    }
  },
});

// --- niche movers ----------------------------------------------------------------------

const MOVERS_SORT = ["growth", "followers", "velocity"] as const;

const MoverSchema = StoredCreatorSchema.pick({
  id: true,
  username: true,
  url: true,
  followers: true,
})
  .extend(FollowerGrowthSchema.shape)
  .extend({
    snapshots: z.number().int().describe("Profile snapshots stored for this creator"),
    medianVelocity: z
      .number()
      .nullable()
      .describe("Median plays/day of the creator's recent videos (published within --recent)"),
    recentVideos: z.number().int().describe("Videos behind medianVelocity"),
    recentVideosOverWindow: z
      .number()
      .int()
      .describe("Of those, how many were measured between two snapshots rather than on lifetime"),
  });
type Mover = z.infer<typeof MoverSchema>;

const movers = defineCommand({
  id: "niche.movers",
  summary: "Creators of a niche ranked by growth",
  description:
    "Reads the local database only. Ranks by follower growth over --window\n" +
    "(growth: relative, followers: per day) or by the median plays/day of the\n" +
    "videos each creator published within --recent (velocity). Follower growth\n" +
    "needs two profile snapshots: refresh the niche on different days.",
  input: z.object({
    slug: z.string(),
    window: windowFlag,
    recent: z
      .string()
      .default("30d")
      .describe("Videos published within this count towards medianVelocity: 30d, 2w or a date"),
    sort: z
      .enum(MOVERS_SORT)
      .default("growth")
      .describe(
        "growth: follower growth rate. followers: followers per day. velocity: median plays/day",
      ),
    limit: flags.limit(20),
  }),
  output: z.array(MoverSchema),
  network: false,
  writes: "none",
  configure: (cmd) =>
    cmd
      .argument("<slug>")
      .option("--window <when>", `measure growth over 12h, 7d, 2w... (default ${DEFAULT_WINDOW})`)
      .option("--recent <when>", "videos published within this count as recent (default 30d)")
      .option("--sort <key>", "growth | followers | velocity")
      .option("--limit <n>", "maximum results (default 20)"),
  args: ([slug]) => ({ slug }),
  handler: async (input, ctx) => {
    const windowMs = parseWindow(input.window);
    const recentCutoff = Date.now() - parseWindow(input.recent, Date.now(), "--recent");
    const niche = ctx.store.getNiche(input.slug);
    const { creators, videos } = velocitiesInScope(ctx, { niche: niche.slug }, windowMs);
    const profileSnapshots = ctx.store.listCreatorSnapshots({ niche: niche.slug });

    const rows: Mover[] = creators.map((c) => {
      const snapshots = profileSnapshots.get(c.id) ?? [];
      const recent = videos.filter(
        (v) =>
          v.creatorId === c.id &&
          v.velocity !== null &&
          v.takenAt !== null &&
          Date.parse(v.takenAt) >= recentCutoff,
      );
      const med = median(recent.map((v) => v.velocity as number));
      return {
        id: c.id,
        username: c.username,
        url: c.url,
        followers: c.followers,
        ...followerGrowth(snapshots, windowMs),
        snapshots: snapshots.length,
        medianVelocity: med === null ? null : round(med),
        recentVideos: recent.length,
        recentVideosOverWindow: recent.filter((v) => v.velocityBasis === "window").length,
      };
    });

    const metric = (r: Mover): number | null =>
      input.sort === "velocity"
        ? r.medianVelocity
        : input.sort === "followers"
          ? r.followersPerDay
          : r.followerGrowthRate;
    rows.sort((a, b) => {
      const ma = metric(a);
      const mb = metric(b);
      if (ma === null && mb === null) return (b.followers ?? -1) - (a.followers ?? -1);
      if (ma === null) return 1;
      if (mb === null) return -1;
      return mb - ma;
    });

    const withGrowth = rows.filter((r) => r.followersGained !== null).length;
    const meta = {
      sort: input.sort,
      window: input.window.trim(),
      recent: input.recent.trim(),
      minSpanHours: MIN_SPAN_HOURS,
      creatorsConsidered: creators.length,
      creatorsWithFollowerGrowth: withGrowth,
      creatorsWithMedianVelocity: rows.filter((r) => r.medianVelocity !== null).length,
      note:
        creators.length > 0 && withGrowth < creators.length
          ? `${creators.length - withGrowth} of ${creators.length} creators have no two profile snapshots at least ${MIN_SPAN_HOURS}h apart, so no follower growth. Run \`ig niche refresh ${niche.slug}\` again on a later day.`
          : null,
    };
    const shown = rows.slice(0, input.limit);
    const nextSteps: NextStep[] = [];
    if (creators.length === 0) {
      nextSteps.push({
        command: `ig creator add <username> --niche ${niche.slug}`,
        description: "track a creator in this niche",
      });
    } else if (withGrowth < creators.length) {
      nextSteps.push({
        command: `ig niche refresh ${niche.slug}`,
        description: "on a later day: a second snapshot is what makes growth measurable",
      });
    }
    if (shown[0]) {
      nextSteps.push({
        command: `ig creator history ${shown[0].username}`,
        description: "the top creator's follower series and posting cadence",
      });
    }
    return { data: shown, meta, nextSteps };
  },
  human: (data, _ctx, meta) => {
    const head = (header: string, key: string) => (meta.sort === key ? `${header} ↓` : header);
    const cell = (key: string, text: string) => (meta.sort === key ? emphasize(text) : quiet(text));
    printTable(
      data,
      [
        { header: "#", align: "right", cell: (_r, i) => muted(String(i + 1)) },
        { header: "CREATOR", cell: (r) => oneLine(r.username), maxWidth: 28 },
        right("FOLLOWERS", (r) => quiet(compact(r.followers))),
        right("GAINED", (r) => change(r.followersGained)),
        right(head("GROWTH", "growth"), (r) =>
          cell("growth", r.followerGrowthRate === null ? DASH : percent(r.followerGrowthRate, 2)),
        ),
        right(head("PER DAY", "followers"), (r) => cell("followers", perDay(r.followersPerDay))),
        right("OVER", (r) => quiet(span(r.spanHours))),
        right(head("MEDIAN PLAYS/DAY", "velocity"), (r) =>
          cell("velocity", perDay(r.medianVelocity)),
        ),
        right("RECENT REELS", (r) =>
          r.recentVideos === 0
            ? dim(DASH)
            : `${r.recentVideos} ${muted(`(${r.recentVideosOverWindow} measured)`)}`,
        ),
      ],
      "No creators in this niche yet.",
    );
    if (data.length > 0) {
      note(
        `\nwindow ${meta.window} · median plays/day over reels published in the last ${meta.recent}; "measured" reels have two snapshots, the rest use lifetime plays / age.`,
      );
    }
    if (typeof meta.note === "string") process.stderr.write(`${warn("note")} ${meta.note}\n`);
  },
});

export const trendsCommands = [trending, videoHistoryCmd, creatorHistoryCmd, movers];
