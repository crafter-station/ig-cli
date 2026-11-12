import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AnalyzeDeps,
  analyzeFile,
  analyzeVideos,
  audioArgs,
  DEFAULT_THRESHOLD,
  FRAMES_INDEX,
  FramesIndexSchema,
  frameArgs,
  frameName,
  framesDirFor,
  mergeCuts,
  missingTools,
  parseAudio,
  parseProbe,
  parseScenes,
  pickFrames,
  probeArgs,
  type RunResult,
  readFramesIndex,
  SHEET_FILE,
  sceneArgs,
  sheetArgs,
  sheetLayout,
  shotStats,
  type Tool,
} from "../src/core/analyze.js";
import { Store } from "../src/db/store.js";
import { creator, tempHome, video } from "./helpers.js";

// --- fake ffmpeg -------------------------------------------------------------

const probeJson = (
  over: { duration?: number | null; audio?: boolean; width?: number; height?: number } = {},
): string =>
  JSON.stringify({
    streams: [
      { codec_type: "video", width: over.width ?? 540, height: over.height ?? 960 },
      ...(over.audio === false ? [] : [{ codec_type: "audio" }]),
    ],
    format: over.duration === null ? {} : { duration: String(over.duration ?? 13) },
  });

const sceneOut = (times: number[]): string =>
  times
    .map(
      (t, i) => `frame:${i}    pts:${Math.round(t * 30000)}   pts_time:${t}\nlavfi.scene_score=0.7`,
    )
    .join("\n");

const AUDIO_ERR = [
  "[silencedetect @ 0x1] silence_start: 1",
  "[silencedetect @ 0x1] silence_end: 2.3 | silence_duration: 1.3",
  "[Parsed_volumedetect_1 @ 0x2] mean_volume: -21.1 dB",
  "[Parsed_volumedetect_1 @ 0x2] max_volume: -12.4 dB",
].join("\n");

type Kind = "probe" | "scene" | "audio" | "sheet" | "frame";
type Call = { tool: Tool; args: string[]; kind: Kind };

type FakeConfig = {
  probe: string;
  cuts: number[];
  audioErr: string;
  /** Fail ffprobe when the input path contains this. */
  probeFailFor: string | null;
  audioFails: boolean;
  audioThrows: boolean;
  sheetFails: boolean;
  /** `-ss` values (3 decimals) for which no frame file is written. */
  skipFrames: string[];
};

function fake(over: Partial<FakeConfig> = {}) {
  const config: FakeConfig = {
    probe: probeJson(),
    cuts: [2, 5, 6.5, 9, 11],
    audioErr: AUDIO_ERR,
    probeFailFor: null,
    audioFails: false,
    audioThrows: false,
    sheetFails: false,
    skipFrames: [],
    ...over,
  };
  const calls: Call[] = [];
  const done = (r: Partial<RunResult> = {}): RunResult => ({
    code: 0,
    stdout: "",
    stderr: "",
    ...r,
  });
  const flag = (args: string[], name: string): string => args[args.indexOf(name) + 1] ?? "";
  const run = async (tool: Tool, args: string[]): Promise<RunResult> => {
    const record = (kind: Kind) => calls.push({ tool, args, kind });
    const out = args[args.length - 1] as string;
    if (tool === "ffprobe") {
      record("probe");
      if (config.probeFailFor && flag(args, "-i").includes(config.probeFailFor)) {
        return done({ code: 1, stderr: "some noise\nNo such file or directory\n" });
      }
      return done({ stdout: config.probe });
    }
    if (args.includes("-vf") && flag(args, "-vf").includes("select='gt(scene")) {
      record("scene");
      return done({ stdout: sceneOut(config.cuts) });
    }
    if (args.includes("-af") && flag(args, "-af").includes("silencedetect")) {
      record("audio");
      if (config.audioThrows) throw new Error("spawn failed");
      if (config.audioFails) return done({ code: 1, stderr: "boom" });
      return done({ stderr: config.audioErr });
    }
    if (args.includes("-filter_complex")) {
      record("sheet");
      if (config.sheetFails) return done({ code: 1, stderr: "tile failed" });
      writeFileSync(out, "sheet");
      return done();
    }
    record("frame");
    if (config.skipFrames.includes(flag(args, "-ss"))) return done();
    writeFileSync(out, "jpg");
    return done();
  };
  const deps: AnalyzeDeps = { run, hasTool: () => true };
  const count = (kind: Kind): number => calls.filter((c) => c.kind === kind).length;
  return { config, calls, deps, count };
}

let home: { dir: string; cleanup: () => void };
beforeEach(() => {
  home = tempHome();
});
afterEach(() => home.cleanup());

// --- pure parsing ------------------------------------------------------------

