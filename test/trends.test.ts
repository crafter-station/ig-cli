import { describe, expect, it } from "vitest";
import { rankVideos, sortVideos } from "../src/core/ranking.js";
import {
  type CreatorSnapshot,
  changeOver,
  computeVelocities,
  creatorHistory,
  followerGrowth,
  MIN_SPAN_HOURS,
  parseWindow,
  postingCadence,
  type VideoSnapshot,
  videoHistory,
  videoVelocity,
} from "../src/core/trends.js";
import type { StoredVideo, VelocityFields } from "../src/core/types.js";
import { IgError } from "../src/lib/errors.js";
import { video } from "./helpers.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Midnight UTC of a day of November 2026, optionally at hh:mm:ss. */
const nov = (day: number, time = "00:00:00"): string =>
  `2026-11-${String(day).padStart(2, "0")}T${time}.000Z`;

const stored = (id: string, creatorId: string, plays: number | null, extra = {}): StoredVideo => ({
  ...video({ id, creatorId, creatorUsername: `u${creatorId}`, plays, ...extra }),
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
});

const plays = (takenAt: string, value: number | null): VideoSnapshot => ({
  takenAt,
  plays: value,
  likes: null,
  comments: null,
});

const followers = (takenAt: string, value: number | null): CreatorSnapshot => ({
  takenAt,
  followers: value,
  following: null,
  mediaCount: null,
});

function invalid(fn: () => unknown): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(IgError);
  expect(thrown).toMatchObject({ code: "INVALID_INPUT" });
}

describe("parseWindow", () => {
  it("rejects a bare number instead of reading it as a date", () => {
    for (const bad of ["12", "7", "2020"]) {
      expect(() => parseWindow(bad)).toThrowError(
        expect.objectContaining({ code: "INVALID_INPUT" }),
      );
    }
  });
  const now = Date.parse("2026-11-12T00:00:00.000Z");

  it("the minimum span is one hour", () => {
    expect(MIN_SPAN_HOURS).toBe(1);
  });

  it("turns 12h, 7d and 2w into milliseconds", () => {
    expect(parseWindow("12h", now)).toBe(43_200_000); // 12 * 3.6e6
    expect(parseWindow("7d", now)).toBe(604_800_000); // 7 * 86.4e6
    expect(parseWindow("2w", now)).toBe(1_209_600_000); // 14 * 86.4e6
    expect(parseWindow("1h", now)).toBe(3_600_000); // exactly the minimum
    expect(parseWindow("  7d ", now)).toBe(604_800_000);
  });

  it("measures a past date against the injected now", () => {
    // 2026-11-05T00:00Z is 7 days before 2026-11-12T00:00Z.
    expect(parseWindow("2026-11-05", now)).toBe(7 * DAY);
    expect(parseWindow("2026-11-11T12:00:00.000Z", now)).toBe(12 * HOUR);
    // The same date is a different window from a different now.
    expect(parseWindow("2026-11-05", now + DAY)).toBe(8 * DAY);
  });

  it("rejects garbage with INVALID_INPUT", () => {
    invalid(() => parseWindow("garbage", now));
    invalid(() => parseWindow("", now));
    invalid(() => parseWindow("d7", now));
  });

  it("rejects a zero duration", () => {
    invalid(() => parseWindow("0d", now));
    invalid(() => parseWindow("0h", now));
  });

  it("rejects a future date and now itself", () => {
    invalid(() => parseWindow("2026-12-01", now));
    invalid(() => parseWindow("2026-11-12T00:00:00.000Z", now));
  });

  it("rejects anything below the minimum span", () => {
    // 30 minutes before now.
    invalid(() => parseWindow("2026-11-11T23:30:00.000Z", now));
    // 59 minutes 59 seconds before now.
    invalid(() => parseWindow("2026-11-11T23:00:01.000Z", now));
    // Exactly one hour is accepted.
    expect(parseWindow("2026-11-11T23:00:00.000Z", now)).toBe(HOUR);
  });

  it("names the minimum in the hint", () => {
    try {
      parseWindow("nope", now);
      expect.unreachable();
    } catch (error) {
      expect((error as IgError).hint).toContain("1h");
    }
  });
});

