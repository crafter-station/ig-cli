import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commands } from "../src/commands/index.js";
import { makeTranscriptCommands, toSrt } from "../src/commands/transcript.js";
import { probeArgs, probeFile } from "../src/core/ffmpeg.js";
import {
  AUTO_ORDER,
  extractAudio,
  hookOf,
  resolveEngine,
  type TranscribeDeps,
  type TranscribeSummary,
  transcribeDeps,
} from "../src/core/transcribe.js";
import type { Transcript, Video } from "../src/core/types.js";
import type { CommandDef } from "../src/lib/command.js";
import { ConfigSchema, setConfigValue } from "../src/lib/config.js";
import { IgError } from "../src/lib/errors.js";
import type { Meta } from "../src/lib/output.js";
import type {
  Engine,
  EngineAvailability,
  EngineName,
  EngineResult,
} from "../src/transcribe/types.js";
import { byId, type TestEnv, testEnv } from "./fake-backend.js";
import { creator, video } from "./helpers.js";

let env: TestEnv;
afterEach(async () => {
  vi.restoreAllMocks();
  await env?.cleanup();
});

const ana = creator({ id: "1", username: "ana", followers: 10_000 });
const beto = creator({ id: "2", username: "beto", followers: 100 });

const reel = (id: string, over: Partial<Video> = {}) =>
  video({ id, shortcode: `sc${id}`, creatorId: "1", creatorUsername: "ana", ...over });

const spoken: EngineResult = {
  language: "es",
  text: "Tres errores que arruinan tu pasta. El primero es el agua. Y el segundo, la sal.",
  segments: [
    { start: 0.2, end: 2.4, text: "Tres errores que arruinan tu pasta." },
    { start: 2.9, end: 4.5, text: " El primero es el agua. " },
    { start: 5.0, end: 7.0, text: "Y el segundo, la sal." },
  ],
  model: "fake-1",
};
const silent: EngineResult = { language: null, text: "", segments: [], model: "fake-1" };

type Harness = {
  deps: Partial<TranscribeDeps>;
  /** Every ffmpeg/ffprobe invocation: [bin, ...args]. */
  runs: string[][];
  /** Audio paths handed to the engine, with the options. */
  heard: { path: string; language?: string; existed: boolean }[];
  tempDirs: string[];
  logs: string[];
};

type HarnessOptions = {
  engine?: EngineName;
  usable?: EngineName[];
  /** Result, or an error to throw, per call in order; the last one repeats. */
  results?: (EngineResult | Error)[];
  /** Local paths ffprobe reports as having no audio stream. */
  noAudio?: string[];
  /** Local paths ffprobe cannot read. */
  unreadable?: string[];
  durationSec?: number;
  ffmpeg?: boolean;
};

function harness(opts: HarnessOptions = {}): Harness {
  const h: Harness = { deps: {}, runs: [], heard: [], tempDirs: [], logs: [] };
  const usable = opts.usable ?? [opts.engine ?? "whisper-cpp"];
  const results = opts.results ?? [spoken];
  let call = 0;
  const real = transcribeDeps();
  const engineFor = (name: EngineName): Engine => ({
    name,
    local: name === "whisper-cpp",
    audioFormat: name === "whisper-cpp" ? "wav" : "flac",
    maxBytes: null,
    transcribe: async (path, o) => {
      h.heard.push({ path, language: o.language, existed: existsSync(path) });
      const result = results[Math.min(call++, results.length - 1)] as EngineResult | Error;
      if (result instanceof Error) throw result;
      return result;
    },
  });
  h.deps = {
    env: {},
    hasCommand: () => opts.ffmpeg !== false,
    run: async (bin, args) => {
      h.runs.push([bin, ...args]);
      const target = args[args.length - 1] as string;
      if (bin === "ffprobe") {
        if (opts.unreadable?.includes(target)) {
          return { code: 1, stdout: "", stderr: "moov atom not found\n" };
        }
        const streams = [{ codec_type: "video" }];
        if (!opts.noAudio?.includes(target)) streams.push({ codec_type: "audio" });
        return {
          code: 0,
          stdout: JSON.stringify({ format: { duration: String(opts.durationSec ?? 30) }, streams }),
          stderr: "",
        };
      }
      writeFileSync(target, "audio");
      return { code: 0, stdout: "", stderr: "" };
    },
    makeTempDir: () => {
      const dir = real.makeTempDir();
      h.tempDirs.push(dir);
      return dir;
    },
    availability: (): EngineAvailability[] =>
      AUTO_ORDER.map((name) => ({
        name,
        local: name === "whisper-cpp",
        usable: usable.includes(name),
        detail: usable.includes(name) ? "ready" : "not set up",
        hint: usable.includes(name) ? null : `set up ${name}`,
      })),
    createEngine: (name) => engineFor(name),
  };
  return h;
}

