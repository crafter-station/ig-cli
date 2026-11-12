// `--captions` on refresh and `ig video captions`, against a fake backend that
// behaves like the browser one: the reel list only captions what is on the
// first timeline page, and `fetchCaptions` reads further at one request a page.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptionOptions, CaptionPass } from "../src/backends/types.js";
import { captionCommands } from "../src/commands/captions.js";
import { creatorCommands } from "../src/commands/creator.js";
import { nicheCommands } from "../src/commands/niche.js";
import { videoCommands } from "../src/commands/video.js";
import {
  backfillCaptions,
  CAPTION_MAX_REQUESTS,
  refreshCaptionPlan,
  refreshNeedsCaptionPass,
  withTimeline,
} from "../src/core/captions.js";
import type { Gate } from "../src/core/gate.js";
import { refreshCreator } from "../src/core/refresh.js";
import type { StoredVideo, Video } from "../src/core/types.js";
import type { CommandDef } from "../src/lib/command.js";
import { IgError } from "../src/lib/errors.js";
import type { NextStep } from "../src/lib/output.js";
import { byId, FakeBackend, type FakeData, type TestEnv, testEnv } from "./fake-backend.js";
import { creator, video } from "./helpers.js";

let env: TestEnv;
afterEach(async () => {
  vi.restoreAllMocks();
  // The pure tests create no environment.
  await env?.cleanup();
  env = undefined as unknown as TestEnv;
});

/**
 * A fake with a post timeline. `posts[creatorId]` is the timeline, newest
 * first, with captions; pages hold `pageSize` videos. Like the browser
 * backend, the first page is free right after `getProfile` for that creator
 * and costs one request otherwise; every further page costs one.
 */
class PagingBackend extends FakeBackend {
  posts: Record<string, Video[]> = {};
  pageSize = 2;
  readonly asked: CaptionOptions[] = [];
  private readonly cursor = new Map<string, number>();

  constructor(
    private readonly gateRef: Gate,
    data: FakeData,
  ) {
    super("browser", gateRef, data);
  }

  private async spend(call: string): Promise<void> {
    await this.gateRef.before();
    this.calls.push(call);
    if (this.blockNext) {
      const reason = this.blockNext;
      this.blockNext = null;
      this.gateRef.block(reason, "HTTP 429");
    }
  }

  override async getProfile(username: string) {
    const profile = await super.getProfile(username);
    this.cursor.set(profile.id, this.pageSize);
    return profile;
  }

  async fetchCaptions(
    who: { id: string; username: string },
    opts: CaptionOptions,
  ): Promise<CaptionPass> {
    this.asked.push(opts);
    const timeline = this.posts[who.id] ?? [];
    const loaded: string[] = [];
    let requests = 0;
    const onProfile = this.calls.at(-1) === `getProfile:${who.username}`;
    if (!onProfile) {
      await this.spend(`openProfile:${who.username}`);
      requests++;
      this.cursor.set(who.id, this.pageSize);
      loaded.push(...timeline.slice(0, this.pageSize).map((v) => v.id));
    }
    let read = this.cursor.get(who.id) ?? this.pageSize;
    const covered = () => {
      const seen = new Set(timeline.slice(0, read).map((v) => v.id));
      const ahead = opts.ids.filter((id) => !seen.has(id)).length;
      return seen.size >= opts.minVideos && ahead <= (opts.leave ?? 0);
    };
    while (requests < opts.maxRequests && read < timeline.length && !covered()) {
      await this.spend(`scrollTimeline:${who.username}`);
      requests++;
      loaded.push(...timeline.slice(read, read + this.pageSize).map((v) => v.id));
      read += this.pageSize;
    }
    this.cursor.set(who.id, read);
    return { videos: timeline.slice(0, read), loaded, requests };
  }

  /** One reel by itself, as its own page has it. Reels in `gone` no longer exist. */
  readonly gone = new Set<string>();
  override async getVideo(shortcode: string): Promise<Video> {
    await this.spend(`getVideo:${shortcode}`);
    const found = [...Object.values(this.posts), ...Object.values(this.single)]
      .flat()
      .find((v) => v.shortcode === shortcode);
    if (!found || this.gone.has(shortcode)) {
      throw new IgError("NOT_FOUND", `No reel with shortcode ${shortcode}`);
    }
    return found;
  }
  /** Reels that exist but are not on the timeline (pinned long ago, kept off the grid). */
  single: Record<string, Video[]> = {};