describe("changeOver", () => {
  const series = [
    { takenAt: nov(1), value: 100 },
    { takenAt: nov(3), value: 200 },
    { takenAt: nov(8), value: 500 },
    { takenAt: nov(10), value: 900 },
  ];

  it("takes the latest reading at least the window older than the newest", () => {
    // Newest is Nov 10. Nov 1 (9d) and Nov 3 (exactly 7d) qualify; the latest is Nov 3.
    // 900 - 200 = 700 over 7 days = 168h -> 100/day.
    expect(changeOver(series, 7 * DAY)).toEqual({
      from: nov(3),
      to: nov(10),
      hours: 168,
      start: 200,
      end: 900,
      gained: 700,
      perDay: 100,
    });
    // Window 2d: Nov 8 is exactly 2 days older. 900 - 500 = 400 over 48h -> 200/day.
    expect(changeOver(series, 2 * DAY)).toMatchObject({
      from: nov(8),
      hours: 48,
      gained: 400,
      perDay: 200,
    });
    // Window 3d: Nov 8 is only 2 days older, so the baseline steps back to Nov 3.
    expect(changeOver(series, 3 * DAY)).toMatchObject({ from: nov(3), gained: 700 });
  });

  it("falls back to the oldest reading when the history is shorter than the window", () => {
    // 900 - 100 = 800 over 9 days = 216h -> 88.888... -> 88.89/day.
    expect(changeOver(series, 30 * DAY)).toEqual({
      from: nov(1),
      to: nov(10),
      hours: 216,
      start: 100,
      end: 900,
      gained: 800,
      perDay: 88.89,
    });
  });

  it("skips null readings, as a baseline and as the newest", () => {
    const hiddenBase = series.map((r) => (r.takenAt === nov(3) ? { ...r, value: null } : r));
    // Nov 3 is unusable, so the 7d baseline is Nov 1: 800 over 9 days.
    expect(changeOver(hiddenBase, 7 * DAY)).toMatchObject({
      from: nov(1),
      to: nov(10),
      gained: 800,
      hours: 216,
    });

    const hiddenNewest = series.map((r) => (r.takenAt === nov(10) ? { ...r, value: null } : r));
    // The newest usable reading is Nov 8 (500); Nov 1 is exactly 7 days older.
    // 400 over 7 days -> 57.142... -> 57.14/day.
    expect(changeOver(hiddenNewest, 7 * DAY)).toEqual({
      from: nov(1),
      to: nov(8),
      hours: 168,
      start: 100,
      end: 500,
      gained: 400,
      perDay: 57.14,
    });
  });

  it("returns null for no reading, one reading, or only null readings", () => {
    expect(changeOver([], 7 * DAY)).toBeNull();
    expect(changeOver([{ takenAt: nov(1), value: 5 }], 7 * DAY)).toBeNull();
    expect(
      changeOver(
        [
          { takenAt: nov(1), value: null },
          { takenAt: nov(5), value: null },
        ],
        7 * DAY,
      ),
    ).toBeNull();
    // Two readings, but only one carries a number.
    expect(
      changeOver(
        [
          { takenAt: nov(1), value: null },
          { takenAt: nov(5), value: 10 },
        ],
        7 * DAY,
      ),
    ).toBeNull();
  });

  it("returns null for readings closer than the minimum span, and accepts exactly the minimum", () => {
    const at = (time: string, value: number) => ({ takenAt: nov(5, time), value });
    expect(changeOver([at("00:00:00", 100), at("00:00:30", 110)], 7 * DAY)).toBeNull();
    expect(changeOver([at("00:00:00", 100), at("00:59:59", 110)], 7 * DAY)).toBeNull();
    // Exactly 1h apart: +10 in 1/24 day -> 240/day.
    expect(changeOver([at("00:00:00", 100), at("01:00:00", 110)], 7 * DAY)).toEqual({
      from: nov(5),
      to: nov(5, "01:00:00"),
      hours: 1,
      start: 100,
      end: 110,
      gained: 10,
      perDay: 240,
    });
    // 90 minutes: hours is fractional. +10 in 1.5h -> 160/day.
    expect(changeOver([at("00:00:00", 100), at("01:30:00", 110)], 7 * DAY)).toMatchObject({
      hours: 1.5,
      perDay: 160,
    });
  });

  it("does not depend on the input order", () => {
    const shuffled = [series[2], series[0], series[3], series[1]].flatMap((r) => (r ? [r] : []));
    expect(changeOver(shuffled, 7 * DAY)).toEqual(changeOver(series, 7 * DAY));
    expect(changeOver(shuffled, 7 * DAY)).toMatchObject({ from: nov(3), to: nov(10), gained: 700 });
  });

  it("keeps a decrease as a negative gain and rate", () => {
    // 900 -> 200 over 7 days: -700, -100/day.
    expect(
      changeOver(
        [
          { takenAt: nov(3), value: 900 },
          { takenAt: nov(10), value: 200 },
        ],
        7 * DAY,
      ),
    ).toMatchObject({ gained: -700, perDay: -100 });
  });

  it("ignores readings with an unparseable timestamp", () => {
    expect(
      changeOver([...series, { takenAt: "not a date", value: 1_000_000 }], 7 * DAY),
    ).toMatchObject({ to: nov(10), gained: 700 });
  });
});

