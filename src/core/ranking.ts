// "Trending for a creator" means a video that did unusually well *for them*,
// not a video with a big absolute number because the account is big.

import type { RankedVideo, SortKey, StoredVideo } from "./types.js";

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid] as number;
  if (sorted.length % 2 === 1) return hi;
  return ((sorted[mid - 1] as number) + hi) / 2;
}

/** Fewer videos than this and a median says nothing; the score stays null. */
export const MIN_VIDEOS_FOR_OUTLIER = 3;

export type CreatorStats = { followers: number | null };

/**
 * Attaches per-creator relative metrics. The median is computed over the
 * videos passed in, so callers should pass every stored video for the
 * creators involved, not a pre-filtered slice.
 */
export function rankVideos(
  videos: StoredVideo[],
  creators: Map<string, CreatorStats>,
): RankedVideo[] {
  const playsByCreator = new Map<string, number[]>();
  for (const v of videos) {
    if (v.plays === null) continue;
    const list = playsByCreator.get(v.creatorId) ?? [];
    list.push(v.plays);
    playsByCreator.set(v.creatorId, list);
  }

  const medians = new Map<string, number | null>();
  for (const [creatorId, plays] of playsByCreator) {
    medians.set(creatorId, plays.length >= MIN_VIDEOS_FOR_OUTLIER ? median(plays) : null);
  }

  return videos.map((v) => {
    const med = medians.get(v.creatorId) ?? null;
    const followers = creators.get(v.creatorId)?.followers ?? null;
    const outlierScore = v.plays !== null && med !== null && med > 0 ? round(v.plays / med) : null;
    const engagementRate =
      followers !== null && followers > 0 && v.likes !== null
        ? round(((v.likes ?? 0) + (v.comments ?? 0)) / followers, 4)
        : null;
    return {
      ...v,
      outlierScore,
      engagementRate,
      creatorFollowers: followers,
      creatorMedianPlays: med,
    };
  });
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function metric(v: RankedVideo, key: SortKey): number | null {
  switch (key) {
    case "outlier":
      return v.outlierScore;
    case "plays":
      return v.plays;
    case "engagement":
      return v.engagementRate;
    case "likes":
      return v.likes;
    case "comments":
      return v.comments;
    case "recent":
      return v.takenAt ? Date.parse(v.takenAt) : null;
  }
}

/** Descending by the chosen metric. Videos missing the metric sort last, never first. */
export function sortVideos(videos: RankedVideo[], key: SortKey): RankedVideo[] {
  return [...videos].sort((a, b) => {
    const ma = metric(a, key);
    const mb = metric(b, key);
    if (ma === null && mb === null) return (b.plays ?? -1) - (a.plays ?? -1);
    if (ma === null) return 1;
    if (mb === null) return -1;
    return mb - ma;
  });
}
