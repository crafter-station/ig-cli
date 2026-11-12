// What is growing now, as opposed to what is big in total. Every refresh
// stores one metrics snapshot per video and per creator; this module turns
// those series into rates. Pure functions: no database, no clock of their own.

import { IgError } from "../lib/errors.js";
import { parseSince } from "../lib/format.js";
import { MIN_VIDEOS_FOR_OUTLIER, median } from "./ranking.js";
import type { StoredVideo, VelocityFields } from "./types.js";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 7 * DAY;

export const DEFAULT_WINDOW = "7d";

/**
 * Two snapshots closer together than this say nothing about a daily rate (a
 * forced double refresh is seconds apart), so such a span is never used.
 */
export const MIN_SPAN_HOURS = 1;
const MIN_SPAN_MS = MIN_SPAN_HOURS * HOUR;

export type VideoSnapshot = {
  takenAt: string;
  plays: number | null;
  likes: number | null;
  comments: number | null;
};

export type CreatorSnapshot = {
  takenAt: string;
  followers: number | null;
  following: number | null;
  mediaCount: number | null;
};

/** `--window`: the syntax of `--since` (12h, 7d, 2w or a date), as milliseconds. */
export function parseWindow(value: string, now = Date.now()): number {
  // A bare number is a forgotten unit, not the year or month Date.parse makes of it.
  const iso = /^\d+$/.test(value.trim()) ? null : parseSince(value.trim(), now);
  const ms = iso === null ? Number.NaN : now - Date.parse(iso);
  if (!(ms >= MIN_SPAN_MS)) {
    throw new IgError("INVALID_INPUT", "--window is not a duration or a past date.", {
      hint: `Use 12h, 7d, 2w, or a date such as 2026-10-01. The minimum is ${MIN_SPAN_HOURS}h.`,
    });
  }
  return ms;
}

export function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// --- change of one counter over a window ---------------------------------------

export type Change = {
  from: string;
  to: string;
  hours: number;
  start: number;
  end: number;
  gained: number;
  perDay: number;
};

/**
 * Change of a counter between the newest reading and the latest reading at
 * least `windowMs` older. When the history is shorter than the window the
 * oldest reading is the baseline instead, so the span can be shorter than
 * asked; it is always reported. Null readings are skipped. Returns null when
 * no two readings are at least MIN_SPAN_HOURS apart.
 */
export function changeOver(
  readings: { takenAt: string; value: number | null }[],
  windowMs: number,
): Change | null {
  const points = readings
    .map((r) => ({ iso: r.takenAt, at: Date.parse(r.takenAt), value: r.value }))
    .filter((p): p is { iso: string; at: number; value: number } => {
      return p.value !== null && !Number.isNaN(p.at);
    })
    .sort((a, b) => a.at - b.at);
  const newest = points.at(-1);
  const oldest = points[0];
  if (!newest || !oldest) return null;

  let base = oldest;
  for (const p of points) {
    if (newest.at - p.at >= windowMs) base = p;
    else break;
  }
  const span = newest.at - base.at;
  if (span < MIN_SPAN_MS) return null;
  const gained = newest.value - base.value;
  return {
    from: base.iso,
    to: newest.iso,
    hours: round(span / HOUR),
    start: base.value,
    end: newest.value,
    gained,
    perDay: round(gained / (span / DAY)),
  };
}

// --- video velocity -----------------------------------------------------------

export type VideoVelocity = VelocityFields & {
  /** Plays gained per day between two snapshots. Null with fewer than two usable ones. */
  playsPerDay: number | null;
  /** Plays divided by the video's age when they were counted. */
  lifetimePlaysPerDay: number | null;
  /** Plays gained over the span. Negative when Instagram's count went down. */
  playsGained: number | null;
  spanFrom: string | null;
  spanTo: string | null;
  spanHours: number | null;
  /** Snapshots stored for the video, usable or not. */
  snapshots: number;
  creatorMedianVelocity: number | null;
};

