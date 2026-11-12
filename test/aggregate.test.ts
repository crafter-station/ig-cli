import { describe, expect, it } from "vitest";
import { audioStats, durationStats, groupStats, tagStats } from "../src/core/aggregate.js";
import type { RankedVideo } from "../src/core/types.js";

let seq = 0;
function ranked(over: Partial<RankedVideo>): RankedVideo {
  const id = over.id ?? `v${++seq}`;
  return {
    id,
    shortcode: over.shortcode ?? id,
    url: `https://www.instagram.com/reel/${id}/`,
    creatorId: "1",
    creatorUsername: "ana",
    caption: null,
    takenAt: "2026-11-01T00:00:00.000Z",
    durationSec: null,
    plays: 100,
    likes: 10,
    comments: 1,
    thumbnailUrl: null,
    videoUrl: null,
    localPath: null,
    downloadedAt: null,
    firstSeenAt: "2026-11-01T00:00:00.000Z",
    refreshedAt: "2026-11-01T00:00:00.000Z",
    audio: null,
    hashtags: [],
    mentions: [],
    width: null,
    height: null,
    cuts: null,
    cutsPerMin: null,
    framesDir: null,
    analyzedAt: null,
    hasTranscript: false,
    outlierScore: 1,
    engagementRate: null,
    creatorFollowers: 1000,
    creatorMedianPlays: 100,
    ...over,
  };
}

const opts = { minVideos: 1, sort: "videos", limit: 50 } as const;

describe("groupStats", () => {
  it("uses medians and ignores missing values", () => {
    const stats = groupStats([
      ranked({ id: "a", plays: 100, outlierScore: 1 }),
      ranked({ id: "b", plays: 300, outlierScore: 4, creatorId: "2", creatorUsername: "beto" }),
      ranked({ id: "c", plays: 10_000, outlierScore: null }),
      ranked({ id: "d", plays: null, outlierScore: null }),
    ]);
    expect(stats).toEqual({
      videos: 4,
      creators: 2,
      medianPlays: 300,
      medianOutlier: 2.5,
      bestShortcode: "b",
      bestCreator: "beto",
      bestPlays: 300,
      bestOutlier: 4,
    });
  });

  it("falls back to plays for the best video when nothing has a score", () => {
    const stats = groupStats([
      ranked({ id: "a", plays: 100, outlierScore: null }),
      ranked({ id: "b", plays: 900, outlierScore: null }),
      ranked({ id: "c", plays: null, outlierScore: null }),
    ]);
    expect(stats).toMatchObject({ bestShortcode: "b", bestOutlier: null, medianOutlier: null });
  });

  it("is all nulls for an empty group", () => {
    expect(groupStats([])).toEqual({
      videos: 0,
      creators: 0,
      medianPlays: null,
      medianOutlier: null,
      bestShortcode: null,
      bestCreator: null,
      bestPlays: null,
      bestOutlier: null,
    });
  });
});

describe("tagStats", () => {
  const videos = [
    ranked({ id: "a", hashtags: ["pasta", "receta"], plays: 100, outlierScore: 1 }),
    ranked({ id: "b", hashtags: ["pasta"], plays: 500, outlierScore: 5 }),
    ranked({
      id: "c",
      hashtags: ["receta", "vegano"],
      plays: 50,
      outlierScore: 0.5,
      creatorId: "2",
      creatorUsername: "beto",
    }),
    ranked({ id: "d", hashtags: [], plays: 70 }),
  ];

  it("counts videos and creators per tag, most used first", () => {
    const result = tagStats(videos, opts);
    expect(result.rows.map((r) => [r.tag, r.videos, r.creators])).toEqual([
      ["receta", 2, 2],
      ["pasta", 2, 1],
      ["vegano", 1, 1],
    ]);
    expect(result).toMatchObject({ groups: 3, belowMinVideos: 0, videosWithData: 3 });
    expect(result.rows.find((r) => r.tag === "pasta")).toMatchObject({
      medianPlays: 300,
      medianOutlier: 3,
      bestShortcode: "b",
    });
  });

  it("sorts by median outlier, by creators and by median plays", () => {
    expect(tagStats(videos, { ...opts, sort: "outlier" }).rows.map((r) => r.tag)).toEqual([
      "pasta",
      "receta",
      "vegano",
    ]);
    expect(tagStats(videos, { ...opts, sort: "creators" }).rows[0]?.tag).toBe("receta");
    expect(tagStats(videos, { ...opts, sort: "plays" }).rows.map((r) => r.tag)).toEqual([
      "pasta",
      "receta",
      "vegano",
    ]);
  });

  it("puts groups without a score last when sorting by outlier", () => {
    const rows = tagStats(
      [
        ranked({ hashtags: ["sinscore"], outlierScore: null, plays: 9_999_999 }),
        ranked({ hashtags: ["sinscore"], outlierScore: null }),
        ranked({ hashtags: ["bajo"], outlierScore: 0.1 }),
      ],
      { ...opts, sort: "outlier" },
    ).rows;
    expect(rows.map((r) => r.tag)).toEqual(["bajo", "sinscore"]);
  });

  it("applies --min-videos before --limit and reports what it dropped", () => {
    const result = tagStats(videos, { minVideos: 2, sort: "videos", limit: 1 });
    expect(result.rows.map((r) => r.tag)).toEqual(["receta"]);
    expect(result).toMatchObject({ groups: 3, belowMinVideos: 1 });
  });

  it("counts a tag repeated in one video once", () => {
    const result = tagStats([ranked({ hashtags: ["pasta", "pasta"] })], opts);
    expect(result.rows[0]?.videos).toBe(1);
  });
});

