import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeCommands, analyzeSeams, timeline } from "../src/commands/analyze.js";
import type { RunResult, Tool } from "../src/core/analyze.js";
import type { CommandDef } from "../src/lib/command.js";
import type { IgError } from "../src/lib/errors.js";
import type { Meta } from "../src/lib/output.js";
import { byId, type TestEnv, testEnv } from "./fake-backend.js";
import { creator, video } from "./helpers.js";

const defs = analyzeCommands as CommandDef[];
const analyze = byId(defs, "video.analyze");
const frames = byId(defs, "video.frames");
const pace = byId(defs, "niche.pace");

// --- fake ffmpeg -------------------------------------------------------------

type Fake = {
  calls: { tool: Tool; args: string[] }[];
  /** Cut timestamps by a substring of the input path; default applies otherwise. */
  cutsFor: Record<string, number[]>;
  /** Input paths containing this make ffprobe fail. */
  broken: string;
  scenes: () => number;
};

function fakeFfmpeg(): Fake {
  const state: Fake = {
    calls: [],
    cutsFor: {},
    broken: "BROKEN",
    scenes: () => state.calls.filter((c) => c.args.some((a) => a.includes("gt(scene"))).length,
  };
  const done = (r: Partial<RunResult> = {}): RunResult => ({
    code: 0,
    stdout: "",
    stderr: "",
    ...r,
  });
  const run = async (tool: Tool, args: string[]): Promise<RunResult> => {
    state.calls.push({ tool, args });
    const input = args[args.indexOf("-i") + 1] ?? "";
    const out = args[args.length - 1] as string;
    if (tool === "ffprobe") {
      if (input.includes(state.broken)) {
        return done({ code: 1, stderr: "Invalid data found when processing input" });
      }
      return done({
        stdout: JSON.stringify({
          streams: [{ codec_type: "video", width: 720, height: 1280 }, { codec_type: "audio" }],
          format: { duration: "60" },
        }),
      });
    }
    if (args.some((a) => a.includes("gt(scene"))) {
      const key = Object.keys(state.cutsFor).find((k) => input.includes(k));
      const cuts = key ? (state.cutsFor[key] as number[]) : [10, 20, 30];
      return done({
        stdout: cuts.map((t) => `frame:0 pts:0 pts_time:${t}\nlavfi.scene_score=0.6`).join("\n"),
      });
    }
    if (args.some((a) => a.includes("silencedetect"))) {
      return done({ stderr: "silence_duration: 6\nmean_volume: -18.0 dB\nmax_volume: -1.0 dB" });
    }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, "jpg");
    return done();
  };
  analyzeSeams.deps = { run, hasTool: () => true };
  return state;
}

// --- fixtures ----------------------------------------------------------------

let env: TestEnv;
let ff: Fake;

const ana = creator({ id: "1", username: "ana", followers: 10_000 });
const beto = creator({ id: "2", username: "beto", followers: 100 });

/**
 * Niche `cocina` with Ana (a1..a4) and Beto (b1). a1, a2, a3 and b1 have a
 * file on disk; a4 does not. Ana's median plays is 250.
 */
function seed(): void {
  const { store } = env.ctx;
  store.createNiche({ slug: "cocina", name: "Cocina" });
  store.createNiche({ slug: "vacio", name: "Vacío" });
  store.upsertCreator(ana, { refreshed: false });
  store.upsertCreator(beto, { refreshed: false });
  store.addCreatorToNiche("1", "cocina");
  store.addCreatorToNiche("2", "cocina");
  const a = (id: string, plays: number) =>
    video({
      id,
      shortcode: `${id}code`,
      creatorId: "1",
      creatorUsername: "ana",
      plays,
      durationSec: null,
    });
  store.upsertVideos([
    a("a1", 1000),
    a("a2", 200),
    a("a3", 300),
    a("a4", 100),
    video({ id: "b1", shortcode: "b1code", creatorId: "2", creatorUsername: "beto", plays: 50 }),
  ]);
  for (const [id, user] of [
    ["a1", "ana"],
    ["a2", "ana"],
    ["a3", "ana"],
    ["b1", "beto"],
  ] as const) {
    const file = join(env.ctx.mediaDir, user, `${id}code.mp4`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "mp4");
    store.markDownloaded(id, file);
  }
}

