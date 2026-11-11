import { describe, expect, it } from "vitest";
import { median, rankVideos, sortVideos } from "../src/core/ranking.js";
import type { StoredVideo } from "../src/core/types.js";
import { video } from "./helpers.js";

const stored = (id: string, creatorId: string, plays: number | null, extra = {}): StoredVideo => ({
  ...video({ id, creatorId, creatorUsername: `u${creatorId}`, plays, ...extra }),
  localPath: null,
  downloadedAt: null,
  firstSeenAt: "2026-11-01T00:00:00.000Z",
  refreshedAt: "2026-11-01T00:00:00.000Z",
});

describe("median", () => {
  it("handles empty, single, odd and even sets", () => {
    expect(median([])).toBeNull();
    expect(median([7])).toBe(7);
    expect(median([9, 1, 5])).toBe(5);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe("rankVideos", () => {
  const creators = new Map([
    ["big", { followers: 1_000_000 as number | null }],
    ["small", { followers: 1_000 }],
    ["tiny", { followers: null }],
  ]);
  const videos = [
    stored("b1", "big", 500_000),
    stored("b2", "big", 500_000),
    stored("b3", "big", 600_000),
    stored("s1", "small", 1_000),
    stored("s2", "small", 1_000),
    stored("s3", "small", 10_000, { likes: 400, comments: 100 }),
    stored("t1", "tiny", 50),
    stored("h1", "small", null),
  ];
  const ranked = rankVideos(videos, creators);
  const by = (id: string) => ranked.find((v) => v.id === id);

  it("scores against the creator's own median, so a small account can outrank a big one", () => {
    expect(by("s3")?.outlierScore).toBe(10);
    expect(by("b3")?.outlierScore).toBe(1.2);
    expect(sortVideos(ranked, "outlier")[0]?.id).toBe("s3");
    expect(sortVideos(ranked, "plays")[0]?.id).toBe("b3");
  });

  it("gives no outlier score with too few videos or hidden plays", () => {
    expect(by("t1")?.outlierScore).toBeNull();
    expect(by("h1")?.outlierScore).toBeNull();
  });

  it("computes engagement against followers, null when followers are unknown", () => {
    expect(by("s3")?.engagementRate).toBe(0.5);
    expect(by("t1")?.engagementRate).toBeNull();
  });

  it("sorts videos missing the metric last, never first", () => {
    const order = sortVideos(ranked, "outlier").map((v) => v.id);
    expect(order.slice(-2).sort()).toEqual(["h1", "t1"]);
  });

  it("sorts by recency across a year boundary", () => {
    const dated = rankVideos(
      [
        stored("old", "big", 1, { takenAt: "2025-12-31T23:59:59.000Z" }),
        stored("new", "big", 1, { takenAt: "2026-01-01T00:00:00.000Z" }),
        stored("none", "big", 1, { takenAt: null }),
      ],
      creators,
    );
    expect(sortVideos(dated, "recent").map((v) => v.id)).toEqual(["new", "old", "none"]);
  });
});