describe("videoVelocity", () => {
  const WEEK = 7 * DAY;

  it("measures over the window when two snapshots are far enough apart", () => {
    const v = videoVelocity(
      { takenAt: nov(1), plays: 4500, refreshedAt: nov(12) },
      [plays(nov(5), 1000), plays(nov(12), 4500)],
      WEEK,
    );
    // 4500 - 1000 = 3500 over 7 days -> 500/day.
    // Lifetime: 4500 plays at 11 days old -> 409.0909... -> 409.09/day.
    expect(v).toEqual({
      velocity: 500,
      velocityBasis: "window",
      playsPerDay: 500,
      lifetimePlaysPerDay: 409.09,
      playsGained: 3500,
      spanFrom: nov(5),
      spanTo: nov(12),
      spanHours: 168,
      snapshots: 2,
    });
  });

  it("falls back to lifetime with one snapshot, using the age at the snapshot time", () => {
    // The row itself claims other numbers at a later refresh; the snapshot wins.
    const v = videoVelocity(
      { takenAt: nov(1), plays: 9999, refreshedAt: nov(21) },
      [plays(nov(5), 1000)],
      WEEK,
    );
    // 1000 plays when the video was 4 days (96h) old -> 250/day.
    expect(v).toEqual({
      velocity: 250,
      velocityBasis: "lifetime",
      playsPerDay: null,
      lifetimePlaysPerDay: 250,
      playsGained: 1000,
      spanFrom: nov(1),
      spanTo: nov(5),
      spanHours: 96,
      snapshots: 1,
    });
  });

  it("falls back to lifetime when the snapshots are seconds apart", () => {
    const v = videoVelocity(
      { takenAt: nov(1), plays: 1010, refreshedAt: nov(5, "00:00:30") },
      [plays(nov(5), 1000), plays(nov(5, "00:00:30"), 1010)],
      WEEK,
    );
    // Newest count 1010 at 4 days + 30s = 345630s = 4.000347 days -> 252.478 -> 252.48/day.
    // 345630s = 96.00833h -> 96.01.
    expect(v).toEqual({
      velocity: 252.48,
      velocityBasis: "lifetime",
      playsPerDay: null,
      lifetimePlaysPerDay: 252.48,
      playsGained: 1010,
      spanFrom: nov(1),
      spanTo: nov(5, "00:00:30"),
      spanHours: 96.01,
      snapshots: 2,
    });
  });

  it("has no basis when every play count is hidden", () => {
    const v = videoVelocity(
      { takenAt: nov(1), plays: null, refreshedAt: nov(12) },
      [plays(nov(5), null), plays(nov(12), null)],
      WEEK,
    );
    expect(v).toEqual({
      velocity: null,
      velocityBasis: null,
      playsPerDay: null,
      lifetimePlaysPerDay: null,
      playsGained: null,
      spanFrom: null,
      spanTo: null,
      spanHours: null,
      snapshots: 2,
    });
  });

  it("uses the stored row when no snapshot carries a count", () => {
    // 5000 plays read at the refresh, 10 days (240h) after publishing -> 500/day.
    const row = { takenAt: nov(1), plays: 5000, refreshedAt: nov(11) };
    for (const snapshots of [[], [plays(nov(11), null)]]) {
      expect(videoVelocity(row, snapshots, WEEK)).toMatchObject({
        velocity: 500,
        velocityBasis: "lifetime",
        spanFrom: nov(1),
        spanTo: nov(11),
        spanHours: 240,
        snapshots: snapshots.length,
      });
    }
  });

  it("is unmeasurable with one snapshot and no publish date", () => {
    const v = videoVelocity(
      { takenAt: null, plays: 1000, refreshedAt: nov(5) },
      [plays(nov(5), 1000)],
      WEEK,
    );
    expect(v).toMatchObject({
      velocity: null,
      velocityBasis: null,
      lifetimePlaysPerDay: null,
      playsGained: null,
      spanHours: null,
      snapshots: 1,
    });
  });

  it("still measures over the window without a publish date", () => {
    const v = videoVelocity(
      { takenAt: null, plays: 4500, refreshedAt: nov(12) },
      [plays(nov(5), 1000), plays(nov(12), 4500)],
      WEEK,
    );
    expect(v).toMatchObject({
      velocity: 500,
      velocityBasis: "window",
      lifetimePlaysPerDay: null,
    });
  });

  it("reports 0 plays/day with the negative gain when the count went down", () => {
    const v = videoVelocity(
      { takenAt: nov(1), plays: 900, refreshedAt: nov(12) },
      [plays(nov(5), 1000), plays(nov(12), 900)],
      WEEK,
    );
    expect(v).toMatchObject({
      velocity: 0,
      velocityBasis: "window",
      playsPerDay: 0,
      playsGained: -100,
      spanHours: 168,
    });
  });

  it("measures up to the newest snapshot that has a count", () => {
    const v = videoVelocity(
      { takenAt: nov(1), plays: 900, refreshedAt: nov(12) },
      [plays(nov(3), 200), plays(nov(10), 900), plays(nov(12), null)],
      WEEK,
    );
    // Newest usable: Nov 10 (900). Baseline: Nov 3, exactly 7 days older. 700 / 7 = 100/day.
    // Lifetime: 900 plays at 9 days old (Nov 1 -> Nov 10) -> 100/day.
    expect(v).toEqual({
      velocity: 100,
      velocityBasis: "window",
      playsPerDay: 100,
      lifetimePlaysPerDay: 100,
      playsGained: 700,
      spanFrom: nov(3),
      spanTo: nov(10),
      spanHours: 168,
      snapshots: 3,
    });
  });

  it("gives no lifetime rate to a video counted less than an hour after publishing", () => {
    const v = videoVelocity(
      { takenAt: nov(5), plays: 50, refreshedAt: nov(5, "00:30:00") },
      [plays(nov(5, "00:30:00"), 50)],
      WEEK,
    );
    expect(v).toMatchObject({ velocity: null, velocityBasis: null, lifetimePlaysPerDay: null });
  });

  it("does not depend on the snapshot order", () => {
    const v = videoVelocity(
      { takenAt: nov(1), plays: 4500, refreshedAt: nov(12) },
      [plays(nov(12), 4500), plays(nov(5), 1000)],
      WEEK,
    );
    expect(v).toMatchObject({ velocity: 500, spanFrom: nov(5), spanTo: nov(12) });
  });
});