/** Ana with three downloaded reels and one that is not; Beto with one downloaded. */
function setup(h: Harness, stored?: Video[]): { defs: CommandDef[]; paths: Map<string, string> } {
  env = testEnv();
  (env.ctx as { log: (m: string) => void }).log = (m) => h.logs.push(m);
  const { store } = env.ctx;
  store.createNiche({ slug: "cocina", name: "Cocina" });
  store.upsertCreator(ana, { refreshed: false });
  store.upsertCreator(beto, { refreshed: false });
  store.addCreatorToNiche("1", "cocina");
  const videos = stored ?? [
    reel("1", { plays: 1000, durationSec: null }),
    reel("2", { plays: 100 }),
    reel("3", { plays: 100 }),
    reel("4", { plays: 300 }),
    reel("9", { creatorId: "2", creatorUsername: "beto", plays: 50 }),
  ];
  store.upsertVideos(videos);
  const paths = new Map<string, string>();
  const dir = join(env.ctx.paths.state, "media");
  mkdirSync(dir, { recursive: true });
  for (const v of videos) {
    if (v.id === "4") continue;
    const path = join(dir, `${v.shortcode}.mp4`);
    writeFileSync(path, "mp4");
    store.markDownloaded(v.id, path);
    paths.set(v.id, path);
  }
  return { defs: makeTranscriptCommands(h.deps) as CommandDef[], paths };
}

async function transcribe(defs: CommandDef[], input: Record<string, unknown>) {
  const result = await env.run(byId(defs, "video.transcribe"), input);
  return { ...result, data: result.data as TranscribeSummary };
}

async function failure(run: () => Promise<unknown>): Promise<IgError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof IgError) return err;
    throw err;
  }
  throw new Error("expected the command to fail");
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

const human = (def: CommandDef, data: unknown, meta: Meta = {}) =>
  capture(() => def.human?.(data as never, env.ctx, meta));

describe("hook", () => {
  it("is the text of the segments that start inside the window, kept whole", () => {
    expect(hookOf(spoken.segments, 3)).toBe(
      "Tres errores que arruinan tu pasta. El primero es el agua.",
    );
    expect(hookOf(spoken.segments, 1)).toBe("Tres errores que arruinan tu pasta.");
  });

  it("is null when nothing is said that early, and the boundary itself is outside", () => {
    expect(hookOf([{ start: 3, end: 5, text: "tarde" }], 3)).toBeNull();
    expect(hookOf([{ start: 0, end: 1, text: "   " }], 3)).toBeNull();
    expect(hookOf([], 3)).toBeNull();
  });
});

describe("engine selection", () => {
  const config = ConfigSchema.parse({});
  const pick = (usable: EngineName[], requested?: EngineName | "auto", cfg = config) =>
    resolveEngine(cfg, requested, transcribeDeps(harness({ usable }).deps)).name;

  it("auto prefers local whisper, then ElevenLabs, then OpenAI", () => {
    expect(AUTO_ORDER).toEqual(["whisper-cpp", "elevenlabs", "openai"]);
    expect(pick(["openai", "elevenlabs", "whisper-cpp"])).toBe("whisper-cpp");
    expect(pick(["openai", "elevenlabs"])).toBe("elevenlabs");
    expect(pick(["openai"])).toBe("openai");
  });

  it("takes the flag over config, and config over auto", () => {
    const cfg = ConfigSchema.parse({ transcribeEngine: "openai" });
    expect(pick(["openai", "whisper-cpp"], undefined, cfg)).toBe("openai");
    expect(pick(["openai", "whisper-cpp"], "whisper-cpp", cfg)).toBe("whisper-cpp");
    expect(pick(["openai", "whisper-cpp"], "auto", cfg)).toBe("whisper-cpp");
  });

  it("never falls back from an explicit engine to another one", async () => {
    const local = await failure(async () => pick(["openai"], "whisper-cpp"));
    expect(local).toMatchObject({ code: "BACKEND_UNAVAILABLE", hint: "set up whisper-cpp" });
    const api = await failure(async () => pick(["whisper-cpp"], "elevenlabs"));
    expect(api).toMatchObject({ code: "AUTH_REQUIRED", exitCode: 3 });
  });

  it("explains every engine when none is usable", async () => {
    const err = await failure(async () => pick([]));
    expect(err.code).toBe("BACKEND_UNAVAILABLE");
    expect(err.message).toContain("whisper-cpp: not set up");
    expect(err.message).toContain("openai: not set up");
  });
});