describe("parseProbe", () => {
  it("reads duration, size and audio presence", () => {
    expect(parseProbe(probeJson({ duration: 53.286939, width: 720, height: 1280 }))).toEqual({
      durationSec: 53.287,
      width: 720,
      height: 1280,
      hasVideo: true,
      hasAudio: true,
    });
    expect(parseProbe(probeJson({ audio: false })).hasAudio).toBe(false);
  });

  it("falls back to the stream duration and reports null when unknown", () => {
    const doc = { streams: [{ codec_type: "video", width: 10, height: 20, duration: "4.5" }] };
    expect(parseProbe(JSON.stringify(doc)).durationSec).toBe(4.5);
    expect(parseProbe(probeJson({ duration: null })).durationSec).toBeNull();
  });

  it("swaps width and height for a stream rotated by 90 degrees", () => {
    const side = {
      streams: [
        { codec_type: "video", width: 1280, height: 720, side_data_list: [{ rotation: -90 }] },
      ],
      format: { duration: "5" },
    };
    expect(parseProbe(JSON.stringify(side))).toMatchObject({ width: 720, height: 1280 });
    const tag = {
      streams: [{ codec_type: "video", width: 1280, height: 720, tags: { rotate: "90" } }],
    };
    expect(parseProbe(JSON.stringify(tag))).toMatchObject({ width: 720, height: 1280 });
    const upside = {
      streams: [
        { codec_type: "video", width: 1280, height: 720, side_data_list: [{ rotation: 180 }] },
      ],
    };
    expect(parseProbe(JSON.stringify(upside))).toMatchObject({ width: 1280, height: 720 });
  });

  it("does not take cover art for a video stream", () => {
    const doc = {
      streams: [
        { codec_type: "video", width: 500, height: 500, disposition: { attached_pic: 1 } },
        { codec_type: "audio" },
      ],
      format: { duration: "30" },
    };
    expect(parseProbe(JSON.stringify(doc))).toEqual({
      durationSec: 30,
      width: null,
      height: null,
      hasVideo: false,
      hasAudio: true,
    });
  });

  it("throws on output that is not JSON", () => {
    expect(() => parseProbe("not json")).toThrow(/did not return JSON/);
  });
});

describe("parseScenes", () => {
  it("pairs each timestamp with its score, also with CRLF line ends", () => {
    const out =
      "frame:0    pts:60000   pts_time:2\r\nlavfi.scene_score=0.738012\r\n" +
      "frame:1    pts:150000  pts_time:5.0333\r\nlavfi.scene_score=0.5221\r\n";
    expect(parseScenes(out)).toEqual([
      { timeSec: 2, score: 0.738 },
      { timeSec: 5.033, score: 0.522 },
    ]);
  });

  it("drops a detection at t=0 and sorts by time", () => {
    const out = [
      "frame:0 pts:1 pts_time:7.5",
      "lavfi.scene_score=0.4",
      "frame:1 pts:0 pts_time:0",
      "lavfi.scene_score=0.9",
      "frame:2 pts:2 pts_time:3.25",
      "lavfi.scene_score=0.6",
    ].join("\n");
    expect(parseScenes(out).map((d) => d.timeSec)).toEqual([3.25, 7.5]);
  });

  it("accepts showinfo-style lines that carry only a timestamp", () => {
    const out =
      "[Parsed_showinfo_1 @ 0x1] n:0 pts:1 pts_time:1.5 duration:1\n" +
      "[Parsed_showinfo_1 @ 0x1] n:1 pts:2 pts_time:4.25 duration:1\n";
    expect(parseScenes(out).map((d) => d.timeSec)).toEqual([1.5, 4.25]);
  });

  it("returns nothing for empty output", () => {
    expect(parseScenes("")).toEqual([]);
  });
});

describe("mergeCuts", () => {
  const det = (...times: number[]) => times.map((timeSec) => ({ timeSec, score: 1 }));

  it("counts a burst of high-scoring frames once, at its first frame", () => {
    expect(mergeCuts(det(3.0, 3.033, 3.1, 6.1), 0.25)).toEqual([3.0, 6.1]);
  });

  it("keeps a detection exactly at the minimum gap", () => {
    expect(mergeCuts(det(1, 1.25, 1.4), 0.25)).toEqual([1, 1.25]);
  });

  it("measures the gap from the last kept cut, not the last detection", () => {
    expect(mergeCuts(det(1, 1.2, 1.4), 0.25)).toEqual([1, 1.4]);
  });

  it("keeps everything with a zero gap", () => {
    expect(mergeCuts(det(1, 1.01), 0)).toEqual([1, 1.01]);
    expect(mergeCuts([], 0.25)).toEqual([]);
  });
});

describe("shotStats", () => {
  it("computes pace and shot lengths from cuts and duration", () => {
    expect(shotStats([2, 5, 6.5, 9, 11], 13)).toEqual({
      cuts: 5,
      cutsPerMin: 23.1,
      avgShotSec: 2.17,
      medianShotSec: 2,
      firstShotSec: 2,
    });
  });

  it("treats a video without cuts as one shot", () => {
    expect(shotStats([], 10)).toEqual({
      cuts: 0,
      cutsPerMin: 0,
      avgShotSec: 10,
      medianShotSec: 10,
      firstShotSec: 10,
    });
  });

  it("reports only the count without a duration", () => {
    expect(shotStats([2, 5], null)).toEqual({
      cuts: 2,
      cutsPerMin: null,
      avgShotSec: null,
      medianShotSec: null,
      firstShotSec: 2,
    });
    expect(shotStats([], null).firstShotSec).toBeNull();
  });
});

