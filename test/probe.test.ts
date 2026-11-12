import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FFPROBE_HINT,
  type MediaInfo,
  needsProbe,
  type ProbeDeps,
  parseFfprobe,
  probeVideos,
} from "../src/core/probe.js";
import type { StoredVideo, Video } from "../src/core/types.js";
import { type TestEnv, testEnv } from "./fake-backend.js";
import { creator, video } from "./helpers.js";

let env: TestEnv;
afterEach(async () => {
  await env?.cleanup();
});

const out = (doc: unknown) => JSON.stringify(doc);

describe("parseFfprobe", () => {
  it("reads duration and dimensions", () => {
    expect(
      parseFfprobe(
        out({
          streams: [{ width: 320, height: 568, duration: "3.000000" }],
          format: { duration: "3.033333" },
        }),
      ),
    ).toEqual({ durationSec: 3.033, width: 320, height: 568 });
  });

  it("prefers the container duration and falls back to the stream", () => {
    const streams = [{ width: 10, height: 20, duration: "7.5" }];
    expect(parseFfprobe(out({ streams, format: { duration: "8.25" } })).durationSec).toBe(8.25);
    expect(parseFfprobe(out({ streams, format: {} })).durationSec).toBe(7.5);
    expect(parseFfprobe(out({ streams, format: { duration: "N/A" } })).durationSec).toBe(7.5);
    expect(parseFfprobe(out({ streams })).durationSec).toBe(7.5);
  });

  it("a missing or nonsensical value is null, never zero", () => {
    expect(
      parseFfprobe(out({ streams: [{ width: 0, duration: "N/A" }], format: { duration: "-1" } })),
    ).toEqual({ durationSec: null, width: null, height: null });
  });

  it.each([
    ["side data -90", { side_data_list: [{ rotation: -90 }] }],
    ["side data 90", { side_data_list: [{ rotation: 90 }] }],
    ["side data 270", { side_data_list: [{ rotation: "270" }] }],
    ["rotate tag", { tags: { rotate: "90" } }],
  ])("swaps to display dimensions for a sideways stream (%s)", (_name, extra) => {
    const info = parseFfprobe(out({ streams: [{ width: 1920, height: 1080, ...extra }] }));
    expect(info).toMatchObject({ width: 1080, height: 1920 });
  });

  it("keeps dimensions for an upside-down or unrotated stream", () => {
    for (const extra of [{ side_data_list: [{ rotation: 180 }] }, { tags: { rotate: "0" } }, {}]) {
      const info = parseFfprobe(out({ streams: [{ width: 1920, height: 1080, ...extra }] }));
      expect(info).toMatchObject({ width: 1920, height: 1080 });
    }
  });

  it("throws when there is no video stream", () => {
    expect(() => parseFfprobe(out({ streams: [], format: { duration: "3" } }))).toThrow(
      "no video stream",
    );
    expect(() => parseFfprobe(out({}))).toThrow("no video stream");
    expect(() => parseFfprobe("null")).toThrow("no video stream");
  });

  it("throws on output that is not JSON", () => {
    expect(() => parseFfprobe("")).toThrow("not JSON");
    expect(() => parseFfprobe("Invalid data found")).toThrow("not JSON");
  });
});