describe("ffmpeg", () => {
  it("probes with an argument array and reads duration and audio presence", async () => {
    const h = harness({ durationSec: 12.5, noAudio: ["mute.mp4"] });
    const deps = transcribeDeps(h.deps);
    expect(await probeFile("a b.mp4", deps.run)).toMatchObject({
      durationSec: 12.5,
      hasAudio: true,
    });
    expect(await probeFile("mute.mp4", deps.run)).toMatchObject({
      durationSec: 12.5,
      hasAudio: false,
    });
    expect(h.runs[0]).toEqual(["ffprobe", ...probeArgs("a b.mp4")]);
  });

  it("extracts the first audio stream as mono 16 kHz in the engine's format", async () => {
    const h = harness();
    const deps = transcribeDeps(h.deps);
    const dir = deps.makeTempDir();
    try {
      const wav = await extractAudio("in.mp4", dir, "wav", deps);
      const flac = await extractAudio("in.mp4", dir, "flac", deps);
      expect(wav).toBe(join(dir, "audio.wav"));
      expect(flac).toBe(join(dir, "audio.flac"));
      const args = h.runs[0] as string[];
      expect(args.slice(0, 7)).toEqual([
        "ffmpeg",
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
      ]);
      expect(args.slice(7)).toEqual([
        "in.mp4",
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        wav,
      ]);
      expect(h.runs[1]?.slice(-2)).toEqual(["flac", flac]);
    } finally {
      deps.removeDir(dir);
    }
  });

  it("reports ffmpeg's last line when extraction fails", async () => {
    const deps = transcribeDeps({
      ...harness().deps,
      run: async () => ({ code: 1, stdout: "", stderr: "first\nInvalid data found\n" }),
    });
    await expect(extractAudio("in.mp4", "nowhere", "wav", deps)).rejects.toThrow(
      "ffmpeg could not extract the audio: Invalid data found",
    );
  });
});