describe("computeVelocities", () => {
  // Every video is published on Nov 1 and counted on Nov 5, at 4 days old,
  // unless stated: lifetime velocity = plays / 4.
  const single = (id: string, creatorId: string, count: number | null) => ({
    video: stored(id, creatorId, count, { takenAt: nov(1) }),
    snapshots: [plays(nov(5), count)],
  });
  const fixtures = [
    single("a1", "A", 400), // 100/day
    single("a2", "A", 800), // 200/day
    {
      // Two snapshots: (3200 - 400) / 7 days = 400/day on the window basis.
      video: stored("a3", "A", 3200, { takenAt: nov(1) }),
      snapshots: [plays(nov(5), 400), plays(nov(12), 3200)],
    },
    single("a4", "A", null), // hidden
    single("b1", "B", 4000), // 1000/day
    single("b2", "B", 8000), // 2000/day
    single("c1", "C", 0), // 0/day
    single("c2", "C", 0), // 0/day
    single("c3", "C", 500), // 125/day
    single("d1", "D", 4000), // 1000/day
    single("d2", "D", 8000), // 2000/day
    single("d3", "D", 12000), // 3000/day
    single("e1", "E", 400), // 100/day
    single("e2", "E", 800), // 200/day
    single("e3", "E", 1600), // 400/day
    single("e4", "E", 3200), // 800/day
  ];
  const result = computeVelocities(
    fixtures.map((f) => f.video),
    new Map(fixtures.map((f) => [f.video.id, f.snapshots])),
    7 * DAY,
  );
  const by = (id: string) => result.get(id);

  it("returns one entry per video", () => {
    expect(result.size).toBe(fixtures.length);
  });

  it("scores each video against the creator's median velocity, mixing bases", () => {
    // A: 100, 200, 400 -> median 200.
    expect(by("a1")).toMatchObject({
      velocity: 100,
      velocityBasis: "lifetime",
      velocityScore: 0.5,
    });
    expect(by("a2")).toMatchObject({ velocity: 200, velocityScore: 1 });
    expect(by("a3")).toMatchObject({ velocity: 400, velocityBasis: "window", velocityScore: 2 });
    expect(by("a1")?.creatorMedianVelocity).toBe(200);
  });

  it("leaves an unmeasurable video without a score but out of the median", () => {
    expect(by("a4")).toMatchObject({
      velocity: null,
      velocityBasis: null,
      velocityScore: null,
      creatorMedianVelocity: 200,
    });
  });

  it("gives no score below three measurable videos per creator", () => {
    expect(by("b1")).toMatchObject({
      velocity: 1000,
      velocityScore: null,
      creatorMedianVelocity: null,
    });
    expect(by("b2")).toMatchObject({
      velocity: 2000,
      velocityScore: null,
      creatorMedianVelocity: null,
    });
  });

  it("gives no score when the creator's median is 0", () => {
    // C: 0, 0, 125 -> median 0.
    expect(by("c1")).toMatchObject({ velocity: 0, velocityScore: null, creatorMedianVelocity: 0 });
    expect(by("c3")).toMatchObject({
      velocity: 125,
      velocityScore: null,
      creatorMedianVelocity: 0,
    });
  });

  it("computes the median per creator", () => {
    // D: 1000, 2000, 3000 -> median 2000. A video at 1000/day is 0.5x for D
    // while 400/day is 2x for A.
    expect(by("d1")).toMatchObject({ velocityScore: 0.5, creatorMedianVelocity: 2000 });
    expect(by("d2")).toMatchObject({ velocityScore: 1, creatorMedianVelocity: 2000 });
    expect(by("d3")).toMatchObject({ velocityScore: 1.5, creatorMedianVelocity: 2000 });
  });

  it("averages the two middle values for an even count and rounds the score", () => {
    // E: 100, 200, 400, 800 -> median (200 + 400) / 2 = 300.
    // 100/300 = 0.333 -> 0.33; 200/300 -> 0.67; 400/300 -> 1.33; 800/300 -> 2.67.
    expect(by("e1")).toMatchObject({ velocityScore: 0.33, creatorMedianVelocity: 300 });
    expect(by("e2")?.velocityScore).toBe(0.67);
    expect(by("e3")?.velocityScore).toBe(1.33);
    expect(by("e4")?.velocityScore).toBe(2.67);
  });

  it("treats a video missing from the snapshot map as having none", () => {
    // Falls back to the row: 800 plays read on Nov 5, 4 days after Nov 1 -> 200/day.
    const lone = stored("x1", "X", 800, { takenAt: nov(1) });
    lone.refreshedAt = nov(5);
    expect(computeVelocities([lone], new Map(), 7 * DAY).get("x1")).toMatchObject({
      velocity: 200,
      velocityBasis: "lifetime",
      snapshots: 0,
      velocityScore: null,
    });
  });
});

