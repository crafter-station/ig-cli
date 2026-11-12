// What repeats across a niche, and how it performed: hashtags, sounds and
// lengths. Pure functions over ranked videos; the commands do the loading.
//
// Every group reports medians, not means: one viral reel must not make a
// hashtag look good. The outlier score comes from `rankVideos`, so it is
// relative to each creator's own usual numbers.

import { round } from "../lib/math.js";
import { median } from "./ranking.js";
import type { RankedVideo } from "./types.js";

export type GroupStats = {
  videos: number;
  creators: number;
  medianPlays: number | null;
  medianOutlier: number | null;
  bestShortcode: string | null;
  bestCreator: string | null;
  bestPlays: number | null;
  bestOutlier: number | null;
};

export const AGGREGATE_SORTS = ["videos", "outlier", "creators", "plays"] as const;
export type AggregateSort = (typeof AGGREGATE_SORTS)[number];

const round2 = (n: number | null): number | null => (n === null ? null : round(n));

const numbers = (values: (number | null)[]): number[] =>
  values.filter((v): v is number => v !== null);

/** The video that did best for its creator; by plays when nothing has a score. */
function best(videos: RankedVideo[]): RankedVideo | null {
  let top: RankedVideo | null = null;
  for (const v of videos) {
    if (top === null) {
      top = v;
      continue;
    }
    const a = v.outlierScore;
    const b = top.outlierScore;
    if (a !== null && b !== null ? a > b : a !== null && b === null) top = v;
    else if (a === b && (v.plays ?? -1) > (top.plays ?? -1)) top = v;
  }
  return top;
}

export function groupStats(videos: RankedVideo[]): GroupStats {
  const top = best(videos);
  return {
    videos: videos.length,
    creators: new Set(videos.map((v) => v.creatorId)).size,
    medianPlays: median(numbers(videos.map((v) => v.plays))),
    medianOutlier: round2(median(numbers(videos.map((v) => v.outlierScore)))),
    bestShortcode: top?.shortcode ?? null,
    bestCreator: top?.creatorUsername ?? null,
    bestPlays: top?.plays ?? null,
    bestOutlier: top?.outlierScore ?? null,
  };
}

/** Descending by the chosen column, nulls last; ties fall back to videos, then the label. */
function sortRows<T extends GroupStats>(rows: T[], sort: AggregateSort, label: (r: T) => string) {
  const value = (r: T): number | null =>
    sort === "outlier"
      ? r.medianOutlier
      : sort === "plays"
        ? r.medianPlays
        : sort === "creators"
          ? r.creators
          : r.videos;
  return [...rows].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va !== vb) {
      if (va === null) return 1;
      if (vb === null) return -1;
      return vb - va;
    }
    if (a.videos !== b.videos) return b.videos - a.videos;
    if (a.creators !== b.creators) return b.creators - a.creators;
    return label(a).localeCompare(label(b));
  });
}

export type AggregateOptions = { minVideos: number; sort: AggregateSort; limit: number };

export type Aggregate<T> = {
  rows: T[];
  /** Distinct groups before `minVideos` and `limit`. */
  groups: number;
  /** Groups dropped by `minVideos`. */
  belowMinVideos: number;
  /** Videos that belong to at least one group. */
  videosWithData: number;
};

function finish<T extends GroupStats>(
  all: T[],
  videosWithData: number,
  opts: AggregateOptions,
  label: (r: T) => string,
): Aggregate<T> {
  const kept = all.filter((r) => r.videos >= opts.minVideos);
  return {
    rows: sortRows(kept, opts.sort, label).slice(0, opts.limit),
    groups: all.length,
    belowMinVideos: all.length - kept.length,
    videosWithData,
  };
}

// --- hashtags ----------------------------------------------------------------

export type TagRow = GroupStats & { tag: string };

