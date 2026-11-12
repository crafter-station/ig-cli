import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaInfo, ProbeDeps } from "../src/core/probe.js";

// The command passes no overrides, so the seam is swapped here: no real ffprobe runs.
const fake = vi.hoisted(() => ({
  installed: true,
  results: new Map<string, unknown>(),
  calls: [] as string[],
}));
vi.mock("../src/core/probe.js", async (original) => {
  const actual = await original<typeof import("../src/core/probe.js")>();
  const deps: ProbeDeps = {
    hasFfprobe: () => fake.installed,
    ffprobe: async (path) => {
      fake.calls.push(path);
      const result = [...fake.results].find(([name]) => path.endsWith(name))?.[1];
      if (result instanceof Error) throw result;
      return (result as MediaInfo | undefined) ?? { durationSec: 21.5, width: 720, height: 1280 };
    },
  };
  return {
    ...actual,
    probeVideos: (env: never, request: never) => actual.probeVideos(env, request, deps),
  };
});

import { mediaCommands } from "../src/commands/media.js";
import type { Video } from "../src/core/types.js";
import type { CommandDef } from "../src/lib/command.js";
import type { Meta } from "../src/lib/output.js";
import { byId, type TestEnv, testEnv } from "./fake-backend.js";
import { creator, video } from "./helpers.js";

const defs = mediaCommands as CommandDef[];
const probe = byId(defs, "video.probe");
const tags = byId(defs, "niche.tags");
const audio = byId(defs, "niche.audio");
const durations = byId(defs, "niche.durations");

let env: TestEnv;
afterEach(async () => {
  vi.restoreAllMocks();
  fake.installed = true;
  fake.results.clear();
  fake.calls.length = 0;
  await env.cleanup();
});

const a = (id: string, over: Partial<Video>) =>
  video({ id, shortcode: id, creatorId: "1", creatorUsername: "ana", durationSec: null, ...over });
const b = (id: string, over: Partial<Video>) =>
  video({ id, shortcode: id, creatorId: "2", creatorUsername: "beto", durationSec: null, ...over });

const tema = { id: "900", title: "Tema Viral", artist: "La Banda", isOriginal: false };

/**
 * Niche `cocina`: Ana (median plays 200, so scores 5 / 1.5 / 0.5 / 0.5) and
 * Beto (two reels, no outlier score). `otros` holds Cata; `vacio` is empty.
 */
function seeded(): TestEnv {
  const e = testEnv();
  const { store } = e.ctx;
  store.createNiche({ slug: "cocina", name: "Cocina" });
  store.createNiche({ slug: "otros", name: "Otros" });
  store.createNiche({ slug: "vacio", name: "Vacío" });
  store.upsertCreator(creator({ id: "1", username: "ana" }), { refreshed: false });
  store.upsertCreator(creator({ id: "2", username: "beto" }), { refreshed: false });
  store.upsertCreator(creator({ id: "3", username: "cata" }), { refreshed: false });
  store.addCreatorToNiche("1", "cocina");
  store.addCreatorToNiche("2", "cocina");
  store.addCreatorToNiche("3", "otros");
  store.upsertVideos([
    a("a1", { plays: 1000, caption: "Pasta #Receta #pasta", takenAt: "2026-10-01T00:00:00.000Z" }),
    a("a2", { plays: 300, caption: "#receta rápida", audio: tema }),
    a("a3", { plays: 100, caption: "sin etiquetas" }),
    a("a4", { plays: 100, caption: "#pasta otra vez", audio: tema }),
    b("b1", { plays: 5000, caption: "#receta de @ana", audio: tema }),
    b("b2", { plays: 4000, caption: null }),
    video({
      id: "c1",
      shortcode: "c1",
      creatorId: "3",
      creatorUsername: "cata",
      caption: "#ajeno",
      audio: { id: "111", title: "Ajeno", artist: null, isOriginal: true },
    }),
  ]);
  return e;
}