describe("videoHistory", () => {
  const snap = (
    takenAt: string,
    p: number | null,
    l: number | null,
    c: number | null,
  ): VideoSnapshot => ({ takenAt, plays: p, likes: l, comments: c });

  // Deliberately out of order.
  const rows = videoHistory([
    snap(nov(4, "00:30:00"), 200, 14, 2),
    snap(nov(1), 100, 10, 1),
    snap(nov(6, "00:30:00"), 300, 20, 5),
    snap(nov(2), 250, 15, null),
    snap(nov(5, "00:30:00"), null, null, null),
    snap(nov(2, "00:30:00"), 260, 15, 3),
  ]);

  it("returns the rows oldest first", () => {
    expect(rows.map((r) => r.takenAt)).toEqual([
      nov(1),
      nov(2),
      nov(2, "00:30:00"),
      nov(4, "00:30:00"),
      nov(5, "00:30:00"),
      nov(6, "00:30:00"),
    ]);
  });

  it("has no deltas on the first row", () => {
    expect(rows[0]).toEqual({
      takenAt: nov(1),
      plays: 100,
      likes: 10,
      comments: 1,
      playsDelta: null,
      likesDelta: null,
      commentsDelta: null,
      hoursSincePrevious: null,
      playsPerDay: null,
    });
  });

  it("compares each row with the one right before", () => {
    // 100 -> 250 in 24h: +150, 150/day. Comments went from 1 to unknown.
    expect(rows[1]).toMatchObject({
      playsDelta: 150,
      likesDelta: 5,
      commentsDelta: null,
      hoursSincePrevious: 24,
      playsPerDay: 150,
    });
  });

  it("keeps the delta but gives no rate under the minimum span", () => {
    // 30 minutes later: +10 plays, likes unchanged, comments unknown before.
    expect(rows[2]).toMatchObject({
      playsDelta: 10,
      likesDelta: 0,
      commentsDelta: null,
      hoursSincePrevious: 0.5,
      playsPerDay: null,
    });
  });

  it("keeps negative deltas raw", () => {
    // 260 -> 200 in 48h: -60, -30/day. Likes 15 -> 14, comments 3 -> 2.
    expect(rows[3]).toMatchObject({
      playsDelta: -60,
      likesDelta: -1,
      commentsDelta: -1,
      hoursSincePrevious: 48,
      playsPerDay: -30,
    });
  });

  it("propagates null on both sides of a hidden reading", () => {
    expect(rows[4]).toMatchObject({
      plays: null,
      playsDelta: null,
      likesDelta: null,
      commentsDelta: null,
      hoursSincePrevious: 24,
      playsPerDay: null,
    });
    // The row after a hidden one has nothing to compare with either.
    expect(rows[5]).toMatchObject({
      plays: 300,
      playsDelta: null,
      likesDelta: null,
      commentsDelta: null,
      hoursSincePrevious: 24,
      playsPerDay: null,
    });
  });

  it("handles empty input", () => {
    expect(videoHistory([])).toEqual([]);
  });
});