  /** As the browser backend does: the reel list is captioned from what the timeline has read. */
  override async listReels(who: { id: string; username: string }, opts: { limit: number }) {
    const listed = await super.listReels(who, opts);
    const read = (this.posts[who.id] ?? []).slice(0, this.cursor.get(who.id) ?? this.pageSize);
    return listed.map((v) =>
      withTimeline(
        v,
        read.find((p) => p.id === v.id),
      ),
    );
  }
}

const ana = creator({ id: "1", username: "ana" });
const beto = creator({ id: "2", username: "beto" });

/** Reel `n` of a creator: higher is newer. The reel list has plays and no caption. */
const reel = (n: number, who = ana): Video =>
  video({
    id: `${who.id}0${n}`,
    creatorId: who.id,
    creatorUsername: who.username,
    takenAt: `2026-10-${String(n).padStart(2, "0")}T00:00:00.000Z`,
    plays: n * 100,
  });
/** The same reel as the post timeline has it: caption and sound, no plays. */
const post = (n: number, who = ana): Video => ({
  ...reel(n, who),
  plays: null,
  likes: 7,
  caption: `caption ${n} #tag${n} @friend`,
  videoUrl: `https://cdn.example/${who.id}0${n}.mp4`,
  audio: { id: `a${n}`, title: "Audio original", artist: who.username, isOriginal: true },
});
const newestFirst = (ns: number[], make: (n: number) => Video): Video[] =>
  [...ns].sort((x, y) => y - x).map((n) => make(n));

function paging(data: FakeData, posts: Record<string, Video[]>): PagingBackend {
  env = testEnv(data);
  const backend = new PagingBackend(env.ctx.gate("browser"), data);
  backend.posts = posts;
  env.ctx.useBackend(backend);
  return backend;
}

function track(who = ana, refreshed = false): void {
  env.ctx.store.upsertCreator(who, { refreshed });
}
const stored = (id: string): StoredVideo => env.ctx.store.findVideo(id) as StoredVideo;
const used = () => env.ctx.gate("browser").budget.used;

type Out<T> = { data: T; meta: Record<string, unknown>; nextSteps: NextStep[] };
async function run<T>(
  defs: readonly unknown[],
  id: string,
  input: Record<string, unknown>,
): Promise<Out<T>> {
  const result = await env.run(byId(defs as CommandDef[], id), input);
  return { data: result.data as T, meta: result.meta ?? {}, nextSteps: result.nextSteps ?? [] };
}
const failure = async (p: Promise<unknown>): Promise<IgError> => {
  try {
    await p;
  } catch (err) {
    return err as IgError;
  }
  throw new Error("expected a failure");
};

// --- planning -----------------------------------------------------------------

describe("refreshCaptionPlan", () => {
  const sv = (id: string, caption: string | null) => ({ id, caption }) as StoredVideo;

  it("asks for as many videos as reels when nothing is stored yet", () => {
    expect(refreshCaptionPlan([], 15)).toEqual({
      ids: [],
      minVideos: 15,
      maxRequests: CAPTION_MAX_REQUESTS,
      leave: 0,
    });
    expect(refreshNeedsCaptionPass([], 15)).toBe(true);
    expect(refreshNeedsCaptionPass([], 0)).toBe(false);
  });

  it("covers stored reels without caption among the newest, and reaches the newest stored", () => {
    const plan = refreshCaptionPlan([sv("5", "c"), sv("4", null), sv("3", "c"), sv("2", null)], 3);
    // "2" is outside the newest three: left to `ig video captions`.
    expect(plan).toEqual({
      ids: ["4", "5"],
      minVideos: 0,
      maxRequests: CAPTION_MAX_REQUESTS,
      leave: 1,
    });
  });

  it("only reaches the newest stored reel when every caption is there", () => {
    const all = [sv("5", "c"), sv("4", "c")];
    // The newest stored reel must be reached, so it may not be the one left over.
    expect(refreshCaptionPlan(all, 15)).toMatchObject({ ids: ["5"], leave: 0 });
    expect(refreshCaptionPlan([sv("5", null), sv("4", "c")], 15)).toMatchObject({
      ids: ["5"],
      leave: 0,
    });
    expect(refreshNeedsCaptionPass(all, 15)).toBe(false);
  });
});