type VideoFacts = Pick<StoredVideo, "takenAt" | "plays" | "refreshedAt">;

/**
 * One video's rate, without the per-creator score.
 *
 *   window    two snapshots far enough apart: plays gained / elapsed days.
 *             A count that went down gives 0, with the negative `playsGained`.
 *   lifetime  the fallback: plays / age at the time they were counted. Says
 *             how fast the video has grown on average, not how fast it grows now.
 *   null      hidden play counts, or one snapshot and no publish date.
 */
export function videoVelocity(
  video: VideoFacts,
  snapshots: VideoSnapshot[],
  windowMs: number,
): Omit<VideoVelocity, "velocityScore" | "creatorMedianVelocity"> {
  const change = changeOver(
    snapshots.map((s) => ({ takenAt: s.takenAt, value: s.plays })),
    windowMs,
  );

  // The newest count and the moment it was read.
  let latest: { at: string; plays: number } | null = null;
  for (const s of snapshots) {
    if (s.plays === null) continue;
    if (latest === null || Date.parse(s.takenAt) >= Date.parse(latest.at)) {
      latest = { at: s.takenAt, plays: s.plays };
    }
  }
  if (latest === null && video.plays !== null) {
    latest = { at: video.refreshedAt, plays: video.plays };
  }

  let lifetimePlaysPerDay: number | null = null;
  let ageMs: number | null = null;
  if (latest !== null && video.takenAt !== null) {
    const age = Date.parse(latest.at) - Date.parse(video.takenAt);
    if (age >= MIN_SPAN_MS) {
      ageMs = age;
      lifetimePlaysPerDay = round(latest.plays / (age / DAY));
    }
  }

  const count = snapshots.length;
  if (change) {
    const playsPerDay = Math.max(0, change.perDay);
    return {
      velocity: playsPerDay,
      velocityBasis: "window",
      playsPerDay,
      lifetimePlaysPerDay,
      playsGained: change.gained,
      spanFrom: change.from,
      spanTo: change.to,
      spanHours: change.hours,
      snapshots: count,
    };
  }
  if (lifetimePlaysPerDay !== null && latest !== null && ageMs !== null) {
    return {
      velocity: lifetimePlaysPerDay,
      velocityBasis: "lifetime",
      playsPerDay: null,
      lifetimePlaysPerDay,
      playsGained: latest.plays,
      spanFrom: video.takenAt,
      spanTo: latest.at,
      spanHours: round(ageMs / HOUR),
      snapshots: count,
    };
  }
  return {
    velocity: null,
    velocityBasis: null,
    playsPerDay: null,
    lifetimePlaysPerDay: null,
    playsGained: null,
    spanFrom: null,
    spanTo: null,
    spanHours: null,
    snapshots: count,
  };
}

/**
 * Velocity of every video, keyed by video id, with `velocityScore`: the
 * video's plays/day divided by the median plays/day of that creator's videos.
 * As with the outlier score, pass every stored video of the creators involved
 * and filter afterwards. The score is null for a creator with fewer than
 * MIN_VIDEOS_FOR_OUTLIER measurable videos or a median of zero.
 */
export function computeVelocities(
  videos: StoredVideo[],
  snapshots: Map<string, VideoSnapshot[]>,
  windowMs: number,
): Map<string, VideoVelocity> {
  const raw = videos.map((v) => ({
    video: v,
    velocity: videoVelocity(v, snapshots.get(v.id) ?? [], windowMs),
  }));

  const byCreator = new Map<string, number[]>();
  for (const { video, velocity } of raw) {
    if (velocity.velocity === null) continue;
    const list = byCreator.get(video.creatorId) ?? [];
    list.push(velocity.velocity);
    byCreator.set(video.creatorId, list);
  }
  const medians = new Map<string, number | null>();
  for (const [creatorId, values] of byCreator) {
    medians.set(creatorId, values.length >= MIN_VIDEOS_FOR_OUTLIER ? median(values) : null);
  }

  const out = new Map<string, VideoVelocity>();
  for (const { video, velocity } of raw) {
    const med = medians.get(video.creatorId) ?? null;
    out.set(video.id, {
      ...velocity,
      velocityScore:
        velocity.velocity !== null && med !== null && med > 0
          ? round(velocity.velocity / med)
          : null,
      creatorMedianVelocity: med === null ? null : round(med),
    });
  }
  return out;
}