describe("creatorHistory", () => {
  const snap = (
    takenAt: string,
    f: number | null,
    g: number | null,
    m: number | null,
  ): CreatorSnapshot => ({ takenAt, followers: f, following: g, mediaCount: m });

  const rows = creatorHistory([
    snap(nov(3, "00:10:00"), 1101, 50, 12),
    snap(nov(1), 1000, 50, 10),
    snap(nov(5, "00:10:00"), null, null, null),
    snap(nov(3), 1100, 50, 12),
    snap(nov(4, "00:10:00"), 1000, 40, 12),
    snap(nov(6, "00:10:00"), 1200, 41, 13),
  ]);

  it("returns the rows oldest first with no deltas on the first", () => {
    expect(rows.map((r) => r.followers)).toEqual([1000, 1100, 1101, 1000, null, 1200]);
    expect(rows[0]).toEqual({
      takenAt: nov(1),
      followers: 1000,
      following: 50,
      mediaCount: 10,
      followersDelta: null,
      followingDelta: null,
      mediaCountDelta: null,
      hoursSincePrevious: null,
      followersPerDay: null,
    });
  });

  it("computes deltas and a per-day rate against the previous row", () => {
    // 1000 -> 1100 in 48h: +100, 50/day.
    expect(rows[1]).toMatchObject({
      followersDelta: 100,
      followingDelta: 0,
      mediaCountDelta: 2,
      hoursSincePrevious: 48,
      followersPerDay: 50,
    });
  });

  it("gives no rate under the minimum span", () => {
    // 10 minutes = 0.1666h -> 0.17.
    expect(rows[2]).toMatchObject({
      followersDelta: 1,
      hoursSincePrevious: 0.17,
      followersPerDay: null,
    });
  });

  it("keeps negative deltas raw", () => {
    // 1101 -> 1000 in 24h: -101, -101/day. Following 50 -> 40.
    expect(rows[3]).toMatchObject({
      followersDelta: -101,
      followingDelta: -10,
      mediaCountDelta: 0,
      hoursSincePrevious: 24,
      followersPerDay: -101,
    });
  });

  it("propagates null around a reading without numbers", () => {
    expect(rows[4]).toMatchObject({
      followersDelta: null,
      followingDelta: null,
      mediaCountDelta: null,
      hoursSincePrevious: 24,
      followersPerDay: null,
    });
    expect(rows[5]).toMatchObject({
      followersDelta: null,
      followingDelta: null,
      mediaCountDelta: null,
      hoursSincePrevious: 24,
      followersPerDay: null,
    });
  });
});

describe("followerGrowth", () => {
  it("reports gained, per day and the rate over the window", () => {
    // 10000 -> 10700 over 7 days: +700, 100/day, 700/10000 = 0.07.
    expect(
      followerGrowth([followers(nov(5), 10_000), followers(nov(12), 10_700)], 7 * DAY),
    ).toEqual({
      followersGained: 700,
      followersPerDay: 100,
      followerGrowthRate: 0.07,
      spanFrom: nov(5),
      spanTo: nov(12),
      spanHours: 168,
    });
  });

  it("uses the window baseline and rounds the rate to four digits", () => {
    const series = [followers(nov(1), 9000), followers(nov(5), 9500), followers(nov(12), 10_000)];
    // 7d: baseline Nov 5. +500 over 7 days -> 71.428 -> 71.43/day; 500/9500 = 0.05263 -> 0.0526.
    expect(followerGrowth(series, 7 * DAY)).toMatchObject({
      followersGained: 500,
      followersPerDay: 71.43,
      followerGrowthRate: 0.0526,
      spanFrom: nov(5),
      spanHours: 168,
    });
    // 30d: history is shorter, baseline Nov 1. +1000 over 11 days (264h) -> 90.909 -> 90.91/day;
    // 1000/9000 = 0.1111.
    expect(followerGrowth(series, 30 * DAY)).toMatchObject({
      followersGained: 1000,
      followersPerDay: 90.91,
      followerGrowthRate: 0.1111,
      spanFrom: nov(1),
      spanHours: 264,
    });
  });

  it("is all null with a single snapshot or none", () => {
    const empty = {
      followersGained: null,
      followersPerDay: null,
      followerGrowthRate: null,
      spanFrom: null,
      spanTo: null,
      spanHours: null,
    };
    expect(followerGrowth([followers(nov(5), 10_000)], 7 * DAY)).toEqual(empty);
    expect(followerGrowth([], 7 * DAY)).toEqual(empty);
    // Two snapshots, one without a count.
    expect(followerGrowth([followers(nov(5), null), followers(nov(12), 10_000)], 7 * DAY)).toEqual(
      empty,
    );
  });

  it("reports a loss as negative and no rate from a zero start", () => {
    // 2000 -> 1900 over 7 days: -100, -14.2857 -> -14.29/day, -0.05.
    expect(
      followerGrowth([followers(nov(5), 2000), followers(nov(12), 1900)], 7 * DAY),
    ).toMatchObject({ followersGained: -100, followersPerDay: -14.29, followerGrowthRate: -0.05 });
    // 0 -> 70: +70, 10/day, rate undefined.
    expect(followerGrowth([followers(nov(5), 0), followers(nov(12), 70)], 7 * DAY)).toMatchObject({
      followersGained: 70,
      followersPerDay: 10,
      followerGrowthRate: null,
    });
  });
});