describe("pickFrames", () => {
  it("takes the first frame and one shortly after each cut", () => {
    expect(pickFrames(13, [2, 5, 6.5, 9, 11], { maxFrames: 12 })).toEqual([
      { timeSec: 0, reason: "first", shot: 1 },
      { timeSec: 2.2, reason: "cut", shot: 2 },
      { timeSec: 5.2, reason: "cut", shot: 3 },
      { timeSec: 6.7, reason: "cut", shot: 4 },
      { timeSec: 9.2, reason: "cut", shot: 5 },
      { timeSec: 11.2, reason: "cut", shot: 6 },
    ]);
  });

  it("lands in the middle of a shot shorter than the usual offset", () => {
    const picks = pickFrames(10, [2, 2.3], { maxFrames: 12 });
    expect(picks.filter((p) => p.reason === "cut")).toEqual([
      { timeSec: 2.15, reason: "cut", shot: 2 },
      { timeSec: 2.5, reason: "cut", shot: 3 },
    ]);
  });

  it("respects the cap, spreading over the cuts and keeping the first and last", () => {
    const cuts = Array.from({ length: 20 }, (_, i) => i + 1);
    const picks = pickFrames(30, cuts, { maxFrames: 5 });
    expect(picks.map((p) => p.timeSec)).toEqual([0, 1.2, 7.2, 14.2, 20.2]);
    expect(picks.map((p) => p.shot)).toEqual([1, 2, 8, 15, 21]);
  });

  it("fills a video without cuts with evenly spaced frames", () => {
    expect(pickFrames(10, [], { maxFrames: 12 })).toEqual([
      { timeSec: 0, reason: "first", shot: 1 },
      { timeSec: 2.5, reason: "interval", shot: 1 },
      { timeSec: 5, reason: "interval", shot: 1 },
      { timeSec: 7.5, reason: "interval", shot: 1 },
    ]);
  });

  it("fills up to four frames when there is a single cut, sorted, with the right shot", () => {
    expect(pickFrames(10, [4], { maxFrames: 12 })).toEqual([
      { timeSec: 0, reason: "first", shot: 1 },
      { timeSec: 2.1, reason: "interval", shot: 1 },
      { timeSec: 4.2, reason: "cut", shot: 2 },
      { timeSec: 7.1, reason: "interval", shot: 2 },
    ]);
  });

  it("never picks a moment in the last tenth of a second", () => {
    const picks = pickFrames(10, [9.95], { maxFrames: 12 });
    expect(Math.max(...picks.map((p) => p.timeSec))).toBeLessThanOrEqual(9.9);
    expect(picks.find((p) => p.reason === "cut")?.timeSec).toBe(9.9);
  });

  it("returns only the first frame when the cap is one", () => {
    expect(pickFrames(13, [2, 5], { maxFrames: 1 })).toEqual([
      { timeSec: 0, reason: "first", shot: 1 },
    ]);
    expect(pickFrames(13, [], { maxFrames: 0 })).toHaveLength(1);
  });

  it("still reaches four frames when a cut sits where a filler would go", () => {
    const picks = pickFrames(13, [4], { maxFrames: 12 });
    expect(picks.map((p) => [p.timeSec, p.reason])).toEqual([
      [0, "first"],
      [4.2, "cut"],
      [6.4, "interval"],
      [8.6, "interval"],
    ]);
  });

  it("adds no filler when the duration is unknown", () => {
    expect(pickFrames(null, [2], { maxFrames: 12 }).map((p) => p.timeSec)).toEqual([0, 2.2]);
  });
});

