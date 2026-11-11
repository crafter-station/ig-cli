import { afterEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "../src/cligentic/platform/style.js";
import { videoCommands } from "../src/commands/video.js";
import type { RankedVideo, StoredVideo, Video } from "../src/core/types.js";
import type { CommandDef } from "../src/lib/command.js";
import type { Meta } from "../src/lib/output.js";
import { byId, type FakeData, type TestEnv, testEnv } from "./fake-backend.js";
import { creator, video } from "./helpers.js";

const defs = videoCommands as CommandDef[];
const list = byId(defs, "video.list");
const top = byId(defs, "video.top");
const search = byId(defs, "video.search");
const discover = byId(defs, "video.discover");

let env: TestEnv;
afterEach(async () => {
  vi.restoreAllMocks();
  await env.cleanup();
});

const ana = creator({ id: "1", username: "ana", followers: 10_000 });
const beto = creator({ id: "2", username: "beto", followers: 100 });
const cata = creator({ id: "3", username: "cata", followers: 500 });

const a = (id: string, over: Partial<Video>) =>
  video({ id, shortcode: id, creatorId: "1", creatorUsername: "ana", ...over });
const b = (id: string, over: Partial<Video>) =>
  video({ id, shortcode: id, creatorId: "2", creatorUsername: "beto", ...over });

// Ana's reels cross a year and a month boundary and include one with hidden
// counts. Her median over the four visible play counts is 200.
const anaVideos = [
  a("a1", { takenAt: "2025-12-31T23:59:59.000Z", plays: 1000, likes: 50, comments: 5 }),
  a("a2", { takenAt: "2026-01-01T00:00:00.000Z", plays: 100, likes: 500, comments: 0 }),
  a("a3", { takenAt: "2026-01-31T12:00:00.000Z", plays: 100, likes: 10, comments: 0 }),
  a("a4", { takenAt: "2026-02-01T00:00:00.000Z", plays: 300, likes: 20, comments: 0 }),
  a("a5", { takenAt: "2026-02-10T00:00:00.000Z", plays: null, likes: null, comments: null }),
];
// Beto has two reels: below the minimum for an outlier score.
const betoVideos = [
  b("b1", { takenAt: "2026-01-15T00:00:00.000Z", plays: 5000, likes: 30, comments: 1 }),
  b("b2", { takenAt: "2026-02-05T00:00:00.000Z", plays: 4000, likes: 10, comments: 0 }),
];

/** Ana and Beto in niche `cocina`, Cata tracked with no videos and no niche. */
function seeded(data: FakeData = {}): TestEnv {
  const e = testEnv(data);
  const { store } = e.ctx;
  store.createNiche({ slug: "cocina", name: "Cocina" });
  store.createNiche({ slug: "vacio", name: "Vacío" });
  for (const c of [ana, beto, cata]) store.upsertCreator(c, { refreshed: false });
  store.addCreatorToNiche("1", "cocina");
  store.addCreatorToNiche("2", "cocina");
  store.upsertVideos([...anaVideos, ...betoVideos]);
  return e;
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

async function runTop(input: Record<string, unknown> = {}) {
  const result = await env.run(top, input);
  return { ...result, data: result.data as RankedVideo[] };
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

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const set = (source: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(source)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  set(vars);
  try {
    return fn();
  } finally {
    set(before);
  }
}

const plain = { NO_COLOR: "1", FORCE_COLOR: undefined };
const colored = { NO_COLOR: undefined, FORCE_COLOR: "1" };
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

function human(def: CommandDef, data: unknown, meta: Meta = {}) {
  return capture(() => def.human?.(data as never, env.ctx, meta));
}

describe("video top", () => {
  it("ranks by outlier with the median taken over each creator's full set", async () => {
    env = seeded();
    const { data, meta } = await runTop();
    // a1 5.0x, a4 1.5x, then the 0.5x pair, then creators without a score by plays.
    expect(ids(data)).toEqual(["a1", "a4", "a3", "a2", "b1", "b2", "a5"]);
    expect(data[0]).toMatchObject({ outlierScore: 5, creatorMedianPlays: 200 });
    expect(data[1]?.outlierScore).toBe(1.5);
    expect(data.find((v) => v.id === "b1")?.outlierScore).toBeNull();
    expect(data.find((v) => v.id === "a5")).toMatchObject({ plays: null, outlierScore: null });
    expect(meta).toEqual({
      sort: "outlier",
      videosConsidered: 7,
      creatorsConsidered: 3,
      creatorsBelowOutlierMinimum: 2,
      outlierMinimumVideos: 3,
    });
  });

  it("--since filters after ranking, and includes the boundary instant", async () => {
    env = seeded();
    const { data, meta } = await runTop({ since: "2026-01-01" });
    expect(ids(data)).toEqual(["a4", "a3", "a2", "b1", "b2", "a5"]);
    // a1 is filtered out but still counts towards Ana's median.
    expect(data[0]).toMatchObject({ id: "a4", outlierScore: 1.5, creatorMedianPlays: 200 });
    expect(meta?.videosConsidered).toBe(7);
  });

  it("--since accepts a relative duration", async () => {
    env = testEnv();
    env.ctx.store.upsertCreator(ana);
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    env.ctx.store.upsertVideos([
      a("new", { takenAt: hoursAgo(1) }),
      a("old", { takenAt: hoursAgo(72) }),
      a("undated", { takenAt: null }),
    ]);
    expect(ids((await runTop({ since: "2d" })).data)).toEqual(["new"]);
    expect(ids((await runTop({ since: "1w", sort: "recent" })).data)).toEqual(["new", "old"]);
  });

  it("rejects an unparseable --since with the valid forms, even on an empty database", async () => {
    env = testEnv();
    await expect(runTop({ since: "banana" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      hint: expect.stringContaining("30d"),
    });
  });

  it("sorts by recency across a month and a year boundary", async () => {
    env = seeded();
    const { data } = await runTop({ sort: "recent" });
    expect(ids(data)).toEqual(["a5", "b2", "a4", "a3", "b1", "a2", "a1"]);
  });

  it("sorts by engagement relative to followers, hidden counts last", async () => {
    env = seeded();
    const { data } = await runTop({ sort: "engagement" });
    // b1: 31/100. b2: 10/100. a2: 500/10000.
    expect(ids(data).slice(0, 3)).toEqual(["b1", "b2", "a2"]);
    expect(data[0]?.engagementRate).toBe(0.31);
    expect(data.at(-1)).toMatchObject({ id: "a5", engagementRate: null });
  });

  it("--min-plays drops low and hidden play counts", async () => {
    env = seeded();
    const { data } = await runTop({ minPlays: 300, sort: "plays" });
    expect(ids(data)).toEqual(["b1", "b2", "a1", "a4"]);
  });

  it("--per-creator caps after sorting, then --limit cuts", async () => {
    env = seeded();
    expect(ids((await runTop({ sort: "plays", perCreator: 1 })).data)).toEqual(["b1", "a1"]);
    expect(ids((await runTop({ sort: "plays", perCreator: 1, limit: 1 })).data)).toEqual(["b1"]);
    expect(ids((await runTop({ limit: 2 })).data)).toEqual(["a1", "a4"]);
  });

  it("scopes to a niche or a creator", async () => {
    env = seeded();
    const niche = await runTop({ niche: "cocina" });
    expect(niche.data).toHaveLength(7);
    expect(niche.meta).toMatchObject({ creatorsConsidered: 2, creatorsBelowOutlierMinimum: 1 });

    const one = await runTop({ creator: "@Beto" });
    expect(ids(one.data)).toEqual(["b1", "b2"]);
    expect(one.meta).toMatchObject({ creatorsConsidered: 1, creatorsBelowOutlierMinimum: 1 });
    expect(one.nextSteps?.[0]?.command).toBe("ig video download --top 2 --creator beto");
  });

  it("an unknown niche or creator is NOT_FOUND with a way out", async () => {
    env = seeded();
    await expect(runTop({ niche: "nope" })).rejects.toMatchObject({
      code: "NOT_FOUND",
      hint: expect.stringContaining("ig niche list"),
    });
    await expect(runTop({ creator: "nobody" })).rejects.toMatchObject({
      code: "NOT_FOUND",
      hint: expect.stringContaining("ig creator add nobody"),
    });
  });

  it("an empty scope returns an empty list that says where to get data", async () => {
    env = seeded();
    const emptyNiche = await runTop({ niche: "vacio" });
    expect(emptyNiche.data).toEqual([]);
    expect(emptyNiche.meta).toMatchObject({ videosConsidered: 0, creatorsConsidered: 0 });
    expect(emptyNiche.nextSteps).toEqual([
      expect.objectContaining({ command: "ig niche refresh vacio" }),
    ]);

    const noVideos = await runTop({ creator: "cata" });
    expect(noVideos.data).toEqual([]);
    expect(noVideos.nextSteps?.[0]?.command).toBe("ig creator get cata --refresh");
  });

  it("an empty database points at refresh commands", async () => {
    env = testEnv();
    const { data, nextSteps } = await runTop();
    expect(data).toEqual([]);
    expect(nextSteps?.map((s) => s.command)).toEqual([
      "ig niche refresh <slug>",
      "ig creator get <username> --refresh",
    ]);
  });

  it("filters that match nothing give no refresh advice: the data is there", async () => {
    env = seeded();
    const { data, nextSteps, meta } = await runTop({ minPlays: 1_000_000 });
    expect(data).toEqual([]);
    expect(nextSteps).toEqual([]);
    expect(meta?.videosConsidered).toBe(7);
  });

  it("rejects an out-of-range limit and an unknown sort", async () => {
    env = seeded();
    await expect(runTop({ limit: 0 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(runTop({ sort: "views" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("video top, human view", () => {
  const hostile = "\x1b[31mFREE\x1b[0m money\nsecond line\x07 \x1b]0;pwned\x07";

  it("shows the sorted metric, a dash for missing values, and a sanitized caption", async () => {
    env = seeded();
    env.ctx.store.upsertVideos([{ ...(anaVideos[0] as Video), caption: hostile }]);
    const { data, meta } = await runTop();
    const { out, err } = withEnv(plain, () => human(top, data, meta as Meta));
    const lines = out.trimEnd().split("\n");

    expect(lines[0]).toMatch(/^\s*#\s+CREATOR\s+OUTLIER ↓\s+PLAYS\s+AGE\s+LEN\s+CAPTION\s+LINK$/);
    expect(lines[1]).toMatch(/^\s*1\s+ana\s+5\.0x\s+1K\s/);
    expect(lines[1]).toContain("FREE money second line");
    expect(lines[1]).toContain("https://www.instagram.com/reel/a1/");
    // Hidden counts: a dash in both metric columns, never a zero.
    expect(lines.at(-1)).toMatch(/^\s*7\s+ana\s+–\s+–\s/);
    expect(out).not.toMatch(/[\x00-\x09\x0b-\x1f]/);
    expect(lines).toHaveLength(8);
    expect(err).toContain("2 of 3 creators have fewer than 3 videos");
  });

  it("keeps columns aligned when cells are styled", async () => {
    env = seeded();
    const { data, meta } = await runTop({ sort: "engagement" });
    const bare = withEnv(plain, () => human(top, data, meta as Meta)).out;
    const styled = withEnv(colored, () => human(top, data, meta as Meta)).out;
    expect(styled).toContain("\x1b[");
    expect(stripAnsi(styled)).toBe(bare);
    expect(bare.split("\n")[0]).toContain("ENGAGEMENT ↓");
    expect(bare).toContain("31.0%");
    const widths = styled.trimEnd().split("\n").map(visibleWidth);
    expect(Math.max(...widths)).toBeLessThan(140);
  });

  it("prints a single creator once as a heading instead of on every row", async () => {
    env = seeded();
    const { data, meta } = await runTop({ creator: "ana" });
    const { out } = withEnv(plain, () => human(top, data, meta as Meta));
    expect(out.split("\n")[0]).toBe("@ana · 5 reels");
    expect(out.split("\n")[1]).not.toContain("CREATOR");
    expect(out.match(/ana/g)).toHaveLength(1);
  });

  it("an empty result prints one line to stderr and nothing to stdout", async () => {
    env = seeded();
    const none = await runTop({ niche: "vacio" });
    expect(human(top, none.data, none.meta as Meta)).toEqual({
      out: "",
      err: "No videos stored in this scope yet.\n",
    });
    const filtered = await runTop({ minPlays: 1_000_000 });
    expect(human(top, filtered.data, filtered.meta as Meta).err).toBe(
      "None of the 7 stored videos match these filters.\n",
    );
  });
});

describe("video list", () => {
  async function runList(input: Record<string, unknown>) {
    const result = await env.run(list, input);
    return { ...result, data: result.data as StoredVideo[] };
  }

  it("lists newest first across the year boundary, up to the limit", async () => {
    env = seeded();
    expect(ids((await runList({ creator: "ana" })).data)).toEqual(["a5", "a4", "a3", "a2", "a1"]);
    const two = await runList({ creator: "https://www.instagram.com/ana/", limit: 2 });
    expect(ids(two.data)).toEqual(["a5", "a4"]);
    expect(env.backend.calls).toEqual([]);
  });

  it("an untracked creator is NOT_FOUND with the command that tracks it", async () => {
    env = seeded();
    await expect(runList({ creator: "@nobody" })).rejects.toMatchObject({
      code: "NOT_FOUND",
      hint: expect.stringContaining("ig creator add nobody"),
    });
  });

  it("a creator without videos returns an empty list pointing at --refresh", async () => {
    env = seeded();
    const { data, nextSteps } = await runList({ creator: "cata" });
    expect(data).toEqual([]);
    expect(nextSteps?.[0]?.command).toBe("ig video list cata --refresh");
  });

  it("--refresh fetches at least 15 reels even when the limit is smaller", async () => {
    const reels = Array.from({ length: 18 }, (_, i) =>
      video({
        id: `c${i}`,
        creatorId: "3",
        creatorUsername: "cata",
        takenAt: new Date(Date.UTC(2026, 9, 28 - i)).toISOString(),
      }),
    );
    env = seeded({ profiles: [cata], reels: { "3": reels } });
    const { data, meta } = await runList({ creator: "cata", refresh: true, limit: 2 });
    expect(ids(data)).toEqual(["c0", "c1"]);
    expect(env.backend.calls).toEqual(["getProfile:cata", "listReels:cata"]);
    expect(env.ctx.store.getCreator("cata").videoCount).toBe(15);
    expect(meta?.refresh).toEqual({
      status: "refreshed",
      reason: null,
      newVideos: 15,
      totalVideos: 15,
    });
  });

  it("--refresh on a fresh creator makes no request and says so in meta", async () => {
    env = seeded({ profiles: [ana] });
    env.ctx.store.upsertCreator(ana, { refreshed: true });
    const { data, meta } = await runList({ creator: "ana", refresh: true });
    expect(data).toHaveLength(5);
    expect(env.backend.calls).toEqual([]);
    expect(meta?.refresh).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("--force"),
    });

    await runList({ creator: "ana", refresh: true, force: true });
    expect(env.backend.calls).toEqual(["getProfile:ana", "listReels:ana"]);
  });

  it("--force without --refresh is rejected rather than ignored", async () => {
    env = seeded();
    await expect(runList({ creator: "ana", force: true })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("a block during --refresh propagates", async () => {
    env = seeded({ profiles: [ana] });
    env.backend.blockNext = "RATE_LIMITED";
    await expect(runList({ creator: "ana", refresh: true })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("human view: one heading, plays likes and comments, dashes for hidden counts", async () => {
    env = seeded();
    const { data } = await runList({ creator: "ana" });
    const { out } = withEnv(plain, () => human(list, data));
    const lines = out.trimEnd().split("\n");
    expect(lines[0]).toBe("@ana · 5 reels");
    expect(lines[1]).toMatch(/^#\s+PLAYS\s+LIKES\s+COMMENTS\s+AGE ↓\s+LEN\s+CAPTION\s+LINK$/);
    expect(lines[2]).toMatch(/^1\s+–\s+–\s+–\s/);
    expect(human(list, []).err).toContain("--refresh");
  });
});

describe("video search", () => {
  async function runSearch(input: Record<string, unknown>) {
    const result = await env.run(search, input);
    return { ...result, data: result.data as StoredVideo[] };
  }

  function withCaptions(): TestEnv {
    const e = seeded();
    e.ctx.store.upsertVideos([
      { ...(anaVideos[0] as Video), caption: "Receta fácil de pasta" },
      { ...(anaVideos[1] as Video), caption: "Pasta al pesto" },
      { ...(betoVideos[0] as Video), caption: "receta de pan" },
    ]);
    e.ctx.store.createNiche({ slug: "solo-ana", name: "Solo Ana" });
    e.ctx.store.addCreatorToNiche("1", "solo-ana");
    return e;
  }

  it("matches all words, ignoring accents and case", async () => {
    env = withCaptions();
    expect(ids((await runSearch({ query: "FACIL receta" })).data)).toEqual(["a1"]);
    expect(ids((await runSearch({ query: "pasta" })).data).sort()).toEqual(["a1", "a2"]);
    expect(ids((await runSearch({ query: "receta" })).data).sort()).toEqual(["a1", "b1"]);
    expect(env.backend.calls).toEqual([]);
  });

  it("honours --niche and --limit", async () => {
    env = withCaptions();
    expect(ids((await runSearch({ query: "receta", niche: "solo-ana" })).data)).toEqual(["a1"]);
    expect((await runSearch({ query: "pasta", limit: 1 })).data).toHaveLength(1);
    await expect(runSearch({ query: "pasta", niche: "nope" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("no match is an empty list that points at discover", async () => {
    env = withCaptions();
    const { data, nextSteps } = await runSearch({ query: 'sushi "crudo"' });
    expect(data).toEqual([]);
    expect(nextSteps).toEqual([
      expect.objectContaining({ command: 'ig video discover "sushi crudo"' }),
    ]);
  });

  it("FTS syntax in the query is treated as plain words", async () => {
    env = withCaptions();
    expect(ids((await runSearch({ query: 'pasta" OR NOT (pesto*' })).data)).toEqual([]);
    expect(ids((await runSearch({ query: "pesto*" })).data)).toEqual(["a2"]);
  });

  it("rejects an empty query and one without any word", async () => {
    env = withCaptions();
    await expect(runSearch({ query: "" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(runSearch({ query: "!!! ???" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      hint: expect.stringContaining("ig video search"),
    });
  });

  it("human view shows the creator column for mixed results", async () => {
    env = withCaptions();
    const { data } = await runSearch({ query: "receta" });
    const { out } = withEnv(plain, () => human(search, data));
    expect(out.split("\n")[0]).toMatch(/^#\s+CREATOR\s+PLAYS\s+LIKES\s+COMMENTS\s+AGE\s+LEN/);
    expect(out).toContain("Receta fácil de pasta");
    expect(human(search, []).out).toBe("");
  });
});

describe("video discover", () => {
  type Hit = Video & { creatorTracked: boolean };
  async function runDiscover(input: Record<string, unknown>) {
    const result = await env.run(discover, input);
    return { ...result, data: result.data as Hit[] };
  }

  const stranger = (n: number, over: Partial<Video> = {}) =>
    video({ id: `s${n}`, creatorId: `9${n}`, creatorUsername: `stranger${n}`, ...over });
  const found = [
    stranger(1, { plays: null }),
    a("ax", {}),
    stranger(2),
    stranger(1, { id: "s1b" }),
    stranger(3),
    stranger(4),
  ];

  it("searches reels by keyword, flags tracked authors and stores nothing", async () => {
    env = seeded({ reelSearch: { pasta: found } });
    const { data, nextSteps, meta } = await runDiscover({ query: " pasta " });
    expect(env.backend.calls).toEqual(["searchReels:pasta"]);
    expect(data.map((v) => [v.creatorUsername, v.creatorTracked])).toEqual([
      ["stranger1", false],
      ["ana", true],
      ["stranger2", false],
      ["stranger1", false],
      ["stranger3", false],
      ["stranger4", false],
    ]);
    expect(data[0]?.plays).toBeNull();
    expect(meta?.source).toBe("reels:pasta");
    // A few untracked authors, each once, never the tracked one.
    expect(nextSteps?.[0]).toMatchObject({
      command: "ig creator add stranger1 stranger2 stranger3",
      description: expect.stringContaining("4 are not tracked"),
    });
    expect(env.ctx.store.findVideo("s1")).toBeNull();
    expect(env.ctx.store.findVideo("ax")).toBeNull();
    expect(env.ctx.store.findCreator("stranger1")).toBeNull();
  });

  it("--hashtag strips a leading # and uses the hashtag surface", async () => {
    env = seeded({ hashtags: { recetas: found.slice(0, 2) } });
    const { data, meta } = await runDiscover({ query: "#recetas", hashtag: true, limit: 1 });
    expect(env.backend.calls).toEqual(["hashtagReels:recetas"]);
    expect(data).toHaveLength(1);
    expect(meta?.source).toBe("hashtag:recetas");
  });

  it("without --hashtag a # is part of the keyword", async () => {
    env = seeded();
    await runDiscover({ query: "#recetas" });
    expect(env.backend.calls).toEqual(["searchReels:#recetas"]);
  });

  it("no results is an empty list with no made-up next step", async () => {
    env = seeded();
    const { data, nextSteps } = await runDiscover({ query: "nada" });
    expect(data).toEqual([]);
    expect(nextSteps).toEqual([]);
  });

  it("does not suggest adding authors when all are tracked", async () => {
    env = seeded({ reelSearch: { pasta: [a("ax", {})] } });
    const { nextSteps } = await runDiscover({ query: "pasta" });
    expect(nextSteps?.map((s) => s.command)).toEqual(["ig video download ax"]);
  });

  it("never puts a malformed upstream username into a suggested command", async () => {
    env = seeded({
      reelSearch: { x: [stranger(1, { creatorUsername: "evil; rm -rf ~" }), stranger(2)] },
    });
    const { nextSteps } = await runDiscover({ query: "x" });
    expect(nextSteps?.[0]?.command).toBe("ig creator add stranger2");
  });

  it("rejects an empty query before spending a request", async () => {
    env = seeded();
    await expect(runDiscover({ query: "#", hashtag: true })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(runDiscover({ query: "   " })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(runDiscover({ query: "x", limit: 201 })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(env.backend.calls).toEqual([]);
  });

  it("a block propagates and halts the backend", async () => {
    env = seeded();
    env.backend.blockNext = "CHECKPOINT";
    await expect(runDiscover({ query: "pasta" })).rejects.toMatchObject({ code: "CHECKPOINT" });
    expect(env.ctx.gate("browser").halted()?.reason).toBe("CHECKPOINT");
  });

  it("human view marks tracked authors and shows hidden plays as a dash", async () => {
    env = seeded({ reelSearch: { pasta: found } });
    const { data } = await runDiscover({ query: "pasta" });
    const { out } = withEnv(plain, () => human(discover, data));
    const lines = out.trimEnd().split("\n");
    expect(lines[0]).toMatch(
      /^#\s+CREATOR\s+PLAYS\s+LIKES\s+AGE\s+LEN\s+TRACKED\s+CAPTION\s+LINK$/,
    );
    expect(lines[1]).toMatch(/^1\s+stranger1\s+–\s+10\s.*\sno\s/);
    expect(lines[2]).toMatch(/^2\s+ana\s+100\s+10\s.*\syes\s/);
    expect(human(discover, []).err).toContain("no reels");
  });
});