beforeEach(() => {
  env = testEnv();
  ff = fakeFfmpeg();
  seed();
});

afterEach(async () => {
  vi.restoreAllMocks();
  analyzeSeams.deps = {};
  await env.cleanup();
});

type AnalyzeData = {
  analyzed: number;
  skipped: number;
  notDownloaded: number;
  failed: number;
  items: {
    id: string | null;
    shortcode: string;
    status: string;
    reason: string | null;
    analysis: {
      cuts: number;
      cutsPerMin: number | null;
      firstShotSec: number | null;
      framesDir: string;
      frames: { path: string; reason: string }[];
      sheet: string | null;
      threshold: number;
    } | null;
  }[];
};

async function runAnalyze(input: Record<string, unknown>) {
  const result = await env.run(analyze, input);
  return { ...result, data: result.data as AnalyzeData };
}

async function failure(run: Promise<unknown>): Promise<IgError> {
  return (await run.then(
    () => {
      throw new Error("expected the command to fail");
    },
    (err) => err,
  )) as IgError;
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

// --- video analyze -----------------------------------------------------------

describe("video analyze: input", () => {
  it("rejects a call with neither targets nor a selection", async () => {
    const err = await failure(runAnalyze({}));
    expect(err).toMatchObject({ code: "INVALID_INPUT", exitCode: 2 });
    expect(err.hint).toContain("ig video analyze --all-downloaded");
  });

  it("rejects targets together with a selection", async () => {
    for (const extra of [
      { top: 3 },
      { niche: "cocina" },
      { creator: "ana" },
      { allDownloaded: true },
    ]) {
      const err = await failure(runAnalyze({ targets: ["a1code"], ...extra }));
      expect(err.code).toBe("INVALID_INPUT");
    }
    expect(ff.calls).toHaveLength(0);
  });

  it("rejects out-of-range options before any work", async () => {
    for (const bad of [{ threshold: 0 }, { threshold: 1 }, { maxFrames: 0 }, { frameWidth: 10 }]) {
      const err = await failure(runAnalyze({ targets: ["a1code"], ...bad }));
      expect(err.code).toBe("INVALID_INPUT");
    }
    expect(ff.calls).toHaveLength(0);
  });

  it("fails on an unknown niche or creator", async () => {
    expect((await failure(runAnalyze({ niche: "nope" }))).code).toBe("NOT_FOUND");
    expect((await failure(runAnalyze({ creator: "nobody" }))).code).toBe("NOT_FOUND");
  });

  it("says so when ffmpeg is not installed", async () => {
    analyzeSeams.deps = { ...analyzeSeams.deps, hasTool: (tool) => tool !== "ffmpeg" };
    const err = await failure(runAnalyze({ targets: ["a1code"] }));
    expect(err).toMatchObject({ code: "UNSUPPORTED", message: "ffmpeg not found on PATH." });
    expect(err.hint).toContain("ig doctor");
    expect(ff.calls).toHaveLength(0);
  });
});

describe("video analyze: outcomes", () => {
  it("analyzes a downloaded video, stores the result and points at the frames", async () => {
    const { data, nextSteps } = await runAnalyze({ targets: ["a1code"] });
    expect(data).toMatchObject({ analyzed: 1, skipped: 0, notDownloaded: 0, failed: 0 });
    const item = data.items[0];
    expect(item).toMatchObject({ id: "a1", status: "analyzed", reason: null });
    expect(item?.analysis).toMatchObject({ cuts: 3, cutsPerMin: 3, firstShotSec: 10 });
    expect(item?.analysis?.framesDir).toBe(join(env.ctx.mediaDir, "frames", "a1code"));
    expect(item?.analysis?.frames.map((f) => f.reason)).toEqual(["first", "cut", "cut", "cut"]);
    for (const f of item?.analysis?.frames ?? []) expect(existsSync(f.path)).toBe(true);

    const stored = env.ctx.store.findVideo("a1");
    expect(stored).toMatchObject({
      cuts: 3,
      cutsPerMin: 3,
      durationSec: 60,
      width: 720,
      height: 1280,
      framesDir: item?.analysis?.framesDir,
    });
    expect(stored?.analyzedAt).not.toBeNull();
    expect(nextSteps).toEqual([
      { command: "ig video frames a1code", description: "list the key frames to look at" },
    ]);
  });

  it("accepts a media id and a reel URL, and analyzes a repeated target once", async () => {
    const { data } = await runAnalyze({
      targets: ["a1", "https://www.instagram.com/reel/a2code/", "a1"],
    });
    expect(data.items.map((i) => [i.id, i.status])).toEqual([
      ["a1", "analyzed"],
      ["a2", "analyzed"],
    ]);
  });

  it("names the download command for videos that are not on disk", async () => {
    const { data, nextSteps } = await runAnalyze({ targets: ["a1code", "a4code", "ZZnotStored1"] });
    expect(data).toMatchObject({ analyzed: 1, notDownloaded: 2, failed: 0 });
    expect(data.items.map((i) => i.status)).toEqual([
      "analyzed",
      "not-downloaded",
      "not-downloaded",
    ]);
    expect(nextSteps?.[0]).toEqual({
      command: "ig video download a4code ZZnotStored1",
      description: "download first, then analyze again",
    });
  });

  it("treats a file deleted from disk as not downloaded", async () => {
    rmSync(join(env.ctx.mediaDir, "ana", "a1code.mp4"));
    const { data } = await runAnalyze({ targets: ["a1code"] });
    expect(data.items[0]).toMatchObject({ status: "not-downloaded" });
    expect(data.items[0]?.reason).toContain("gone");
    expect(ff.calls).toHaveLength(0);
  });

  it("skips an analyzed video without running ffmpeg, and --force runs it again", async () => {
    await runAnalyze({ targets: ["a1code"] });
    const before = ff.calls.length;
    const again = await runAnalyze({ targets: ["a1code"] });
    expect(again.data.items[0]).toMatchObject({ status: "skipped" });
    expect(again.data.items[0]?.analysis?.cuts).toBe(3);
    expect(ff.calls).toHaveLength(before);

    ff.cutsFor.a1code = [5];
    const forced = await runAnalyze({ targets: ["a1code"], force: true });
    expect(forced.data.items[0]).toMatchObject({ status: "analyzed" });
    expect(forced.data.items[0]?.analysis?.cuts).toBe(1);
    expect(env.ctx.store.findVideo("a1")?.cuts).toBe(1);
  });

  it("continues past one failure and suggests the doctor", async () => {
    ff.broken = "a2code";
    const { data, nextSteps } = await runAnalyze({ targets: ["a1code", "a2code", "a3code"] });
    expect(data).toMatchObject({ analyzed: 2, failed: 1 });
    expect(data.items[1]).toMatchObject({ status: "failed" });
    expect(data.items[1]?.reason).toContain("Invalid data found");
    expect(env.ctx.store.findVideo("a2")?.analyzedAt).toBeNull();
    expect(nextSteps?.map((s) => s.command)).toContain("ig doctor");
  });

  it("is an error when every video fails", async () => {
    ff.broken = "code";
    const err = await failure(runAnalyze({ targets: ["a1code", "a2code"] }));
    expect(err).toMatchObject({ code: "ANALYSIS_FAILED", exitCode: 1 });
    expect(err.message).toContain("None of the 2 videos");
    expect((err.details as AnalyzeData).items).toHaveLength(2);
  });

  it("passes the options down to ffmpeg and builds the sheet on request", async () => {
    const { data } = await runAnalyze({
      targets: ["a1code"],
      threshold: "0.45",
      maxFrames: "2",
      frameWidth: "320",
      sheet: true,
    });
    const a = data.items[0]?.analysis;
    expect(a?.threshold).toBe(0.45);
    expect(a?.frames).toHaveLength(2);
    expect(a?.sheet).toBe(join(env.ctx.mediaDir, "frames", "a1code", "sheet.jpg"));
    const flat = ff.calls.map((c) => c.args.join(" "));
    expect(flat.some((a) => a.includes("gt(scene,0.450)"))).toBe(true);
    expect(flat.some((a) => a.includes("min(320,iw)"))).toBe(true);
    expect(flat.some((a) => a.includes("tile="))).toBe(true);
  });

  it("merges detections closer than --min-gap", async () => {
    ff.cutsFor.a1code = [10, 10.1, 10.6, 30];
    const tight = await runAnalyze({ targets: ["a1code"] });
    expect(tight.data.items[0]?.analysis?.cuts).toBe(3);
    const wide = await runAnalyze({ targets: ["a1code"], force: true, minGap: 1 });
    expect(wide.data.items[0]?.analysis?.cuts).toBe(2);
  });
});

describe("video analyze: selections", () => {
  it("--niche takes every downloaded video of the niche", async () => {
    const { data, nextSteps } = await runAnalyze({ niche: "cocina" });
    expect(data.items.map((i) => i.id).sort()).toEqual(["a1", "a2", "a3", "b1"]);
    expect(data.analyzed).toBe(4);
    expect(nextSteps?.map((s) => s.command)).toContain("ig niche pace cocina");
  });

  it("--creator and --all-downloaded scope the same way", async () => {
    const one = await runAnalyze({ creator: "@Beto" });
    expect(one.data.items.map((i) => i.id)).toEqual(["b1"]);
    const all = await runAnalyze({ allDownloaded: true });
    expect(all.data.items).toHaveLength(4);
    expect(all.data).toMatchObject({ analyzed: 3, skipped: 1 });
  });

  it("--top ranks first and reports the ones that are not downloaded", async () => {
    const { data, nextSteps } = await runAnalyze({ top: 2, creator: "ana", sort: "recent" });
    expect(data.items).toHaveLength(2);
    const byPlays = await runAnalyze({ top: 4, creator: "ana", sort: "plays" });
    expect(byPlays.data.items.map((i) => i.id)).toEqual(["a1", "a3", "a2", "a4"]);
    expect(byPlays.data.items[3]).toMatchObject({ status: "not-downloaded" });
    expect(byPlays.nextSteps?.[0]?.command).toBe("ig video download a4code");
    expect(nextSteps).toBeDefined();
  });

  it("an empty scope succeeds and says how to get videos", async () => {
    analyzeSeams.deps = { ...analyzeSeams.deps, hasTool: () => false };
    const { data, nextSteps } = await runAnalyze({ niche: "vacio" });
    expect(data.items).toEqual([]);
    expect(nextSteps?.[0]?.command).toBe("ig video download --top 10 --niche vacio");
  });
});

// --- video frames ------------------------------------------------------------

describe("video frames", () => {
  it("lists the frames of an analyzed video", async () => {
    await runAnalyze({ targets: ["a1code"] });
    const { data, nextSteps } = await env.run(frames, { video: "a1code" });
    const d = data as { frames: { file: string; path: string }[]; sheet: string | null };
    expect(data).toMatchObject({ id: "a1", shortcode: "a1code", cuts: 3, firstShotSec: 10 });
    expect(d.frames.map((f) => f.file)).toEqual([
      "frame-01.jpg",
      "frame-02.jpg",
      "frame-03.jpg",
      "frame-04.jpg",
    ]);
    expect(d.sheet).toBeNull();
    expect(nextSteps?.[0]?.command).toBe("ig video analyze a1code --sheet");
  });

  it("offers no sheet step once a sheet exists", async () => {
    await runAnalyze({ targets: ["a1code"], sheet: true });
    const { data, nextSteps } = await env.run(frames, {
      video: "https://www.instagram.com/reel/a1code/",
    });
    expect((data as { sheet: string | null }).sheet).toContain("sheet.jpg");
    expect(nextSteps).toEqual([]);
  });

  it("explains what to run for a video that is not analyzed, not downloaded or unknown", async () => {
    const notAnalyzed = await failure(env.run(frames, { video: "a2code" }));
    expect(notAnalyzed).toMatchObject({ code: "NOT_FOUND" });
    expect(notAnalyzed.hint).toBe("Run `ig video analyze a2code`.");

    const notDownloaded = await failure(env.run(frames, { video: "a4code" }));
    expect(notDownloaded.hint).toContain("ig video download a4code");

    const unknown = await failure(env.run(frames, { video: "ZZnotStored1" }));
    expect(unknown).toMatchObject({ code: "NOT_FOUND" });
    expect(unknown.hint).toContain("ig video download ZZnotStored1");
  });

  it("asks for --force when the frames directory was deleted", async () => {
    const { data } = await runAnalyze({ targets: ["a1code"] });
    rmSync(data.items[0]?.analysis?.framesDir as string, { recursive: true });
    const err = await failure(env.run(frames, { video: "a1code" }));
    expect(err.message).toContain("no longer on disk");
    expect(err.hint).toBe("Run `ig video analyze a1code --force`.");
  });
});

// --- niche pace --------------------------------------------------------------

type PaceData = {
  videos: number;
  downloaded: number;
  analyzed: number;
  notAnalyzed: number;
  notDownloaded: number;
  medianCutsPerMin: number | null;
  medianFirstShotSec: number | null;
  cutsPerMin: {
    label: string;
    videos: number;
    medianPlays: number | null;
    best: string | null;
    medianOutlierScore: number | null;
  }[];
  firstShot: { label: string; videos: number; best: string | null }[];
};

describe("niche pace", () => {
  it("fails on an unknown niche", async () => {
    expect((await failure(env.run(pace, { slug: "nope" }))).code).toBe("NOT_FOUND");
  });

  it("with nothing analyzed, counts what is missing and names the command", async () => {
    const { data, nextSteps } = await env.run(pace, { slug: "cocina" });
    expect(data).toMatchObject({
      niche: "cocina",
      videos: 5,
      downloaded: 4,
      analyzed: 0,
      notAnalyzed: 4,
      notDownloaded: 1,
      medianCutsPerMin: null,
    });
    expect(nextSteps?.map((s) => s.command)).toEqual([
      "ig video analyze --niche cocina",
      "ig video download --top 10 --niche cocina",
    ]);
  });

  it("buckets analyzed videos by cuts per minute and by opening shot", async () => {
    // 60 s each: a1 no cuts, a2 3 cuts (3/min, opens 10 s), a3 30 cuts (30/min, opens 0.5 s).
    ff.cutsFor.a1code = [];
    ff.cutsFor.a3code = Array.from({ length: 30 }, (_, i) => 0.5 + i * 2);
    await runAnalyze({ creator: "ana" });
    const { data, meta, nextSteps } = await env.run(pace, { slug: "cocina" });
    const d = data as PaceData;
    expect(d).toMatchObject({ analyzed: 3, notAnalyzed: 1, notDownloaded: 1 });
    expect(d.medianCutsPerMin).toBe(3);
    expect(d.medianFirstShotSec).toBe(10);

    const rate = Object.fromEntries(d.cutsPerMin.map((b) => [b.label, b]));
    expect(rate["no cuts"]).toMatchObject({
      videos: 1,
      medianPlays: 1000,
      medianOutlierScore: 4,
      best: "a1code",
    });
    expect(rate["under 10/min"]).toMatchObject({ videos: 1, medianPlays: 200, best: "a2code" });
    expect(rate["20 to 40/min"]).toMatchObject({ videos: 1, medianPlays: 300 });
    expect(rate["10 to 20/min"]).toMatchObject({ videos: 0, medianPlays: null, best: null });

    const opening = Object.fromEntries(d.firstShot.map((b) => [b.label, b]));
    expect(opening["under 1s"]).toMatchObject({ videos: 1, best: "a3code" });
    expect(opening["8s and up"]).toMatchObject({ videos: 2, best: "a1code" });

    expect((meta as Meta).note).toContain("Only 3 analyzed");
    expect(nextSteps?.[0]?.description).toContain("1 downloaded video(s)");
  });

  it("still buckets by pace when frames.json is gone, and counts the unknown openings", async () => {
    await runAnalyze({ targets: ["a2code"] });
    rmSync(join(env.ctx.mediaDir, "frames"), { recursive: true });
    const { data, meta } = await env.run(pace, { slug: "cocina" });
    const d = data as PaceData;
    expect(d.cutsPerMin.find((b) => b.label === "under 10/min")?.videos).toBe(1);
    expect(d.firstShot.every((b) => b.videos === 0)).toBe(true);
    expect((meta as Meta).firstShotUnknown).toBe(1);
  });
});

// --- human views -------------------------------------------------------------

describe("human output", () => {
  it("draws one bar per cut on a timeline of fixed width", () => {
    expect(timeline([], 10, 10)).toBe("──────────");
    expect(timeline([2, 5, 9.99], 10, 10)).toBe("──│──│───│");
    expect(timeline([1], null)).toBe("");
    expect(timeline([50], 10, 10)).toBe("─────────│");
  });

  it("prints a compact block per video and a total", async () => {
    const { data } = await runAnalyze({ targets: ["a1code", "a4code"] });
    const { out } = capture(() => analyze.human?.(data, env.ctx, {}));
    expect(out).toContain("ana/a1code");
    expect(out).toContain("3 cuts");
    expect(out).toContain("opening holds");
    expect(out).toContain("│");
    expect(out).toContain("10% silence");
    expect(out).toContain("not downloaded yet");
    expect(out).toContain("1 analyzed, 0 skipped, 1 not downloaded, 0 failed");
    expect(out.split("\n").length).toBeLessThan(14);
  });

  it("strips control characters from upstream text", async () => {
    const hostile = {
      analyzed: 0,
      skipped: 0,
      notDownloaded: 1,
      failed: 0,
      items: [
        {
          id: null,
          shortcode: "x\x1b[31mred",
          creatorUsername: "evil\x07",
          status: "not-downloaded",
          reason: "nope\x1b[2J",
          analysis: null,
        },
      ],
    };
    const { out } = capture(() => analyze.human?.(hostile, env.ctx, {}));
    expect(out).not.toMatch(/\x1b\[31m|\x1b\[2J|\x07/);
  });

  it("renders the frame list and the pace tables", async () => {
    await runAnalyze({ creator: "ana" });
    const listed = await env.run(frames, { video: "a1code" });
    const framesOut = capture(() => frames.human?.(listed.data, env.ctx, {}));
    expect(framesOut.out).toContain("first frame");
    expect(framesOut.out).toContain("after a cut");
    expect(framesOut.out).toContain("frame-04.jpg");

    const paced = await env.run(pace, { slug: "cocina" });
    const paceOut = capture(() => pace.human?.(paced.data, env.ctx, paced.meta ?? {}));
    expect(paceOut.out).toContain("Cuts per minute");
    expect(paceOut.out).toContain("Opening shot");
    expect(paceOut.err).toContain("too few to read a pattern");
  });
});