// --- series with deltas ---------------------------------------------------------

const delta = (now: number | null, before: number | null | undefined): number | null =>
  now === null || before === null || before === undefined ? null : now - before;

/** Hours between two snapshots, and a per-day rate when the span is long enough. */
function step(
  at: string,
  previousAt: string | undefined,
  gained: number | null,
): { hours: number | null; perDay: number | null } {
  if (previousAt === undefined) return { hours: null, perDay: null };
  const ms = Date.parse(at) - Date.parse(previousAt);
  return {
    hours: round(ms / HOUR),
    perDay: gained !== null && ms >= MIN_SPAN_MS ? round(gained / (ms / DAY)) : null,
  };
}

export type VideoHistoryRow = VideoSnapshot & {
  playsDelta: number | null;
  likesDelta: number | null;
  commentsDelta: number | null;
  hoursSincePrevious: number | null;
  playsPerDay: number | null;
};

/** Oldest first. Deltas compare with the snapshot right before; raw, so they can be negative. */
export function videoHistory(snapshots: VideoSnapshot[]): VideoHistoryRow[] {
  const sorted = [...snapshots].sort((a, b) => Date.parse(a.takenAt) - Date.parse(b.takenAt));
  return sorted.map((s, i) => {
    const prev = sorted[i - 1];
    const playsDelta = delta(s.plays, prev?.plays);
    const { hours, perDay } = step(s.takenAt, prev?.takenAt, playsDelta);
    return {
      ...s,
      playsDelta,
      likesDelta: delta(s.likes, prev?.likes),
      commentsDelta: delta(s.comments, prev?.comments),
      hoursSincePrevious: hours,
      playsPerDay: perDay,
    };
  });
}

export type CreatorHistoryRow = CreatorSnapshot & {
  followersDelta: number | null;
  followingDelta: number | null;
  mediaCountDelta: number | null;
  hoursSincePrevious: number | null;
  followersPerDay: number | null;
};

export function creatorHistory(snapshots: CreatorSnapshot[]): CreatorHistoryRow[] {
  const sorted = [...snapshots].sort((a, b) => Date.parse(a.takenAt) - Date.parse(b.takenAt));
  return sorted.map((s, i) => {
    const prev = sorted[i - 1];
    const followersDelta = delta(s.followers, prev?.followers);
    const { hours, perDay } = step(s.takenAt, prev?.takenAt, followersDelta);
    return {
      ...s,
      followersDelta,
      followingDelta: delta(s.following, prev?.following),
      mediaCountDelta: delta(s.mediaCount, prev?.mediaCount),
      hoursSincePrevious: hours,
      followersPerDay: perDay,
    };
  });
}

export type FollowerGrowth = {
  followersGained: number | null;
  followersPerDay: number | null;
  /** Gained divided by the followers at the start of the span. 0.05 is +5%. */
  followerGrowthRate: number | null;
  spanFrom: string | null;
  spanTo: string | null;
  spanHours: number | null;
};

export function followerGrowth(snapshots: CreatorSnapshot[], windowMs: number): FollowerGrowth {
  const change = changeOver(
    snapshots.map((s) => ({ takenAt: s.takenAt, value: s.followers })),
    windowMs,
  );
  if (!change) {
    return {
      followersGained: null,
      followersPerDay: null,
      followerGrowthRate: null,
      spanFrom: null,
      spanTo: null,
      spanHours: null,
    };
  }
  return {
    followersGained: change.gained,
    followersPerDay: change.perDay,
    followerGrowthRate: change.start > 0 ? round(change.gained / change.start, 4) : null,
    spanFrom: change.from,
    spanTo: change.to,
    spanHours: change.hours,
  };
}