describe("probeVideos", () => {
  const ana = creator({ id: "1", username: "ana" });
  const reel = (id: string, over: Partial<Video> = {}) =>
    video({ id, shortcode: `sc${id}`, creatorId: "1", creatorUsername: "ana", ...over });

  /** Stores `videos`; those named in `onDisk` get a real file and a local path. */
  function setup(videos: Video[], onDisk: string[]): void {
    env = testEnv();
    const { store } = env.ctx;
    store.upsertCreator(ana, { refreshed: false });
    store.upsertVideos(videos);
    const dir = join(env.ctx.paths.state, "media", "ana");
    mkdirSync(dir, { recursive: true });
    for (const id of onDisk) {
      const path = join(dir, `sc${id}.mp4`);
      writeFileSync(path, Buffer.alloc(64));
      store.markDownloaded(id, path);
    }
  }

  const stored = (): StoredVideo[] =>
    env.ctx.store.listVideos().sort((a, b) => (a.id < b.id ? -1 : 1));

  function run(
    opts: { all?: boolean; videos?: StoredVideo[] } = {},
    over: Partial<ProbeDeps> = {},
  ) {
    const logs: string[] = [];
    const probed: string[] = [];
    const info: MediaInfo = { durationSec: 3.033, width: 320, height: 568 };
    const promise = probeVideos(
      { store: env.ctx.store, log: (m) => logs.push(m) },
      { videos: opts.videos ?? stored(), all: opts.all ?? false },
      {
        hasFfprobe: () => true,
        ffprobe: async (path) => {
          probed.push(path);
          return info;
        },
        ...over,
      },
    );
    return { promise, logs, probed };
  }

  it("needsProbe is true while any of the three values is unknown", () => {
    setup([reel("1", { durationSec: 30 }), reel("2", { durationSec: null })], []);
    const [one, two] = stored() as [StoredVideo, StoredVideo];
    expect(needsProbe(one)).toBe(true);
    expect(needsProbe(two)).toBe(true);
    expect(needsProbe({ ...one, width: 1, height: 2 })).toBe(false);
    expect(needsProbe({ ...one, width: 1, height: 2, durationSec: null })).toBe(true);
  });

  it("measures files that lack a value and stores the result", async () => {
    setup([reel("1", { durationSec: null }), reel("2", { durationSec: 30 })], ["1", "2"]);
    const r = run();
    const summary = await r.promise;
    expect(summary).toMatchObject({ measured: 2, skipped: 0, missingFile: 0, failed: 0 });
    expect(summary.items[0]).toEqual({
      id: "1",
      shortcode: "sc1",
      creatorUsername: "ana",
      status: "measured",
      reason: null,
      path: join(env.ctx.paths.state, "media", "ana", "sc1.mp4"),
      durationSec: 3.033,
      width: 320,
      height: 568,
    });
    expect(r.probed).toHaveLength(2);
    expect(env.ctx.store.findVideo("1")).toMatchObject({
      durationSec: 3.033,
      width: 320,
      height: 568,
    });
    expect(r.logs).toEqual(["1/2 ana/sc1 0:03 320x568", "2/2 ana/sc2 0:03 320x568"]);
  });

  it("skips what is already measured, unless --all", async () => {
    setup([reel("1", { durationSec: 30 })], ["1"]);
    env.ctx.store.setVideoMedia("1", { width: 720, height: 1280 });

    const first = run();
    const skipped = await first.promise;
    expect(skipped).toMatchObject({ measured: 0, skipped: 1 });
    expect(skipped.items[0]).toMatchObject({
      status: "skipped",
      reason: "already measured; use --all to measure again",
      durationSec: 30,
      width: 720,
      height: 1280,
    });
    expect(first.probed).toEqual([]);
    expect(first.logs).toEqual([]);

    const again = run({ all: true });
    expect(await again.promise).toMatchObject({ measured: 1, skipped: 0 });
    expect(env.ctx.store.findVideo("1")).toMatchObject({ durationSec: 3.033, width: 320 });
  });

  it("reports a file that is gone, and a video never downloaded", async () => {
    setup([reel("1", { durationSec: null }), reel("2", { durationSec: null })], []);
    env.ctx.store.markDownloaded("1", join(env.ctx.paths.state, "media", "ana", "gone.mp4"));
    const r = run();
    const summary = await r.promise;
    expect(summary).toMatchObject({ measured: 0, missingFile: 2, failed: 0 });
    expect(summary.items.map((i) => [i.id, i.status, i.reason])).toEqual([
      ["1", "missing-file", "the downloaded file is no longer on disk; download it again"],
      ["2", "missing-file", "not downloaded"],
    ]);
    expect(r.probed).toEqual([]);
  });

  it("one unreadable file fails one item and the batch goes on", async () => {
    setup([reel("1", { durationSec: null }), reel("2", { durationSec: null })], ["1", "2"]);
    const r = run(
      {},
      {
        ffprobe: async (path) => {
          if (path.endsWith("sc1.mp4")) throw new Error("moov atom\n not found\x1b[2J");
          return { durationSec: 9, width: 4, height: 8 };
        },
      },
    );
    const summary = await r.promise;
    expect(summary).toMatchObject({ measured: 1, failed: 1 });
    expect(summary.items[0]).toMatchObject({
      status: "failed",
      reason: "moov atom not found",
      durationSec: null,
    });
    expect(env.ctx.store.findVideo("1")?.width).toBeNull();
    expect(env.ctx.store.findVideo("2")).toMatchObject({ durationSec: 9, width: 4, height: 8 });
    expect(r.logs[0]).toBe("1/2 ana/sc1 failed: moov atom not found");
  });

  it("a null measurement leaves the stored value in place", async () => {
    setup([reel("1", { durationSec: 30 })], ["1"]);
    const r = run({}, { ffprobe: async () => ({ durationSec: null, width: 4, height: 8 }) });
    const summary = await r.promise;
    expect(summary.items[0]).toMatchObject({ status: "measured", durationSec: 30, width: 4 });
    expect(env.ctx.store.findVideo("1")).toMatchObject({ durationSec: 30, width: 4, height: 8 });
  });

  it("without ffprobe it fails before any work, naming the fix", async () => {
    setup([reel("1", { durationSec: null })], ["1"]);
    const r = run({}, { hasFfprobe: () => false });
    await expect(r.promise).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: "ffprobe is not installed, so files cannot be measured.",
      hint: FFPROBE_HINT,
    });
    expect(FFPROBE_HINT).toContain("ig video probe");
    expect(r.probed).toEqual([]);
  });

  it("without ffprobe but with nothing to measure it does not fail", async () => {
    setup([reel("1", { durationSec: 30 }), reel("2", { durationSec: null })], ["1"]);
    env.ctx.store.setVideoMedia("1", { width: 720, height: 1280 });
    const r = run({}, { hasFfprobe: () => false });
    expect(await r.promise).toMatchObject({ measured: 0, skipped: 1, missingFile: 1, failed: 0 });

    const empty = run({ videos: [] }, { hasFfprobe: () => false });
    expect(await empty.promise).toEqual({
      measured: 0,
      skipped: 0,
      missingFile: 0,
      failed: 0,
      items: [],
    });
  });
});
