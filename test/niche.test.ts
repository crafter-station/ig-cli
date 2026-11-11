import { afterEach, describe, expect, it, vi } from "vitest";
import { nicheCommands } from "../src/commands/niche.js";
import type { Niche, StoredCreator } from "../src/core/types.js";
import type { CommandDef } from "../src/lib/command.js";
import { IgError } from "../src/lib/errors.js";
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
  const result = await env.run(byId(nicheCommands as CommandDef[], id), input);
  return { data: result.data as T, meta: result.meta ?? {}, nextSteps: result.nextSteps ?? [] };
}

async function human(id: string, input: Record<string, unknown>) {
  const def = byId(nicheCommands as CommandDef[], id);
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

const DAY_MS = 86_400_000;
// The parsed config shares its default `limits` object between Contexts, so a
// test replaces it instead of mutating it.
const setBudget = (limit: number) => {
  const config = env.ctx.config;
  config.limits = { ...config.limits, browser: { ...config.limits.browser, dailyBudget: limit } };
};
const used = () => env.ctx.gate(env.backend.name).budget.used;

// --- niche create / list / show -------------------------------------------------

describe("niche create", () => {
  it("creates a niche whose name defaults to the slug", async () => {
    env = testEnv({});
    const res = await run<Niche>("niche.create", { slug: "gta-6" });
    expect(res.data).toMatchObject({
      slug: "gta-6",
      name: "gta-6",
      description: null,
      creatorCount: 0,
      videoCount: 0,
    });
    expect(res.nextSteps.map((s) => s.command)).toContain(
      "ig creator add <username> --niche gta-6",
    );
  });

  it("keeps a display name and description, and searches by the name next", async () => {
    env = testEnv({});
    const res = await run<Niche>("niche.create", {
      slug: "gta-6",
      name: "GTA 6",
      description: "Rockstar leaks",
    });
    expect(res.data).toMatchObject({ name: "GTA 6", description: "Rockstar leaks" });
    expect(res.nextSteps[0]?.command).toBe('ig creator search "GTA 6"');
  });

  it.each([
    ["GTA 6", "gta-6"],
    ["Cocina Fácil", "cocina-facil"],
    ["-cocina-", "cocina"],
    ["a--b", "a-b"],
    ["under_score", "under-score"],
  ])("rejects %j and suggests %s", async (input, suggestion) => {
    env = testEnv({});
    const err = await run("niche.create", { slug: input }).catch((e) => e);
    expect(err).toMatchObject({ code: "INVALID_INPUT" });
    expect(err.hint).toContain(`ig niche create ${suggestion}`);
    expect(env.ctx.store.listNiches()).toEqual([]);
  });

  it("rejects a slug with nothing usable in it without suggesting an empty one", async () => {
    env = testEnv({});
    for (const slug of ["", "   ", "!!!"]) {
      const err = await run("niche.create", { slug }).catch((e) => e);
      expect(err).toMatchObject({ code: "INVALID_INPUT" });
      expect(err.hint).not.toContain("ig niche create  ");
      expect(err.hint).toContain("gta-6");
    }
  });

  it("rejects a duplicate slug", async () => {
    env = testEnv({});
    await run("niche.create", { slug: "cocina" });
    await expect(run("niche.create", { slug: "cocina" })).rejects.toMatchObject({
      code: "ALREADY_EXISTS",
    });
  });
});

describe("niche list", () => {
  it("is an empty list with a way to start when there are no niches", async () => {
    env = testEnv({});
    const res = await run<Niche[]>("niche.list", {});
    expect(res.data).toEqual([]);
    expect(res.nextSteps.map((s) => s.command)).toEqual(["ig niche create <slug>"]);
    const out = await human("niche.list", {});
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("No niches yet.");
  });

  it("lists niches with their counts and points at the busiest one", async () => {
    env = testEnv({});
    env.ctx.store.createNiche({ slug: "cocina", name: "Cocina" });
    env.ctx.store.createNiche({ slug: "gta-6", name: "GTA 6" });
    env.ctx.store.upsertCreator(creator({ id: "1", username: "ana" }));
    env.ctx.store.addCreatorToNiche("1", "gta-6");
    env.ctx.store.upsertVideos([video({ id: "10", creatorId: "1", creatorUsername: "ana" })]);

    const res = await run<Niche[]>("niche.list", {});
    expect(res.data.map((n) => [n.slug, n.creatorCount, n.videoCount])).toEqual([
      ["cocina", 0, 0],
      ["gta-6", 1, 1],
    ]);
    expect(res.nextSteps.map((s) => s.command)).toEqual([
      "ig niche show gta-6",
      'ig creator search "Cocina"',
    ]);
    expect(env.backend.calls).toEqual([]);
  });
});

describe("niche show", () => {
  it("fails with NOT_FOUND for an unknown niche", async () => {
    env = testEnv({});
    const err = await run("niche.show", { slug: "nope" }).catch((e) => e);
    expect(err).toMatchObject({ code: "NOT_FOUND" });
    expect(err.hint).toContain("ig niche create nope");
  });

  it("shows an empty niche with how to fill it", async () => {
    env = testEnv({});
    env.ctx.store.createNiche({ slug: "cocina", name: "Cocina Fácil" });
    const res = await run<{ niche: Niche; creators: StoredCreator[] }>("niche.show", {
      slug: "cocina",
    });
    expect(res.data.creators).toEqual([]);
    expect(res.nextSteps.map((s) => s.command)).toEqual([
      'ig creator search "Cocina Fácil"',
      "ig creator add <username> --niche cocina",
    ]);
    const out = await human("niche.show", { slug: "cocina" });
    expect(out.stdout).toContain("cocina");
    expect(out.stderr).toContain("No creators in this niche yet.");
  });

  it("lists only this niche's creators, largest first with unknown last, cut to --limit", async () => {
    env = testEnv({});
    env.ctx.store.createNiche({ slug: "cocina", name: "Cocina" });
    env.ctx.store.createNiche({ slug: "otro", name: "Otro" });
    const rows: [string, string, number | null][] = [
      ["1", "ana", 500],
      ["2", "beto", null],
      ["3", "caro", 9000],
      ["4", "dani", 70],
    ];
    for (const [id, username, followers] of rows) {
      env.ctx.store.upsertCreator(creator({ id, username, followers }));
      env.ctx.store.addCreatorToNiche(id, id === "4" ? "otro" : "cocina");
    }
    const res = await run<{ niche: Niche; creators: StoredCreator[] }>("niche.show", {
      slug: "cocina",
    });
    expect(res.data.niche.creatorCount).toBe(3);
    expect(res.data.creators.map((c) => c.username)).toEqual(["caro", "ana", "beto"]);

    const cut = await run<{ niche: Niche; creators: StoredCreator[] }>("niche.show", {
      slug: "cocina",
      limit: 1,
    });
    expect(cut.data.creators.map((c) => c.username)).toEqual(["caro"]);
    expect(cut.nextSteps.map((s) => s.command)).toContain(
      "ig creator list --niche cocina --limit 3",
    );
  });
});

// --- niche refresh ----------------------------------------------------------------

type RefreshOut = {
  niche: string;
  backend: string;
  refreshed: number;
  skipped: number;
  failed: number;
  requestsUsed: number;
  items: {
    username: string;
    status: string;
    reason: string | null;
    followers: number | null;
    newVideos: number;
    totalVideos: number;
  }[];
};

const ana = creator({ id: "1", username: "ana", followers: 2000 });
const beto = creator({ id: "2", username: "beto", followers: 9000 });
const caro = creator({ id: "3", username: "caro", followers: 400 });
const dani = creator({ id: "4", username: "dani", followers: 70 });

const reelsOf = (c: { id: string; username: string }, n: number) =>
  Array.from({ length: n }, (_, i) =>
    video({ id: `${c.id}${i}`, creatorId: c.id, creatorUsername: c.username }),
  );

const upstream = (): FakeData => ({
  profiles: [ana, beto, caro, dani],
  reels: { "1": reelsOf(ana, 2), "2": reelsOf(beto, 3), "3": reelsOf(caro, 1), "4": [] },
});

/** Sets when a creator was last refreshed; null means never. */
function setRefreshed(id: string, daysAgo: number | null): void {
  const at = daysAgo === null ? null : new Date(Date.now() - daysAgo * DAY_MS).toISOString();
  env.ctx.store.db.prepare("UPDATE creators SET refreshed_at = ? WHERE id = ?").run(at, id);
}

/**
 * A niche crossing the freshness boundary (minRefreshDays is 3 by default):
 * dani never refreshed, caro 30 days ago, beto just over the line, ana just
 * under it.
 */
function seed(): void {
  const min = env.ctx.config.minRefreshDays;
  env.ctx.store.createNiche({ slug: "cocina", name: "Cocina" });
  for (const c of [ana, beto, caro, dani]) {
    env.ctx.store.upsertCreator({ ...c, followers: 1 });
    env.ctx.store.addCreatorToNiche(c.id, "cocina");
  }
  setRefreshed("1", min - 0.01);
  setRefreshed("2", min + 0.01);
  setRefreshed("3", 30);
  setRefreshed("4", null);
}

/** Runs `before` just ahead of the profile request for `username`. */
function beforeProfileOf(username: string, before: () => void): void {
  const getProfile = env.backend.getProfile.bind(env.backend);
  env.backend.getProfile = async (name) => {
    if (name === username) before();
    return getProfile(name);
  };
}

describe("niche refresh", () => {
  it("fails with NOT_FOUND for an unknown niche, before any request", async () => {
    env = testEnv(upstream());
    await expect(run("niche.refresh", { slug: "nope" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(env.backend.calls).toEqual([]);
  });

  it("an empty niche is a report with zero items and a next step, and costs nothing", async () => {
    env = testEnv(upstream());
    env.ctx.store.createNiche({ slug: "cocina", name: "Cocina" });
    const res = await run<RefreshOut>("niche.refresh", { slug: "cocina" });
    expect(res.data).toEqual({
      niche: "cocina",
      backend: "browser",
      refreshed: 0,
      skipped: 0,
      failed: 0,
      requestsUsed: 0,
      items: [],
    });
    expect(res.nextSteps[0]?.command).toBe("ig creator add <username> --niche cocina");
    expect(env.backend.calls).toEqual([]);
  });

  it("refreshes stale creators stalest first and skips the fresh one without a request", async () => {
    env = testEnv(upstream());
    seed();
    const res = await run<RefreshOut>("niche.refresh", { slug: "cocina" });

    expect(res.data.items.map((i) => [i.username, i.status])).toEqual([
      ["dani", "refreshed"],
      ["caro", "refreshed"],
      ["beto", "refreshed"],
      ["ana", "skipped"],
    ]);
    expect(env.backend.calls).toEqual([
      "getProfile:dani",
      "listReels:dani",
      "getProfile:caro",
      "listReels:caro",
      "getProfile:beto",
      "listReels:beto",
    ]);
    expect(res.data).toMatchObject({ refreshed: 3, skipped: 1, failed: 0, requestsUsed: 6 });
    expect(res.data.items[2]).toEqual({
      username: "beto",
      status: "refreshed",
      reason: null,
      followers: 9000,
      newVideos: 3,
      totalVideos: 3,
    });
    // The skipped one keeps its stored values and says why.
    expect(res.data.items[3]).toMatchObject({ followers: 1, newVideos: 0 });
    expect(res.data.items[3]?.reason).toContain("--force");
    expect(res.nextSteps[0]?.command).toBe("ig video top --niche cocina");
  });

  it("a second run right after finds everything fresh and makes no request", async () => {
    env = testEnv(upstream());
    seed();
    await run("niche.refresh", { slug: "cocina" });
    env.backend.calls.length = 0;
    const res = await run<RefreshOut>("niche.refresh", { slug: "cocina" });
    expect(res.data).toMatchObject({ refreshed: 0, skipped: 4, requestsUsed: 0 });
    expect(env.backend.calls).toEqual([]);
    expect(res.nextSteps.map((s) => s.command)).toEqual(["ig niche refresh cocina --force"]);
    // A re-seen video is not new again.
    expect(env.ctx.store.getCreator("beto").videoCount).toBe(3);
  });

  it("--force refreshes the fresh one too", async () => {
    env = testEnv(upstream());
    seed();
    const res = await run<RefreshOut>("niche.refresh", { slug: "cocina", force: true });
    expect(res.data).toMatchObject({ refreshed: 4, skipped: 0, requestsUsed: 8 });
    expect(env.backend.calls).toContain("getProfile:ana");
  });

  it("a paid backend is never held back by freshness", async () => {
    env = testEnv(upstream(), "hiker");
    seed();
    const res = await run<RefreshOut>("niche.refresh", { slug: "cocina", backend: "hiker" });
    expect(res.data).toMatchObject({ backend: "hiker", refreshed: 4, skipped: 0 });
    expect(env.ctx.gate("browser").budget.used).toBe(0);
  });

  it("--reels 0 fetches profiles only", async () => {
    env = testEnv(upstream());
    seed();
    const res = await run<RefreshOut>("niche.refresh", { slug: "cocina", reels: 0 });
    expect(env.backend.calls).toEqual(["getProfile:dani", "getProfile:caro", "getProfile:beto"]);
    expect(res.data.requestsUsed).toBe(3);
  });

  it("--max-creators takes the stalest ones and says more remain", async () => {
    env = testEnv(upstream());
    seed();
    const res = await run<RefreshOut>("niche.refresh", { slug: "cocina", maxCreators: 2 });
    expect(res.data.items.map((i) => i.username)).toEqual(["dani", "caro"]);
    expect(res.meta.notConsidered).toBe(2);
    expect(res.nextSteps.map((s) => s.command)).toContain(
      "ig niche refresh cocina --max-creators 2",
    );
    // Run again: the two just refreshed moved to the back of the line.
    const next = await run<RefreshOut>("niche.refresh", { slug: "cocina", maxCreators: 2 });
    expect(next.data.items.map((i) => [i.username, i.status])).toEqual([
      ["beto", "refreshed"],
      ["ana", "skipped"],
    ]);
  });

  it("--dry-run plans with the same freshness rule and makes zero requests", async () => {
    env = testEnv(upstream());
    seed();
    const res = await run<RefreshOut>("niche.refresh", { slug: "cocina", dryRun: true });
    expect(res.data.items.map((i) => [i.username, i.status])).toEqual([
      ["dani", "would-refresh"],
      ["caro", "would-refresh"],
      ["beto", "would-refresh"],
      ["ana", "skipped"],
    ]);
    expect(res.data).toMatchObject({ refreshed: 0, skipped: 1, failed: 0, requestsUsed: 0 });
    expect(res.meta).toMatchObject({
      dryRun: true,
      wouldRefresh: 3,
      estimatedRequests: 6,
      halted: false,
    });
    expect(env.backend.calls).toEqual([]);
    expect(used()).toBe(0);
    expect(env.ctx.store.getCreator("dani").refreshedAt).toBeNull();
    expect(res.nextSteps[0]?.command).toBe("ig niche refresh cocina");

    // The plan matches what the real run then does.
    const real = await run<RefreshOut>("niche.refresh", { slug: "cocina" });
    expect(real.data.items.map((i) => [i.username, i.status])).toEqual(
      res.data.items.map((i) => [
        i.username,
        i.status === "would-refresh" ? "refreshed" : i.status,
      ]),
    );
  });

  it("--dry-run --force plans every creator; and does not need a working backend", async () => {
    env = testEnv(upstream());
    seed();
    const res = await run<RefreshOut>("niche.refresh", {
      slug: "cocina",
      dryRun: true,
      force: true,
      // No hiker backend is registered in this environment at all.
      backend: "hiker",
    });
    expect(res.data.backend).toBe("hiker");
    expect(res.data.items.every((i) => i.status === "would-refresh")).toBe(true);
    expect(res.nextSteps[0]?.command).toBe("ig niche refresh cocina --force --backend hiker");
  });

  it("an account that no longer exists becomes a failed item and the run continues", async () => {
    env = testEnv({ ...upstream(), profiles: [ana, beto, dani] });
    seed();
    const res = await run<RefreshOut>("niche.refresh", { slug: "cocina" });
    expect(res.data.items.map((i) => [i.username, i.status])).toEqual([
      ["dani", "refreshed"],
      ["caro", "failed"],
      ["beto", "refreshed"],
      ["ana", "skipped"],
    ]);
    expect(res.data).toMatchObject({ refreshed: 2, skipped: 1, failed: 1, requestsUsed: 5 });
    expect(res.data.items[1]).toMatchObject({
      reason: "account not found (renamed, deleted or deactivated)",
      followers: 1,
      totalVideos: 0,
    });
    expect(res.nextSteps.map((s) => s.command)).toContain("ig creator remove caro --niche cocina");
    // Not a block: the backend stays usable.
    expect(env.ctx.gate("browser").halted()).toBeNull();
  });

  it("an upstream shape change on one creator is a failed item, not the end of the run", async () => {
    env = testEnv(upstream());
    seed();
    const listReels = env.backend.listReels.bind(env.backend);
    env.backend.listReels = async (c, o) => {
      if (c.username === "caro") {
        throw new IgError("UPSTREAM_CHANGED", "clips endpoint returned an unknown shape");
      }
      return listReels(c, o);
    };
    const res = await run<RefreshOut>("niche.refresh", { slug: "cocina" });
    expect(res.data).toMatchObject({ refreshed: 2, failed: 1 });
    expect(res.data.items[1]?.reason).toContain("UPSTREAM_CHANGED");
    // The failed creator stays stale, so the next run tries it again.
    expect(
      Date.now() - Date.parse(env.ctx.store.getCreator("caro").refreshedAt as string),
    ).toBeGreaterThan(29 * DAY_MS);
  });

  it("a block in the middle stops at once and reports what was saved and what remains", async () => {
    env = testEnv(upstream());
    seed();
    beforeProfileOf("caro", () => {
      env.backend.blockNext = "CHECKPOINT";
    });
    const err = await run("niche.refresh", { slug: "cocina" }).catch((e) => e);

    expect(err).toMatchObject({ code: "CHECKPOINT" });
    expect(err.exitCode).toBe(4);
    expect(err.hint).toContain("ig auth resume browser");
    expect(err.details.progress).toMatchObject({
      niche: "cocina",
      backend: "browser",
      refreshed: 1,
      skipped: 0,
      failed: 0,
      requestsUsed: 3,
      stoppedAt: "caro",
      remaining: 3,
      total: 4,
      items: [{ username: "dani", status: "refreshed" }],
      resume: "ig niche refresh cocina",
    });
    // Nothing after the block was attempted.
    expect(env.backend.calls).toEqual(["getProfile:dani", "listReels:dani", "getProfile:caro"]);
    // What was done before it is stored.
    expect(env.ctx.store.getCreator("dani").refreshedAt).not.toBeNull();
    expect(env.ctx.gate("browser").halted()?.reason).toBe("CHECKPOINT");

    // And the next run refuses before doing any work.
    env.backend.calls.length = 0;
    await expect(run("niche.refresh", { slug: "cocina" })).rejects.toMatchObject({
      code: "HALTED",
    });
    expect(env.backend.calls).toEqual([]);
  });

  it("the budget running out mid-run stops with progress and loses nothing already done", async () => {
    env = testEnv(upstream());
    seed();
    // dani takes two requests, caro's profile the third; caro's reels cannot be paid for.
    setBudget(3);
    const err = await run("niche.refresh", { slug: "cocina" }).catch((e) => e);

    expect(err).toMatchObject({ code: "BUDGET_EXHAUSTED" });
    expect(err.hint).toContain("dailyBudget");
    expect(err.details.progress).toMatchObject({
      refreshed: 1,
      requestsUsed: 3,
      stoppedAt: "caro",
      remaining: 3,
    });
    expect(env.backend.calls).toEqual(["getProfile:dani", "listReels:dani", "getProfile:caro"]);
    // caro was not half-stored: it is still 30 days stale and goes first next time.
    expect(env.ctx.store.getCreator("caro")).toMatchObject({ followers: 1, videoCount: 0 });
    expect(env.ctx.gate("browser").halted()).toBeNull();

    setBudget(100);
    const resumed = await run<RefreshOut>("niche.refresh", { slug: "cocina" });
    expect(resumed.data.items.map((i) => [i.username, i.status])).toEqual([
      ["caro", "refreshed"],
      ["beto", "refreshed"],
      ["ana", "skipped"],
      ["dani", "skipped"],
    ]);
  });

  it("an exhausted budget fails before the first creator", async () => {
    env = testEnv(upstream());
    seed();
    setBudget(0);
    const err = await run("niche.refresh", { slug: "cocina" }).catch((e) => e);
    expect(err).toMatchObject({ code: "BUDGET_EXHAUSTED" });
    expect(env.backend.calls).toEqual([]);
  });

  it("reports progress per creator with its position", async () => {
    env = testEnv({ ...upstream(), profiles: [ana, beto, dani] });
    seed();
    const lines: string[] = [];
    (env.ctx as { log: (m: string) => void }).log = (m) => lines.push(m);
    await run("niche.refresh", { slug: "cocina" });
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^1\/4 @dani/);
    expect(lines[1]).toMatch(/^2\/4 @caro: failed/);
    expect(lines[3]).toMatch(/^4\/4 @ana: skipped/);
  });

  it("human view: a summary line, then one row per creator with failures readable", async () => {
    env = testEnv({ ...upstream(), profiles: [ana, beto, dani] });
    seed();
    const out = await human("niche.refresh", { slug: "cocina" });
    expect(out.stdout).toContain("2 refreshed");
    expect(out.stdout).toContain("1 failed");
    expect(out.stdout).toContain("5 request(s)");
    expect(out.stdout).toContain("account not found");
    expect(out.stdout).toContain("+3");

    const dry = await human("niche.refresh", { slug: "cocina", dryRun: true, force: true });
    expect(dry.stdout).toContain("dry run: 4 would be refreshed");
    expect(dry.stdout).toContain("would refresh");
  });
});