describe("postingCadence", () => {
  // Thursday 2026-11-12, noon UTC. Four weeks back is Oct 15 12:00Z, twelve
  // weeks (84 days) back is Aug 20 12:00Z.
  const now = Date.parse("2026-11-12T12:00:00.000Z");
  const lima = { now, timeZone: "America/Lima" }; // UTC-5, no DST

  it("counts posts per week over 4 and 12 weeks when the store covers them", () => {
    const k = postingCadence(
      [
        "2026-10-27T15:00:00.000Z",
        "2026-08-01T15:00:00.000Z", // before the 12 weeks: Saturday
        "2026-09-01T15:00:00.000Z", // Tuesday
        "2026-09-20T15:00:00.000Z", // Sunday
        "2026-10-01T15:00:00.000Z", // Thursday
        "2026-10-20T15:00:00.000Z", // Tuesday, as are the next three
        "2026-11-03T15:00:00.000Z",
        "2026-11-10T15:00:00.000Z",
      ],
      lima,
    );
    // Last 4 weeks: Oct 20, Oct 27, Nov 3, Nov 10 -> 4 / 4 = 1.
    // Last 12 weeks: those plus Sep 1, Sep 20, Oct 1 -> 7 / 12 = 0.5833 -> 0.58.
    // Gaps in hours: 744 (31d), 456 (19d), 264 (11d), 456 (19d), 168, 168, 168
    // -> sorted 168 168 168 264 456 456 744 -> median 264.
    // 15:00Z is 10:00 in Lima, the same calendar day.
    expect(k).toEqual({
      timeZone: "America/Lima",
      videos: 8,
      oldestAt: "2026-08-01T15:00:00.000Z",
      newestAt: "2026-11-10T15:00:00.000Z",
      postsPerWeek4w: 1,
      postsPerWeek12w: 0.58,
      covers4w: true,
      covers12w: true,
      medianGapHours: 264,
      topWeekday: "Tuesday",
      topWeekdayCount: 5,
      topHour: 10,
      topHourCount: 8,
      byWeekday: [1, 0, 5, 0, 1, 0, 1],
      byHour: Array.from({ length: 24 }, (_, h) => (h === 10 ? 8 : 0)),
    });
  });

  it("takes the rate over the covered span, at least one week, when the store is shorter", () => {
    // Oldest post is 3 days old: the span is floored at one week. 3 posts / 1 week.
    const short = postingCadence(
      ["2026-11-09T12:00:00.000Z", "2026-11-10T12:00:00.000Z", "2026-11-11T12:00:00.000Z"],
      lima,
    );
    expect(short).toMatchObject({
      videos: 3,
      postsPerWeek4w: 3,
      postsPerWeek12w: 3,
      covers4w: false,
      covers12w: false,
      medianGapHours: 24,
    });

    // Oldest post is exactly 14 days old: 3 posts / 2 weeks = 1.5 for both periods.
    // A post at exactly `now` counts.
    const twoWeeks = postingCadence(
      ["2026-10-29T12:00:00.000Z", "2026-11-05T12:00:00.000Z", "2026-11-12T12:00:00.000Z"],
      lima,
    );
    expect(twoWeeks).toMatchObject({
      videos: 3,
      postsPerWeek4w: 1.5,
      postsPerWeek12w: 1.5,
      covers4w: false,
      covers12w: false,
      medianGapHours: 168,
    });
  });

  it("can cover 4 weeks without covering 12", () => {
    // Oldest post Oct 1 12:00Z is exactly 42 days = 6 weeks old.
    const k = postingCadence(
      [
        "2026-10-01T12:00:00.000Z",
        "2026-10-05T12:00:00.000Z",
        "2026-11-01T12:00:00.000Z",
        "2026-11-08T12:00:00.000Z",
      ],
      lima,
    );
    // 4 weeks (since Oct 15): Nov 1, Nov 8 -> 2 / 4 = 0.5.
    // 12 weeks: all 4 over the 6 covered weeks -> 0.6667 -> 0.67.
    // Gaps: 96h, 648h (27d), 168h -> median 168.
    expect(k).toMatchObject({
      postsPerWeek4w: 0.5,
      postsPerWeek12w: 0.67,
      covers4w: true,
      covers12w: false,
      medianGapHours: 168,
    });
  });

  it("expresses weekday and hour in the given time zone", () => {
    // Monday 02:00 UTC is Sunday 21:00 in Lima.
    const post = ["2026-11-09T02:00:00.000Z"];
    const local = postingCadence(post, lima);
    expect(local).toMatchObject({
      topWeekday: "Sunday",
      topWeekdayCount: 1,
      topHour: 21,
      topHourCount: 1,
      medianGapHours: null,
    });
    expect(local.byWeekday).toEqual([1, 0, 0, 0, 0, 0, 0]);
    expect(local.byHour[21]).toBe(1);
    expect(local.byHour[2]).toBe(0);

    const utc = postingCadence(post, { now, timeZone: "UTC" });
    expect(utc).toMatchObject({ timeZone: "UTC", topWeekday: "Monday", topHour: 2 });
    expect(utc.byWeekday).toEqual([0, 1, 0, 0, 0, 0, 0]);
  });

  it("puts local midnight in hour 0, not 24", () => {
    // 05:00 UTC is 00:00 in Lima, still Monday.
    const k = postingCadence(["2026-11-09T05:00:00.000Z"], lima);
    expect(k).toMatchObject({ topWeekday: "Monday", topHour: 0, topHourCount: 1 });
    expect(k.byHour[0]).toBe(1);
    expect(k.byHour).toHaveLength(24);
  });

  it("ignores null, unparseable and future publish dates", () => {
    const k = postingCadence(
      [null, "2026-11-13T00:00:00.000Z", "not a date", "2026-11-10T15:00:00.000Z", null],
      lima,
    );
    expect(k).toMatchObject({
      videos: 1,
      oldestAt: "2026-11-10T15:00:00.000Z",
      newestAt: "2026-11-10T15:00:00.000Z",
      postsPerWeek4w: 1,
      topWeekday: "Tuesday",
      topWeekdayCount: 1,
    });
    expect(k.byWeekday.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("is empty, not zero, without any dated video", () => {
    for (const input of [[], [null, null]]) {
      expect(postingCadence(input, lima)).toEqual({
        timeZone: "America/Lima",
        videos: 0,
        oldestAt: null,
        newestAt: null,
        postsPerWeek4w: null,
        postsPerWeek12w: null,
        covers4w: false,
        covers12w: false,
        medianGapHours: null,
        topWeekday: null,
        topWeekdayCount: 0,
        topHour: null,
        topHourCount: 0,
        byWeekday: [0, 0, 0, 0, 0, 0, 0],
        byHour: new Array(24).fill(0),
      });
    }
  });
});

describe("rankVideos and sortVideos with velocity", () => {
  const creators = new Map([["c", { followers: 1000 as number | null }]]);
  // v5 comes before v6 and has far fewer plays: total plays must not order the tail.
  const videos = [
    stored("v1", "c", 10),
    stored("v2", "c", 20),
    stored("v3", "c", 30),
    stored("v4", "c", 40),
    stored("v5", "c", 1),
    stored("v6", "c", 1_000_000),
  ];
  const velocities = new Map<string, VelocityFields>([
    ["v1", { velocity: 100, velocityBasis: "window", velocityScore: 2 }],
    ["v2", { velocity: 50, velocityBasis: "lifetime", velocityScore: 5 }],
    ["v3", { velocity: 300, velocityBasis: "window", velocityScore: null }],
    ["v4", { velocity: 900, velocityBasis: "lifetime", velocityScore: null }],
    ["v6", { velocity: null, velocityBasis: null, velocityScore: null }],
  ]);

  it("leaves the velocity fields null without the third argument", () => {
    const ranked = rankVideos(videos, creators);
    expect(ranked).toHaveLength(6);
    for (const v of ranked) {
      expect(v).toMatchObject({ velocity: null, velocityBasis: null, velocityScore: null });
    }
  });

  it("attaches the velocity fields by video id", () => {
    const ranked = rankVideos(videos, creators, velocities);
    const by = (id: string) => ranked.find((v) => v.id === id);
    expect(by("v1")).toMatchObject({ velocity: 100, velocityBasis: "window", velocityScore: 2 });
    expect(by("v2")).toMatchObject({ velocity: 50, velocityBasis: "lifetime", velocityScore: 5 });
    expect(by("v3")).toMatchObject({ velocity: 300, velocityScore: null });
    // v5 is not in the map at all.
    expect(by("v5")).toMatchObject({ velocity: null, velocityBasis: null, velocityScore: null });
  });

  it("sorts by velocityScore, nulls last, the null tail by raw velocity", () => {
    const ranked = rankVideos(videos, creators, velocities);
    // Scored: v2 (5x) before v1 (2x) although v1 is faster in absolute terms.
    // Unscored: v4 (900/day) before v3 (300/day), then the unmeasurable pair in
    // input order, not by plays.
    expect(sortVideos(ranked, "velocity").map((v) => v.id)).toEqual([
      "v2",
      "v1",
      "v4",
      "v3",
      "v5",
      "v6",
    ]);
    // Other keys are untouched by the velocity fields.
    expect(sortVideos(ranked, "plays")[0]?.id).toBe("v6");
  });

  it("without velocities the velocity sort keeps the input order", () => {
    const ranked = rankVideos(videos, creators);
    expect(sortVideos(ranked, "velocity").map((v) => v.id)).toEqual([
      "v1",
      "v2",
      "v3",
      "v4",
      "v5",
      "v6",
    ]);
  });
});
