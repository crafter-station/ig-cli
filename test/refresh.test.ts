import { afterEach, describe, expect, it } from "vitest";
import { refreshCreator } from "../src/core/refresh.js";
import { type TestEnv, testEnv } from "./fake-backend.js";
import { creator, video } from "./helpers.js";

let env: TestEnv;
afterEach(() => env.cleanup());

const ana = creator({ id: "1", username: "ana", followers: 2000 });
const reels = [
  video({ id: "11", creatorId: "1", creatorUsername: "ana", plays: 900 }),
  video({ id: "10", creatorId: "1", creatorUsername: "ana", plays: 300 }),
];

function track(e: TestEnv, refreshed: boolean) {
  e.ctx.store.upsertCreator({ ...ana, followers: 1500 }, { refreshed });
  return e.ctx.store.getCreator("ana");
}

describe("refreshCreator", () => {
  it("fetches profile and reels, stores them, and reports what was new", async () => {
    env = testEnv({ profiles: [ana], reels: { "1": reels } });
    const outcome = await refreshCreator(env.ctx, env.backend, track(env, false), {
      reels: 15,
      force: false,
    });
    expect(outcome).toEqual({
      username: "ana",
      status: "refreshed",
      reason: null,
      followers: 2000,
      newVideos: 2,
      totalVideos: 2,
    });
    expect(env.backend.calls).toEqual(["getProfile:ana", "listReels:ana"]);
    expect(env.ctx.store.getCreator("ana").refreshedAt).not.toBeNull();
  });

  it("skips a recently refreshed creator on the browser backend without any request", async () => {
    env = testEnv({ profiles: [ana], reels: { "1": reels } });
    const outcome = await refreshCreator(env.ctx, env.backend, track(env, true), {
      reels: 15,
      force: false,
    });
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toContain("--force");
    expect(outcome.followers).toBe(1500);
    expect(env.backend.calls).toEqual([]);
    expect(env.ctx.gate("browser").budget.used).toBe(0);
  });

  it("refreshes a fresh creator when forced", async () => {
    env = testEnv({ profiles: [ana], reels: { "1": reels } });
    const outcome = await refreshCreator(env.ctx, env.backend, track(env, true), {
      reels: 15,
      force: true,
    });
    expect(outcome.status).toBe("refreshed");
  });

  it("never holds back a paid backend", async () => {
    env = testEnv({ profiles: [ana], reels: { "1": reels } }, "hiker");
    const outcome = await refreshCreator(env.ctx, env.backend, track(env, true), {
      reels: 15,
      force: false,
    });
    expect(outcome.status).toBe("refreshed");
  });

  it("does not ask for reels of a private account", async () => {
    env = testEnv({ profiles: [{ ...ana, isPrivate: true }], reels: { "1": reels } });
    const outcome = await refreshCreator(env.ctx, env.backend, track(env, false), {
      reels: 15,
      force: false,
    });
    expect(outcome.totalVideos).toBe(0);
    expect(env.backend.calls).toEqual(["getProfile:ana"]);
  });

  it("a block mid-refresh halts the backend and propagates", async () => {
    env = testEnv({ profiles: [ana], reels: { "1": reels } });
    env.backend.blockNext = "CHECKPOINT";
    await expect(
      refreshCreator(env.ctx, env.backend, track(env, false), { reels: 15, force: false }),
    ).rejects.toMatchObject({ code: "CHECKPOINT" });
    expect(env.ctx.gate("browser").halted()?.reason).toBe("CHECKPOINT");
  });
});
