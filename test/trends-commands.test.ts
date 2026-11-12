import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trendsCommands } from "../src/commands/trends.js";
import { videoCommands } from "../src/commands/video.js";
import type { RankedVideo, Video } from "../src/core/types.js";
import type { CommandDef } from "../src/lib/command.js";
import type { Meta, NextStep } from "../src/lib/output.js";
import { byId, type TestEnv, testEnv } from "./fake-backend.js";
import { creator, video } from "./helpers.js";

const defs = trendsCommands as CommandDef[];
const trending = byId(defs, "video.trending");
const videoHistory = byId(defs, "video.history");
const creatorHistory = byId(defs, "creator.history");
const movers = byId(defs, "niche.movers");
const top = byId(videoCommands as CommandDef[], "video.top");

// Thursday noon UTC. Every "now" in this file is this instant.
const NOW = "2026-11-12T12:00:00.000Z";
/** Noon UTC of a day of November 2026. */
const nov = (day: number): string => `2026-11-${String(day).padStart(2, "0")}T12:00:00.000Z`;

let env: TestEnv;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await env.cleanup();
});

type Velocity = {
  velocity: number | null;
  velocityBasis: "window" | "lifetime" | null;
  velocityScore: number | null;
  playsPerDay: number | null;
  lifetimePlaysPerDay: number | null;
  playsGained: number | null;
  spanFrom: string | null;
  spanTo: string | null;
  spanHours: number | null;
  snapshots: number;
  creatorMedianVelocity: number | null;
};
type TrendingRow = RankedVideo & Velocity;
type VideoHistoryData = {
  video: Record<string, unknown>;
  velocity: Velocity;
  totalSnapshots: number;
  snapshots: Record<string, unknown>[];
};
type CreatorHistoryData = {
  creator: Record<string, unknown>;
  growth: Record<string, unknown>;
  cadence: Record<string, unknown> & { byWeekday: number[]; byHour: number[] };
  totalSnapshots: number;
  snapshots: Record<string, unknown>[];
};
type Mover = Record<string, unknown> & { username: string };
type Result<T> = { data: T; meta: Meta; nextSteps: NextStep[] };

async function run<T>(def: CommandDef, input: Record<string, unknown> = {}): Promise<Result<T>> {
  return (await env.run(def, input)) as unknown as Result<T>;
}

