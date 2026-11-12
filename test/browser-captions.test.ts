// Sound and timeline paging of the browser backend, against the trimmed live
// captures in test/fixtures/browser. No browser is involved: the paging loop
// takes its scroll as a function.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addPage,
  BUDGET_RESERVE,
  pageTimeline,
  passOf,
  timelineCovers,
  timelineState,
} from "../src/backends/browser/captions.js";
import {
  isTimelinePayload,
  mergeTimeline,
  reelsFromResponse,
  type TimelinePage,
  timelinePageFromResponse,
  uploadMs,
  videoFromMedia,
  videoFromWebInfo,
} from "../src/backends/browser/normalize.js";
import { VideoSchema } from "../src/core/types.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "browser", name), "utf8"));

const owner = { id: "3532778", username: "jamieoliver" };
const KEY = "xdt_api__v1__feed__user_timeline_graphql_connection";

describe("audio", () => {
  it("reads a creator's own sound from the timeline", () => {
    const page = timelinePageFromResponse(fixture("timeline.json"));
    const video = page.videos.get("4027454424454836023");
    expect(video?.audio).toEqual({
      id: "28970531749254861",
      title: "Audio original",
      artist: "jamieoliver",
      isOriginal: true,
    });
    expect(VideoSchema.safeParse(video).success).toBe(true);
  });

  it("reads licensed music from the timeline", () => {
    const page = timelinePageFromResponse(fixture("timeline-licensed-music.json"));
    expect([...page.videos.values()][0]?.audio).toEqual({
      id: "919391855061851",
      title: "Danger Zone",
      artist: "Kenny Loggins",
      isOriginal: false,
    });
  });

  it("reads the sound of a single reel page", () => {
    expect(videoFromWebInfo(fixture("reel-page.json"))?.audio).toMatchObject({
      id: "549374974344451",
      isOriginal: true,
      artist: "jamieoliver",
    });
  });

  it("leaves audio out, not null, on surfaces that do not report it", () => {
    for (const reel of reelsFromResponse(fixture("reels.json"), owner).items) {
      expect("audio" in reel).toBe(false);
    }
  });

  it("is null when the reel reports clips_metadata without a sound", () => {
    const base = { media_type: 2, pk: "4027454424454836023", code: "abc", user: { pk: "1" } };
    const node = { ...base, user: { pk: "1", username: "ana" } };
    expect(videoFromMedia({ ...node, clips_metadata: null })?.audio).toBeNull();
    expect(
      videoFromMedia({
        ...node,
        clips_metadata: { audio_type: null, music_info: null, original_sound_info: null },
      })?.audio,
    ).toBeNull();
    // An original sound whose artist is gone still yields what is known.
    expect(
      videoFromMedia({
        ...node,
        clips_metadata: {
          original_sound_info: { audio_asset_id: "77", original_audio_title: "x", ig_artist: null },
        },
      })?.audio,
    ).toEqual({ id: "77", title: "x", artist: null, isOriginal: true });
  });

  it("gives a reel from the reels tab the sound its timeline post has", () => {
    const timeline = timelinePageFromResponse(fixture("timeline.json")).videos;
    const reels = reelsFromResponse(fixture("reels.json"), owner).items;
    const merged = mergeTimeline(reels, timeline);
    expect(merged.find((v) => v.id === "4027454424454836023")?.audio?.isOriginal).toBe(true);
    const unknown = merged.find((v) => v.id === "3485895473040538296");
    expect(unknown && "audio" in unknown).toBe(false);
  });
});

describe("timeline page", () => {
  const page = timelinePageFromResponse(fixture("timeline.json"));

  it("reads the page the app loads when the profile grid is scrolled", () => {
    // Captured from PolarisProfilePostsTabContentQuery_connection: same shape as the first page.
    const more = timelinePageFromResponse(fixture("timeline-more.json"));
    expect(isTimelinePayload(fixture("timeline-more.json"))).toBe(true);
    expect(more.posts).toBe(4);
    expect(more.hasNext).toBe(true);
    const videos = [...more.videos.values()];
    expect(videos.map((v) => v.shortcode)).toEqual(["DfNAIEogg3a", "DfHbb0pATp0"]);
    expect(videos.every((v) => v.caption && v.videoUrl && v.takenAt)).toBe(true);
    expect(videos.every((v) => v.plays === null)).toBe(true);
    expect(videos[0]?.audio).toMatchObject({ title: "Danger Zone", isOriginal: false });
    expect(videos[1]?.audio).toMatchObject({ artist: "jamieoliver", isOriginal: true });
    expect(new Date(more.oldestMs as number).toISOString().slice(0, 10)).toBe("2026-10-29");
  });

  it("counts every post, keeps the videos, and knows there is more", () => {
    expect(page.posts).toBe(6);
    expect([...page.videos.keys()].sort()).toEqual([
      "3927465820040561085",
      "4026641251917986362",
      "4027454424454836023",
    ]);
    expect(page.hasNext).toBe(true);
  });

  it("dates the page by its oldest unpinned post, ignoring pinned ones", () => {
    // The two pinned posts are from 2025 and mid 2026; the oldest unpinned is 2026-11-08.
    expect(new Date(page.oldestMs as number).toISOString().slice(0, 10)).toBe("2026-11-08");
  });

  it("recognizes a timeline payload whatever query carried it", () => {
    expect(isTimelinePayload(fixture("timeline.json"))).toBe(true);
    expect(isTimelinePayload(fixture("reels.json"))).toBe(false);
    expect(isTimelinePayload({ data: { [KEY]: null } })).toBe(false);
    expect(isTimelinePayload(null)).toBe(false);
  });

  it("fails loudly when the connection is gone", () => {
    expect(() => timelinePageFromResponse({ data: {} })).toThrowError(
      expect.objectContaining({ code: "UPSTREAM_CHANGED" }),
    );
  });

  it("derives upload time from a media id only", () => {
    expect(new Date(uploadMs("4027454424454836023") as number).toISOString()).toMatch(
      /^2026-11-10T/,
    );
    expect(uploadMs("abc")).toBeNull();
    expect(uploadMs(null)).toBeNull();
  });
});