// --- refresh ------------------------------------------------------------------

describe("refreshCreator with captions", () => {
  it("first refresh: reads on until the fetched reels are captioned and reports the cost", async () => {
    const backend = paging(
      { profiles: [ana], reels: { "1": newestFirst([1, 2, 3, 4, 5], reel) } },
      { "1": newestFirst([1, 2, 3, 4, 5], post) },
    );
    track();
    const outcome = await refreshCreator(env.ctx, backend, env.ctx.store.getCreator("ana"), {
      reels: 5,
      force: false,
      captions: true,
    });
    // Page one (2 reels) came with the profile; 3 more reels took 2 scrolls.
    expect(outcome.captions).toEqual({ filled: 3, missing: 0, requests: 2 });
    expect(outcome.newVideos).toBe(5);
    expect(backend.calls).toEqual([
      "getProfile:ana",
      "scrollTimeline:ana",
      "scrollTimeline:ana",
      "listReels:ana",
    ]);
    expect(used()).toBe(4);
    const oldest = stored("101");
    expect(oldest).toMatchObject({
      caption: "caption 1 #tag1 @friend",
      plays: 100,
      hashtags: ["tag1"],
      mentions: ["friend"],
      audio: { id: "a1", artist: "ana", isOriginal: true },
    });
  });

  it("without the flag nothing extra is asked and old reels stay uncaptioned", async () => {
    const backend = paging(
      { profiles: [ana], reels: { "1": newestFirst([1, 2, 3, 4], reel) } },
      { "1": newestFirst([1, 2, 3, 4], post) },
    );
    track();
    const outcome = await refreshCreator(env.ctx, backend, env.ctx.store.getCreator("ana"), {
      reels: 4,
      force: false,
    });
    expect("captions" in outcome).toBe(false);
    expect(backend.asked).toEqual([]);
    expect(backend.calls).toEqual(["getProfile:ana", "listReels:ana"]);
    expect(stored("104").caption).toBe("caption 4 #tag4 @friend");
    expect(stored("101").caption).toBeNull();
  });

  it("later refresh: costs nothing extra when the new reels are on the first page", async () => {
    const backend = paging(
      { profiles: [ana], reels: { "1": newestFirst([3, 4, 5, 6], reel) } },
      { "1": newestFirst([1, 2, 3, 4, 5, 6], post) },
    );
    track();
    env.ctx.store.upsertVideos(newestFirst([3, 4, 5], post).map((p) => ({ ...p, plays: 1 })));
    const outcome = await refreshCreator(env.ctx, backend, env.ctx.store.getCreator("ana"), {
      reels: 4,
      force: false,
      captions: true,
    });
    expect(outcome.captions).toEqual({ filled: 0, missing: 0, requests: 0 });
    expect(backend.asked).toEqual([
      { ids: ["105"], minVideos: 0, maxRequests: CAPTION_MAX_REQUESTS, leave: 0 },
    ]);
    expect(backend.calls).toEqual(["getProfile:ana", "listReels:ana"]);
    expect(stored("106").caption).toBe("caption 6 #tag6 @friend");
  });

  it("fills stored reels that are no longer on the reel list, keeping their play counts", async () => {
    const backend = paging(
      { profiles: [ana], reels: { "1": newestFirst([4, 5, 6], reel) } },
      { "1": newestFirst([1, 2, 3, 4, 5, 6], post) },
    );
    track();
    // Stored by an earlier refresh without captions; 3 has since left the list.
    env.ctx.store.upsertVideos(newestFirst([3, 4, 5], reel));
    const outcome = await refreshCreator(env.ctx, backend, env.ctx.store.getCreator("ana"), {
      reels: 3,
      force: false,
      captions: true,
    });
    // 5 was on the free first page; 4 and 3 took one scroll.
    expect(outcome.captions).toEqual({ filled: 2, missing: 0, requests: 1 });
    expect(stored("103")).toMatchObject({ caption: "caption 3 #tag3 @friend", plays: 300 });
    expect(stored("103").likes).toBe(7);
  });

  it("fetches one leftover reel by itself instead of reading on for it", async () => {
    const backend = paging(
      { profiles: [ana], reels: { "1": newestFirst([1, 2, 3, 4], reel) } },
      // Reel 1 is not on the grid: pinned long ago, or kept off it.
      { "1": newestFirst([2, 3, 4], post) },
    );
    backend.single = { "1": [post(1)] };
    track();
    const outcome = await refreshCreator(env.ctx, backend, env.ctx.store.getCreator("ana"), {
      reels: 4,
      force: false,
      captions: true,
    });
    // One scroll for reel 2, one request for reel 1 by itself.
    expect(outcome.captions).toEqual({ filled: 2, missing: 0, requests: 2 });
    expect(backend.calls).toEqual([
      "getProfile:ana",
      "scrollTimeline:ana",
      "listReels:ana",
      "getVideo:sc101",
    ]);
    expect(stored("101")).toMatchObject({ caption: "caption 1 #tag1 @friend", plays: 100 });
  });

  it("settles a reel that has no caption, or is gone, so it is never asked for again", async () => {
    const posts = newestFirst([2, 3, 4], post);
    // Reel 3 is on the timeline with no caption text. Reel 1 no longer exists.
    (posts[1] as Video).caption = null;
    const backend = paging(
      { profiles: [ana], reels: { "1": newestFirst([1, 2, 3, 4], reel) } },
      { "1": posts },
    );
    backend.gone.add("sc101");
    track();
    const first = await refreshCreator(env.ctx, backend, env.ctx.store.getCreator("ana"), {
      reels: 4,
      force: false,
      captions: true,
    });
    expect(first.captions).toEqual({ filled: 1, missing: 0, requests: 2 });
    expect(stored("103").caption).toBe("");
    expect(stored("101")).toMatchObject({ caption: "", plays: 100 });

    backend.calls.length = 0;
    const second = await refreshCreator(env.ctx, backend, env.ctx.store.getCreator("ana"), {
      reels: 4,
      force: true,
      captions: true,
    });
    expect(second.captions).toEqual({ filled: 0, missing: 0, requests: 0 });
    expect(backend.calls).toEqual(["getProfile:ana", "listReels:ana"]);
  });

  it("leaves several leftovers alone and reports them as missing", async () => {
    const backend = paging(
      { profiles: [ana], reels: { "1": newestFirst([1, 2, 3, 4], reel) } },
      // The timeline ends after two reels; reels 1 and 2 are not on it.
      { "1": newestFirst([3, 4], post) },
    );
    track();
    const outcome = await refreshCreator(env.ctx, backend, env.ctx.store.getCreator("ana"), {
      reels: 4,
      force: false,
      captions: true,
    });
    expect(outcome.captions).toEqual({ filled: 0, missing: 2, requests: 0 });
    expect(backend.calls).toEqual(["getProfile:ana", "listReels:ana"]);
    expect(stored("101").caption).toBeNull();
  });

  it("is a harmless no-op on a backend that already returns captions", async () => {
    const withCaptions = newestFirst([1, 2, 3], (n) => ({ ...reel(n), caption: `c${n}` }));
    env = testEnv({ profiles: [ana], reels: { "1": withCaptions } }, "hiker");
    track();
    const outcome = await refreshCreator(env.ctx, env.backend, env.ctx.store.getCreator("ana"), {
      reels: 15,
      force: false,
      captions: true,
    });
    expect(outcome.captions).toEqual({ filled: 0, missing: 0, requests: 0 });
    expect(env.backend.calls).toEqual(["getProfile:ana", "listReels:ana"]);
  });

  it("asks for nothing on a private account or a skipped creator", async () => {
    const backend = paging({ profiles: [{ ...ana, isPrivate: true }] }, {});
    track();
    const priv = await refreshCreator(env.ctx, backend, env.ctx.store.getCreator("ana"), {
      reels: 15,
      force: false,
      captions: true,
    });
    expect("captions" in priv).toBe(false);
    const skipped = await refreshCreator(env.ctx, backend, env.ctx.store.getCreator("ana"), {
      reels: 15,
      force: false,
      captions: true,
    });
    expect(skipped.status).toBe("skipped");
    expect(backend.asked).toEqual([]);
    expect(backend.calls).toEqual(["getProfile:ana"]);
  });

  it("a block while reading captions halts the backend and is not retried", async () => {
    const backend = paging(
      { profiles: [ana], reels: { "1": newestFirst([1, 2, 3, 4], reel) } },
      { "1": newestFirst([1, 2, 3, 4], post) },
    );
    track();
    const original = backend.fetchCaptions.bind(backend);
    backend.fetchCaptions = async (who, opts) => {
      backend.blockNext = "RATE_LIMITED";
      return original(who, opts);
    };
    const err = await failure(
      refreshCreator(env.ctx, backend, env.ctx.store.getCreator("ana"), {
        reels: 4,
        force: false,
        captions: true,
      }),
    );
    expect(err.code).toBe("RATE_LIMITED");
    expect(env.ctx.gate("browser").halted()?.reason).toBe("RATE_LIMITED");
    expect(backend.calls).toEqual(["getProfile:ana", "scrollTimeline:ana"]);
  });
});