describe("video transcribe", () => {
  it("stores text, segments, language and the hook, and removes the temp audio", async () => {
    const h = harness();
    const { defs, paths } = setup(h);
    const { data, nextSteps } = await transcribe(defs, { targets: ["sc1"], language: "ES" });

    expect(data).toMatchObject({
      engine: "whisper-cpp",
      model: "fake-1",
      uploadsAudio: false,
      transcribed: 1,
      noSpeech: 0,
      skipped: 0,
      failed: 0,
      audioSeconds: 30,
      audioMinutes: 0.5,
    });
    expect(data.items).toEqual([
      {
        id: "1",
        shortcode: "sc1",
        creatorUsername: "ana",
        status: "transcribed",
        reason: null,
        durationSec: 30,
        language: "es",
        hook: "Tres errores que arruinan tu pasta. El primero es el agua.",
        words: 16,
      },
    ]);

    const stored = env.ctx.store.getTranscript("sc1") as Transcript;
    expect(stored).toMatchObject({
      videoId: "1",
      language: "es",
      text: spoken.text,
      hook: "Tres errores que arruinan tu pasta. El primero es el agua.",
      engine: "whisper-cpp",
      model: "fake-1",
    });
    expect(stored.segments[1]).toEqual({ start: 2.9, end: 4.5, text: "El primero es el agua." });
    expect(env.ctx.store.findVideo("1")).toMatchObject({ hasTranscript: true, durationSec: 30 });

    // The engine got an extracted file, never the mp4, and it is gone afterwards.
    expect(h.heard).toHaveLength(1);
    expect(h.heard[0]).toMatchObject({ language: "es", existed: true });
    expect(h.heard[0]?.path).toBe(join(h.tempDirs[0] as string, "audio.wav"));
    expect(h.heard[0]?.path).not.toBe(paths.get("1"));
    expect(existsSync(h.tempDirs[0] as string)).toBe(false);
    expect(nextSteps?.map((s) => s.command)).toEqual(["ig video transcript sc1", "ig video hooks"]);
  });

  it("uses --hook-seconds, then hookSeconds from config", async () => {
    const h = harness();
    const { defs } = setup(h);
    const first = await transcribe(defs, { targets: ["sc1"], hookSeconds: 1 });
    expect(first.data.items[0]?.hook).toBe("Tres errores que arruinan tu pasta.");
    env.ctx.config.hookSeconds = 6;
    const second = await transcribe(defs, { targets: ["sc2"] });
    expect(second.data.items[0]?.hook).toBe(spoken.text);
  });

  it("only transcribes downloaded videos and gives the download command for the rest", async () => {
    const h = harness();
    const { defs } = setup(h);
    const { data, nextSteps } = await transcribe(defs, { targets: ["sc4", "sc1", "NOPE123"] });
    expect(data.items.map((i) => [i.shortcode, i.status, i.reason])).toEqual([
      ["sc4", "skipped", "not downloaded; only downloaded videos can be transcribed"],
      ["sc1", "transcribed", null],
      ["NOPE123", "failed", "not in the local database; download it first"],
    ]);
    expect(data.notDownloaded).toEqual(["sc4", "NOPE123"]);
    expect(nextSteps?.[0]).toMatchObject({ command: "ig video download sc4 NOPE123" });
    expect(h.heard).toHaveLength(1);
  });

  it("treats a recorded file that is gone as not downloaded", async () => {
    const h = harness();
    const { defs } = setup(h);
    env.ctx.store.markDownloaded("2", join(env.ctx.paths.state, "gone.mp4"));
    const { data } = await transcribe(defs, { targets: ["sc2"] });
    expect(data.items[0]).toMatchObject({
      status: "skipped",
      reason: "the downloaded file is gone; download it again",
    });
    expect(data.notDownloaded).toEqual(["sc2"]);
  });

  it("skips a video that has a transcript unless --force", async () => {
    const h = harness();
    const { defs } = setup(h);
    await transcribe(defs, { targets: ["sc1"] });
    const again = await transcribe(defs, { targets: ["sc1"] });
    expect(again.data.items[0]).toMatchObject({
      status: "skipped",
      reason: "already transcribed; use --force to redo",
    });
    expect(h.heard).toHaveLength(1);
    const forced = await transcribe(defs, { targets: ["sc1"], force: true });
    expect(forced.data.items[0]?.status).toBe("transcribed");
    expect(h.heard).toHaveLength(2);
  });

  it("stores an empty transcript for a file without an audio stream, without calling the engine", async () => {
    const h = harness({ engine: "openai" });
    const { defs, paths } = setup(h);
    h.deps.run = harness({ noAudio: [paths.get("1") as string] }).deps.run;
    const plan = await transcribe(defs, { targets: ["sc1"], dryRun: true });
    expect(plan.data).toMatchObject({ audioSeconds: 0 });
    expect(plan.data.items[0]).toMatchObject({
      status: "would-transcribe",
      reason: "no audio stream: an empty transcript is stored and nothing is sent",
    });
    const { data } = await transcribe(defs, { targets: ["sc1"] });
    expect(data).toMatchObject({ transcribed: 0, noSpeech: 1, failed: 0, audioSeconds: 0 });
    expect(data.items[0]).toMatchObject({
      status: "no-speech",
      reason: "the file has no audio stream",
      hook: null,
      words: 0,
    });
    expect(h.heard).toHaveLength(0);
    expect(env.ctx.store.getTranscript("sc1")).toMatchObject({
      text: "",
      hook: null,
      segments: [],
      engine: "none",
      model: null,
    });
    // Stored, so the next run does not try again.
    const again = await transcribe(defs, { targets: ["sc1"] });
    expect(again.data.items[0]?.status).toBe("skipped");
  });

  it("stores an empty transcript when the engine hears no speech", async () => {
    const h = harness({ results: [silent] });
    const { defs } = setup(h);
    const { data, nextSteps } = await transcribe(defs, { targets: ["sc1"], language: "es" });
    expect(data).toMatchObject({ transcribed: 0, noSpeech: 1, audioSeconds: 30 });
    expect(data.items[0]).toMatchObject({
      status: "no-speech",
      reason: "no speech detected",
      language: null,
    });
    expect(env.ctx.store.getTranscript("sc1")).toMatchObject({
      text: "",
      hook: null,
      language: null,
      engine: "whisper-cpp",
    });
    expect(nextSteps).toEqual([]);
    const { out } = human(byId(defs, "video.transcribe"), data);
    expect(out).toContain("no speech");
    expect(out).toContain("1 without speech");
  });

  it("--dry-run reports videos and minutes without extracting or calling the engine", async () => {
    const h = harness({ engine: "elevenlabs", durationSec: 90 });
    const { defs } = setup(h);
    const { data, nextSteps } = await transcribe(defs, {
      allDownloaded: true,
      dryRun: true,
      engine: "elevenlabs",
    });
    expect(data).toMatchObject({
      engine: "elevenlabs",
      uploadsAudio: true,
      dryRun: true,
      transcribed: 0,
      audioSeconds: 360,
      audioMinutes: 6,
    });
    expect(data.items.map((i) => i.status)).toEqual(Array(4).fill("would-transcribe"));
    expect(h.heard).toHaveLength(0);
    expect(h.runs.every((r) => r[0] === "ffprobe")).toBe(true);
    expect(env.ctx.store.getTranscript("sc1")).toBeNull();
    expect(nextSteps).toEqual([
      {
        command: "ig video transcribe --all-downloaded --engine elevenlabs",
        description: "run it for real: uploads 6 min of audio to elevenlabs",
      },
    ]);
    const { out } = human(byId(defs, "video.transcribe"), data);
    expect(out).toContain("4 would be transcribed");
    expect(out).toContain("(audio would be uploaded)");
  });

  it("says how much audio goes to a paid provider before the first upload", async () => {
    const h = harness({ engine: "openai", durationSec: 60 });
    setup(h);
    let logsAtFirstCall: string[] = [];
    const create = h.deps.createEngine as NonNullable<TranscribeDeps["createEngine"]>;
    h.deps.createEngine = (name, config, e) => {
      const engine = create(name, config, e);
      return {
        ...engine,
        transcribe: async (path, o) => {
          if (h.heard.length === 0) logsAtFirstCall = [...h.logs];
          return engine.transcribe(path, o);
        },
      };
    };
    const defs = makeTranscriptCommands(h.deps) as CommandDef[];
    const { data } = await transcribe(defs, { creator: "@Ana" });
    expect(logsAtFirstCall).toEqual(["Uploading the audio of 3 videos (3 min) to openai."]);
    expect(data).toMatchObject({ uploadsAudio: true, transcribed: 3, audioMinutes: 3 });
    expect(h.heard.every((c) => c.path.endsWith("audio.flac"))).toBe(true);
    expect(h.logs.at(-1)).toMatch(/^3\/3 ana\/sc\d transcribed$/);
  });

  it("continues past one failure and reports its reason", async () => {
    const h = harness({ results: [new Error("boom\x1b[31m\nsecond line"), spoken] });
    const { defs } = setup(h);
    const { data } = await transcribe(defs, { targets: ["sc1", "sc2"] });
    expect(data.items.map((i) => [i.status, i.reason])).toEqual([
      ["failed", "boom second line"],
      ["transcribed", null],
    ]);
    expect(data).toMatchObject({ transcribed: 1, failed: 1, audioSeconds: 30 });
    expect(env.ctx.store.getTranscript("sc1")).toBeNull();
    expect(h.tempDirs.every((d) => !existsSync(d))).toBe(true);
  });

  it("fails a video ffprobe cannot read", async () => {
    const h = harness();
    const { defs, paths } = setup(h);
    h.deps.run = harness({ unreadable: [paths.get("1") as string] }).deps.run;
    const { data } = await transcribe(defs, { targets: ["sc1", "sc2"] });
    expect(data.items[0]).toMatchObject({
      status: "failed",
      reason: "ffprobe failed: moov atom not found",
    });
    expect(data.items[1]?.status).toBe("transcribed");
  });

  it("is an error when every attempted video fails", async () => {
    const h = harness({ results: [new Error("bad audio")] });
    const { defs } = setup(h);
    const err = await failure(() => transcribe(defs, { targets: ["sc1", "sc2"] }));
    expect(err).toMatchObject({ code: "TRANSCRIBE_FAILED", exitCode: 1 });
    expect(err.message).toContain("None of the 2 videos could be transcribed");
    const unknown = await failure(() => transcribe(defs, { targets: ["NOPE123"] }));
    expect(unknown.hint).toContain("ig video download NOPE123");
  });

  it("ends the batch on a rejected key and keeps what was done", async () => {
    const denied = new IgError("AUTH_REQUIRED", "ElevenLabs rejected the key.", { hint: "fix" });
    const h = harness({ engine: "elevenlabs", results: [spoken, denied] });
    const { defs } = setup(h);
    const err = await failure(() => transcribe(defs, { targets: ["sc1", "sc2", "sc3"] }));
    expect(err).toMatchObject({ code: "AUTH_REQUIRED", exitCode: 3, hint: "fix" });
    const progress = err.details?.progress as TranscribeSummary;
    expect(err.details?.remaining).toBe(2);
    expect(progress.items.map((i) => [i.shortcode, i.status])).toEqual([["sc1", "transcribed"]]);
    expect(progress).toMatchObject({ transcribed: 1, failed: 0, audioSeconds: 30 });
    expect(h.heard).toHaveLength(2);
    expect(env.ctx.store.getTranscript("sc1")).not.toBeNull();
    expect(h.tempDirs.every((d) => !existsSync(d))).toBe(true);
  });

  it("--limit caps the videos transcribed in one run and says how many wait", async () => {
    const h = harness();
    const { defs } = setup(h);
    const { data, nextSteps } = await transcribe(defs, { allDownloaded: true, limit: 2 });
    expect(data).toMatchObject({ transcribed: 2, overLimit: 2 });
    expect(data.items).toHaveLength(2);
    expect(nextSteps?.[0]).toEqual({
      command: "ig video transcribe --all-downloaded --limit 2",
      description: "2 more are waiting",
    });
    const rest = await transcribe(defs, { allDownloaded: true, limit: 5 });
    expect(rest.data).toMatchObject({ transcribed: 2, skipped: 2, overLimit: 0 });
  });

  it("selects with --top through the ranking, and with --niche or --creator", async () => {
    const h = harness();
    const { defs } = setup(h);
    // Ana's median is 200: sc1 is 5.0x, sc4 1.5x (not downloaded).
    const top = await transcribe(defs, { top: 2, niche: "cocina", dryRun: true });
    expect(top.data.items.map((i) => [i.shortcode, i.status])).toEqual([
      ["sc1", "would-transcribe"],
      ["sc4", "skipped"],
    ]);
    expect(top.nextSteps?.map((s) => s.command)).toEqual([
      "ig video download sc4",
      "ig video transcribe --top 2 --niche cocina",
    ]);
    const niche = await transcribe(defs, { niche: "cocina", dryRun: true });
    expect(niche.data.items.map((i) => i.shortcode).sort()).toEqual(["sc1", "sc2", "sc3"]);
    const one = await transcribe(defs, { creator: "beto", dryRun: true });
    expect(one.data.items.map((i) => i.shortcode)).toEqual(["sc9"]);
  });

  it("rejects an empty or contradictory selection, and unknown scopes", async () => {
    const h = harness();
    const { defs } = setup(h);
    expect(await failure(() => transcribe(defs, {}))).toMatchObject({ code: "INVALID_INPUT" });
    expect(await failure(() => transcribe(defs, { targets: ["sc1"], top: 3 }))).toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(await failure(() => transcribe(defs, { top: 3, allDownloaded: true }))).toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(await failure(() => transcribe(defs, { niche: "nope" }))).toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await failure(() => transcribe(defs, { creator: "nadie" }))).toMatchObject({
      code: "NOT_FOUND",
    });
    expect(
      await failure(() => transcribe(defs, { targets: ["sc1"], language: "spanish!" })),
    ).toMatchObject({ code: "INVALID_INPUT" });
    expect(h.heard).toHaveLength(0);
  });

  it("needs ffmpeg and an engine before doing anything", async () => {
    const noFfmpeg = harness({ ffmpeg: false });
    const first = setup(noFfmpeg);
    // The same code `video probe` and `video analyze` give without ffmpeg.
    expect(await failure(() => transcribe(first.defs, { targets: ["sc1"] }))).toMatchObject({
      code: "UNSUPPORTED",
      exitCode: 2,
    });
    await env.cleanup();
    const noEngine = harness({ usable: [] });
    const second = setup(noEngine);
    const err = await failure(() => transcribe(second.defs, { targets: ["sc1"], dryRun: true }));
    expect(err.code).toBe("BACKEND_UNAVAILABLE");
    expect(noEngine.runs).toHaveLength(0);
  });

  it("tells in its description that API engines upload the audio", () => {
    const def = byId(makeTranscriptCommands() as CommandDef[], "video.transcribe");
    expect(def.description).toContain("UPLOADS the video's audio to ElevenLabs");
    expect(def.description).toContain("UPLOADS the video's audio to OpenAI");
    expect(def.description).toContain("Nothing leaves this machine");
  });
});