// --- paging -----------------------------------------------------------------

const DAY = 86_400_000;
const IG_EPOCH = 1314220021721;
/** A media id uploaded at `ms`. */
const pkAt = (ms: number): string => String(BigInt(ms - IG_EPOCH) << 23n);
const T0 = Date.UTC(2026, 9, 1);

/** A timeline payload of videos published `daysAgo` before T0, in the live shape. */
function payload(daysAgo: number[], hasNext: boolean, opts: { photos?: number } = {}): unknown {
  const edges: unknown[] = daysAgo.map((d) => ({
    node: {
      media_type: 2,
      pk: pkAt(T0 - d * DAY),
      code: `code${d}`,
      taken_at: Math.floor((T0 - d * DAY) / 1000) + 60,
      caption: { text: `caption ${d} #tag${d}` },
      user: { pk: "1", username: "ana" },
      timeline_pinned_user_ids: [],
    },
  }));
  for (let i = 0; i < (opts.photos ?? 0); i++) {
    // Photos posted the same day as the newest video of the page.
    edges.push({
      node: { media_type: 1, pk: pkAt(T0 - Math.min(...daysAgo) * DAY + i), code: `photo${i}` },
    });
  }
  return { data: { [KEY]: { edges, page_info: { has_next_page: hasNext } } } };
}
const pageOf = (daysAgo: number[], hasNext: boolean): TimelinePage =>
  timelinePageFromResponse(payload(daysAgo, hasNext));
const idOf = (daysAgo: number): string => pkAt(T0 - daysAgo * DAY);

/** A scroll that serves the given payloads in order and records how often it ran. */
function scroller(pages: unknown[][]) {
  const state = { calls: 0 };
  return {
    state,
    deps: {
      scroll: async () => pages[state.calls++] ?? [],
      remaining: () => 100,
    },
  };
}

describe("timelineCovers", () => {
  it("is satisfied by an empty request", () => {
    expect(timelineCovers(timelineState(pageOf([1, 2], true)), { ids: [], minVideos: 0 })).toBe(
      true,
    );
  });

  it("wants more while a wanted reel is older than what was read", () => {
    const state = timelineState(pageOf([1, 2], true));
    expect(timelineCovers(state, { ids: [idOf(5)], minVideos: 0 })).toBe(false);
    addPage(state, pageOf([3, 5], true));
    expect(timelineCovers(state, { ids: [idOf(5)], minVideos: 0 })).toBe(true);
  });

  it("gives up on a wanted reel once the reading has gone past its date", () => {
    // Day 4 is not on the grid (deleted or kept off it); day 6 was read.
    const state = timelineState(pageOf([1, 2, 6], true));
    expect(timelineCovers(state, { ids: [idOf(4)], minVideos: 0 })).toBe(true);
  });

  it("wants more until the minimum number of videos was seen", () => {
    const state = timelineState(pageOf([1, 2], true));
    expect(timelineCovers(state, { ids: [], minVideos: 3 })).toBe(false);
    expect(timelineCovers(state, { ids: [], minVideos: 2 })).toBe(true);
  });

  it("with leave, stops while that many wanted reels may still lie ahead", () => {
    const state = timelineState(pageOf([1, 2], true));
    const ids = [idOf(5), idOf(300)];
    expect(timelineCovers(state, { ids, minVideos: 0, leave: 1 })).toBe(false);
    addPage(state, pageOf([4, 5], true));
    // Only the reel from 300 days ago is left: cheaper to fetch by itself.
    expect(timelineCovers(state, { ids, minVideos: 0, leave: 1 })).toBe(true);
    expect(timelineCovers(state, { ids, minVideos: 0 })).toBe(false);
  });

  it("ignores ids that are not media ids instead of reading forever", () => {
    const state = timelineState(pageOf([1], true));
    expect(timelineCovers(state, { ids: ["not-an-id"], minVideos: 0 })).toBe(true);
  });
});