// --- commands that refresh ------------------------------------------------------

type RefreshOut = {
  refreshed: number;
  requestsUsed: number;
  captionsFilled?: number;
  captionRequests?: number;
  items: { username: string; status: string; captions?: unknown }[];
};

function nicheOfTwo(): PagingBackend {
  const backend = paging(
    {
      profiles: [ana, beto],
      reels: {
        "1": newestFirst([1, 2, 3, 4], reel),
        "2": newestFirst([1, 2], (n) => reel(n, beto)),
      },
    },
    {
      "1": newestFirst([1, 2, 3, 4], post),
      "2": newestFirst([1, 2], (n) => post(n, beto)),
    },
  );
  env.ctx.store.createNiche({ slug: "cocina", name: "Cocina" });
  for (const c of [ana, beto]) {
    track(c);
    env.ctx.store.addCreatorToNiche(c.id, "cocina");
  }
  return backend;
}

describe("niche refresh --captions", () => {
  it("reports captions filled and what they cost, per creator and in total", async () => {
    const backend = nicheOfTwo();
    const res = await run<RefreshOut>(nicheCommands, "niche.refresh", {
      slug: "cocina",
      captions: true,
    });
    expect(res.data).toMatchObject({
      refreshed: 2,
      captionsFilled: 2,
      captionRequests: 1,
      requestsUsed: 5,
    });
    const item = (name: string) => res.data.items.find((i) => i.username === name);
    expect(item("ana")?.captions).toEqual({ filled: 2, missing: 0, requests: 1 });
    expect(item("beto")?.captions).toEqual({ filled: 0, missing: 0, requests: 0 });
    expect(res.meta.captions).toBe(true);
    expect(backend.calls.filter((c) => c.startsWith("scrollTimeline"))).toHaveLength(1);
  });

  it("leaves the output as it was without the flag", async () => {
    nicheOfTwo();
    const res = await run<RefreshOut>(nicheCommands, "niche.refresh", { slug: "cocina" });
    expect("captionsFilled" in res.data).toBe(false);
    expect("captionRequests" in res.data).toBe(false);
    expect(res.data.items.every((i) => !("captions" in i))).toBe(true);
    expect(res.data.requestsUsed).toBe(4);
  });

  it("dry run states the ceiling of the extra cost and spends nothing", async () => {
    const backend = nicheOfTwo();
    // Beto is fully captioned already, so only Ana can cost extra.
    env.ctx.store.upsertVideos(newestFirst([1, 2], (n) => post(n, beto)));
    const res = await run<RefreshOut>(nicheCommands, "niche.refresh", {
      slug: "cocina",
      captions: true,
      dryRun: true,
    });
    expect(res.meta).toMatchObject({
      dryRun: true,
      estimatedRequests: 4,
      captionRequestsMax: 2 * CAPTION_MAX_REQUESTS,
      captionCreatorsBehind: 1,
    });
    expect(res.nextSteps[0]?.command).toBe("ig niche refresh cocina --captions");
    expect(res.nextSteps[0]?.description).toContain(
      `plus 0 to ${2 * CAPTION_MAX_REQUESTS} for captions (1 creator(s) have captions to catch up on)`,
    );
    expect(backend.calls).toEqual([]);
    expect(used()).toBe(0);
  });

  it("dry run promises no extra cost on hiker", async () => {
    nicheOfTwo();
    const res = await run<RefreshOut>(nicheCommands, "niche.refresh", {
      slug: "cocina",
      captions: true,
      dryRun: true,
      backend: "hiker",
    });
    expect(res.meta.captionRequestsMax).toBe(0);
    expect(res.nextSteps[0]?.description).not.toContain("for captions");
  });

  it("shows a person what the captions cost, in the run and in the dry run", async () => {
    nicheOfTwo();
    const def = byId(nicheCommands as CommandDef[], "niche.refresh");
    const render = async (input: Record<string, unknown>): Promise<string> => {
      const result = await env.run(def, input);
      let out = "";
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        out += String(chunk);
        return true;
      });
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      def.human?.(result.data, env.ctx, { ...(result.meta ?? {}), nextSteps: result.nextSteps });
      vi.restoreAllMocks();
      return out;
    };
    const dry = await render({ slug: "cocina", captions: true, dryRun: true });
    expect(dry).toContain(`plus 0 to ${2 * CAPTION_MAX_REQUESTS} for captions`);
    const real = await render({ slug: "cocina", captions: true });
    expect(real).toContain("2 caption(s) filled with 1 of those request(s)");
    expect(real).toContain("NO CAPTION");
  });

  it("says in its help what the flag costs", () => {
    const def = byId(nicheCommands as CommandDef[], "niche.refresh");
    expect(def.description).toContain("--captions");
    expect(def.description).toContain(`at most ${CAPTION_MAX_REQUESTS} per creator`);
  });
});