export function tagStats(videos: RankedVideo[], opts: AggregateOptions): Aggregate<TagRow> {
  const byTag = new Map<string, RankedVideo[]>();
  let withTags = 0;
  for (const v of videos) {
    const tags = new Set(v.hashtags);
    if (tags.size > 0) withTags++;
    for (const tag of tags) {
      const list = byTag.get(tag) ?? [];
      list.push(v);
      byTag.set(tag, list);
    }
  }
  const rows = [...byTag].map(([tag, list]) => ({ tag, ...groupStats(list) }));
  return finish(rows, withTags, opts, (r) => r.tag);
}

// --- sounds ------------------------------------------------------------------

export type AudioRow = GroupStats & {
  id: string | null;
  title: string | null;
  artist: string | null;
  isOriginal: boolean | null;
};

/** The id identifies a sound; without one, title and artist together have to do. */
function audioKey(audio: NonNullable<RankedVideo["audio"]>): string | null {
  if (audio.id) return `id:${audio.id}`;
  const title = audio.title?.trim().toLowerCase() ?? "";
  const artist = audio.artist?.trim().toLowerCase() ?? "";
  return title === "" && artist === "" ? null : `name:${title}\u0000${artist}`;
}

export function audioStats(videos: RankedVideo[], opts: AggregateOptions): Aggregate<AudioRow> {
  const bySound = new Map<string, RankedVideo[]>();
  let withAudio = 0;
  for (const v of videos) {
    const key = v.audio ? audioKey(v.audio) : null;
    if (key === null) continue;
    withAudio++;
    const list = bySound.get(key) ?? [];
    list.push(v);
    bySound.set(key, list);
  }
  const rows = [...bySound.values()].map((list) => {
    // Rows of one sound can differ in how complete they are; take the first value known.
    const pick = <K extends "id" | "title" | "artist" | "isOriginal">(k: K) =>
      list.map((v) => v.audio?.[k] ?? null).find((x) => x !== null) ?? null;
    return {
      id: pick("id") as string | null,
      title: pick("title") as string | null,
      artist: pick("artist") as string | null,
      isOriginal: pick("isOriginal") as boolean | null,
      ...groupStats(list),
    };
  });
  return finish(rows, withAudio, opts, (r) => r.title ?? r.id ?? "");
}

// --- durations ---------------------------------------------------------------

/** Lower bound inclusive, upper bound exclusive; the last bucket is open-ended. */
export const DURATION_BUCKETS: { bucket: string; minSec: number; maxSec: number | null }[] = [
  { bucket: "<15s", minSec: 0, maxSec: 15 },
  { bucket: "15-30s", minSec: 15, maxSec: 30 },
  { bucket: "30-60s", minSec: 30, maxSec: 60 },
  { bucket: "60-90s", minSec: 60, maxSec: 90 },
  { bucket: ">90s", minSec: 90, maxSec: null },
];

export type DurationRow = GroupStats & {
  bucket: string;
  minSec: number;
  maxSec: number | null;
};

export type DurationStats = {
  /** Always every bucket, in order, including empty ones. */
  rows: DurationRow[];
  withDuration: number;
  withoutDuration: number;
  /** Of those without a duration, how many have a file on disk to measure. */
  withoutDurationDownloaded: number;
};

/** `fileExists` lets the caller discount files that were downloaded and later removed. */
export function durationStats(
  videos: RankedVideo[],
  fileExists: (path: string) => boolean = () => true,
): DurationStats {
  const measured = videos.filter((v) => v.durationSec !== null);
  const unmeasured = videos.filter((v) => v.durationSec === null);
  return {
    rows: DURATION_BUCKETS.map((b) => ({
      ...b,
      ...groupStats(
        measured.filter((v) => {
          const d = v.durationSec as number;
          return d >= b.minSec && (b.maxSec === null || d < b.maxSec);
        }),
      ),
    })),
    withDuration: measured.length,
    withoutDuration: unmeasured.length,
    withoutDurationDownloaded: unmeasured.filter(
      (v) => v.localPath !== null && fileExists(v.localPath),
    ).length,
  };
}