describe("argument builders", () => {
  it("probeArgs asks for JSON and passes the file after -i", () => {
    const args = probeArgs("C:/m/a b.mp4");
    expect(args.slice(-2)).toEqual(["-i", "C:/m/a b.mp4"]);
    expect(args).toContain("json");
  });

  it("sceneArgs carries the threshold with three decimals and the file as its own argument", () => {
    const file = "C:/media/it's; rm -rf $(x).mp4";
    const args = sceneArgs(file, 0.3);
    expect(args[args.indexOf("-i") + 1]).toBe(file);
    expect(args[args.indexOf("-vf") + 1]).toBe("select='gt(scene,0.300)',metadata=print:file=-");
    expect(args.slice(-3)).toEqual(["-f", "null", "-"]);
    expect(args).toContain("-an");
    expect(args.filter((a) => a.includes(file))).toEqual([file]);
  });

  it("frameArgs seeks, never upscales, and writes exactly the given path", () => {
    const args = frameArgs("in.mp4", 2.2, 540.9, "C:/out/100%/frame-01.jpg");
    expect(args[args.indexOf("-ss") + 1]).toBe("2.200");
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(args[args.indexOf("-i") + 1]).toBe("in.mp4");
    expect(args[args.indexOf("-vf") + 1]).toBe("scale='min(540,iw)':-2");
    expect(args[args.indexOf("-frames:v") + 1]).toBe("1");
    expect(args.slice(-3)).toEqual(["-update", "1", "C:/out/100%/frame-01.jpg"]);
  });

  it("sheetArgs takes every frame as a literal input and tiles them", () => {
    const frames = ["a.jpg", "b.jpg", "c.jpg", "d.jpg", "e.jpg"];
    const args = sheetArgs(frames, "sheet.jpg");
    for (const f of frames) {
      const at = args.indexOf(f);
      expect(args.slice(at - 3, at)).toEqual(["-pattern_type", "none", "-i"]);
    }
    const filter = args[args.indexOf("-filter_complex") + 1] as string;
    expect(filter).toContain("[0:v][1:v][2:v][3:v][4:v]concat=n=5:v=1:a=0");
    expect(filter).toContain("tile=4x2");
    expect(args[args.indexOf("-map") + 1]).toBe("[sheet]");
    expect(args.slice(-3)).toEqual(["-update", "1", "sheet.jpg"]);
  });

  it("sheetLayout picks a grid that holds every frame", () => {
    expect(sheetLayout(1)).toEqual({ cols: 1, rows: 1 });
    expect(sheetLayout(4)).toEqual({ cols: 4, rows: 1 });
    expect(sheetLayout(5)).toEqual({ cols: 4, rows: 2 });
    expect(sheetLayout(12)).toEqual({ cols: 4, rows: 3 });
    expect(sheetLayout(13)).toEqual({ cols: 5, rows: 3 });
    expect(sheetLayout(20)).toEqual({ cols: 5, rows: 4 });
    expect(sheetLayout(24)).toEqual({ cols: 6, rows: 4 });
    expect(sheetLayout(0)).toEqual({ cols: 1, rows: 1 });
  });

  it("audioArgs measures silence and volume without decoding video", () => {
    const args = audioArgs("in.mp4");
    expect(args[args.indexOf("-af") + 1]).toBe("silencedetect=noise=-40dB:d=0.4,volumedetect");
    expect(args).toContain("-vn");
    expect(args).toContain("-nostats");
    // The filters report at info level: the log must not be turned down.
    expect(args).not.toContain("-loglevel");
    expect(args.slice(-3)).toEqual(["-f", "null", "-"]);
  });

  it("frameName is 1-based and zero-padded", () => {
    expect(frameName(0)).toBe("frame-01.jpg");
    expect(frameName(11)).toBe("frame-12.jpg");
  });
});

describe("parseAudio", () => {
  it("sums silences and relates them to the duration", () => {
    const err = [
      "[silencedetect @ 0x1] silence_end: 2.5 | silence_duration: 1.5",
      "[silencedetect @ 0x1] silence_end: 9 | silence_duration: 2.25",
      "[Parsed_volumedetect_1 @ 0x2] mean_volume: -17.9 dB",
      "[Parsed_volumedetect_1 @ 0x2] max_volume: -0.0 dB",
    ].join("\r\n");
    const facts = parseAudio(err, 10);
    expect(facts).toMatchObject({
      hasAudio: true,
      meanVolumeDb: -17.9,
      silenceSec: 3.75,
      silenceRatio: 0.375,
    });
    expect(facts.maxVolumeDb).toBeCloseTo(0);
  });

  it("clamps silence to the duration", () => {
    expect(parseAudio("silence_duration: 12.4", 10)).toMatchObject({
      silenceSec: 10,
      silenceRatio: 1,
    });
  });

  it("reports everything as unknown when ffmpeg printed no measurement", () => {
    expect(parseAudio("", 10)).toEqual({
      hasAudio: true,
      meanVolumeDb: null,
      maxVolumeDb: null,
      silenceSec: null,
      silenceRatio: null,
    });
    expect(parseAudio("mean_volume: -inf dB", 10).meanVolumeDb).toBeNull();
  });

  it("gives no ratio without a duration", () => {
    expect(parseAudio("silence_duration: 2", null)).toMatchObject({
      silenceSec: 2,
      silenceRatio: null,
    });
  });
});

// --- analyzeFile -------------------------------------------------------------