describe("creator get / video list --captions", () => {
  it("creator get --refresh --captions reports the caption cost in meta", async () => {
    paging(
      { profiles: [ana], reels: { "1": newestFirst([1, 2, 3], reel) } },
      { "1": newestFirst([1, 2, 3], post) },
    );
    track();
    const res = await run(creatorCommands, "creator.get", {
      username: "ana",
      refresh: true,
      captions: true,
    });
    expect(res.meta.refresh).toMatchObject({
      status: "refreshed",
      requestsUsed: 3,
      captions: { filled: 1, missing: 0, requests: 1 },
    });
  });

  it("video list --refresh --captions stores captions for the listed reels", async () => {
    paging(
      { profiles: [ana], reels: { "1": newestFirst([1, 2, 3], reel) } },
      { "1": newestFirst([1, 2, 3], post) },
    );
    track();
    const res = await run<StoredVideo[]>(videoCommands, "video.list", {
      creator: "ana",
      refresh: true,
      captions: true,
    });
    expect(res.data.map((v) => v.caption)).toEqual([
      "caption 3 #tag3 @friend",
      "caption 2 #tag2 @friend",
      "caption 1 #tag1 @friend",
    ]);
    expect(res.meta.refresh).toMatchObject({ captions: { filled: 1, requests: 1 } });
  });

  it("refuses --captions without --refresh, before any request", async () => {
    const backend = paging({ profiles: [ana] }, {});
    track();
    for (const [defs, id, input] of [
      [creatorCommands, "creator.get", { username: "ana", captions: true }],
      [videoCommands, "video.list", { creator: "ana", captions: true }],
    ] as const) {
      const err = await failure(run(defs, id, input));
      expect(err.code).toBe("INVALID_INPUT");
      expect(err.hint).toContain("--refresh --captions");
    }
    expect(backend.calls).toEqual([]);
  });
});