function capture(fn: () => void): { out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const o = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  const e = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  try {
    fn();
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
  return { out: out.join(""), err: err.join("") };
}

/** Runs the human renderer with colors off and returns what it printed. */
function human(def: CommandDef, result: Result<unknown>): { out: string; err: string } {
  const before = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR };
  process.env.NO_COLOR = "1";
  delete process.env.FORCE_COLOR;
  try {
    return capture(() => def.human?.(result.data as never, env.ctx, result.meta));
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const ESC = "\x1b";
const codes = (rows: { shortcode: string }[]) => rows.map((r) => r.shortcode);
const names = (rows: { username: string }[]) => rows.map((r) => r.username);
const lineWith = (text: string, needle: string): string =>
  text.split("\n").find((l) => l.includes(needle)) ?? "";

// --- fixture -----------------------------------------------------------------------
//
// Creators: ana (1), beto (2), cata (3), dani (4), eli (5).
// Niches: cocina = ana, beto, dani, eli. duo = ana, beto. vacio = nobody. Cata has none.
//
// Video snapshots, plays only, window 7d, now = Nov 12 12:00Z (all times 12:00Z):
//
//   ana01  published Nov 1   Nov 5: 1000, Nov 10: 7000, Nov 12: 8000
//          7d baseline Nov 5 -> (8000-1000)/7 = 1000/day (window)
//          lifetime 8000 / 11 days = 727.27/day
//   ana02  published Nov 2   Nov 5: 500, Nov 12: 1200   -> 700/7  = 100/day (window)
//   ana03  published Nov 3   Nov 5: 300, Nov 12: 1700   -> 1400/7 = 200/day (window)
//   ana04  published Nov 8   Nov 12: 2000               -> 2000/4 = 500/day (lifetime)
//   ana05  published Nov 9   Nov 12: hidden             -> unmeasurable
//   Ana's median over 100, 200, 500, 1000 = 350. Scores: ana01 2.86, ana04 1.43,
//   ana03 0.57, ana02 0.29.
//
//   beto1  published Nov 1   Nov 5: 10000, Nov 12: 31000 -> 21000/7 = 3000/day (window)
//   beto2  published Nov 10  Nov 12: 600                 -> 600/2 = 300/day (lifetime)
//   Two measurable videos: no median, no score.
//
//   cata1  published Nov 2   Nov 12: 100                 -> 100/10 = 10/day (lifetime)
//   cata2  published Nov 2   Nov 12: 200                 -> 200/10 = 20/day (lifetime)
//   cata3  published Nov 7   Nov 8: 100, Nov 12: 600     -> history shorter than 7d,
//          baseline is the oldest: 500/4 = 125/day (window)
//   Cata's median over 10, 20, 125 = 20. Scores: cata3 6.25, cata2 1, cata1 0.5.
//
// Profile snapshots (followers / following / posts):
//   ana   Nov 1: 9000/100/40, Nov 5: 9500/101/42, Nov 12: 10000/101/45
//   beto  Nov 5: 400/10/5, Nov 12: 500/10/5
//   cata  Nov 12: 2000/10/5       dani  Nov 12: 50000/10/5       eli  none

const RED_CAPTION = `${ESC}[31mred alert`;

const people = [
  creator({ id: "1", username: "ana", followers: 10_000, following: 101, mediaCount: 45 }),
  creator({ id: "2", username: "beto", followers: 500 }),
  creator({ id: "3", username: "cata", followers: 2000 }),
  creator({ id: "4", username: "dani", followers: 50_000 }),
  creator({ id: "5", username: "eli", followers: 300 }),
];

const reel = (
  id: string,
  shortcode: string,
  owner: { id: string; username: string },
  publishedDay: number,
  over: Partial<Video> = {},
): Video =>
  video({
    id,
    shortcode,
    creatorId: owner.id,
    creatorUsername: owner.username,
    takenAt: nov(publishedDay),
    ...over,
  });

const ana = { id: "1", username: "ana" };
const beto = { id: "2", username: "beto" };
const cata = { id: "3", username: "cata" };

const reels = [
  reel("101", "ana01", ana, 1, { plays: 8000, likes: 450, comments: 28, caption: RED_CAPTION }),
  reel("102", "ana02", ana, 2, { plays: 1200 }),
  reel("103", "ana03", ana, 3, { plays: 1700 }),
  reel("104", "ana04", ana, 8, { plays: 2000 }),
  reel("105", "ana05", ana, 9, { plays: null, likes: null, comments: null }),
  reel("201", "beto1", beto, 1, { plays: 31_000 }),
  reel("202", "beto2", beto, 10, { plays: 600 }),
  reel("301", "cata1", cata, 2, { plays: 100 }),
  reel("302", "cata2", cata, 2, { plays: 200 }),
  reel("303", "cata3", cata, 7, { plays: 600 }),
];

// [video id, day, plays, likes, comments]. Deliberately not in chronological order.
const videoSnaps: [string, number, number | null, number | null, number | null][] = [
  ["101", 12, 8000, 450, 28],
  ["101", 5, 1000, 100, 10],
  ["101", 10, 7000, 400, 30],
  ["102", 12, 1200, 10, 1],
  ["102", 5, 500, 10, 1],
  ["103", 5, 300, 10, 1],
  ["103", 12, 1700, 10, 1],
  ["104", 12, 2000, 10, 1],
  ["105", 12, null, null, null],
  ["201", 12, 31_000, 10, 1],
  ["201", 5, 10_000, 10, 1],
  ["202", 12, 600, 10, 1],
  ["301", 12, 100, 10, 1],
  ["302", 12, 200, 10, 1],
  ["303", 12, 600, 10, 1],
  ["303", 8, 100, 10, 1],
];

// [creator id, day, followers, following, media count]. Not in chronological order either.
const creatorSnaps: [string, number, number, number, number][] = [
  ["1", 12, 10_000, 101, 45],
  ["1", 1, 9000, 100, 40],
  ["1", 5, 9500, 101, 42],
  ["2", 12, 500, 10, 5],
  ["2", 5, 400, 10, 5],
  ["3", 12, 2000, 10, 5],
  ["4", 12, 50_000, 10, 5],
];

function seeded(): TestEnv {
  const e = testEnv();
  const { store } = e.ctx;
  store.createNiche({ slug: "cocina", name: "Cocina" });
  store.createNiche({ slug: "duo", name: "Duo" });
  store.createNiche({ slug: "vacio", name: "Vacio" });
  for (const c of people) store.upsertCreator(c, { refreshed: false });
  for (const id of ["1", "2", "4", "5"]) store.addCreatorToNiche(id, "cocina");
  for (const id of ["1", "2"]) store.addCreatorToNiche(id, "duo");
  store.upsertVideos(reels);

  // The upserts stamped their own snapshots at "now"; replace them with a
  // series at controlled times.
  store.db.exec("DELETE FROM video_snapshots; DELETE FROM creator_snapshots;");
  const addVideo = store.db.prepare(
    "INSERT INTO video_snapshots (video_id, taken_at, plays, likes, comments) VALUES (?, ?, ?, ?, ?)",
  );
  for (const [id, day, plays, likes, comments] of videoSnaps) {
    addVideo.run(id, nov(day), plays, likes, comments);
  }
  const addCreator = store.db.prepare(
    "INSERT INTO creator_snapshots (creator_id, taken_at, followers, following, media_count) VALUES (?, ?, ?, ?, ?)",
  );
  for (const [id, day, followers, following, media] of creatorSnaps) {
    addCreator.run(id, nov(day), followers, following, media);
  }
  return e;
}

// --- store ---------------------------------------------------------------------------

describe("Store history", () => {
  it("returns one video's snapshots oldest first, whatever the insertion order", () => {
    env = seeded();
    expect(env.ctx.store.videoSnapshots("101")).toEqual([
      { takenAt: nov(5), plays: 1000, likes: 100, comments: 10 },
      { takenAt: nov(10), plays: 7000, likes: 400, comments: 30 },
      { takenAt: nov(12), plays: 8000, likes: 450, comments: 28 },
    ]);
    expect(env.ctx.store.videoSnapshots("105")).toEqual([
      { takenAt: nov(12), plays: null, likes: null, comments: null },
    ]);
  });

  it("returns an empty list for a video without snapshots or an unknown id", () => {
    env = seeded();
    expect(env.ctx.store.videoSnapshots("999")).toEqual([]);
    env.ctx.store.db.prepare("DELETE FROM video_snapshots WHERE video_id = ?").run("104");
    expect(env.ctx.store.videoSnapshots("104")).toEqual([]);
  });

  it("scopes video snapshots by video, creator and niche", () => {
    env = seeded();
    const { store } = env.ctx;
    const keys = (m: Map<string, unknown>) => [...m.keys()].sort();

    expect(keys(store.listVideoSnapshots())).toEqual([
      "101",
      "102",
      "103",
      "104",
      "105",
      "201",
      "202",
      "301",
      "302",
      "303",
    ]);
    expect(keys(store.listVideoSnapshots({ videoId: "303" }))).toEqual(["303"]);
    expect(keys(store.listVideoSnapshots({ creatorId: "2" }))).toEqual(["201", "202"]);
    // cocina holds ana and beto (dani and eli have no videos); cata is outside.
    expect(keys(store.listVideoSnapshots({ niche: "cocina" }))).toEqual([
      "101",
      "102",
      "103",
      "104",
      "105",
      "201",
      "202",
    ]);
    // Both filters apply together: cata is not in cocina.
    expect(store.listVideoSnapshots({ creatorId: "3", niche: "cocina" }).size).toBe(0);
    expect(store.listVideoSnapshots({ niche: "vacio" }).size).toBe(0);
    expect(store.listVideoSnapshots({ creatorId: "5" }).size).toBe(0);

    // Every list is oldest first.
    expect(
      store
        .listVideoSnapshots({ creatorId: "2" })
        .get("201")
        ?.map((s) => s.plays),
    ).toEqual([10_000, 31_000]);
    expect(
      store
        .listVideoSnapshots({ niche: "cocina" })
        .get("101")
        ?.map((s) => s.takenAt),
    ).toEqual([nov(5), nov(10), nov(12)]);
  });

  it("returns a creator's snapshots oldest first", () => {
    env = seeded();
    expect(env.ctx.store.creatorSnapshots("1")).toEqual([
      { takenAt: nov(1), followers: 9000, following: 100, mediaCount: 40 },
      { takenAt: nov(5), followers: 9500, following: 101, mediaCount: 42 },
      { takenAt: nov(12), followers: 10_000, following: 101, mediaCount: 45 },
    ]);
    expect(env.ctx.store.creatorSnapshots("5")).toEqual([]);
    expect(env.ctx.store.creatorSnapshots("999")).toEqual([]);
  });

  it("scopes creator snapshots by creator and niche", () => {
    env = seeded();
    const { store } = env.ctx;
    const keys = (m: Map<string, unknown>) => [...m.keys()].sort();
    // Eli has no snapshot, so no entry.
    expect(keys(store.listCreatorSnapshots())).toEqual(["1", "2", "3", "4"]);
    expect(keys(store.listCreatorSnapshots({ niche: "cocina" }))).toEqual(["1", "2", "4"]);
    expect(keys(store.listCreatorSnapshots({ niche: "duo" }))).toEqual(["1", "2"]);
    expect(keys(store.listCreatorSnapshots({ creatorId: "2" }))).toEqual(["2"]);
    expect(store.listCreatorSnapshots({ creatorId: "3", niche: "cocina" }).size).toBe(0);
    expect(store.listCreatorSnapshots({ niche: "vacio" }).size).toBe(0);
    expect(
      store
        .listCreatorSnapshots({ niche: "duo" })
        .get("2")
        ?.map((s) => s.followers),
    ).toEqual([400, 500]);
  });

  it("is empty on an empty database and rejects an unknown niche", () => {
    env = testEnv();
    const { store } = env.ctx;
    expect(store.listVideoSnapshots().size).toBe(0);
    expect(store.listCreatorSnapshots().size).toBe(0);
    expect(() => store.listVideoSnapshots({ niche: "nada" })).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
    expect(() => store.listCreatorSnapshots({ niche: "nada" })).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
  });

  it("the refresh path records one snapshot per upsert, stamped with the clock", () => {
    env = testEnv();
    const { store } = env.ctx;
    const [first] = people;
    const [firstReel] = reels;
    if (!first || !firstReel) throw new Error("fixture");
    store.upsertCreator(first);
    store.upsertVideos([firstReel]);
    vi.setSystemTime(new Date("2026-11-13T12:00:00.000Z"));
    store.upsertCreator({ ...first, followers: 10_500 });
    store.upsertVideos([{ ...firstReel, plays: 9000 }]);
    expect(store.creatorSnapshots("1").map((s) => [s.takenAt, s.followers])).toEqual([
      [NOW, 10_000],
      ["2026-11-13T12:00:00.000Z", 10_500],
    ]);
    expect(store.videoSnapshots("101").map((s) => [s.takenAt, s.plays])).toEqual([
      [NOW, 8000],
      ["2026-11-13T12:00:00.000Z", 9000],
    ]);
  });
});

// --- video trending ------------------------------------------------------------------

describe("video trending", () => {
  const runTrending = (input: Record<string, unknown> = {}) => run<TrendingRow[]>(trending, input);

  it("orders by the velocity score by default, unscored videos last by raw rate", async () => {
    env = seeded();
    const { data, meta } = await runTrending();
    // Scores: cata3 6.25, ana01 2.86, ana04 1.43, cata2 1, ana03 0.57, cata1 0.5,
    // ana02 0.29; then beto's unscored pair by rate (3000, 300). ana05 is unmeasurable.
    expect(codes(data)).toEqual([
      "cata3",
      "ana01",
      "ana04",
      "cata2",
      "ana03",
      "cata1",
      "ana02",
      "beto1",
      "beto2",
    ]);
    expect(data.map((v) => v.velocityScore)).toEqual([
      6.25,
      2.86,
      1.43,
      1,
      0.57,
      0.5,
      0.29,
      null,
      null,
    ]);
    expect(meta.sort).toBe("score");
  });

  it("reports the full velocity detail on each row", async () => {
    env = seeded();
    const { data } = await runTrending();
    const by = (code: string) => data.find((v) => v.shortcode === code);
    expect(by("ana01")).toMatchObject({
      id: "101",
      creatorUsername: "ana",
      plays: 8000,
      velocity: 1000,
      velocityBasis: "window",
      velocityScore: 2.86,
      playsPerDay: 1000,
      lifetimePlaysPerDay: 727.27,
      playsGained: 7000,
      spanFrom: nov(5),
      spanTo: nov(12),
      spanHours: 168,
      snapshots: 3,
      creatorMedianVelocity: 350,
    });
    expect(by("ana04")).toMatchObject({
      velocity: 500,
      velocityBasis: "lifetime",
      velocityScore: 1.43,
      playsPerDay: null,
      lifetimePlaysPerDay: 500,
      playsGained: 2000,
      spanFrom: nov(8),
      spanTo: nov(12),
      spanHours: 96,
      snapshots: 1,
    });
    expect(by("beto1")).toMatchObject({
      velocity: 3000,
      velocityBasis: "window",
      velocityScore: null,
      creatorMedianVelocity: null,
    });
    // History shorter than the window: the oldest snapshot is the baseline.
    expect(by("cata3")).toMatchObject({
      velocity: 125,
      velocityBasis: "window",
      playsGained: 500,
      spanFrom: nov(8),
      spanHours: 96,
      creatorMedianVelocity: 20,
    });
  });

  it("--sort plays-per-day orders by the raw rate", async () => {
    env = seeded();
    const { data, meta } = await runTrending({ sort: "plays-per-day" });
    // 3000, 1000, 500, 300, 200, 125, 100, 20, 10.
    expect(codes(data)).toEqual([
      "beto1",
      "ana01",
      "ana04",
      "beto2",
      "ana03",
      "cata3",
      "ana02",
      "cata2",
      "cata1",
    ]);
    expect(data.map((v) => v.velocity)).toEqual([3000, 1000, 500, 300, 200, 125, 100, 20, 10]);
    expect(meta.sort).toBe("plays-per-day");
  });

  it("explains the measurement in meta", async () => {
    env = seeded();
    const { meta, nextSteps } = await runTrending();
    expect(meta).toMatchObject({
      sort: "score",
      window: "7d",
      windowHours: 168,
      minSpanHours: 1,
      creatorsConsidered: 5,
      videosConsidered: 10,
      candidates: 10,
      // ana01, ana02, ana03, beto1, cata3
      measuredOverWindow: 5,
      // ana04, beto2, cata1, cata2
      lifetimeFallback: 4,
      // ana05
      unmeasurable: 1,
      // ana04, ana05, beto2, cata1, cata2
      singleSnapshot: 5,
    });
    expect(meta.note).toContain("5 of 10 candidate videos have a single snapshot");
    expect(meta.note).toMatch(/Run `ig niche refresh [a-z-]+` again on a later day/);
    expect(nextSteps[0]?.command).toMatch(/^ig niche refresh [a-z-]+$/);
    expect(nextSteps.at(-1)?.command).toBe("ig video history cata3");
  });

  it("--niche scopes the videos, the counts and the refresh command", async () => {
    env = seeded();
    const { data, meta, nextSteps } = await runTrending({ niche: "cocina" });
    expect(codes(data)).toEqual(["ana01", "ana04", "ana03", "ana02", "beto1", "beto2"]);
    expect(meta).toMatchObject({
      creatorsConsidered: 4,
      videosConsidered: 7,
      candidates: 7,
      measuredOverWindow: 4,
      lifetimeFallback: 2,
      unmeasurable: 1,
      singleSnapshot: 3,
    });
    expect(meta.note).toContain("3 of 7 candidate videos");
    expect(meta.note).toContain("`ig niche refresh cocina`");
    expect(nextSteps[0]?.command).toBe("ig niche refresh cocina");

    const empty = await runTrending({ niche: "vacio" });
    expect(empty.data).toEqual([]);
    expect(empty.meta).toMatchObject({ creatorsConsidered: 0, videosConsidered: 0, note: null });
    expect(empty.nextSteps).toEqual([
      { command: "ig niche refresh vacio", description: expect.any(String) },
    ]);
  });

  it("--creator scopes to one creator, accepting an @handle", async () => {
    env = seeded();
    const { data, meta, nextSteps } = await runTrending({ creator: "@Ana" });
    expect(codes(data)).toEqual(["ana01", "ana04", "ana03", "ana02"]);
    expect(meta).toMatchObject({
      creatorsConsidered: 1,
      videosConsidered: 5,
      candidates: 5,
      measuredOverWindow: 3,
      lifetimeFallback: 1,
      unmeasurable: 1,
      singleSnapshot: 2,
    });
    expect(meta.note).toContain("`ig creator get ana --refresh`");
    expect(nextSteps[0]?.command).toBe("ig creator get ana --refresh");
  });

  it("--creator outside --niche gives nothing", async () => {
    env = seeded();
    const { data, meta } = await runTrending({ creator: "cata", niche: "cocina" });
    expect(data).toEqual([]);
    expect(meta).toMatchObject({ creatorsConsidered: 0, videosConsidered: 0, candidates: 0 });
  });

  it("--min-plays filters the candidates after scoring", async () => {
    env = seeded();
    const { data, meta } = await runTrending({ minPlays: 1500 });
    // At least 1500 plays: ana01 (8000), ana04 (2000), ana03 (1700), beto1 (31000).
    expect(codes(data)).toEqual(["ana01", "ana04", "ana03", "beto1"]);
    // The median still comes from Ana's full set.
    expect(data[0]).toMatchObject({ velocityScore: 2.86, creatorMedianVelocity: 350 });
    expect(meta).toMatchObject({
      videosConsidered: 10,
      candidates: 4,
      measuredOverWindow: 3,
      lifetimeFallback: 1,
      unmeasurable: 0,
      singleSnapshot: 1,
    });
    expect(meta.note).toContain("1 of 4 candidate videos");

    // The boundary is inclusive, and hidden counts never pass.
    expect(codes((await runTrending({ minPlays: 8000 })).data)).toEqual(["ana01", "beto1"]);
    expect(codes((await runTrending({ minPlays: 0 })).data)).not.toContain("ana05");
    expect((await runTrending({ minPlays: 0 })).meta.candidates).toBe(9);
  });

  it("--per-creator caps each creator after sorting, --limit cuts the result", async () => {
    env = seeded();
    expect(codes((await runTrending({ perCreator: 1 })).data)).toEqual(["cata3", "ana01", "beto1"]);
    expect(codes((await runTrending({ perCreator: 2, sort: "plays-per-day" })).data)).toEqual([
      "beto1",
      "ana01",
      "ana04",
      "beto2",
      "cata3",
      "cata2",
    ]);
    const limited = await runTrending({ limit: 2 });
    expect(codes(limited.data)).toEqual(["cata3", "ana01"]);
    // The counts describe the candidates, not the page.
    expect(limited.meta).toMatchObject({ candidates: 10, measuredOverWindow: 5 });
    expect(codes((await runTrending({ perCreator: 1, limit: 2 })).data)).toEqual([
      "cata3",
      "ana01",
    ]);
  });

  it("--window moves the baseline", async () => {
    env = seeded();
    const week = await runTrending({ window: "7d" });
    expect(week.data.find((v) => v.shortcode === "ana01")).toMatchObject({
      velocity: 1000,
      playsGained: 7000,
      spanFrom: nov(5),
      spanHours: 168,
    });

    const two = await runTrending({ window: " 2d " });
    // The latest snapshot at least 2 days older than Nov 12 is Nov 10 (7000):
    // (8000 - 7000) / 2 = 500/day. Ana's rates become 500, 100, 200, 500: the
    // median stays 350 and the score drops to 500/350 = 1.43.
    expect(two.data.find((v) => v.shortcode === "ana01")).toMatchObject({
      velocity: 500,
      velocityBasis: "window",
      velocityScore: 1.43,
      playsGained: 1000,
      spanFrom: nov(10),
      spanTo: nov(12),
      spanHours: 48,
      creatorMedianVelocity: 350,
    });
    // Videos whose only older snapshot is Nov 5 keep their baseline.
    expect(two.data.find((v) => v.shortcode === "ana02")).toMatchObject({
      velocity: 100,
      spanFrom: nov(5),
    });
    expect(two.meta).toMatchObject({ window: "2d", windowHours: 48 });
  });

  it("--window accepts a date, measured from now", async () => {
    env = seeded();
    // Nov 10 12:00Z is 48h before the frozen clock.
    const { data, meta } = await runTrending({ window: "2026-11-10T12:00:00.000Z" });
    expect(meta.windowHours).toBe(48);
    expect(data.find((v) => v.shortcode === "ana01")?.velocity).toBe(500);
  });

  it("rejects a bad --window, --sort or --limit with INVALID_INPUT", async () => {
    env = seeded();
    for (const window of ["nope", "0d", "2026-12-25", "30m"]) {
      await expect(runTrending({ window })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    await expect(runTrending({ sort: "velocity" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(runTrending({ limit: 0 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects a bad --window even on an empty database", async () => {
    env = testEnv();
    await expect(runTrending({ window: "nope" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("an unknown niche or creator is NOT_FOUND", async () => {
    env = seeded();
    await expect(runTrending({ niche: "nada" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(runTrending({ creator: "nobody" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("an empty database gives empty data and a next step", async () => {
    env = testEnv();
    const { data, meta, nextSteps } = await runTrending();
    expect(data).toEqual([]);
    expect(meta).toMatchObject({
      creatorsConsidered: 0,
      videosConsidered: 0,
      candidates: 0,
      measuredOverWindow: 0,
      lifetimeFallback: 0,
      unmeasurable: 0,
      singleSnapshot: 0,
      note: null,
    });
    expect(nextSteps).toEqual([
      { command: "ig niche refresh <slug>", description: expect.any(String) },
    ]);
  });

  it("has no note once every candidate has two snapshots", async () => {
    env = seeded();
    // beto1 is the only video of the scope with at least 20000 plays.
    const { data, meta, nextSteps } = await runTrending({ minPlays: 20_000 });
    expect(codes(data)).toEqual(["beto1"]);
    expect(meta).toMatchObject({ candidates: 1, singleSnapshot: 0, note: null });
    expect(nextSteps).toEqual([
      { command: "ig video history beto1", description: expect.any(String) },
    ]);
  });

  it("human: prints a BASIS column, the measurement line and the note", async () => {
    env = seeded();
    const result = await runTrending();
    const { out, err } = human(trending, result);
    const header = out.split("\n")[0] ?? "";
    expect(header).toContain("CREATOR");
    expect(header).toContain("SCORE ↓");
    expect(header).toContain("PLAYS/DAY");
    expect(header).not.toContain("PLAYS/DAY ↓");
    expect(header).toContain("BASIS");
    // 2.86x, 1000/day, +7000 over 168h, window basis, 8000 plays.
    expect(lineWith(out, "/reel/ana01/")).toMatch(/ana\s+2\.9x\s+1K\s+\+7K\s+7d\s+window\s+8K/);
    // No score, 300/day, +600 over 48h, lifetime basis, 600 plays.
    expect(lineWith(out, "/reel/beto2/")).toMatch(/beto\s+–\s+300\s+\+600\s+2d\s+lifetime\s+600/);
    expect(out).not.toContain("ana05");
    expect(out.trimEnd().split("\n")).toHaveLength(10);

    expect(err).toContain(
      "window 7d: 5 of 10 candidate videos measured between two snapshots, 4 on lifetime plays / age.",
    );
    expect(err).toContain("note 5 of 10 candidate videos have a single snapshot");
    expect(err).toMatch(/Run `ig niche refresh [a-z-]+` again on a later day/);
  });

  it("human: marks the rate column under --sort plays-per-day", async () => {
    env = seeded();
    const { out } = human(trending, await runTrending({ sort: "plays-per-day" }));
    const header = out.split("\n")[0] ?? "";
    expect(header).toContain("PLAYS/DAY ↓");
    expect(header).not.toContain("SCORE ↓");
  });

  it("human: a single creator becomes a heading instead of a column", async () => {
    env = seeded();
    const { out, err } = human(trending, await runTrending({ creator: "ana" }));
    const lines = out.split("\n");
    expect(lines[0]).toBe("@ana");
    expect(lines[1]).not.toContain("CREATOR");
    expect(lines[1]).toContain("BASIS");
    expect(err).toContain("`ig creator get ana --refresh`");
  });

  it("human: says so when nothing is stored, and when nothing is measurable", async () => {
    env = seeded();
    const none = human(trending, await runTrending({ niche: "vacio" }));
    expect(none.out).toBe("");
    expect(none.err).toContain("No videos stored in this scope yet.");

    // Leave only the hidden-count video in Ana's set.
    env.ctx.store.db.prepare("DELETE FROM videos WHERE creator_id = ? AND id <> ?").run("1", "105");
    const hidden = await runTrending({ creator: "ana" });
    expect(hidden.data).toEqual([]);
    expect(hidden.meta).toMatchObject({ videosConsidered: 1, unmeasurable: 1, singleSnapshot: 1 });
    const shown = human(trending, hidden);
    expect(shown.out).toBe("");
    expect(shown.err).toContain("No stored video in this scope has a measurable velocity");
    expect(shown.err).toContain("note 1 of 1 candidate videos have a single snapshot");
  });

  it("human: a caption cannot smuggle an ANSI escape into the terminal", async () => {
    env = seeded();
    const result = await runTrending();
    // The machine output keeps the raw value.
    expect(result.data.find((v) => v.shortcode === "ana01")?.caption).toBe(RED_CAPTION);
    const { out, err } = human(trending, result);
    expect(out).toContain("red alert");
    expect(out).not.toContain(`${ESC}[31m`);
    expect(out).not.toContain(ESC);
    expect(err).not.toContain(ESC);
  });
});

// --- video history -------------------------------------------------------------------

describe("video history", () => {
  const runHistory = (input: Record<string, unknown>) => run<VideoHistoryData>(videoHistory, input);

  it("returns the series with deltas, by shortcode", async () => {
    env = seeded();
    const { data, meta, nextSteps } = await runHistory({ video: "ana01" });
    expect(data.video).toEqual({
      id: "101",
      shortcode: "ana01",
      url: "https://www.instagram.com/reel/ana01/",
      creatorUsername: "ana",
      caption: RED_CAPTION,
      takenAt: nov(1),
      plays: 8000,
      likes: 450,
      comments: 28,
    });
    expect(data.totalSnapshots).toBe(3);
    expect(data.snapshots).toEqual([
      {
        takenAt: nov(5),
        plays: 1000,
        likes: 100,
        comments: 10,
        playsDelta: null,
        likesDelta: null,
        commentsDelta: null,
        hoursSincePrevious: null,
        playsPerDay: null,
      },
      {
        // 5 days = 120h later: +6000 plays -> 1200/day.
        takenAt: nov(10),
        plays: 7000,
        likes: 400,
        comments: 30,
        playsDelta: 6000,
        likesDelta: 300,
        commentsDelta: 20,
        hoursSincePrevious: 120,
        playsPerDay: 1200,
      },
      {
        // 2 days = 48h later: +1000 plays -> 500/day. Comments went down by 2.
        takenAt: nov(12),
        plays: 8000,
        likes: 450,
        comments: 28,
        playsDelta: 1000,
        likesDelta: 50,
        commentsDelta: -2,
        hoursSincePrevious: 48,
        playsPerDay: 500,
      },
    ]);
    expect(data.velocity).toEqual({
      velocity: 1000,
      velocityBasis: "window",
      velocityScore: 2.86,
      playsPerDay: 1000,
      lifetimePlaysPerDay: 727.27,
      playsGained: 7000,
      spanFrom: nov(5),
      spanTo: nov(12),
      spanHours: 168,
      snapshots: 3,
      creatorMedianVelocity: 350,
    });
    expect(meta).toMatchObject({ window: "7d", minSpanHours: 1 });
    expect(nextSteps).toEqual([
      { command: "ig video trending --creator ana", description: expect.any(String) },
    ]);
  });

  it("finds the video by reel URL and by media id", async () => {
    env = seeded();
    const byCode = await runHistory({ video: "ana01" });
    for (const ref of [
      "https://www.instagram.com/reel/ana01/",
      "https://www.instagram.com/reel/ana01/?igsh=abc123",
      "https://www.instagram.com/ana/reel/ana01/",
      "  ana01  ",
      "101",
    ]) {
      const { data } = await runHistory({ video: ref });
      expect(data).toEqual(byCode.data);
    }
  });

  it("--limit keeps the latest N rows with their deltas; totalSnapshots stays full", async () => {
    env = seeded();
    const { data } = await runHistory({ video: "ana01", limit: 2 });
    expect(data.totalSnapshots).toBe(3);
    expect(data.snapshots.map((s) => s.takenAt)).toEqual([nov(10), nov(12)]);
    // The first shown row still compares with the hidden one before it.
    expect(data.snapshots[0]).toMatchObject({ playsDelta: 6000, hoursSincePrevious: 120 });
    expect(data.velocity.snapshots).toBe(3);

    const one = await runHistory({ video: "ana01", limit: 1 });
    expect(one.data.snapshots).toHaveLength(1);
    expect(one.data.snapshots[0]).toMatchObject({ takenAt: nov(12), playsDelta: 1000 });
  });

  it("reports the same velocity as video trending for every measurable video", async () => {
    env = seeded();
    for (const window of ["7d", "2d"]) {
      const listed = await run<TrendingRow[]>(trending, { window, limit: 50 });
      expect(listed.data).toHaveLength(9);
      for (const row of listed.data) {
        const { data } = await runHistory({ video: row.shortcode, window });
        expect(row).toMatchObject(data.velocity);
      }
    }
  });

  it("--window changes the velocity summary, not the rows", async () => {
    env = seeded();
    const { data, meta } = await runHistory({ video: "ana01", window: "2d" });
    // Baseline Nov 10: (8000 - 7000) / 2 days = 500/day; 500 / median 350 = 1.43.
    expect(data.velocity).toMatchObject({
      velocity: 500,
      velocityScore: 1.43,
      playsGained: 1000,
      spanFrom: nov(10),
      spanHours: 48,
    });
    expect(data.snapshots).toHaveLength(3);
    expect(meta.window).toBe("2d");
  });

  it("a single snapshot gives the lifetime basis and suggests a refresh", async () => {
    env = seeded();
    const { data, nextSteps } = await runHistory({ video: "ana04" });
    expect(data.totalSnapshots).toBe(1);
    expect(data.snapshots).toHaveLength(1);
    // 2000 plays at 4 days old -> 500/day; 500 / 350 = 1.43.
    expect(data.velocity).toMatchObject({
      velocity: 500,
      velocityBasis: "lifetime",
      velocityScore: 1.43,
      playsPerDay: null,
      snapshots: 1,
    });
    expect(nextSteps.map((s) => s.command)).toEqual([
      "ig creator get ana --refresh",
      "ig video trending --creator ana",
    ]);
  });

  it("a video with hidden counts has a history but no velocity", async () => {
    env = seeded();
    const { data } = await runHistory({ video: "ana05" });
    expect(data.snapshots).toEqual([
      {
        takenAt: nov(12),
        plays: null,
        likes: null,
        comments: null,
        playsDelta: null,
        likesDelta: null,
        commentsDelta: null,
        hoursSincePrevious: null,
        playsPerDay: null,
      },
    ]);
    expect(data.velocity).toMatchObject({
      velocity: null,
      velocityBasis: null,
      velocityScore: null,
      creatorMedianVelocity: 350,
    });
  });

  it("an unknown video is NOT_FOUND, a bad window INVALID_INPUT", async () => {
    env = seeded();
    await expect(runHistory({ video: "zzzzz" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      runHistory({ video: "https://www.instagram.com/reel/zzzzz/" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(runHistory({ video: "ana01", window: "nope" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(runHistory({})).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("human: prints the series and the velocity summary", async () => {
    env = seeded();
    const { out, err } = human(videoHistory, await runHistory({ video: "ana01" }));
    const lines = out.split("\n");
    // Published Nov 1, 11 days before the frozen clock.
    expect(lines[0]).toBe("@ana · ana01 · published 11d ago");
    expect(lines[1]).toBe("red alert");
    expect(out).toContain("SNAPSHOT");
    expect(out).toContain("PLAYS/DAY");
    // plays, delta, plays/day, hours since, likes, delta, comments, delta
    expect(out).toMatch(/1K\s+–\s+–\s+–\s+100\s+–\s+10\s+–/);
    expect(out).toMatch(/7K\s+\+6K\s+1\.2K\s+5d\s+400\s+\+300\s+30\s+\+20/);
    expect(out).toMatch(/8K\s+\+1K\s+500\s+2d\s+450\s+\+50\s+28\s+-2/);
    expect(lineWith(out, "window 7d")).toContain("+7K plays over 7d = 1K/day");
    expect(lineWith(out, "lifetime")).toContain("727/day since it was published");
    expect(lineWith(out, "score")).toContain(
      "2.9x this creator's median of 350/day (window basis)",
    );
    expect(err).toBe("");
  });

  it("human: says how many rows are hidden by --limit", async () => {
    env = seeded();
    const { err } = human(videoHistory, await runHistory({ video: "ana01", limit: 2 }));
    expect(err).toContain("2 latest shown of 3");
  });

  it("human: a single snapshot shows the lifetime rate and the hint", async () => {
    env = seeded();
    const { out, err } = human(videoHistory, await runHistory({ video: "ana04" }));
    expect(out).not.toContain("window 7d");
    expect(lineWith(out, "lifetime")).toContain("500/day since it was published");
    expect(lineWith(out, "score")).toContain("1.4x this creator's median of 350/day (lifetime");
    expect(err).toContain(
      "note 1 snapshot(s): growth needs two at different times. Run `ig creator get ana --refresh` again on a later day.",
    );
  });

  it("human: explains a count that went down", async () => {
    env = seeded();
    // ana02 read 500 on Nov 5; make the newest reading lower: 400.
    env.ctx.store.db
      .prepare("UPDATE video_snapshots SET plays = ? WHERE video_id = ? AND taken_at = ?")
      .run(400, "102", nov(12));
    const result = await runHistory({ video: "ana02" });
    expect(result.data.velocity).toMatchObject({
      velocity: 0,
      playsPerDay: 0,
      playsGained: -100,
      velocityBasis: "window",
    });
    const { out, err } = human(videoHistory, result);
    expect(lineWith(out, "window 7d")).toContain("-100 plays over 7d = 0/day");
    expect(err).toContain("The play count went down over the window; the rate is reported as 0.");
  });

  it("human: a caption cannot smuggle an ANSI escape into the terminal", async () => {
    env = seeded();
    const { out, err } = human(videoHistory, await runHistory({ video: "ana01" }));
    expect(out).toContain("red alert");
    expect(out).not.toContain(`${ESC}[31m`);
    expect(out).not.toContain(ESC);
    expect(err).not.toContain(ESC);
  });
});

// --- creator history -----------------------------------------------------------------

describe("creator history", () => {
  const runHistory = (input: Record<string, unknown>) =>
    run<CreatorHistoryData>(creatorHistory, input);
  const machineZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

  it("returns the follower series with deltas", async () => {
    env = seeded();
    const { data, meta, nextSteps } = await runHistory({ username: "ana" });
    expect(data.creator).toEqual({
      id: "1",
      username: "ana",
      url: "https://www.instagram.com/ana/",
      followers: 10_000,
      following: 101,
      mediaCount: 45,
      videoCount: 5,
    });
    expect(data.totalSnapshots).toBe(3);
    expect(data.snapshots).toEqual([
      {
        takenAt: nov(1),
        followers: 9000,
        following: 100,
        mediaCount: 40,
        followersDelta: null,
        followingDelta: null,
        mediaCountDelta: null,
        hoursSincePrevious: null,
        followersPerDay: null,
      },
      {
        // 4 days = 96h later: +500 -> 125/day.
        takenAt: nov(5),
        followers: 9500,
        following: 101,
        mediaCount: 42,
        followersDelta: 500,
        followingDelta: 1,
        mediaCountDelta: 2,
        hoursSincePrevious: 96,
        followersPerDay: 125,
      },
      {
        // 7 days = 168h later: +500 -> 71.428 -> 71.43/day.
        takenAt: nov(12),
        followers: 10_000,
        following: 101,
        mediaCount: 45,
        followersDelta: 500,
        followingDelta: 0,
        mediaCountDelta: 3,
        hoursSincePrevious: 168,
        followersPerDay: 71.43,
      },
    ]);
    expect(meta).toMatchObject({ window: "7d", minSpanHours: 1 });
    expect(nextSteps).toEqual([
      { command: "ig video trending --creator ana", description: expect.any(String) },
    ]);
  });

  it("measures growth over the window", async () => {
    env = seeded();
    // 7d: baseline Nov 5 (9500). +500 over 7 days -> 71.43/day; 500/9500 = 0.0526.
    expect((await runHistory({ username: "ana" })).data.growth).toEqual({
      followersGained: 500,
      followersPerDay: 71.43,
      followerGrowthRate: 0.0526,
      spanFrom: nov(5),
      spanTo: nov(12),
      spanHours: 168,
    });
    // 30d: the history is shorter, baseline Nov 1 (9000). +1000 over 11 days
    // (264h) -> 90.91/day; 1000/9000 = 0.1111.
    const month = await runHistory({ username: "ana", window: "30d" });
    expect(month.data.growth).toEqual({
      followersGained: 1000,
      followersPerDay: 90.91,
      followerGrowthRate: 0.1111,
      spanFrom: nov(1),
      spanTo: nov(12),
      spanHours: 264,
    });
    expect(month.meta.window).toBe("30d");
    // The rows do not depend on the window.
    expect(month.data.snapshots).toHaveLength(3);
  });

  it("computes the posting cadence in the machine's time zone", async () => {
    env = seeded();
    const { cadence } = (await runHistory({ username: "ana" })).data;
    // Ana's reels were published Nov 1, 2, 3, 8, 9 at 12:00Z; now is Nov 12 12:00Z.
    // The store reaches back 11 days = 1.5714 weeks: 5 / 1.5714 = 3.18 per week,
    // for both periods, neither of which is covered.
    // Gaps: 24h, 24h, 120h, 24h -> median 24.
    expect(cadence).toMatchObject({
      timeZone: machineZone,
      videos: 5,
      oldestAt: nov(1),
      newestAt: nov(9),
      postsPerWeek4w: 3.18,
      postsPerWeek12w: 3.18,
      covers4w: false,
      covers12w: false,
      medianGapHours: 24,
    });
    expect(cadence.byWeekday).toHaveLength(7);
    expect(cadence.byHour).toHaveLength(24);
    expect(sum(cadence.byWeekday)).toBe(5);
    expect(sum(cadence.byHour)).toBe(5);
    // All five were posted at the same UTC time, so at the same local hour.
    expect(cadence.topHourCount).toBe(5);
    expect(cadence.topWeekday).toEqual(expect.any(String));
  });

  it("accepts an @handle or a profile URL, and --limit keeps the latest rows", async () => {
    env = seeded();
    const plain = await runHistory({ username: "ana" });
    expect((await runHistory({ username: "@Ana" })).data).toEqual(plain.data);
    expect((await runHistory({ username: "https://www.instagram.com/ana/" })).data).toEqual(
      plain.data,
    );

    const { data } = await runHistory({ username: "ana", limit: 1 });
    expect(data.totalSnapshots).toBe(3);
    expect(data.snapshots).toHaveLength(1);
    expect(data.snapshots[0]).toMatchObject({ takenAt: nov(12), followersDelta: 500 });
    expect(data.growth.followersGained).toBe(500);
  });

  it("a single snapshot gives no growth and suggests a refresh", async () => {
    env = seeded();
    const { data, nextSteps } = await runHistory({ username: "cata" });
    expect(data.totalSnapshots).toBe(1);
    expect(data.growth).toEqual({
      followersGained: null,
      followersPerDay: null,
      followerGrowthRate: null,
      spanFrom: null,
      spanTo: null,
      spanHours: null,
    });
    expect(data.cadence.videos).toBe(3);
    expect(nextSteps.map((s) => s.command)).toEqual([
      "ig creator get cata --refresh",
      "ig video trending --creator cata",
    ]);
    expect(nextSteps[0]?.description).toContain("second snapshot");
  });

  it("a creator with nothing stored has empty rows and an empty cadence", async () => {
    env = seeded();
    const { data, nextSteps } = await runHistory({ username: "eli" });
    expect(data.totalSnapshots).toBe(0);
    expect(data.snapshots).toEqual([]);
    expect(data.cadence).toMatchObject({
      videos: 0,
      oldestAt: null,
      postsPerWeek4w: null,
      postsPerWeek12w: null,
      covers4w: false,
      medianGapHours: null,
      topWeekday: null,
      topHour: null,
    });
    expect(nextSteps[0]?.command).toBe("ig creator get eli --refresh");
  });

  it("with two snapshots but no reels the next step is to fetch them", async () => {
    env = seeded();
    env.ctx.store.db.prepare("DELETE FROM videos WHERE creator_id = ?").run("2");
    const { data, nextSteps } = await runHistory({ username: "beto" });
    expect(data.growth).toMatchObject({ followersGained: 100, followerGrowthRate: 0.25 });
    expect(nextSteps[0]).toEqual({
      command: "ig creator get beto --refresh",
      description: "fetch this creator's reels",
    });
  });

  it("an untracked creator is NOT_FOUND, a bad window INVALID_INPUT", async () => {
    env = seeded();
    await expect(runHistory({ username: "nobody" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(runHistory({ username: "ana", window: "nope" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("human: prints the series, the growth and the cadence", async () => {
    env = seeded();
    const { out, err } = human(creatorHistory, await runHistory({ username: "ana" }));
    expect(out.split("\n")[0]).toBe("@ana · 10K followers · 3 snapshot(s)");
    expect(out).toContain("SNAPSHOT");
    expect(out).toContain("FOLLOWERS");
    // followers, delta, per day, hours since, following, delta, posts, delta
    expect(out).toMatch(/9K\s+–\s+–\s+–\s+100\s+–\s+40\s+–/);
    expect(out).toMatch(/9\.5K\s+\+500\s+125\s+4d\s+101\s+\+1\s+42\s+\+2/);
    expect(out).toMatch(/10K\s+\+500\s+71\.4\s+7d\s+101\s+0\s+45\s+\+3/);
    expect(lineWith(out, "window 7d")).toContain("+500 followers (5.26%) over 7d = 71.4/day");
    expect(lineWith(out, "posts / week")).toContain("3.18 over the last 4 weeks");
    expect(lineWith(out, "posts / week")).toContain("(stored reels start 11d ago)");
    expect(out).toContain("3.18 over the last 12 weeks");
    expect(lineWith(out, "median gap")).toContain("24h between posts");
    expect(lineWith(out, "usual slot")).toContain("(5 of 5)");
    expect(lineWith(out, "time zone")).toContain(machineZone);
    expect(lineWith(out, "based on")).toContain("5 stored reel(s) with a publish date");
    expect(err).toBe("");
  });

  it("human: a single snapshot gets a note with the refresh command", async () => {
    env = seeded();
    const { out, err } = human(creatorHistory, await runHistory({ username: "cata" }));
    expect(out.split("\n")[0]).toBe("@cata · 2K followers · 1 snapshot(s)");
    expect(out).not.toContain("window 7d");
    expect(err).toContain(
      "note 1 profile snapshot(s): follower growth needs two at different times. Run `ig creator get cata --refresh` again on a later day.",
    );
  });

  it("human: says so when there are no snapshots and no reels", async () => {
    env = seeded();
    const { out, err } = human(creatorHistory, await runHistory({ username: "eli" }));
    expect(out.split("\n")[0]).toBe("@eli · 300 followers · 0 snapshot(s)");
    expect(out).not.toContain("posts / week");
    expect(err).toContain("No profile snapshots stored for this creator.");
    expect(err).toContain("No stored reels with a publish date, so no posting cadence.");
    expect(err).toContain("note 0 profile snapshot(s)");
  });
});

// --- niche movers --------------------------------------------------------------------

describe("niche movers", () => {
  const runMovers = (input: Record<string, unknown>) => run<Mover[]>(movers, input);

  it("ranks by follower growth rate by default, creators without growth last", async () => {
    env = seeded();
    const { data, meta } = await runMovers({ slug: "cocina" });
    // beto 100/400 = 0.25; ana 500/9500 = 0.0526; dani and eli have no growth
    // and fall back to followers (50000, 300).
    expect(names(data)).toEqual(["beto", "ana", "dani", "eli"]);
    expect(data[0]).toEqual({
      id: "2",
      username: "beto",
      url: "https://www.instagram.com/beto/",
      followers: 500,
      // 400 -> 500 over 7 days: +100, 14.2857 -> 14.29/day, 0.25.
      followersGained: 100,
      followersPerDay: 14.29,
      followerGrowthRate: 0.25,
      spanFrom: nov(5),
      spanTo: nov(12),
      spanHours: 168,
      snapshots: 2,
      // Median of 3000 and 300.
      medianVelocity: 1650,
      recentVideos: 2,
      recentVideosOverWindow: 1,
    });
    expect(data[1]).toMatchObject({
      username: "ana",
      followersGained: 500,
      followersPerDay: 71.43,
      followerGrowthRate: 0.0526,
      snapshots: 3,
      // Median of 100, 200, 500, 1000; the hidden reel does not count.
      medianVelocity: 350,
      recentVideos: 4,
      recentVideosOverWindow: 3,
    });
    expect(data[2]).toMatchObject({
      username: "dani",
      followers: 50_000,
      followersGained: null,
      followersPerDay: null,
      followerGrowthRate: null,
      spanFrom: null,
      spanHours: null,
      snapshots: 1,
      medianVelocity: null,
      recentVideos: 0,
      recentVideosOverWindow: 0,
    });
    expect(data[3]).toMatchObject({ username: "eli", snapshots: 0, followersGained: null });
    expect(meta).toMatchObject({
      sort: "growth",
      window: "7d",
      recent: "30d",
      minSpanHours: 1,
      creatorsConsidered: 4,
      creatorsWithFollowerGrowth: 2,
      creatorsWithMedianVelocity: 2,
    });
  });

  it("--sort followers ranks by followers per day", async () => {
    env = seeded();
    const { data, meta } = await runMovers({ slug: "cocina", sort: "followers" });
    // ana 71.43/day, beto 14.29/day, then the nulls by followers.
    expect(names(data)).toEqual(["ana", "beto", "dani", "eli"]);
    expect(meta.sort).toBe("followers");
  });

  it("--sort velocity ranks by the median plays/day of recent videos", async () => {
    env = seeded();
    const { data, meta } = await runMovers({ slug: "cocina", sort: "velocity" });
    // beto 1650, ana 350, then the nulls by followers.
    expect(names(data)).toEqual(["beto", "ana", "dani", "eli"]);
    expect(data.map((r) => r.medianVelocity)).toEqual([1650, 350, null, null]);
    expect(meta.sort).toBe("velocity");
  });

  it("--recent decides which videos count towards the median", async () => {
    env = seeded();
    // 5d: cutoff Nov 7 12:00Z. Ana: ana04 (500/day; ana05 is hidden). Beto: beto2 (300/day).
    const five = await runMovers({ slug: "cocina", sort: "velocity", recent: "5d" });
    expect(names(five.data)).toEqual(["ana", "beto", "dani", "eli"]);
    expect(five.data[0]).toMatchObject({
      medianVelocity: 500,
      recentVideos: 1,
      recentVideosOverWindow: 0,
    });
    expect(five.data[1]).toMatchObject({
      medianVelocity: 300,
      recentVideos: 1,
      recentVideosOverWindow: 0,
    });
    expect(five.meta).toMatchObject({ recent: "5d", creatorsWithMedianVelocity: 2 });

    // 4d: cutoff Nov 8 12:00Z, the instant ana04 was published. It still counts.
    const four = await runMovers({ slug: "cocina", sort: "velocity", recent: "4d" });
    expect(four.data.find((r) => r.username === "ana")).toMatchObject({
      medianVelocity: 500,
      recentVideos: 1,
    });

    // 3d: cutoff Nov 9 12:00Z. Ana has only the hidden reel left; beto keeps beto2.
    // Without a median Ana sorts among the nulls, by followers: dani 50000, ana 10000, eli 300.
    const three = await runMovers({ slug: "cocina", sort: "velocity", recent: "3d" });
    expect(names(three.data)).toEqual(["beto", "dani", "ana", "eli"]);
    expect(three.data.find((r) => r.username === "ana")).toMatchObject({
      medianVelocity: null,
      recentVideos: 0,
      recentVideosOverWindow: 0,
    });
    expect(three.meta.creatorsWithMedianVelocity).toBe(1);

    // The follower columns do not depend on --recent.
    expect(three.data.find((r) => r.username === "ana")?.followersGained).toBe(500);
  });

  it("--recent accepts a date", async () => {
    env = seeded();
    // Nov 7 12:00Z is 5 days before the frozen clock: the same cutoff as 5d.
    const { data } = await runMovers({
      slug: "cocina",
      sort: "velocity",
      recent: "2026-11-07T12:00:00.000Z",
    });
    expect(data.map((r) => r.medianVelocity)).toEqual([500, 300, null, null]);
  });

  it("--window changes the follower baseline and the video velocities", async () => {
    env = seeded();
    const month = await runMovers({ slug: "cocina", window: "30d", sort: "followers" });
    // Ana from Nov 1: +1000 over 11 days -> 90.91/day, 1000/9000 = 0.1111.
    expect(month.data[0]).toMatchObject({
      username: "ana",
      followersGained: 1000,
      followersPerDay: 90.91,
      followerGrowthRate: 0.1111,
      spanFrom: nov(1),
      spanHours: 264,
    });

    const two = await runMovers({ slug: "cocina", window: "2d" });
    // Ana: the latest snapshot at least 2 days old is Nov 5 (there is none on
    // Nov 10), so her growth is unchanged; ana01's rate drops to 500/day and
    // the median over 100, 200, 500, 500 stays 350.
    expect(two.data.find((r) => r.username === "ana")).toMatchObject({
      followersGained: 500,
      spanFrom: nov(5),
      medianVelocity: 350,
    });
  });

  it("notes the creators without two snapshots and suggests a refresh", async () => {
    env = seeded();
    const { meta, nextSteps } = await runMovers({ slug: "cocina" });
    expect(meta.note).toBe(
      "2 of 4 creators have no two profile snapshots at least 1h apart, so no follower growth. Run `ig niche refresh cocina` again on a later day.",
    );
    expect(nextSteps.map((s) => s.command)).toEqual([
      "ig niche refresh cocina",
      "ig creator history beto",
    ]);
  });

  it("has no note when every creator has growth", async () => {
    env = seeded();
    const { data, meta, nextSteps } = await runMovers({ slug: "duo" });
    expect(names(data)).toEqual(["beto", "ana"]);
    expect(meta).toMatchObject({
      creatorsConsidered: 2,
      creatorsWithFollowerGrowth: 2,
      note: null,
    });
    expect(nextSteps.map((s) => s.command)).toEqual(["ig creator history beto"]);
  });

  it("snapshots seconds apart do not count as growth", async () => {
    env = seeded();
    // Dani gets a second snapshot 30 seconds after the first.
    env.ctx.store.db
      .prepare(
        "INSERT INTO creator_snapshots (creator_id, taken_at, followers, following, media_count) VALUES (?, ?, ?, ?, ?)",
      )
      .run("4", "2026-11-12T12:00:30.000Z", 50_010, 10, 5);
    const { data, meta } = await runMovers({ slug: "cocina" });
    expect(data.find((r) => r.username === "dani")).toMatchObject({
      snapshots: 2,
      followersGained: null,
      followerGrowthRate: null,
    });
    expect(meta.creatorsWithFollowerGrowth).toBe(2);
    expect(meta.note).toContain("2 of 4 creators");
  });

  it("--limit cuts the rows, not the counts", async () => {
    env = seeded();
    const { data, meta } = await runMovers({ slug: "cocina", limit: 1 });
    expect(names(data)).toEqual(["beto"]);
    expect(meta).toMatchObject({ creatorsConsidered: 4, creatorsWithFollowerGrowth: 2 });
  });

  it("an empty niche gives no rows and the command to fill it", async () => {
    env = seeded();
    const { data, meta, nextSteps } = await runMovers({ slug: "vacio" });
    expect(data).toEqual([]);
    expect(meta).toMatchObject({ creatorsConsidered: 0, note: null });
    expect(nextSteps.map((s) => s.command)).toEqual(["ig creator add <username> --niche vacio"]);
  });

  it("an unknown niche is NOT_FOUND; bad flags are INVALID_INPUT", async () => {
    env = seeded();
    await expect(runMovers({ slug: "nada" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(runMovers({ slug: "cocina", window: "nope" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(runMovers({ slug: "cocina", recent: "nope" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "--recent is not a duration or a past date.",
    });
    await expect(runMovers({ slug: "cocina", sort: "plays" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("human: marks the sorted column and prints the note", async () => {
    env = seeded();
    const { out, err } = human(movers, await runMovers({ slug: "cocina" }));
    const header = out.split("\n")[0] ?? "";
    expect(header).toContain("GROWTH ↓");
    expect(header).toContain("MEDIAN PLAYS/DAY");
    expect(header).not.toContain("MEDIAN PLAYS/DAY ↓");
    // followers, gained, growth, per day, span
    expect(lineWith(out, "beto")).toMatch(/1\s+beto\s+500\s+\+100\s+25\.00%\s+14\.3\s+7d/);
    expect(lineWith(out, "beto")).toContain("2 (1 measured)");
    expect(lineWith(out, "ana")).toMatch(/2\s+ana\s+10K\s+\+500\s+5\.26%\s+71\.4\s+7d\s+350/);
    expect(lineWith(out, "ana")).toContain("4 (3 measured)");
    expect(lineWith(out, "dani")).toMatch(/3\s+dani\s+50K\s+–\s+–\s+–\s+–\s+–\s+–/);
    expect(err).toContain("window 7d · median plays/day over reels published in the last 30d");
    expect(err).toContain("note 2 of 4 creators have no two profile snapshots");

    const byVelocity = human(movers, await runMovers({ slug: "cocina", sort: "velocity" }));
    expect(byVelocity.out.split("\n")[0]).toContain("MEDIAN PLAYS/DAY ↓");
    expect(byVelocity.out.split("\n")[0]).not.toContain("GROWTH ↓");
  });

  it("human: says so for an empty niche", async () => {
    env = seeded();
    const { out, err } = human(movers, await runMovers({ slug: "vacio" }));
    expect(out).toBe("");
    expect(err).toContain("No creators in this niche yet.");
    expect(err).not.toContain("note");
  });
});

// --- video top --sort velocity -------------------------------------------------------

describe("video top --sort velocity", () => {
  const runTop = (input: Record<string, unknown>) => run<RankedVideo[]>(top, input);

  it("orders by velocityScore, unscored by raw rate, unmeasurable last", async () => {
    env = seeded();
    const { data, meta } = await runTop({ sort: "velocity" });
    expect(codes(data)).toEqual([
      "cata3",
      "ana01",
      "ana04",
      "cata2",
      "ana03",
      "cata1",
      "ana02",
      "beto1",
      "beto2",
      "ana05",
    ]);
    expect(meta.sort).toBe("velocity");
  });

  it("carries velocity, velocityBasis and velocityScore on every row, for any sort", async () => {
    env = seeded();
    for (const sort of ["velocity", "plays", "outlier"]) {
      const { data } = await runTop({ sort });
      const by = (code: string) => data.find((v) => v.shortcode === code);
      expect(data).toHaveLength(10);
      expect(by("ana01")).toMatchObject({
        velocity: 1000,
        velocityBasis: "window",
        velocityScore: 2.86,
      });
      expect(by("ana04")).toMatchObject({
        velocity: 500,
        velocityBasis: "lifetime",
        velocityScore: 1.43,
      });
      expect(by("beto2")).toMatchObject({
        velocity: 300,
        velocityBasis: "lifetime",
        velocityScore: null,
      });
      expect(by("cata3")).toMatchObject({
        velocity: 125,
        velocityBasis: "window",
        velocityScore: 6.25,
      });
      expect(by("ana05")).toMatchObject({
        velocity: null,
        velocityBasis: null,
        velocityScore: null,
      });
    }
  });

  it("agrees with video trending on the default window", async () => {
    env = seeded();
    const ranked = await runTop({ sort: "velocity", limit: 50 });
    const listed = await run<TrendingRow[]>(trending, { limit: 50 });
    // video trending drops the unmeasurable video; otherwise the same order.
    expect(codes(ranked.data).filter((c) => c !== "ana05")).toEqual(codes(listed.data));
    for (const row of listed.data) {
      expect(ranked.data.find((v) => v.id === row.id)).toMatchObject({
        velocity: row.velocity,
        velocityBasis: row.velocityBasis,
        velocityScore: row.velocityScore,
      });
    }
  });

  it("combines with --niche, --per-creator and --limit", async () => {
    env = seeded();
    expect(codes((await runTop({ sort: "velocity", niche: "cocina" })).data)).toEqual([
      "ana01",
      "ana04",
      "ana03",
      "ana02",
      "beto1",
      "beto2",
      "ana05",
    ]);
    expect(codes((await runTop({ sort: "velocity", perCreator: 1, limit: 2 })).data)).toEqual([
      "cata3",
      "ana01",
    ]);
  });

  it("human: shows a VELOCITY column", async () => {
    env = seeded();
    const { out } = human(top, await runTop({ sort: "velocity" }));
    expect(out).toContain("VELOCITY");
    expect(out).toContain("2.9x");
    expect(out).not.toContain(ESC);
  });
});
