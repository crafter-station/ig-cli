import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreatorCandidate } from "../src/backends/types.js";
import { creatorCommands } from "../src/commands/creator.js";
import type { CreatorHit, StoredCreator } from "../src/core/types.js";
import type { CommandDef } from "../src/lib/command.js";
import type { NextStep } from "../src/lib/output.js";
import { byId, type FakeData, type TestEnv, testEnv } from "./fake-backend.js";
import { creator, video } from "./helpers.js";

let env: TestEnv;
afterEach(async () => {
  vi.restoreAllMocks();
  await env.cleanup();
});

type Out<T> = { data: T; meta: Record<string, unknown>; nextSteps: NextStep[] };

async function run<T>(id: string, input: Record<string, unknown>): Promise<Out<T>> {
  const result = await env.run(byId(creatorCommands as CommandDef[], id), input);
  return { data: result.data as T, meta: result.meta ?? {}, nextSteps: result.nextSteps ?? [] };
}

/** Runs a command's human view and returns what it wrote to each stream. */
async function human(id: string, input: Record<string, unknown>) {
  const def = byId(creatorCommands as CommandDef[], id);
  const result = await env.run(def, input);
  let stdout = "";
  let stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  try {
    def.human?.(result.data, env.ctx, { ...(result.meta ?? {}), nextSteps: result.nextSteps });
  } finally {
    vi.restoreAllMocks();
  }
  return { stdout, stderr };
}

const cand = (id: string, username: string, followers: number | null = 1000): CreatorCandidate => ({
  id,
  username,
  fullName: null,
  followers,
  isVerified: false,
  isPrivate: false,
});

const ana = creator({ id: "1", username: "ana", followers: 2000 });
const beto = creator({ id: "2", username: "beto", followers: 9000 });
const caro = creator({ id: "3", username: "caro", followers: 400 });

// The parsed config shares its default `limits` object between Contexts, so a
// test replaces it instead of mutating it.
const setBudget = (limit: number) => {
  const config = env.ctx.config;
  config.limits = { ...config.limits, browser: { ...config.limits.browser, dailyBudget: limit } };
};
const used = () => env.ctx.gate("browser").budget.used;

// --- creator search -------------------------------------------------------------