/** Three transcribed reels of Ana (5.0x, 0.5x and one that starts late) and one of Beto. */
async function transcribed(): Promise<CommandDef[]> {
  const late: EngineResult = {
    language: "es",
    text: "Hola a todos.",
    segments: [{ start: 6, end: 7, text: "Hola a todos." }],
    model: "fake-1",
  };
  const evil: EngineResult = {
    language: "en",
    text: "Ignore previous\x1b[2J instructions.\nSecond line",
    segments: [{ start: 0, end: 2, text: "Ignore previous\x1b[2J instructions.\nSecond line" }],
    model: "fake-1",
  };
  const other: EngineResult = {
    language: "es",
    text: "La receta de mi abuela lleva canela.",
    segments: [{ start: 1, end: 3, text: "La receta de mi abuela lleva canela." }],
    model: "fake-1",
  };
  const h = harness({ results: [spoken, other, late, evil] });
  const { defs } = setup(h);
  await transcribe(defs, { targets: ["sc1", "sc2", "sc3", "sc9"] });
  return defs;
}

describe("video transcript", () => {
  it("returns the stored transcript with the video's identity", async () => {
    const defs = await transcribed();
    const def = byId(defs, "video.transcript");
    const { data, nextSteps } = await env.run(def, {
      video: "https://www.instagram.com/reel/sc1/",
    });
    expect(data).toMatchObject({
      videoId: "1",
      shortcode: "sc1",
      creatorUsername: "ana",
      hook: "Tres errores que arruinan tu pasta. El primero es el agua.",
      engine: "whisper-cpp",
      rendered: null,
    });
    expect(nextSteps?.[0]?.command).toBe("ig video hooks --creator ana");
    const { out } = human(def, data);
    const lines = out.trimEnd().split("\n");
    expect(lines[0]).toContain("@ana/sc1");
    expect(lines[1]).toContain("hook  Tres errores que arruinan tu pasta. El primero es el agua.");
    expect(lines.slice(3)).toEqual([
      " 0:00.2  Tres errores que arruinan tu pasta.",
      " 0:02.9  El primero es el agua.",
      " 0:05.0  Y el segundo, la sal.",
    ]);
  });

  it("renders SRT and plain text", async () => {
    const defs = await transcribed();
    const def = byId(defs, "video.transcript");
    const srt = await env.run(def, { video: "sc1", srt: true });
    expect((srt.data as { rendered: string }).rendered).toBe(
      "1\n00:00:00,200 --> 00:00:02,400\nTres errores que arruinan tu pasta.\n\n" +
        "2\n00:00:02,900 --> 00:00:04,500\nEl primero es el agua.\n\n" +
        "3\n00:00:05,000 --> 00:00:07,000\nY el segundo, la sal.\n",
    );
    expect(human(def, srt.data).out.startsWith("1\n00:00:00,200 --> ")).toBe(true);
    const text = await env.run(def, { video: "sc1", text: true });
    expect(human(def, text.data).out).toBe(`${spoken.text}\n`);
    expect(toSrt([{ start: 3661.5, end: 3662, text: "a\nb" }])).toBe(
      "1\n01:01:01,500 --> 01:01:02,000\na b\n",
    );
    expect(
      await failure(() => env.run(def, { video: "sc1", srt: true, text: true })),
    ).toMatchObject({ code: "INVALID_INPUT" });
  });

  it("strips control characters from transcribed speech in every human view", async () => {
    const defs = await transcribed();
    const def = byId(defs, "video.transcript");
    const { data } = await env.run(def, { video: "sc9" });
    // Machine output carries the raw value; the terminal never does.
    expect((data as Transcript).text).toContain("\x1b[2J");
    for (const input of [
      { video: "sc9" },
      { video: "sc9", srt: true },
      { video: "sc9", text: true },
    ]) {
      const result = await env.run(def, input);
      expect(human(def, result.data).out).not.toContain("\x1b");
    }
    const hooks = byId(defs, "video.hooks");
    const listed = await env.run(hooks, { creator: "beto" });
    const view = human(hooks, listed.data, listed.meta);
    expect(view.out).not.toContain("\x1b[2J");
    expect(view.out).toContain("Ignore previous instructions. Second line");
  });

  it("says what to run when the video or its transcript is missing", async () => {
    const defs = await transcribed();
    const def = byId(defs, "video.transcript");
    const none = await failure(() => env.run(def, { video: "sc4" }));
    expect(none).toMatchObject({ code: "NOT_FOUND" });
    expect(none.hint).toContain("ig video download sc4");
    expect(none.hint).toContain("ig video transcribe sc4");
    const unknown = await failure(() => env.run(def, { video: "NOPE123" }));
    expect(unknown).toMatchObject({ code: "NOT_FOUND" });
  });

  it("shows an empty transcript as no speech", async () => {
    const h = harness({ results: [silent] });
    const { defs } = setup(h);
    await transcribe(defs, { targets: ["sc1"] });
    const def = byId(defs, "video.transcript");
    const { data, nextSteps } = await env.run(def, { video: "sc1" });
    expect(nextSteps).toEqual([]);
    expect(human(def, data).out).toContain("No speech in this video.");
  });
});