describe("analyzeFile", () => {
  const id = { videoId: "42", shortcode: "abcde" };
  const dirOf = () => join(home.dir, "frames", "abcde");

  it("writes frames and a valid frames.json", async () => {
    const f = fake();
    const index = await analyzeFile("C:/v/in.mp4", dirOf(), id, {}, f.deps);

    expect(index).toMatchObject({
      version: 1,
      videoId: "42",
      shortcode: "abcde",
      source: "C:/v/in.mp4",
      durationSec: 13,
      width: 540,
      height: 960,
      cuts: 5,
      cutsPerMin: 23.1,
      cutTimes: [2, 5, 6.5, 9, 11],
      avgShotSec: 2.17,
      medianShotSec: 2,
      firstShotSec: 2,
      sheet: null,
      threshold: DEFAULT_THRESHOLD,
      framesDir: resolve(dirOf()),
    });
    expect(index.audio).toEqual({
      hasAudio: true,
      meanVolumeDb: -21.1,
      maxVolumeDb: -12.4,
      silenceSec: 1.3,
      silenceRatio: 0.1,
    });
    expect(index.frames.map((x) => x.file)).toEqual([
      "frame-01.jpg",
      "frame-02.jpg",
      "frame-03.jpg",
      "frame-04.jpg",
      "frame-05.jpg",
      "frame-06.jpg",
    ]);
    expect(index.frames[0]).toMatchObject({ timeSec: 0, reason: "first", shot: 1 });
    for (const frame of index.frames) {
      expect(frame.path).toBe(join(resolve(dirOf()), frame.file));
      expect(existsSync(frame.path)).toBe(true);
    }
    expect(existsSync(join(dirOf(), SHEET_FILE))).toBe(false);
    expect(f.count("sheet")).toBe(0);

    const onDisk = JSON.parse(readFileSync(join(dirOf(), FRAMES_INDEX), "utf8"));
    expect(FramesIndexSchema.safeParse(onDisk).success).toBe(true);
    expect(onDisk).toEqual(index);
    expect(Number.isNaN(Date.parse(index.analyzedAt))).toBe(false);
  });

  it("passes options through to ffmpeg", async () => {
    const f = fake();
    const index = await analyzeFile(
      "in.mp4",
      dirOf(),
      id,
      { threshold: 0.45, frameWidth: 320, maxFrames: 3, minGapSec: 4 },
      f.deps,
    );
    const scene = f.calls.find((c) => c.kind === "scene") as Call;
    expect(scene.args[scene.args.indexOf("-vf") + 1]).toContain("gt(scene,0.450)");
    const frame = f.calls.find((c) => c.kind === "frame") as Call;
    expect(frame.args[frame.args.indexOf("-vf") + 1]).toContain("min(320,iw)");
    // minGap 4 merges 5 and 6.5 into one, and 9 and 11 into one.
    expect(index.cutTimes).toEqual([2, 6.5, 11]);
    expect(index.frames).toHaveLength(3);
    expect(index).toMatchObject({ threshold: 0.45, minGapSec: 4 });
  });

  it("builds the contact sheet only when asked", async () => {
    const f = fake();
    const index = await analyzeFile("in.mp4", dirOf(), id, { sheet: true }, f.deps);
    expect(index.sheet).toBe(join(resolve(dirOf()), SHEET_FILE));
    expect(existsSync(index.sheet as string)).toBe(true);
    const sheet = f.calls.find((c) => c.kind === "sheet") as Call;
    for (const frame of index.frames) expect(sheet.args).toContain(frame.path);
  });

  it("makes no audio call for a file without an audio stream", async () => {
    const f = fake({ probe: probeJson({ audio: false }) });
    const index = await analyzeFile("in.mp4", dirOf(), id, {}, f.deps);
    expect(index.audio).toEqual({
      hasAudio: false,
      meanVolumeDb: null,
      maxVolumeDb: null,
      silenceSec: null,
      silenceRatio: null,
    });
    expect(f.count("audio")).toBe(0);
  });

  it("reports audio as unknown when it cannot be measured", async () => {
    const unknown = {
      hasAudio: true,
      meanVolumeDb: null,
      maxVolumeDb: null,
      silenceSec: null,
      silenceRatio: null,
    };
    const failing = fake({ audioFails: true });
    expect((await analyzeFile("in.mp4", dirOf(), id, {}, failing.deps)).audio).toEqual(unknown);
    const throwing = fake({ audioThrows: true });
    expect((await analyzeFile("in.mp4", dirOf(), id, {}, throwing.deps)).audio).toEqual(unknown);
  });

  it("fails with ffprobe's last line and writes nothing", async () => {
    const f = fake({ probeFailFor: "in.mp4" });
    await expect(analyzeFile("in.mp4", dirOf(), id, {}, f.deps)).rejects.toThrow(
      /ffprobe failed: No such file or directory/,
    );
    expect(existsSync(dirOf())).toBe(false);
    expect(f.calls.map((c) => c.kind)).toEqual(["probe"]);
  });

  it("refuses a file without a video stream", async () => {
    const f = fake({ probe: JSON.stringify({ streams: [{ codec_type: "audio" }] }) });
    await expect(analyzeFile("in.mp3", dirOf(), id, {}, f.deps)).rejects.toThrow(/no video stream/);
  });

  it("drops a frame ffmpeg did not write and keeps the numbering contiguous", async () => {
    const f = fake({ skipFrames: ["5.200"] });
    const index = await analyzeFile("in.mp4", dirOf(), id, {}, f.deps);
    expect(index.frames.map((x) => x.file)).toEqual([
      "frame-01.jpg",
      "frame-02.jpg",
      "frame-03.jpg",
      "frame-04.jpg",
      "frame-05.jpg",
    ]);
    expect(index.frames.map((x) => x.timeSec)).toEqual([0, 2.2, 6.7, 9.2, 11.2]);
    expect(index.frames.map((x) => x.shot)).toEqual([1, 2, 4, 5, 6]);
    expect(index.cuts).toBe(5);
    expect(readdirSync(dirOf()).sort()).toEqual([
      "frame-01.jpg",
      "frame-02.jpg",
      "frame-03.jpg",
      "frame-04.jpg",
      "frame-05.jpg",
      FRAMES_INDEX,
    ]);
  });

  it("fails when no frame at all could be exported", async () => {
    const f = fake({ cuts: [], skipFrames: ["0.000", "3.250", "6.500", "9.750"] });
    await expect(analyzeFile("in.mp4", dirOf(), id, {}, f.deps)).rejects.toThrow(
      /exported no frame/,
    );
  });

  it("clears its own files from an earlier run and leaves foreign files alone", async () => {
    mkdirSync(dirOf(), { recursive: true });
    for (const name of ["frame-09.jpg", SHEET_FILE, FRAMES_INDEX, "notes.txt"]) {
      writeFileSync(join(dirOf(), name), "old");
    }
    const f = fake();
    await analyzeFile("in.mp4", dirOf(), id, {}, f.deps);
    expect(existsSync(join(dirOf(), "frame-09.jpg"))).toBe(false);
    expect(existsSync(join(dirOf(), SHEET_FILE))).toBe(false);
    expect(readFileSync(join(dirOf(), "notes.txt"), "utf8")).toBe("old");
    expect(readFileSync(join(dirOf(), FRAMES_INDEX), "utf8")).not.toBe("old");
  });

  it("still succeeds when the sheet cannot be built", async () => {
    const f = fake({ sheetFails: true });
    const index = await analyzeFile("in.mp4", dirOf(), id, { sheet: true }, f.deps);
    expect(index.sheet).toBeNull();
    expect(index.frames).toHaveLength(6);
    expect(f.count("sheet")).toBe(1);
  });

  it("never passes a shell string: the tool name and each argument stay separate", async () => {
    const f = fake();
    await analyzeFile("C:/v/a b & c.mp4", dirOf(), id, { sheet: true }, f.deps);
    for (const call of f.calls) {
      expect(["ffmpeg", "ffprobe"]).toContain(call.tool);
      expect(call.args.every((a) => typeof a === "string")).toBe(true);
    }
    for (const call of f.calls.filter((c) => c.kind !== "sheet")) {
      expect(call.args[call.args.indexOf("-i") + 1]).toBe("C:/v/a b & c.mp4");
    }
  });
});