/** Marks a video as downloaded, with a real (empty) file unless `exists` is false. */
function onDisk(e: TestEnv, id: string, exists = true): string {
  const dir = join(e.ctx.paths.media, "files");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.mp4`);
  if (exists) writeFileSync(path, "x");
  e.ctx.store.markDownloaded(id, path);
  return path;
}

function human(def: CommandDef, data: unknown, meta: Meta = {}) {
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
  const color = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  try {
    def.human?.(data as never, env.ctx, meta);
  } finally {
    if (color === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = color;
    o.mockRestore();
    e.mockRestore();
  }
  return { out: out.join(""), err: err.join("") };
}

type Rows = Record<string, unknown>[];

describe("video probe", () => {
  it("measures downloaded videos that lack a value and stores the result", async () => {
    env = seeded();
    onDisk(env, "a1");
    onDisk(env, "b1");
    fake.results.set("b1.mp4", { durationSec: 61, width: 1080, height: 1920 });
    const { data, meta, nextSteps } = await env.run(probe, {});
    expect(data).toMatchObject({ measured: 2, skipped: 0, missingFile: 0, failed: 0 });
    expect(meta).toEqual({ downloadedVideos: 2 });
    expect(env.ctx.store.findVideo("a1")).toMatchObject({
      durationSec: 21.5,
      width: 720,
      height: 1280,
    });
    expect(env.ctx.store.findVideo("b1")).toMatchObject({ durationSec: 61, width: 1080 });
    // Videos that were never downloaded are not touched and not listed.
    expect(env.ctx.store.findVideo("a2")?.durationSec).toBeNull();
    expect((data as { items: Rows }).items).toHaveLength(2);
    expect(nextSteps?.map((s) => s.command)).toEqual(["ig niche durations cocina"]);
  });

  it("skips what is already measured unless --all", async () => {
    env = seeded();
    onDisk(env, "a1");
    await env.run(probe, {});
    fake.calls.length = 0;

    const again = await env.run(probe, {});
    expect(again.data).toMatchObject({ measured: 0, skipped: 1 });
    expect(fake.calls).toEqual([]);

    fake.results.set("a1.mp4", { durationSec: 9, width: 100, height: 200 });
    const all = await env.run(probe, { all: true });
    expect(all.data).toMatchObject({ measured: 1, skipped: 0 });
    expect(env.ctx.store.findVideo("a1")).toMatchObject({ durationSec: 9, width: 100 });
  });

  it("reports a missing file and a failed probe without stopping", async () => {
    env = seeded();
    onDisk(env, "a1", false);
    onDisk(env, "a2");
    onDisk(env, "a3");
    fake.results.set("a2.mp4", new Error("Invalid data found when processing input"));
    const { data, nextSteps } = await env.run(probe, {});
    expect(data).toMatchObject({ measured: 1, skipped: 0, missingFile: 1, failed: 1 });
    const items = (data as { items: Rows }).items;
    expect(items.find((i) => i.id === "a1")).toMatchObject({ status: "missing-file" });
    expect(items.find((i) => i.id === "a2")).toMatchObject({ status: "failed" });
    expect(nextSteps?.[0]?.command).toBe("ig video download a1 --force");
  });

  it("limits the scope with --niche and --creator", async () => {
    env = seeded();
    onDisk(env, "a1");
    onDisk(env, "b1");
    onDisk(env, "c1");
    const byNiche = await env.run(probe, { niche: "otros" });
    expect((byNiche.data as { items: Rows }).items.map((i) => i.id)).toEqual(["c1"]);
    const byCreator = await env.run(probe, { creator: "@Beto" });
    expect((byCreator.data as { items: Rows }).items.map((i) => i.id)).toEqual(["b1"]);
    const disjoint = await env.run(probe, { niche: "otros", creator: "ana" });
    expect(disjoint.data).toMatchObject({ measured: 0, items: [] });
    expect(env.ctx.store.findVideo("a1")?.durationSec).toBeNull();
  });

  it("points at download when nothing is on disk", async () => {
    env = seeded();
    const { data, nextSteps } = await env.run(probe, { niche: "cocina" });
    expect(data).toEqual({ measured: 0, skipped: 0, missingFile: 0, failed: 0, items: [] });
    expect(nextSteps?.[0]?.command).toBe("ig video download --top 10 --niche cocina");
    expect(human(probe, data).err).toContain("No downloaded videos in this scope.");
  });

  it("fails with a hint when ffprobe is missing and there is work to do", async () => {
    env = seeded();
    onDisk(env, "a1");
    fake.installed = false;
    await expect(env.run(probe, {})).rejects.toMatchObject({
      code: "UNSUPPORTED",
      hint: expect.stringContaining("ffmpeg"),
    });
  });

  it("rejects an unknown niche or creator", async () => {
    env = seeded();
    await expect(env.run(probe, { niche: "nope" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(env.run(probe, { creator: "nadie" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("prints problems and totals, and only counts already-measured rows", async () => {
    env = seeded();
    onDisk(env, "a1");
    await env.run(probe, {});
    onDisk(env, "a2", false);
    const { data } = await env.run(probe, {});
    const { out } = human(probe, data);
    expect(out).toContain("missing file");
    expect(out).toContain("ana/a2");
    expect(out).not.toContain("ana/a1");
    expect(out).toContain("0 measured, 1 already measured, 1 missing file, 0 failed");
  });
});

describe("niche tags", () => {
  it("aggregates hashtags of the niche only", async () => {
    env = seeded();
    const { data, meta, nextSteps } = await env.run(tags, { slug: "cocina" });
    const rows = data as Rows;
    expect(rows.map((r) => [r.tag, r.videos, r.creators])).toEqual([
      ["receta", 3, 2],
      ["pasta", 2, 1],
    ]);
    // receta: a1 5.0x, a2 1.5x, b1 unscored -> median 3.25; plays 1000/300/5000.
    expect(rows[0]).toMatchObject({
      medianPlays: 1000,
      medianOutlier: 3.25,
      bestShortcode: "a1",
      bestCreator: "ana",
      bestOutlier: 5,
    });
    expect(meta).toEqual({
      sort: "videos",
      videosConsidered: 6,
      videosWithHashtags: 4,
      hashtags: 2,
      belowMinVideos: 0,
    });
    expect(nextSteps?.[0]?.command).toBe("ig video top --niche cocina --hashtag receta");
  });

  it("honours --sort, --min-videos and --limit", async () => {
    env = seeded();
    const byOutlier = await env.run(tags, { slug: "cocina", sort: "outlier" });
    expect((byOutlier.data as Rows).map((r) => r.tag)).toEqual(["receta", "pasta"]);
    const min = await env.run(tags, { slug: "cocina", minVideos: "3" });
    expect((min.data as Rows).map((r) => r.tag)).toEqual(["receta"]);
    expect(min.meta?.belowMinVideos).toBe(1);
    const limited = await env.run(tags, { slug: "cocina", limit: 1 });
    expect(limited.data).toHaveLength(1);
    await expect(env.run(tags, { slug: "cocina", sort: "bogus" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("--since cuts the videos but keeps scores relative to the full set", async () => {
    env = seeded();
    const { data, meta, nextSteps } = await env.run(tags, {
      slug: "cocina",
      since: "2026-10-15",
    });
    // a1 (5.0x, 2026-10-01) is out; a2 keeps its 1.5x against Ana's full median.
    expect((data as Rows).find((r) => r.tag === "receta")).toMatchObject({
      videos: 2,
      medianOutlier: 1.5,
    });
    expect(meta?.videosConsidered).toBe(5);
    expect(nextSteps?.[0]?.command).toContain("--since 2026-10-15");
    await expect(env.run(tags, { slug: "cocina", since: "soon" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("explains an empty niche and a threshold nobody reaches", async () => {
    env = seeded();
    const empty = await env.run(tags, { slug: "vacio" });
    expect(empty.data).toEqual([]);
    expect(empty.nextSteps?.[0]?.command).toBe("ig niche refresh vacio");
    expect(human(tags, empty.data, empty.meta).err).toContain("No videos stored in this scope");

    const high = await env.run(tags, { slug: "cocina", minVideos: 50 });
    expect(high.data).toEqual([]);
    expect(high.nextSteps?.[0]?.command).toBe("ig niche tags cocina --min-videos 1");
    expect(human(tags, high.data, high.meta).err).toContain("below --min-videos");

    await expect(env.run(tags, { slug: "nope" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("renders a table with the sorted column marked", async () => {
    env = seeded();
    const { data, meta } = await env.run(tags, { slug: "cocina", sort: "outlier" });
    const { out, err } = human(tags, data, meta);
    expect(out).toContain("MED OUTLIER ↓");
    expect(out).toContain("#receta");
    expect(out).toContain("ana/a1 5.0x");
    expect(err).toContain("4 of 6 videos use a hashtag");
  });
});

describe("niche audio", () => {
  it("lists sounds used by two or more videos by default", async () => {
    env = seeded();
    const { data, meta, nextSteps } = await env.run(audio, { slug: "cocina" });
    expect(data).toHaveLength(1);
    expect((data as Rows)[0]).toMatchObject({
      id: "900",
      title: "Tema Viral",
      artist: "La Banda",
      isOriginal: false,
      videos: 3,
      creators: 2,
      medianPlays: 300,
      medianOutlier: 1,
      bestShortcode: "a2",
    });
    expect(meta).toEqual({
      sort: "videos",
      videosConsidered: 6,
      videosWithAudio: 3,
      sounds: 1,
      belowMinVideos: 0,
    });
    expect(nextSteps?.[0]?.command).toBe("ig video top --niche cocina --audio 900");
    const { out, err } = human(audio, data, meta);
    expect(out).toContain("Tema Viral");
    expect(out).toContain("music");
    expect(err).toContain("3 of 6 videos have audio data");
  });

  it("hides one-off sounds until --min-videos 1", async () => {
    env = seeded();
    const hidden = await env.run(audio, { slug: "otros" });
    expect(hidden.data).toEqual([]);
    expect(hidden.meta).toMatchObject({ videosWithAudio: 1, sounds: 1, belowMinVideos: 1 });
    expect(hidden.nextSteps?.[0]?.command).toBe("ig niche audio otros --min-videos 1");
    expect(human(audio, hidden.data, hidden.meta).err).toContain("below --min-videos");

    const shown = await env.run(audio, { slug: "otros", minVideos: 1 });
    expect((shown.data as Rows)[0]).toMatchObject({ id: "111", isOriginal: true, videos: 1 });
  });

  it("is honest when no stored video has audio data", async () => {
    env = testEnv();
    const { store } = env.ctx;
    store.createNiche({ slug: "mudo", name: "Mudo" });
    store.upsertCreator(creator({ id: "1", username: "ana" }), { refreshed: false });
    store.addCreatorToNiche("1", "mudo");
    store.upsertVideos([a("m1", {}), a("m2", {})]);
    const { data, meta, nextSteps } = await env.run(audio, { slug: "mudo" });
    expect(data).toEqual([]);
    expect(meta).toMatchObject({ videosConsidered: 2, videosWithAudio: 0, sounds: 0 });
    expect(nextSteps).toEqual([
      {
        command: "ig niche refresh mudo --force",
        description: expect.stringContaining("no stored video has audio data yet"),
      },
    ]);
    expect(human(audio, data, meta).err).toContain("has audio data yet");
  });

  it("never puts an untrusted title into a suggested command unquoted", async () => {
    env = testEnv();
    const { store } = env.ctx;
    store.createNiche({ slug: "n", name: "N" });
    store.upsertCreator(creator({ id: "1", username: "ana" }), { refreshed: false });
    store.addCreatorToNiche("1", "n");
    const evil = { id: null, title: "x; rm -rf ~ $(boom)", artist: null, isOriginal: null };
    store.upsertVideos([a("e1", { audio: evil }), a("e2", { audio: evil })]);
    const { data, nextSteps } = await env.run(audio, { slug: "n" });
    expect(data).toHaveLength(1);
    expect(nextSteps).toEqual([]);
  });
});

describe("niche durations", () => {
  it("reports every bucket and how many videos have no duration", async () => {
    env = seeded();
    const { store } = env.ctx;
    store.setVideoMedia("a1", { durationSec: 12 });
    store.setVideoMedia("a2", { durationSec: 14.9 });
    store.setVideoMedia("a3", { durationSec: 8 });
    store.setVideoMedia("b1", { durationSec: 45 });
    onDisk(env, "a4");
    // Downloaded once, file since removed: nothing `ig video probe` could measure.
    onDisk(env, "b2", false);
    const { data, meta, nextSteps } = await env.run(durations, { slug: "cocina" });
    const rows = data as Rows;
    expect(rows.map((r) => [r.bucket, r.videos])).toEqual([
      ["<15s", 3],
      ["15-30s", 0],
      ["30-60s", 1],
      ["60-90s", 0],
      [">90s", 0],
    ]);
    expect(rows[0]).toMatchObject({ medianPlays: 300, medianOutlier: 1.5, bestShortcode: "a1" });
    expect(rows[2]).toMatchObject({ medianPlays: 5000, medianOutlier: null, creators: 1 });
    expect(meta).toEqual({
      videosConsidered: 6,
      withDuration: 4,
      withoutDuration: 2,
      withoutDurationDownloaded: 1,
    });
    expect(nextSteps?.map((s) => s.command)).toEqual([
      "ig video probe --niche cocina",
      "ig video download --top 1 --niche cocina",
      "ig video top --niche cocina --min-duration 0 --max-duration 15",
    ]);
    const { out, err } = human(durations, data, meta);
    expect(out).toContain("<15s");
    expect(out).toContain("15-30s");
    expect(err).toContain("2 of 6 videos have no measured duration");
    expect(err).toContain("ig video probe");
  });

  it("says so when nothing has been measured", async () => {
    env = seeded();
    const { data, meta, nextSteps } = await env.run(durations, { slug: "cocina" });
    expect((data as Rows).every((r) => r.videos === 0)).toBe(true);
    expect(meta).toMatchObject({ withDuration: 0, withoutDuration: 6 });
    expect(nextSteps?.[0]?.command).toBe("ig video download --top 6 --niche cocina");
    const { out, err } = human(durations, data, meta);
    expect(out).toBe("");
    expect(err).toContain("None of the 6 videos in this scope has a measured duration yet.");
    expect(err).toContain("ig video download");
  });

  it("handles an empty niche", async () => {
    env = seeded();
    const { data, meta, nextSteps } = await env.run(durations, { slug: "vacio" });
    expect(data).toHaveLength(5);
    expect(meta).toMatchObject({ videosConsidered: 0, withoutDuration: 0 });
    expect(nextSteps?.map((s) => s.command)).toEqual(["ig niche refresh vacio"]);
    expect(human(durations, data, meta).err).toContain("No videos stored in this scope yet.");
  });
});