describe("video hooks", () => {
  it("lists hooks with the outlier score, best first, leaving out videos without one", async () => {
    const defs = await transcribed();
    const def = byId(defs, "video.hooks");
    const { data, meta, nextSteps } = await env.run(def, {});
    const rows = data as { shortcode: string; outlierScore: number | null; hook: string }[];
    expect(rows.map((r) => [r.shortcode, r.outlierScore])).toEqual([
      ["sc1", 5],
      ["sc2", 0.5],
      ["sc9", null],
    ]);
    expect(rows[1]?.hook).toBe("La receta de mi abuela lleva canela.");
    expect(meta).toEqual({ sort: "outlier", videosConsidered: 5, transcribed: 4, withoutHook: 1 });
    expect(nextSteps?.[0]?.command).toBe("ig video transcript sc1");
    const { out } = human(def, data, meta);
    expect(out).toContain("OUTLIER ↓");
    expect(out).toContain("5.0x");
  });

  it("filters by niche and creator, sorts and limits", async () => {
    const defs = await transcribed();
    const def = byId(defs, "video.hooks");
    const shortcodes = async (input: Record<string, unknown>) =>
      ((await env.run(def, input)).data as { shortcode: string }[]).map((r) => r.shortcode);
    expect(await shortcodes({ niche: "cocina" })).toEqual(["sc1", "sc2"]);
    expect(await shortcodes({ creator: "beto" })).toEqual(["sc9"]);
    expect(await shortcodes({ sort: "plays", limit: 1 })).toEqual(["sc1"]);
    expect(await failure(() => env.run(def, { sort: "likes" }))).toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("points at transcribe when nothing is transcribed", async () => {
    const h = harness();
    const { defs } = setup(h);
    const def = byId(defs, "video.hooks");
    const { data, meta, nextSteps } = await env.run(def, { niche: "cocina" });
    expect(data).toEqual([]);
    expect(nextSteps?.[0]?.command).toBe("ig video transcribe --top 10 --niche cocina");
    expect(human(def, data, meta).err).toContain("No transcripts in this scope yet");
  });
});

describe("video said", () => {
  it("finds what is said, ignoring accents, with the matching passage", async () => {
    const defs = await transcribed();
    const def = byId(defs, "video.said");
    const { data, nextSteps } = await env.run(def, { query: "ABUELA canéla" });
    expect(data).toEqual([
      expect.objectContaining({
        shortcode: "sc2",
        creatorUsername: "ana",
        snippet: "La receta de mi [abuela] lleva [canela].",
        hook: "La receta de mi abuela lleva canela.",
      }),
    ]);
    expect(nextSteps?.[0]?.command).toBe("ig video transcript sc2");
    expect(human(def, data).out).toContain("[abuela]");
  });

  it("scopes to a niche and suggests the caption search when nothing matches", async () => {
    const defs = await transcribed();
    const def = byId(defs, "video.said");
    expect((await env.run(def, { query: "instructions" })).data).toHaveLength(1);
    const scoped = await env.run(def, { query: "instructions", niche: "cocina" });
    expect(scoped.data).toEqual([]);
    expect(scoped.nextSteps?.[0]?.command).toBe('ig video search "instructions"');
    expect(await failure(() => env.run(def, { query: "¿?" }))).toMatchObject({
      code: "INVALID_INPUT",
    });
  });
});

describe("registration, doctor and config", () => {
  it("registers the four commands", () => {
    const ids = commands.map((c) => c.id);
    for (const id of ["video.transcribe", "video.transcript", "video.hooks", "video.said"]) {
      expect(ids).toContain(id);
    }
  });

  it("doctor reports each engine as an optional check, without secrets", async () => {
    env = testEnv();
    const before = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test-secret-value";
    try {
      const { data } = await env.run(byId(commands, "doctor"), {});
      const checks = (
        data as { checks: { name: string; ok: boolean; required: boolean; detail: string }[] }
      ).checks;
      const names = checks.map((c) => c.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "ffmpeg",
          "transcribe:whisper-cpp",
          "transcribe:elevenlabs",
          "transcribe:openai",
        ]),
      );
      const openai = checks.find((c) => c.name === "transcribe:openai");
      expect(openai).toMatchObject({ ok: true, required: false });
      expect(openai?.detail).toContain("uploads audio");
      expect(JSON.stringify(data)).not.toContain("sk-test-secret-value");
    } finally {
      if (before === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = before;
    }
  });

  it("accepts the transcription keys in config and validates them", () => {
    const base = ConfigSchema.parse({});
    expect(base).toMatchObject({ transcribeEngine: "auto", hookSeconds: 3 });
    expect(setConfigValue(base, "transcribeEngine", "elevenlabs").transcribeEngine).toBe(
      "elevenlabs",
    );
    expect(setConfigValue(base, "hookSeconds", "5").hookSeconds).toBe(5);
    expect(setConfigValue(base, "whisperModel", "C:/models/ggml-small.bin").whisperModel).toBe(
      "C:/models/ggml-small.bin",
    );
    expect(() => setConfigValue(base, "transcribeEngine", "google")).toThrow(IgError);
    expect(() => setConfigValue(base, "hookSeconds", "0")).toThrow(IgError);
  });
});