describe("readFramesIndex", () => {
  const id = { videoId: null, shortcode: "abcde" };

  it("returns null for a missing directory or an invalid file", () => {
    expect(readFramesIndex(join(home.dir, "nope"))).toBeNull();
    const dir = join(home.dir, "bad");
    mkdirSync(dir);
    writeFileSync(join(dir, FRAMES_INDEX), "{not json");
    expect(readFramesIndex(dir)).toBeNull();
    writeFileSync(join(dir, FRAMES_INDEX), JSON.stringify({ version: 2, frames: [] }));
    expect(readFramesIndex(dir)).toBeNull();
  });

  it("rebuilds paths from the directory it is read from", async () => {
    const f = fake();
    const from = join(home.dir, "old", "abcde");
    const index = await analyzeFile("in.mp4", from, id, { sheet: true }, f.deps);
    expect(readFramesIndex(from)).toEqual(index);

    const to = join(home.dir, "moved", "abcde");
    cpSync(from, to, { recursive: true });
    rmSync(join(home.dir, "old"), { recursive: true, force: true });

    const moved = readFramesIndex(to);
    expect(moved?.framesDir).toBe(resolve(to));
    expect(moved?.sheet).toBe(join(resolve(to), SHEET_FILE));
    expect(moved?.frames.map((x) => dirname(x.path))).toEqual(index.frames.map(() => resolve(to)));
    expect(moved?.frames.every((x) => existsSync(x.path))).toBe(true);
    expect(moved?.cutTimes).toEqual(index.cutTimes);
  });

  it("reports no sheet once the sheet file is gone", async () => {
    const dir = join(home.dir, "f", "abcde");
    await analyzeFile("in.mp4", dir, id, { sheet: true }, fake().deps);
    rmSync(join(dir, SHEET_FILE));
    expect(readFramesIndex(dir)?.sheet).toBeNull();
  });

  it("does not follow a frame name that points outside the directory", async () => {
    const dir = join(home.dir, "f", "abcde");
    await analyzeFile("in.mp4", dir, id, {}, fake().deps);
    const file = join(dir, FRAMES_INDEX);
    const doc = JSON.parse(readFileSync(file, "utf8"));
    doc.frames[0].file = "../../secret.jpg";
    writeFileSync(file, JSON.stringify(doc));
    const read = readFramesIndex(dir);
    expect(dirname(read?.frames[0]?.path as string)).toBe(resolve(dir));
  });
});

describe("framesDirFor", () => {
  it("puts frames under <mediaDir>/frames/<shortcode>", () => {
    expect(framesDirFor(home.dir, "De_hEKkuZ-x")).toBe(
      join(resolve(home.dir), "frames", "De_hEKkuZ-x"),
    );
  });

  it("never lets a shortcode steer the path", () => {
    const root = join(resolve(home.dir), "frames");
    for (const hostile of ["../x", "..", ".", "", "a/b\\c", "C:\\evil"]) {
      const dir = framesDirFor(home.dir, hostile);
      expect(dirname(dir)).toBe(root);
      expect(dir).not.toBe(root);
    }
    expect(framesDirFor(home.dir, "../x")).toBe(join(root, ".._x"));
  });
});