describe("pageTimeline", () => {
  it("spends nothing when the first page already covers what is wanted", async () => {
    const state = timelineState(pageOf([1, 2, 3], true));
    const { state: s, deps } = scroller([[payload([4], true)]]);
    const pass = await pageTimeline(state, { ids: [idOf(2)], minVideos: 0, maxRequests: 8 }, deps);
    expect(pass).toEqual({ loaded: [], requests: 0 });
    expect(s.calls).toBe(0);
  });

  it("scrolls until the wanted reels are covered, one request per scroll, and stops", async () => {
    const state = timelineState(pageOf([1, 2], true));
    const { state: s, deps } = scroller([
      [payload([3, 4], true, { photos: 2 })],
      [payload([5, 6], true)],
      [payload([7, 8], true)],
    ]);
    const pass = await pageTimeline(state, { ids: [idOf(6)], minVideos: 0, maxRequests: 8 }, deps);
    expect(pass.requests).toBe(2);
    expect(s.calls).toBe(2);
    // Only what the extra pages brought; photos are not videos.
    expect(pass.loaded).toEqual([idOf(3), idOf(4), idOf(5), idOf(6)]);
    expect(pass.loaded.map((id) => state.videos.get(id)?.caption)).toEqual([
      "caption 3 #tag3",
      "caption 4 #tag4",
      "caption 5 #tag5",
      "caption 6 #tag6",
    ]);
    expect(state.videos.size).toBe(6);
    // What the backend hands back: everything read so far, and what this call paid for.
    const whole = passOf(state, pass.loaded, pass.requests);
    expect(whole.videos).toHaveLength(6);
    expect(whole.loaded).toHaveLength(4);
    expect(passOf(undefined, [], 1)).toEqual({ videos: [], loaded: [], requests: 1 });
  });

  it("stops at the request cap", async () => {
    const state = timelineState(pageOf([1], true));
    const { state: s, deps } = scroller([
      [payload([2], true)],
      [payload([3], true)],
      [payload([4], true)],
    ]);
    const pass = await pageTimeline(state, { ids: [idOf(50)], minVideos: 0, maxRequests: 2 }, deps);
    expect(pass.requests).toBe(2);
    expect(s.calls).toBe(2);
  });

  it("stops when the timeline ends", async () => {
    const state = timelineState(pageOf([1], true));
    const { state: s, deps } = scroller([[payload([2], false)], [payload([3], true)]]);
    const pass = await pageTimeline(state, { ids: [], minVideos: 10, maxRequests: 8 }, deps);
    expect(pass.requests).toBe(1);
    expect(s.calls).toBe(1);
  });

  it("stops when a scroll loads nothing, and still counts that request", async () => {
    const state = timelineState(pageOf([1], true));
    const { deps } = scroller([[]]);
    const pass = await pageTimeline(state, { ids: [idOf(9)], minVideos: 0, maxRequests: 8 }, deps);
    expect(pass).toEqual({ loaded: [], requests: 1 });
  });

  it("does not scroll when the first page was the last", async () => {
    const state = timelineState(pageOf([1], false));
    const { state: s, deps } = scroller([[payload([2], false)]]);
    const pass = await pageTimeline(state, { ids: [idOf(9)], minVideos: 5, maxRequests: 8 }, deps);
    expect(pass.requests).toBe(0);
    expect(s.calls).toBe(0);
  });

  it("keeps the last requests of the day for the reel list", async () => {
    const state = timelineState(pageOf([1], true));
    const { state: s, deps } = scroller([[payload([2], true)], [payload([3], true)]]);
    let left = BUDGET_RESERVE + 1;
    const pass = await pageTimeline(
      state,
      { ids: [idOf(9)], minVideos: 0, maxRequests: 8 },
      {
        scroll: async () => {
          left--;
          return deps.scroll();
        },
        remaining: () => left,
      },
    );
    expect(pass.requests).toBe(1);
    expect(s.calls).toBe(1);
  });

  it("lets a block from the scroll through and does not scroll again", async () => {
    const state = timelineState(pageOf([1], true));
    let calls = 0;
    const blocked = Object.assign(new Error("blocked"), { code: "RATE_LIMITED" });
    await expect(
      pageTimeline(
        state,
        { ids: [idOf(9)], minVideos: 0, maxRequests: 8 },
        {
          scroll: async () => {
            calls++;
            throw blocked;
          },
          remaining: () => 100,
        },
      ),
    ).rejects.toBe(blocked);
    expect(calls).toBe(1);
  });
});