// --- ig video captions ----------------------------------------------------------

type CaptionsOut = {
  backend: string;
  filled: number;
  missing: number;
  requestsUsed: number;
  items: {
    username: string;
    status: string;
    reason: string | null;
    missingBefore: number;
    filled: number;
    missing: number;
    requests: number;
  }[];
};

/** Ana lacks three captions (reels 1-3), Beto one (reel 1); both are stored and fresh. */
function tracked(): PagingBackend {
  const backend = paging(
    { profiles: [ana, beto] },
    {
      "1": newestFirst([1, 2, 3, 4, 5], post),
      "2": newestFirst([1, 2], (n) => post(n, beto)),
    },
  );
  env.ctx.store.createNiche({ slug: "cocina", name: "Cocina" });
  track(ana, true);
  track(beto, true);
  env.ctx.store.addCreatorToNiche("1", "cocina");
  env.ctx.store.upsertVideos([...newestFirst([4, 5], post), ...newestFirst([1, 2, 3], reel)]);
  env.ctx.store.upsertVideos([post(2, beto), reel(1, beto)]);
  return backend;
}

describe("video captions", () => {
  it("fills stored reels without touching the reel list or the play counts", async () => {
    const backend = tracked();
    const refreshedAt = env.ctx.store.getCreator("ana").refreshedAt;
    const res = await run<CaptionsOut>(captionCommands, "video.captions", {});
    expect(res.data).toMatchObject({ backend: "browser", filled: 4, missing: 0, requestsUsed: 4 });
    // Most missing first. Ana: open + 2 scrolls reach reels 1-3. Beto: open, reel 1 on page one.
    expect(res.data.items).toEqual([
      {
        username: "ana",
        status: "filled",
        reason: null,
        missingBefore: 3,
        filled: 3,
        missing: 0,
        requests: 3,
      },
      {
        username: "beto",
        status: "filled",
        reason: null,
        missingBefore: 1,
        filled: 1,
        missing: 0,
        requests: 1,
      },
    ]);
    expect(backend.calls.some((c) => c.startsWith("listReels"))).toBe(false);
    expect(stored("101")).toMatchObject({ caption: "caption 1 #tag1 @friend", plays: 100 });
    expect(stored("101").audio?.id).toBe("a1");
    // Not a refresh: the creator keeps its place in line for `niche refresh`.
    expect(env.ctx.store.getCreator("ana").refreshedAt).toBe(refreshedAt);
    expect(res.nextSteps[0]?.command).toContain("ig video search");
  });

  it("dry run lists who lacks captions and the cost range, and spends nothing", async () => {
    const backend = tracked();
    const res = await run<CaptionsOut>(captionCommands, "video.captions", { dryRun: true });
    expect(res.data.items.map((i) => [i.username, i.status, i.missingBefore])).toEqual([
      ["ana", "would-fill", 3],
      ["beto", "would-fill", 1],
    ]);
    expect(res.meta).toMatchObject({
      dryRun: true,
      estimatedRequestsMin: 2,
      // Ana may take the whole cap; Beto lacks one caption, which is one request.
      estimatedRequestsMax: CAPTION_MAX_REQUESTS + 1 + 1,
    });
    expect(res.nextSteps[0]?.command).toBe("ig video captions");
    expect(res.nextSteps[0]?.description).toContain("between 2 and 10 request(s)");
    expect(backend.calls).toEqual([]);
    expect(used()).toBe(0);
  });

  it("narrows to a niche or a creator, and never passes the request cap", async () => {
    const backend = tracked();
    const tight = await run<CaptionsOut>(captionCommands, "video.captions", {
      niche: "cocina",
      maxRequests: 2,
    });
    // One request is kept for a leftover, so only the profile is opened: reels 5 and 4 are there.
    expect(tight.data.items).toMatchObject([
      { username: "ana", status: "none-found", filled: 0, missing: 3, requests: 1 },
    ]);
    expect(tight.data.items[0]?.reason).toContain("not among the posts read");
    expect(tight.nextSteps.some((s) => s.command === "ig video list ana")).toBe(true);

    backend.calls.length = 0;
    const roomy = await run<CaptionsOut>(captionCommands, "video.captions", {
      niche: "cocina",
      maxRequests: 3,
    });
    // Open, one scroll for reels 3 and 2, then reel 1 by itself.
    expect(roomy.data.items).toMatchObject([
      { username: "ana", status: "filled", filled: 3, missing: 0, requests: 3 },
    ]);
    expect(backend.calls).toEqual(["openProfile:ana", "scrollTimeline:ana", "getVideo:sc101"]);

    backend.calls.length = 0;
    const byCreator = await run<CaptionsOut>(captionCommands, "video.captions", {
      creator: "@beto",
    });
    // A single missing reel is fetched by itself: no profile, no paging.
    expect(byCreator.data.items).toMatchObject([{ username: "beto", filled: 1, requests: 1 }]);
    expect(backend.calls).toEqual(["getVideo:sc201"]);
  });

  it("also stores the sound of captioned reels on the pages it reads, at no extra cost", async () => {
    const backend = paging({ profiles: [ana] }, { "1": newestFirst([1, 2, 3, 4], post) });
    track();
    // Reel 4 has its caption but was stored before sounds were read.
    const { audio: _, ...silent } = post(4);
    env.ctx.store.upsertVideos([{ ...silent, plays: 400 }, ...newestFirst([1, 2], reel)]);
    expect(stored("104").audio).toBeNull();
    const res = await run<CaptionsOut>(captionCommands, "video.captions", {});
    expect(res.data).toMatchObject({ filled: 2, missing: 0, requestsUsed: 2 });
    expect(backend.calls).toEqual(["openProfile:ana", "scrollTimeline:ana"]);
    expect(stored("104")).toMatchObject({ plays: 400, audio: { id: "a4" } });
  });

  it("costs nothing when every stored reel has a caption", async () => {
    const backend = paging({ profiles: [ana] }, { "1": newestFirst([1, 2], post) });
    track();
    env.ctx.store.upsertVideos(newestFirst([1, 2], post));
    const res = await run<CaptionsOut>(captionCommands, "video.captions", {});
    expect(res.data).toMatchObject({ filled: 0, missing: 0, requestsUsed: 0, items: [] });
    expect(res.meta.complete).toBe(1);
    expect(backend.calls).toEqual([]);
  });

  it("is a no-op on hiker and says what to do instead", async () => {
    const backend = tracked();
    const res = await run<CaptionsOut>(captionCommands, "video.captions", { backend: "hiker" });
    expect(res.data.requestsUsed).toBe(0);
    expect(res.data.items.every((i) => i.status === "unsupported")).toBe(true);
    expect(res.nextSteps[0]?.command).toBe("ig creator get ana --refresh --backend hiker");
    expect(backend.calls).toEqual([]);
  });

  it("refuses --creator together with --niche", async () => {
    tracked();
    const err = await failure(
      run(captionCommands, "video.captions", { creator: "ana", niche: "cocina" }),
    );
    expect(err.code).toBe("INVALID_INPUT");
  });

  it("a block ends the run with what was done, and nothing is retried", async () => {
    const backend = tracked();
    backend.blockNext = "CHECKPOINT";
    const err = await failure(run(captionCommands, "video.captions", {}));
    expect(err.code).toBe("CHECKPOINT");
    expect(err.details?.progress).toMatchObject({
      stoppedAt: "ana",
      remaining: 2,
      total: 2,
      resume: "ig video captions",
    });
    expect(backend.calls).toEqual(["openProfile:ana"]);
    expect(env.ctx.gate("browser").halted()?.reason).toBe("CHECKPOINT");
  });

  it("a halted backend fails before any work", async () => {
    const backend = tracked();
    await failure(
      (async () => env.ctx.gate("browser").block("RATE_LIMITED", "HTTP 429"))() as Promise<never>,
    );
    const err = await failure(run(captionCommands, "video.captions", {}));
    expect(err.code).toBe("HALTED");
    expect(backend.calls).toEqual([]);
  });

  it("an account that is gone fails alone and the run goes on", async () => {
    const backend = tracked();
    backend.fetchCaptions = ((original) => async (who, opts) => {
      if (who.username === "ana") {
        throw new IgError("NOT_FOUND", "No Instagram account named ana");
      }
      return original(who, opts);
    })(backend.fetchCaptions.bind(backend));
    const res = await run<CaptionsOut>(captionCommands, "video.captions", {});
    expect(res.data.items.map((i) => [i.username, i.status])).toEqual([
      ["ana", "failed"],
      ["beto", "filled"],
    ]);
    expect(res.data.items[0]?.reason).toContain("account not found");
  });

  it("renders for a person, with third-party names sanitized", async () => {
    tracked();
    const def = byId(captionCommands as CommandDef[], "video.captions");
    const result = await env.run(def, { dryRun: true });
    let out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const data = result.data as CaptionsOut;
    (data.items[0] as { username: string }).username = "an\x1b[31ma";
    def.human?.(data, env.ctx, { ...(result.meta ?? {}), nextSteps: result.nextSteps });
    vi.restoreAllMocks();
    expect(out).toContain("would fill");
    expect(out).toContain("between 2 and 10 request(s)");
    expect(out).not.toContain("\x1b[31ma");
  });
});

describe("backfillCaptions", () => {
  it("does not ask a backend without a caption pass", async () => {
    env = testEnv({ profiles: [ana] }, "hiker");
    track();
    env.ctx.store.upsertVideos([reel(1)]);
    const outcome = await backfillCaptions(env.ctx, env.backend, env.ctx.store.getCreator("ana"), {
      maxRequests: 9,
    });
    expect(outcome).toMatchObject({ status: "unsupported", filled: 0, missing: 1, requests: 0 });
    expect(env.backend.calls).toEqual([]);
  });
});