// --- analyzeVideos -----------------------------------------------------------

describe("analyzeVideos", () => {
  let store: Store;
  let logs: string[];
  const mediaDir = () => join(home.dir, "media");
  const env = () => ({ store, mediaDir: mediaDir(), log: (m: string) => logs.push(m) });

  /** Stores a video; `file` true writes a dummy mp4 and marks it downloaded. */
  function add(id: string, opts: { file?: boolean; durationSec?: number | null } = {}): string {
    store.upsertVideos([
      video({
        id,
        shortcode: `code${id}`,
        creatorId: "1",
        creatorUsername: "ana",
        durationSec: opts.durationSec === undefined ? 30 : opts.durationSec,
      }),
    ]);
    const path = join(mediaDir(), "ana", `code${id}.mp4`);
    if (opts.file !== false) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "mp4");
      store.markDownloaded(id, path);
    }
    return path;
  }

  beforeEach(() => {
    store = new Store(":memory:");
    store.upsertCreator(creator({ id: "1", username: "ana" }));
    logs = [];
  });
  afterEach(() => store.close());

  it("analyzes a downloaded video and persists the result", async () => {
    add("10", { durationSec: null });
    const f = fake();
    const summary = await analyzeVideos(env(), { targets: ["code10"], force: false }, f.deps);

    expect(summary).toMatchObject({ analyzed: 1, skipped: 0, notDownloaded: 0, failed: 0 });
    const item = summary.items[0];
    expect(item).toMatchObject({
      id: "10",
      shortcode: "code10",
      creatorUsername: "ana",
      status: "analyzed",
      reason: null,
    });
    expect(item?.analysis).toMatchObject({ cuts: 5, cutsPerMin: 23.1, firstShotSec: 2 });
    // The item carries the analysis, not the bookkeeping of frames.json.
    expect(item?.analysis).not.toHaveProperty("version");
    expect(item?.analysis).not.toHaveProperty("source");

    const stored = store.findVideo("10");
    expect(stored).toMatchObject({
      cuts: 5,
      cutsPerMin: 23.1,
      framesDir: framesDirFor(mediaDir(), "code10"),
      durationSec: 13,
      width: 540,
      height: 960,
    });
    expect(stored?.analyzedAt).not.toBeNull();
    expect(readFramesIndex(stored?.framesDir as string)?.videoId).toBe("10");
    expect(logs).toEqual(["1/1 ana/code10 analyzed: 5 cuts, 6 frames"]);
  });

  it("fills only the media facts that were unknown", async () => {
    add("10", { durationSec: 30 });
    await analyzeVideos(env(), { targets: ["10"], force: false }, fake().deps);
    expect(store.findVideo("10")).toMatchObject({ durationSec: 30, width: 540, height: 960 });
  });

  it("accepts stored videos, ids, shortcodes and reel URLs as targets", async () => {
    add("10");
    add("11");
    add("12");
    const f = fake();
    const summary = await analyzeVideos(
      env(),
      {
        targets: [
          store.findVideo("10") as NonNullable<ReturnType<Store["findVideo"]>>,
          "11",
          "https://www.instagram.com/reel/code12/",
        ],
        force: false,
      },
      f.deps,
    );
    expect(summary.items.map((i) => [i.id, i.status])).toEqual([
      ["10", "analyzed"],
      ["11", "analyzed"],
      ["12", "analyzed"],
    ]);
  });

  it("skips an analyzed video without running ffmpeg again", async () => {
    add("10");
    const first = await analyzeVideos(env(), { targets: ["code10"], force: false }, fake().deps);
    const analyzedAt = store.findVideo("10")?.analyzedAt;

    const f = fake({ cuts: [1] });
    const second = await analyzeVideos(env(), { targets: ["code10"], force: false }, f.deps);
    expect(second).toMatchObject({ analyzed: 0, skipped: 1 });
    expect(second.items[0]).toMatchObject({
      status: "skipped",
      reason: "already analyzed; use --force to analyze again",
    });
    expect(second.items[0]?.analysis).toEqual(first.items[0]?.analysis);
    expect(f.calls).toEqual([]);
    expect(store.findVideo("10")?.analyzedAt).toBe(analyzedAt);
  });

  it("builds only the sheet when it is asked for after the analysis", async () => {
    add("10");
    await analyzeVideos(env(), { targets: ["code10"], force: false }, fake().deps);
    const dir = framesDirFor(mediaDir(), "code10");
    expect(readFramesIndex(dir)?.sheet).toBeNull();

    const f = fake();
    const again = await analyzeVideos(
      env(),
      { targets: ["code10"], force: false, options: { sheet: true } },
      f.deps,
    );
    expect(f.calls.map((c) => c.kind)).toEqual(["sheet"]);
    expect(again.items[0]).toMatchObject({ status: "skipped" });
    expect(again.items[0]?.analysis?.sheet).toBe(join(dir, SHEET_FILE));
    expect(readFramesIndex(dir)?.sheet).toBe(join(dir, SHEET_FILE));

    // Already there: a third run does nothing at all.
    const g = fake();
    await analyzeVideos(
      env(),
      { targets: ["code10"], force: false, options: { sheet: true } },
      g.deps,
    );
    expect(g.calls).toEqual([]);
  });

  it("analyzes again with force", async () => {
    add("10");
    await analyzeVideos(env(), { targets: ["code10"], force: false }, fake().deps);
    const f = fake({ cuts: [4] });
    const again = await analyzeVideos(env(), { targets: ["code10"], force: true }, f.deps);
    expect(again.items[0]).toMatchObject({ status: "analyzed" });
    expect(again.items[0]?.analysis?.cutTimes).toEqual([4]);
    expect(f.count("scene")).toBe(1);
    expect(store.findVideo("10")).toMatchObject({ cuts: 1, cutsPerMin: 4.6 });
    // 6 frames before, fewer now: the extra files are gone.
    const dir = framesDirFor(mediaDir(), "code10");
    const left = readdirSync(dir).filter((n) => n.startsWith("frame-"));
    expect(left).toHaveLength(again.items[0]?.analysis?.frames.length as number);
    expect(left.length).toBeLessThan(6);
  });

  it("analyzes again when the stored frames are gone", async () => {
    add("10");
    await analyzeVideos(env(), { targets: ["code10"], force: false }, fake().deps);
    const dir = framesDirFor(mediaDir(), "code10");
    rmSync(join(dir, "frame-03.jpg"));
    const f = fake();
    const again = await analyzeVideos(env(), { targets: ["code10"], force: false }, f.deps);
    expect(again.items[0]).toMatchObject({ status: "analyzed" });
    expect(existsSync(join(dir, "frame-03.jpg"))).toBe(true);
  });

  it("reports videos that are not on disk, with the reason", async () => {
    add("10", { file: false });
    add("11", { file: false });
    store.markDownloaded("11", join(mediaDir(), "ana", "gone.mp4"));
    const f = fake();
    const summary = await analyzeVideos(
      env(),
      { targets: ["code10", "code11", "ZZZZZ99"], force: false },
      f.deps,
    );
    expect(summary).toMatchObject({ analyzed: 0, notDownloaded: 3, failed: 0 });
    expect(summary.items.map((i) => [i.id, i.shortcode, i.status, i.reason])).toEqual([
      ["10", "code10", "not-downloaded", "not downloaded yet"],
      ["11", "code11", "not-downloaded", "the downloaded file is gone; download it again"],
      [null, "ZZZZZ99", "not-downloaded", "not stored locally; download it first"],
    ]);
    expect(summary.items.every((i) => i.analysis === null)).toBe(true);
    expect(f.calls).toEqual([]);
    expect(store.findVideo("10")?.analyzedAt).toBeNull();
  });

  it("fails a target that is neither a stored id nor a shortcode", async () => {
    const summary = await analyzeVideos(env(), { targets: ["!!"], force: false }, fake().deps);
    expect(summary).toMatchObject({ failed: 1, notDownloaded: 0 });
    expect(summary.items[0]).toMatchObject({
      id: null,
      shortcode: "!!",
      status: "failed",
      reason: "not a stored video id, and not a shortcode or reel URL",
    });
  });

  it("goes on after one video fails, and counts every outcome", async () => {
    add("10");
    add("11");
    add("12");
    add("13", { file: false });
    await analyzeVideos(env(), { targets: ["code12"], force: false }, fake().deps);
    logs = [];

    const f = fake({ probeFailFor: "code10" });
    const summary = await analyzeVideos(
      env(),
      { targets: ["code10", "code11", "code12", "code13"], force: false },
      f.deps,
    );
    expect(summary).toMatchObject({ analyzed: 1, skipped: 1, notDownloaded: 1, failed: 1 });
    expect(summary.items.map((i) => i.status)).toEqual([
      "failed",
      "analyzed",
      "skipped",
      "not-downloaded",
    ]);
    expect(summary.items[0]?.reason).toBe("ffprobe failed: No such file or directory");
    expect(summary.items[0]?.analysis).toBeNull();
    expect(store.findVideo("10")).toMatchObject({ cuts: null, analyzedAt: null, framesDir: null });
    expect(store.findVideo("11")?.cuts).toBe(5);
    expect(logs).toHaveLength(4);
    expect(logs[0]).toBe("1/4 ana/code10 failed: ffprobe failed: No such file or directory");
    expect(logs[3]).toBe("4/4 ana/code13 not-downloaded: not downloaded yet");
  });

  it("returns an empty summary for no targets", async () => {
    expect(await analyzeVideos(env(), { targets: [], force: false }, fake().deps)).toEqual({
      analyzed: 0,
      skipped: 0,
      notDownloaded: 0,
      failed: 0,
      items: [],
    });
  });
});

describe("missingTools", () => {
  it("names the tools that cannot be found", () => {
    expect(missingTools({ hasTool: () => true })).toEqual([]);
    expect(missingTools({ hasTool: (tool) => tool === "ffmpeg" })).toEqual(["ffprobe"]);
    expect(missingTools({ hasTool: () => false })).toEqual(["ffmpeg", "ffprobe"]);
  });
});