// --- posting cadence ------------------------------------------------------------

export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export type Cadence = {
  /** IANA zone the weekday and hour are expressed in. */
  timeZone: string;
  /** Stored videos with a known publish date; the cadence is computed from these only. */
  videos: number;
  oldestAt: string | null;
  newestAt: string | null;
  postsPerWeek4w: number | null;
  postsPerWeek12w: number | null;
  /** False when the stored videos do not reach back the whole period. */
  covers4w: boolean;
  covers12w: boolean;
  medianGapHours: number | null;
  topWeekday: (typeof WEEKDAYS)[number] | null;
  topWeekdayCount: number;
  /** 0-23. */
  topHour: number | null;
  topHourCount: number;
  /** Posts per weekday, Sunday first. */
  byWeekday: number[];
  /** Posts per hour of the day, 0 first. */
  byHour: number[];
};

function localParts(at: number, timeZone: string): { weekday: number; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  return { weekday: Math.max(0, WEEKDAYS.indexOf(weekday as (typeof WEEKDAYS)[number])), hour };
}

function busiest(counts: number[]): { index: number | null; count: number } {
  let index: number | null = null;
  let count = 0;
  counts.forEach((c, i) => {
    if (c > count) {
      index = i;
      count = c;
    }
  });
  return { index, count };
}

/**
 * How often and when a creator posts, from the publish dates of the videos
 * stored locally. A refresh fetches only the latest reels, so the store may
 * not reach back a whole period: the rate is then taken over the part that
 * is covered (at least one week) and `covers4w` / `covers12w` say so.
 */
export function postingCadence(
  takenAts: (string | null)[],
  opts: { now: number; timeZone: string },
): Cadence {
  const times = takenAts
    .filter((t): t is string => t !== null)
    .map((t) => Date.parse(t))
    .filter((t) => !Number.isNaN(t) && t <= opts.now)
    .sort((a, b) => a - b);
  const oldest = times[0];
  const newest = times.at(-1);

  const rate = (weeks: number): { perWeek: number | null; covers: boolean } => {
    if (oldest === undefined) return { perWeek: null, covers: false };
    const start = opts.now - weeks * WEEK;
    const covers = oldest <= start;
    const coveredWeeks = covers ? weeks : Math.max(1, (opts.now - oldest) / WEEK);
    const posts = times.filter((t) => t >= start).length;
    return { perWeek: round(posts / coveredWeeks), covers };
  };
  const four = rate(4);
  const twelve = rate(12);

  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) {
    gaps.push(((times[i] as number) - (times[i - 1] as number)) / HOUR);
  }
  const gap = median(gaps);

  const byWeekday = new Array<number>(7).fill(0);
  const byHour = new Array<number>(24).fill(0);
  for (const t of times) {
    const { weekday, hour } = localParts(t, opts.timeZone);
    byWeekday[weekday] = (byWeekday[weekday] ?? 0) + 1;
    byHour[hour] = (byHour[hour] ?? 0) + 1;
  }
  const day = busiest(byWeekday);
  const hour = busiest(byHour);

  return {
    timeZone: opts.timeZone,
    videos: times.length,
    oldestAt: oldest === undefined ? null : new Date(oldest).toISOString(),
    newestAt: newest === undefined ? null : new Date(newest).toISOString(),
    postsPerWeek4w: four.perWeek,
    postsPerWeek12w: twelve.perWeek,
    covers4w: four.covers,
    covers12w: twelve.covers,
    medianGapHours: gap === null ? null : round(gap),
    topWeekday: day.index === null ? null : (WEEKDAYS[day.index] ?? null),
    topWeekdayCount: day.count,
    topHour: hour.index,
    topHourCount: hour.count,
    byWeekday,
    byHour,
  };
}

/** The machine's IANA time zone, e.g. America/Lima. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