describe("creator search", () => {
  const data = (): FakeData => ({
    profiles: [
      creator({ id: "3", username: "caro", followers: 400, fullName: "Caro C" }),
      creator({ id: "6", username: "fede", followers: 60_000 }),
      creator({ id: "7", username: "gabi", followers: null }),
    ],
    creatorSearch: {
      cocina: [cand("1", "ana", 500), cand("2", "beto", 9000), cand("3", "caro", null)],
    },
    reelSearch: {
      cocina: [
        video({ id: "r1", creatorId: "6", creatorUsername: "fede" }),
        video({ id: "r2", creatorId: "7", creatorUsername: "gabi" }),
      ],
    },
    related: { "2": [cand("8", "hugo", 300)] },
  });

  it("makes one request, sorts largest first with unknown last, and stores nothing", async () => {
    env = testEnv(data());
    const res = await run<CreatorHit[]>("creator.search", { query: "cocina" });
    expect(env.backend.calls).toEqual(["searchCreators:cocina"]);
    expect(res.data.map((h) => [h.username, h.followers])).toEqual([
      ["beto", 9000],
      ["ana", 500],
      ["caro", null],
    ]);
    expect(res.data[0]).toMatchObject({
      url: "https://www.instagram.com/beto/",
      source: "keyword",
      tracked: false,
    });
    expect(res.meta).toMatchObject({
      backend: "browser",
      candidates: 3,
      matched: 3,
      returned: 3,
      requestsUsed: 1,
      sources: [{ source: "keyword:cocina", found: 3, added: 3 }],
    });
    expect(env.ctx.store.listCreators()).toEqual([]);
  });

  it("marks hits that are already tracked and leaves them out of the suggested add", async () => {
    env = testEnv(data());
    env.ctx.store.upsertCreator(beto);
    const res = await run<CreatorHit[]>("creator.search", { query: "cocina" });
    expect(Object.fromEntries(res.data.map((h) => [h.username, h.tracked]))).toEqual({
      ana: false,
      beto: true,
      caro: false,
    });
    const commands = res.nextSteps.map((s) => s.command);
    expect(commands).toContain("ig niche create cocina");
    expect(commands).toContain("ig creator add ana caro --niche cocina");
  });

  it("does not suggest creating a niche that already exists", async () => {
    env = testEnv(data());
    env.ctx.store.createNiche({ slug: "cocina", name: "Cocina" });
    const res = await run<CreatorHit[]>("creator.search", { query: "Cocina" });
    // The fake has no results under "Cocina": the suggestion must not invent an add.
    expect(res.data).toEqual([]);
    expect(res.nextSteps.map((s) => s.command)).toEqual(['ig creator search "Cocina" --expand']);

    const again = await run<CreatorHit[]>("creator.search", { query: "cocina" });
    const commands = again.nextSteps.map((s) => s.command);
    expect(commands).not.toContain("ig niche create cocina");
    expect(commands).toContain("ig creator add beto ana caro --niche cocina");
  });

  it("applies follower bounds inclusively and lets unknown counts through without --resolve", async () => {
    env = testEnv(data());
    const res = await run<CreatorHit[]>("creator.search", {
      query: "cocina",
      minFollowers: 500,
      maxFollowers: 9000,
    });
    expect(res.data.map((h) => h.username)).toEqual(["beto", "ana", "caro"]);

    const narrow = await run<CreatorHit[]>("creator.search", {
      query: "cocina",
      minFollowers: 501,
      maxFollowers: 8999,
    });
    expect(narrow.data.map((h) => h.username)).toEqual(["caro"]);
    expect(narrow.meta).toMatchObject({ candidates: 3, matched: 1 });
  });

  it("rejects min above max before spending a request", async () => {
    env = testEnv(data());
    await expect(
      run("creator.search", { query: "cocina", minFollowers: 10, maxFollowers: 5 }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(env.backend.calls).toEqual([]);
  });

  it("rejects an empty query", async () => {
    env = testEnv(data());
    await expect(run("creator.search", { query: "" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("cuts to --limit after sorting, and reports how many matched", async () => {
    env = testEnv(data());
    const res = await run<CreatorHit[]>("creator.search", { query: "cocina", limit: 1 });
    // The fake honours the page size, so only the first upstream row comes back.
    expect(res.data).toHaveLength(1);
    expect(res.meta).toMatchObject({ returned: 1 });
  });

  it("with --expand, cuts the union to --limit keeping the largest", async () => {
    env = testEnv(data());
    const res = await run<CreatorHit[]>("creator.search", {
      query: "cocina",
      expand: true,
      limit: 2,
    });
    expect(res.data).toHaveLength(2);
    expect(res.data[0]?.username).toBe("beto");
    expect(res.meta.candidates).toBeGreaterThan(2);
  });

  it("with --expand, labels each hit with its source and counts every request", async () => {
    env = testEnv(data());
    const res = await run<CreatorHit[]>("creator.search", { query: "cocina", expand: true });
    expect(Object.fromEntries(res.data.map((h) => [h.username, h.source]))).toEqual({
      ana: "keyword",
      beto: "keyword",
      caro: "keyword",
      fede: "reels:cocina",
      gabi: "reels:cocina",
      hugo: "related:beto",
    });
    // keyword + reels + hashtag + three related seeds.
    expect(env.backend.calls).toHaveLength(6);
    expect(res.meta.requestsUsed).toBe(6);
    // Unknown follower counts sort after every known one.
    expect(res.data.map((h) => h.followers)).toEqual([9000, 500, 300, null, null, null]);
  });

  it("--resolve fetches only hits with unknown followers", async () => {
    env = testEnv(data());
    const res = await run<CreatorHit[]>("creator.search", {
      query: "cocina",
      expand: true,
      resolve: true,
    });
    expect(env.backend.calls.filter((c) => c.startsWith("getProfile")).sort()).toEqual([
      "getProfile:caro",
      "getProfile:fede",
      "getProfile:gabi",
    ]);
    const by = Object.fromEntries(res.data.map((h) => [h.username, h]));
    expect(by.fede?.followers).toBe(60_000);
    expect(by.caro).toMatchObject({ followers: 400, fullName: "Caro C" });
    expect(res.data[0]?.username).toBe("fede");
    expect(res.meta.resolve).toMatchObject({
      attempted: 3,
      resolved: 2,
      unresolved: 1,
      stoppedBy: null,
    });
    expect(res.meta.requestsUsed).toBe(9);
  });

  it("with --resolve, a hit still unknown fails the follower filter; without it, it passes", async () => {
    env = testEnv(data());
    const loose = await run<CreatorHit[]>("creator.search", {
      query: "cocina",
      expand: true,
      minFollowers: 1000,
    });
    expect(loose.data.map((h) => h.username)).toEqual(["beto", "caro", "fede", "gabi"]);

    const strict = await run<CreatorHit[]>("creator.search", {
      query: "cocina",
      expand: true,
      minFollowers: 1000,
      resolve: true,
    });
    // caro resolved to 400 (out), gabi's profile hides the count (out), fede is in.
    expect(strict.data.map((h) => h.username)).toEqual(["fede", "beto"]);
  });

  it("keeps the results when the budget runs out while resolving, and says so", async () => {
    env = testEnv(data());
    // Six for discovery, one left for resolving.
    setBudget(7);
    const res = await run<CreatorHit[]>("creator.search", {
      query: "cocina",
      expand: true,
      resolve: true,
    });
    expect(env.backend.calls.filter((c) => c.startsWith("getProfile"))).toEqual([
      "getProfile:caro",
    ]);
    expect(res.data).toHaveLength(6);
    expect(res.meta.resolve).toMatchObject({
      attempted: 1,
      resolved: 1,
      unresolved: 2,
      stoppedBy: "BUDGET_EXHAUSTED",
    });
    expect((res.meta.resolve as { note: string }).note).toContain("1 of 3");
    expect(used()).toBe(7);
    // Running out of budget is not a block signal: the backend is not halted.
    expect(env.ctx.gate("browser").halted()).toBeNull();
  });

  it("a profile that fails to resolve stays unknown and the rest continue", async () => {
    env = testEnv({ ...data(), profiles: [creator({ id: "6", username: "fede", followers: 7 })] });
    const res = await run<CreatorHit[]>("creator.search", {
      query: "cocina",
      expand: true,
      resolve: true,
    });
    expect(res.meta.resolve).toMatchObject({ attempted: 3, resolved: 1, failed: 2 });
    expect(res.data.find((h) => h.username === "fede")?.followers).toBe(7);
  });

  it("a block while resolving stops the command", async () => {
    env = testEnv(data());
    const getProfile = env.backend.getProfile.bind(env.backend);
    env.backend.getProfile = async (username) => {
      env.backend.blockNext = "CHECKPOINT";
      return getProfile(username);
    };
    await expect(
      run("creator.search", { query: "cocina", expand: true, resolve: true }),
    ).rejects.toMatchObject({ code: "CHECKPOINT" });
    expect(env.backend.calls.filter((c) => c.startsWith("getProfile"))).toHaveLength(1);
  });

  it("fails before any request when the backend is halted or out of budget", async () => {
    env = testEnv(data());
    setBudget(0);
    await expect(run("creator.search", { query: "cocina" })).rejects.toMatchObject({
      code: "BUDGET_EXHAUSTED",
    });
    expect(env.backend.calls).toEqual([]);
  });

  it("an empty result is an empty list with a way forward, not an error", async () => {
    env = testEnv({});
    const res = await run<CreatorHit[]>("creator.search", { query: "nada de nada" });
    expect(res.data).toEqual([]);
    expect(res.meta).toMatchObject({ candidates: 0, returned: 0 });
    expect(res.nextSteps.map((s) => s.command)).toEqual([
      'ig creator search "nada de nada" --expand',
    ]);
  });

  it("when filters remove every candidate, the next step is the search without them", async () => {
    env = testEnv(data());
    const res = await run<CreatorHit[]>("creator.search", {
      query: "cocina",
      expand: true,
      also: ["recetas"],
      minFollowers: 1_000_000,
      resolve: true,
    });
    expect(res.data).toEqual([]);
    expect(res.nextSteps.map((s) => s.command)).toContain(
      'ig creator search "cocina" --expand --also "recetas" --resolve',
    );
  });

  it("offers --resolve only when some shown hit has unknown followers", async () => {
    env = testEnv(data());
    const res = await run<CreatorHit[]>("creator.search", { query: "cocina" });
    expect(res.nextSteps.map((s) => s.command)).toContain('ig creator search "cocina" --resolve');

    const known = await run<CreatorHit[]>("creator.search", { query: "cocina", limit: 2 });
    expect(known.nextSteps.some((s) => s.command.includes("--resolve"))).toBe(false);
  });

  it("human view: empty goes to stderr, third-party text is sanitized", async () => {
    env = testEnv({
      creatorSearch: {
        cocina: [{ ...cand("1", "ana", 1500), fullName: "Ana\x1b[31m\nRed\x07" }],
      },
    });
    const full = await human("creator.search", { query: "cocina" });
    expect(full.stdout).toContain("@ana");
    expect(full.stdout).toContain("Ana Red");
    expect(full.stdout).toContain("1.5K");
    expect(full.stdout).not.toContain("\x1b");
    expect(full.stdout).not.toContain("\x07");
    // One source for every row: no column repeating it.
    expect(full.stdout).not.toContain("FOUND VIA");

    const empty = await human("creator.search", { query: "nothing" });
    expect(empty.stdout).toBe("");
    expect(empty.stderr).toContain("No creators found.");
  });
});

// --- creator add ----------------------------------------------------------------

type AddOut = {
  added: StoredCreator[];
  failed: { username: string; code: string; message: string }[];
};

describe("creator add", () => {
  it("normalizes handles and URLs, de-duplicates, and fetches each new creator once", async () => {
    env = testEnv({ profiles: [ana, beto] });
    const res = await run<AddOut>("creator.add", {
      usernames: ["@Ana", "https://www.instagram.com/ana/", "ana", "beto"],
    });
    expect(env.backend.calls).toEqual(["getProfile:ana", "getProfile:beto"]);
    expect(res.data.added.map((c) => c.username)).toEqual(["ana", "beto"]);
    expect(res.data.failed).toEqual([]);
    expect(res.meta).toMatchObject({ fetched: 2, alreadyTracked: 0, requestsUsed: 2, niche: null });
  });

  it("stores a new creator as never refreshed, so the first niche refresh picks it up", async () => {
    env = testEnv({ profiles: [ana] });
    const res = await run<AddOut>("creator.add", { usernames: ["ana"] });
    expect(res.data.added[0]).toMatchObject({ followers: 2000, refreshedAt: null, niches: [] });
    expect(res.nextSteps[0]?.command).toBe("ig creator get ana --refresh");
  });

  it("checks the niche before any request", async () => {
    env = testEnv({ profiles: [ana] });
    await expect(run("creator.add", { usernames: ["ana"], niche: "nope" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(env.backend.calls).toEqual([]);
    expect(env.ctx.store.findCreator("ana")).toBeNull();
  });

  it("adds an already tracked creator to the niche without a request", async () => {
    env = testEnv({ profiles: [ana, beto] });
    env.ctx.store.createNiche({ slug: "cocina", name: "Cocina" });
    env.ctx.store.upsertCreator(ana);
    const res = await run<AddOut>("creator.add", { usernames: ["ana", "beto"], niche: "cocina" });
    expect(env.backend.calls).toEqual(["getProfile:beto"]);
    expect(res.data.added.map((c) => [c.username, c.niches])).toEqual([
      ["ana", ["cocina"]],
      ["beto", ["cocina"]],
    ]);
    expect(res.meta).toMatchObject({ fetched: 1, alreadyTracked: 1, requestsUsed: 1 });
    expect(res.nextSteps[0]?.command).toBe("ig niche refresh cocina");

    // Repeating it is safe and free.
    const again = await run<AddOut>("creator.add", { usernames: ["ana", "beto"], niche: "cocina" });
    expect(again.meta).toMatchObject({ fetched: 0, alreadyTracked: 2, requestsUsed: 0 });
    expect(env.ctx.store.getNiche("cocina").creatorCount).toBe(2);
  });

  it("records an unknown account as failed and continues with the rest", async () => {
    env = testEnv({ profiles: [ana, caro] });
    const res = await run<AddOut>("creator.add", { usernames: ["ana", "ghost", "caro"] });
    expect(res.data.added.map((c) => c.username)).toEqual(["ana", "caro"]);
    expect(res.data.failed).toEqual([
      { username: "ghost", code: "NOT_FOUND", message: "No Instagram account named ghost" },
    ]);
    expect(env.backend.calls).toEqual(["getProfile:ana", "getProfile:ghost", "getProfile:caro"]);
  });

  it("does not spend a request on something that cannot be a username", async () => {
    env = testEnv({ profiles: [ana] });
    const res = await run<AddOut>("creator.add", { usernames: ["not a name!", "ana"] });
    expect(env.backend.calls).toEqual(["getProfile:ana"]);
    expect(res.data.failed).toMatchObject([{ username: "not a name!", code: "INVALID_INPUT" }]);
  });

  it("when every username fails, still reports ok with the failures and points at search", async () => {
    env = testEnv({});
    const res = await run<AddOut>("creator.add", { usernames: ["ghost", "phantom"] });
    expect(res.data.added).toEqual([]);
    expect(res.data.failed.map((f) => f.code)).toEqual(["NOT_FOUND", "NOT_FOUND"]);
    expect(res.nextSteps[0]?.command).toBe('ig creator search "ghost"');
  });

  it("rejects an empty list and blank usernames", async () => {
    env = testEnv({});
    await expect(run("creator.add", { usernames: [] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(run("creator.add", { usernames: ["  ", "@"] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(env.backend.calls).toEqual([]);
  });

  it("a block in the middle of a batch stops it and reports what was done and what remains", async () => {
    env = testEnv({ profiles: [ana, beto, caro] });
    env.ctx.store.createNiche({ slug: "cocina", name: "Cocina" });
    const getProfile = env.backend.getProfile.bind(env.backend);
    env.backend.getProfile = async (username) => {
      if (username === "beto") env.backend.blockNext = "RATE_LIMITED";
      return getProfile(username);
    };
    const err = await run("creator.add", {
      usernames: ["ana", "ghost", "beto", "caro"],
      niche: "cocina",
    }).catch((e) => e);
    expect(err).toMatchObject({ code: "RATE_LIMITED" });
    expect(err.hint).toContain("ig auth resume browser");
    expect(err.details.progress).toMatchObject({
      added: ["ana"],
      failed: [{ username: "ghost", code: "NOT_FOUND" }],
      remaining: ["beto", "caro"],
      requestsUsed: 3,
    });
    // caro was never asked for, and what was done before the block is kept.
    expect(env.backend.calls).toEqual(["getProfile:ana", "getProfile:ghost", "getProfile:beto"]);
    expect(env.ctx.store.getCreator("ana").niches).toEqual(["cocina"]);
    expect(env.ctx.store.findCreator("beto")).toBeNull();
    expect(env.ctx.gate("browser").halted()?.reason).toBe("RATE_LIMITED");
  });

  it("stops with progress when the budget runs out mid-batch", async () => {
    env = testEnv({ profiles: [ana, beto, caro] });
    setBudget(2);
    const err = await run("creator.add", { usernames: ["ana", "beto", "caro"] }).catch((e) => e);
    expect(err).toMatchObject({ code: "BUDGET_EXHAUSTED" });
    expect(err.details.progress).toMatchObject({ added: ["ana", "beto"], remaining: ["caro"] });
    expect(env.backend.calls).toEqual(["getProfile:ana", "getProfile:beto"]);
  });

  it("human view: lists failures on stderr and never an empty table", async () => {
    env = testEnv({});
    const out = await human("creator.add", { usernames: ["ghost"] });
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("No creators were added.");
    expect(out.stderr).toContain("ghost");
    expect(out.stderr).toContain("NOT_FOUND");
  });
});

// --- creator get ----------------------------------------------------------------

describe("creator get", () => {
  it("is a local lookup: no request, accepts @handle and URL forms", async () => {
    env = testEnv({ profiles: [ana] });
    env.ctx.store.upsertCreator(ana);
    const res = await run<StoredCreator>("creator.get", { username: "@Ana" });
    expect(res.data).toMatchObject({ id: "1", username: "ana", followers: 2000 });
    expect(env.backend.calls).toEqual([]);
    expect(res.meta.refresh).toBeUndefined();
  });

  it("fails with NOT_FOUND and the way to add it when the creator is not tracked", async () => {
    env = testEnv({ profiles: [ana] });
    const err = await run("creator.get", { username: "ana", refresh: true }).catch((e) => e);
    expect(err).toMatchObject({ code: "NOT_FOUND" });
    expect(err.hint).toContain("ig creator add ana");
    expect(env.backend.calls).toEqual([]);
  });

  it("--refresh fetches profile and reels and returns the updated record", async () => {
    env = testEnv({
      profiles: [{ ...ana, followers: 2500 }],
      reels: { "1": [video({ id: "10", creatorId: "1", creatorUsername: "ana" })] },
    });
    env.ctx.store.upsertCreator(ana, { refreshed: false });
    const res = await run<StoredCreator>("creator.get", { username: "ana", refresh: true });
    expect(env.backend.calls).toEqual(["getProfile:ana", "listReels:ana"]);
    expect(res.data).toMatchObject({ followers: 2500, videoCount: 1 });
    expect(res.data.refreshedAt).not.toBeNull();
    expect(res.meta.refresh).toEqual({
      status: "refreshed",
      reason: null,
      newVideos: 1,
      requestsUsed: 2,
    });
  });

  it("--refresh on a fresh creator makes no request and says it was skipped", async () => {
    env = testEnv({ profiles: [{ ...ana, followers: 2500 }] });
    env.ctx.store.upsertCreator(ana);
    const res = await run<StoredCreator>("creator.get", { username: "ana", refresh: true });
    expect(env.backend.calls).toEqual([]);
    expect(res.data.followers).toBe(2000);
    expect(res.meta.refresh).toMatchObject({ status: "skipped", requestsUsed: 0 });
    expect((res.meta.refresh as { reason: string }).reason).toContain("--force");
    expect(res.nextSteps[0]?.command).toBe("ig creator get ana --refresh --force");

    const forced = await run<StoredCreator>("creator.get", {
      username: "ana",
      refresh: true,
      force: true,
    });
    expect(forced.data.followers).toBe(2500);
  });

  it("human view: shows the bio on one line without control characters", async () => {
    env = testEnv({});
    env.ctx.store.upsertCreator({
      ...ana,
      biography: `Chef\n\x1b[2Jrecetas ${"x".repeat(200)}`,
      isVerified: true,
    });
    const out = await human("creator.get", { username: "ana" });
    expect(out.stdout).toContain("@ana");
    expect(out.stdout).toContain("Chef recetas");
    expect(out.stdout).toContain("2K");
    expect(out.stdout).not.toContain("\x1b");
    expect(out.stdout).toContain("…");
    expect(out.stdout).not.toContain("x".repeat(120));
  });
});

// --- creator list ---------------------------------------------------------------

describe("creator list", () => {
  const seed = () => {
    env.ctx.store.createNiche({ slug: "cocina", name: "Cocina" });
    env.ctx.store.upsertCreator(caro);
    env.ctx.store.upsertCreator(beto, { refreshed: false });
    env.ctx.store.upsertCreator({ ...ana, followers: null });
    env.ctx.store.addCreatorToNiche("1", "cocina");
    env.ctx.store.addCreatorToNiche("3", "cocina");
  };

  it("returns an empty list with a next step when nothing is tracked", async () => {
    env = testEnv({});
    const res = await run<StoredCreator[]>("creator.list", {});
    expect(res.data).toEqual([]);
    expect(res.meta).toMatchObject({ total: 0, returned: 0 });
    expect(res.nextSteps[0]?.command).toContain("ig creator search");
  });

  it("sorts by followers with unknown last by default", async () => {
    env = testEnv({});
    seed();
    const res = await run<StoredCreator[]>("creator.list", {});
    expect(res.data.map((c) => c.username)).toEqual(["beto", "caro", "ana"]);
  });

  it("sorts by username, and by refresh age with never-refreshed first", async () => {
    env = testEnv({});
    seed();
    const byName = await run<StoredCreator[]>("creator.list", { sort: "username" });
    expect(byName.data.map((c) => c.username)).toEqual(["ana", "beto", "caro"]);
    const byAge = await run<StoredCreator[]>("creator.list", { sort: "refreshed" });
    expect(byAge.data[0]?.username).toBe("beto");
  });

  it("filters by niche and rejects an unknown one", async () => {
    env = testEnv({});
    seed();
    const res = await run<StoredCreator[]>("creator.list", { niche: "cocina" });
    expect(res.data.map((c) => c.username)).toEqual(["caro", "ana"]);
    expect(res.nextSteps.map((s) => s.command)).toContain("ig niche refresh cocina");
    await expect(run("creator.list", { niche: "nope" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("reports the total when --limit hides rows, and how to see them all", async () => {
    env = testEnv({});
    seed();
    const res = await run<StoredCreator[]>("creator.list", { limit: 2 });
    expect(res.data.map((c) => c.username)).toEqual(["beto", "caro"]);
    expect(res.meta).toMatchObject({ total: 3, returned: 2 });
    expect(res.nextSteps.map((s) => s.command)).toContain(
      "ig creator list --sort followers --limit 3",
    );
  });

  it("rejects an unknown sort key and a zero limit", async () => {
    env = testEnv({});
    await expect(run("creator.list", { sort: "size" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(run("creator.list", { limit: 0 })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("human view: drops the niche column when one niche was asked for", async () => {
    env = testEnv({});
    seed();
    const all = await human("creator.list", {});
    expect(all.stdout).toContain("NICHES");
    expect(all.stdout).toContain("never");
    const one = await human("creator.list", { niche: "cocina" });
    expect(one.stdout).not.toContain("NICHES");
    expect(one.stdout).not.toContain("@beto");
  });

  it("human view: an empty list is a line on stderr, not an empty table", async () => {
    env = testEnv({});
    const none = await human("creator.list", {});
    expect(none.stdout).toBe("");
    expect(none.stderr).toContain("No creators are tracked yet.");
  });
});

// --- creator remove -------------------------------------------------------------

type RemoveOut = {
  username: string;
  action: string;
  niche: string | null;
  videosDeleted: number;
  filesLeftOnDisk: string[];
};

describe("creator remove", () => {
  const seed = () => {
    env.ctx.store.createNiche({ slug: "cocina", name: "Cocina" });
    env.ctx.store.createNiche({ slug: "gta-6", name: "GTA 6" });
    env.ctx.store.upsertCreator(ana);
    env.ctx.store.upsertCreator(beto);
    env.ctx.store.addCreatorToNiche("1", "cocina");
    env.ctx.store.upsertVideos([
      video({ id: "10", creatorId: "1", creatorUsername: "ana" }),
      video({ id: "11", creatorId: "1", creatorUsername: "ana" }),
      video({ id: "20", creatorId: "2", creatorUsername: "beto" }),
    ]);
    env.ctx.store.markDownloaded("10", "/media/ana/sc10.mp4");
  };

  it("fails with NOT_FOUND for a creator that is not tracked", async () => {
    env = testEnv({});
    await expect(run("creator.remove", { username: "ghost", yes: true })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("without --yes refuses, changes nothing, and shows both ways forward", async () => {
    env = testEnv({});
    seed();
    const err = await run("creator.remove", { username: "ana" }).catch((e) => e);
    expect(err).toMatchObject({ code: "INVALID_INPUT" });
    expect(err.hint).toContain("ig creator remove ana --yes");
    expect(err.hint).toContain("ig creator remove ana --dry-run");
    expect(env.ctx.store.getCreator("ana").videoCount).toBe(2);
  });

  it("--dry-run reports the real counts and files and deletes nothing, even with --yes", async () => {
    env = testEnv({});
    seed();
    const res = await run<RemoveOut>("creator.remove", {
      username: "@ana",
      dryRun: true,
      yes: true,
    });
    expect(res.data).toEqual({
      username: "ana",
      action: "would-delete",
      niche: null,
      videosDeleted: 2,
      filesLeftOnDisk: ["/media/ana/sc10.mp4"],
    });
    expect(res.nextSteps[0]?.command).toBe("ig creator remove ana --yes");
    expect(env.ctx.store.getCreator("ana").videoCount).toBe(2);
  });

  it("--yes deletes the creator and their videos only, and lists the files it left", async () => {
    env = testEnv({});
    seed();
    const preview = await run<RemoveOut>("creator.remove", { username: "ana", dryRun: true });
    const res = await run<RemoveOut>("creator.remove", { username: "ana", yes: true });
    // The preview promised exactly what the delete did.
    expect(res.data).toEqual({ ...preview.data, action: "deleted" });
    expect(env.ctx.store.findCreator("ana")).toBeNull();
    expect(env.ctx.store.findVideo("10")).toBeNull();
    expect(env.ctx.store.getCreator("beto").videoCount).toBe(1);
    expect(env.ctx.store.getNiche("cocina").creatorCount).toBe(0);
    expect(env.backend.calls).toEqual([]);
  });

  it("--niche removes only the membership and needs no --yes", async () => {
    env = testEnv({});
    seed();
    const dry = await run<RemoveOut>("creator.remove", {
      username: "ana",
      niche: "cocina",
      dryRun: true,
    });
    expect(dry.data).toMatchObject({ action: "would-remove-from-niche", niche: "cocina" });
    expect(env.ctx.store.getCreator("ana").niches).toEqual(["cocina"]);

    const res = await run<RemoveOut>("creator.remove", { username: "ana", niche: "cocina" });
    expect(res.data).toEqual({
      username: "ana",
      action: "removed-from-niche",
      niche: "cocina",
      videosDeleted: 0,
      filesLeftOnDisk: [],
    });
    expect(env.ctx.store.getCreator("ana")).toMatchObject({ niches: [], videoCount: 2 });
  });

  it("--niche fails for an unknown niche and for a niche the creator is not in", async () => {
    env = testEnv({});
    seed();
    await expect(run("creator.remove", { username: "ana", niche: "nope" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const err = await run("creator.remove", { username: "ana", niche: "gta-6" }).catch((e) => e);
    expect(err).toMatchObject({ code: "NOT_FOUND" });
    expect(err.hint).toContain("cocina");
    expect(env.ctx.store.getCreator("ana").niches).toEqual(["cocina"]);
  });

  it("human view: a dry run reads as a dry run and the files are listed", async () => {
    env = testEnv({});
    seed();
    const out = await human("creator.remove", { username: "ana", dryRun: true });
    expect(out.stdout).toContain("would-delete");
    expect(out.stdout).toContain("nothing changed");
    expect(out.stdout).toContain("/media/ana/sc10.mp4");
  });
});