describe("audioStats", () => {
  const sound = (id: string | null, title: string | null, artist: string | null = null) => ({
    id,
    title,
    artist,
    isOriginal: false,
  });

  it("groups by audio id and reports the sound's details", () => {
    const result = audioStats(
      [
        ranked({ id: "a", audio: sound("77", "Tema", "Banda"), plays: 100, outlierScore: 1 }),
        ranked({
          id: "b",
          audio: sound("77", null),
          plays: 900,
          outlierScore: 3,
          creatorId: "2",
          creatorUsername: "beto",
        }),
        ranked({ id: "c", audio: sound("88", "Otro") }),
        ranked({ id: "d", audio: null }),
      ],
      opts,
    );
    expect(result).toMatchObject({ groups: 2, videosWithData: 3 });
    expect(result.rows[0]).toMatchObject({
      id: "77",
      title: "Tema",
      artist: "Banda",
      isOriginal: false,
      videos: 2,
      creators: 2,
      medianPlays: 500,
      medianOutlier: 2,
      bestShortcode: "b",
    });
  });

  it("falls back to title and artist when there is no id", () => {
    const result = audioStats(
      [
        ranked({ audio: sound(null, "Tema", "Banda") }),
        ranked({ audio: sound(null, " tema ", "BANDA") }),
        ranked({ audio: sound(null, "Tema", "Otra") }),
      ],
      opts,
    );
    expect(result.rows.map((r) => [r.title, r.artist, r.videos])).toEqual([
      ["Tema", "Banda", 2],
      ["Tema", "Otra", 1],
    ]);
  });

  it("ignores audio objects that identify nothing", () => {
    const result = audioStats([ranked({ audio: sound(null, null) })], opts);
    expect(result).toMatchObject({ rows: [], groups: 0, videosWithData: 0 });
  });

  it("is an empty result when no video has audio", () => {
    expect(audioStats([ranked({}), ranked({})], opts)).toEqual({
      rows: [],
      groups: 0,
      belowMinVideos: 0,
      videosWithData: 0,
    });
  });
});

describe("durationStats", () => {
  it("buckets with an inclusive lower and exclusive upper bound", () => {
    const result = durationStats(
      [0.5, 14.99, 15, 29.9, 30, 59, 60, 89.999, 90, 600].map((durationSec, i) =>
        ranked({ id: `d${i}`, durationSec }),
      ),
    );
    expect(result.rows.map((r) => [r.bucket, r.videos])).toEqual([
      ["<15s", 2],
      ["15-30s", 2],
      ["30-60s", 2],
      ["60-90s", 2],
      [">90s", 2],
    ]);
    expect(result.rows[4]).toMatchObject({ minSec: 90, maxSec: null });
  });

  it("lists empty buckets and counts videos without a duration apart", () => {
    const result = durationStats([
      ranked({ id: "a", durationSec: 20, plays: 400, outlierScore: 2 }),
      ranked({ id: "b", durationSec: null, localPath: "/x/b.mp4" }),
      ranked({ id: "c", durationSec: null }),
    ]);
    expect(result).toMatchObject({
      withDuration: 1,
      withoutDuration: 2,
      withoutDurationDownloaded: 1,
    });
    expect(result.rows).toHaveLength(5);
    expect(result.rows[0]).toMatchObject({ bucket: "<15s", videos: 0, medianPlays: null });
    expect(result.rows[1]).toMatchObject({ videos: 1, medianPlays: 400, bestShortcode: "a" });
  });
});
