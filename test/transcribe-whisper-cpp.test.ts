import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IgError } from "../src/lib/errors.js";
import {
  createWhisperCppEngine,
  type WhisperCppDeps,
  whisperCppAvailability,
} from "../src/transcribe/whisper-cpp.js";

const MODEL = join("models", "ggml-small.bin");
const AUDIO = join("tmp", "ig-x", "audio.wav");
const OUT_BASE = join("tmp", "ig-x", "audio.whisper");
const OUT_FILE = `${OUT_BASE}.json`;

type Call = { bin: string; args: string[] };

/** A machine described by what is on PATH, which files exist and what a run does. */
function machine(
  over: {
    onPath?: string[];
    files?: string[];
    output?: unknown;
    rawOutput?: string | null;
    code?: number;
    stderr?: string;
    runError?: Error;
  } = {},
) {
  const calls: Call[] = [];
  const onPath = over.onPath ?? ["whisper-cli"];
  const files = over.files ?? [MODEL];
  const raw =
    over.rawOutput !== undefined
      ? over.rawOutput
      : JSON.stringify(over.output ?? { transcription: [] });
  const deps: WhisperCppDeps = {
    hasCommand: (name) => onPath.includes(name),
    isFile: (path) => files.includes(path),
    run: async (bin, args) => {
      calls.push({ bin, args });
      if (over.runError) throw over.runError;
      return { code: over.code ?? 0, stderr: over.stderr ?? "" };
    },
    readFile: (path) => {
      if (raw === null || path !== OUT_FILE) throw new Error(`ENOENT: ${path}`);
      return raw;
    },
  };
  return { deps, calls };
}

const seg = (from: number, to: number, text: string) => ({
  timestamps: { from: "00:00:00,000", to: "00:00:01,000" },
  offsets: { from, to },
  text,
});

async function failure(promise: Promise<unknown>): Promise<IgError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(IgError);
    return err as IgError;
  }
  throw new Error("expected a rejection");
}

describe("whisperCppAvailability", () => {
  it("is unusable without a binary and says how to get one", () => {
    const { deps } = machine({ onPath: [] });
    const a = whisperCppAvailability({ whisperModel: MODEL }, {}, deps);
    expect(a).toMatchObject({ name: "whisper-cpp", local: true, usable: false });
    expect(a.detail).toContain("whisper-cli, whisper-cpp");
    expect(a.hint).toContain("github.com/ggml-org/whisper.cpp/releases");
    expect(a.hint).toContain("ig config set whisperBin <path>");
    expect(a.hint).toContain("`main`");
  });

  it("never picks up a binary called main on its own", () => {
    const { deps } = machine({ onPath: ["main"] });
    expect(whisperCppAvailability({ whisperModel: MODEL }, {}, deps).usable).toBe(false);
  });

  it("uses main when whisperBin names it explicitly", () => {
    const { deps } = machine({ onPath: ["main"] });
    const a = whisperCppAvailability({ whisperBin: "main", whisperModel: MODEL }, {}, deps);
    expect(a).toMatchObject({ usable: true, detail: "main with ggml-small.bin", hint: null });
  });

  it("falls back to whisper-cpp when whisper-cli is absent", () => {
    const { deps } = machine({ onPath: ["whisper-cpp"] });
    const a = whisperCppAvailability({ whisperModel: MODEL }, {}, deps);
    expect(a.detail).toBe("whisper-cpp with ggml-small.bin");
  });

  it("requires an explicit binary path to exist, without falling back to PATH", () => {
    const bin = join("opt", "whisper", "whisper-cli");
    const missing = machine();
    const a = whisperCppAvailability({ whisperBin: bin, whisperModel: MODEL }, {}, missing.deps);
    expect(a.usable).toBe(false);
    expect(a.detail).toContain("was not found");

    const present = machine({ onPath: [], files: [bin, MODEL] });
    const b = whisperCppAvailability({ whisperBin: bin, whisperModel: MODEL }, {}, present.deps);
    expect(b.usable).toBe(true);
  });

  it("is unusable without a model and names the exact fix", () => {
    const { deps } = machine();
    const a = whisperCppAvailability({}, {}, deps);
    expect(a.usable).toBe(false);
    expect(a.detail).toContain("no model is configured");
    expect(a.hint).toContain("ig config set whisperModel <path-to-ggml-model.bin>");
    expect(a.hint).toContain("download-ggml-model");
    expect(a.hint).toContain("huggingface.co/ggerganov/whisper.cpp");
  });

  it("is unusable when the model path does not exist", () => {
    const { deps } = machine({ files: [] });
    const a = whisperCppAvailability({ whisperModel: MODEL }, {}, deps);
    expect(a.usable).toBe(false);
    expect(a.detail).toContain("does not exist");
    expect(a.detail).toContain("ggml-small.bin");
    expect(a.hint).toContain("ig config set whisperModel");
  });

  it("is usable with a binary and a model", () => {
    const { deps } = machine();
    expect(whisperCppAvailability({ whisperModel: MODEL }, {}, deps)).toEqual({
      name: "whisper-cpp",
      local: true,
      usable: true,
      detail: "whisper-cli with ggml-small.bin",
      hint: null,
    });
  });

  it("lets the environment override the config", () => {
    const envModel = join("env", "ggml-large-v3.bin");
    const { deps } = machine({ onPath: ["whisper-cli", "my-whisper"], files: [envModel] });
    const a = whisperCppAvailability(
      { whisperBin: "whisper-cli", whisperModel: MODEL },
      { IG_WHISPER_BIN: "my-whisper", IG_WHISPER_MODEL: envModel },
      deps,
    );
    expect(a).toMatchObject({ usable: true, detail: "my-whisper with ggml-large-v3.bin" });
  });
});

describe("createWhisperCppEngine", () => {
  it("describes itself as a local wav engine without a size limit", () => {
    const engine = createWhisperCppEngine({ whisperModel: MODEL }, {}, machine().deps);
    expect(engine).toMatchObject({
      name: "whisper-cpp",
      local: true,
      audioFormat: "wav",
      maxBytes: null,
    });
  });

  it("detects the language when there is no hint", async () => {
    const { deps, calls } = machine();
    await createWhisperCppEngine({ whisperModel: MODEL }, {}, deps).transcribe(AUDIO, {});
    expect(calls).toEqual([
      {
        bin: "whisper-cli",
        args: ["-m", MODEL, "-f", AUDIO, "-l", "auto", "-oj", "-of", OUT_BASE, "-np"],
      },
    ]);
  });

  it("passes the language hint and the binary from the environment", async () => {
    const { deps, calls } = machine({ onPath: ["my-whisper"] });
    const engine = createWhisperCppEngine(
      { whisperModel: MODEL },
      { IG_WHISPER_BIN: "my-whisper" },
      deps,
    );
    await engine.transcribe(AUDIO, { language: " ES " });
    expect(calls[0]?.bin).toBe("my-whisper");
    expect(calls[0]?.args).toEqual([
      "-m",
      MODEL,
      "-f",
      AUDIO,
      "-l",
      "es",
      "-oj",
      "-of",
      OUT_BASE,
      "-np",
    ]);
  });

  it("maps the JSON file to seconds, trimmed text and a lowercase language", async () => {
    const { deps } = machine({
      output: {
        systeminfo: "AVX = 1",
        model: { type: "small" },
        params: { language: "auto" },
        result: { language: "ES" },
        transcription: [
          seg(0, 2480, " Hola a todos."),
          seg(2480, 5000, " [MUSIC]"),
          seg(5000, 7250, " Hoy vamos a ver (risas) tres cosas. "),
        ],
      },
    });
    const result = await createWhisperCppEngine({ whisperModel: MODEL }, {}, deps).transcribe(
      AUDIO,
      {},
    );
    expect(result).toEqual({
      language: "es",
      text: "Hola a todos. Hoy vamos a ver (risas) tres cosas.",
      segments: [
        { start: 0, end: 2.48, text: "Hola a todos." },
        { start: 5, end: 7.25, text: "Hoy vamos a ver (risas) tres cosas." },
      ],
      model: "ggml-small.bin",
    });
  });

  it("returns nothing, not an error, when only non-speech markers come back", async () => {
    const { deps } = machine({
      output: {
        result: { language: "en" },
        transcription: [
          seg(0, 1000, " [BLANK_AUDIO]"),
          seg(1000, 2000, " [MUSIC]"),
          seg(2000, 3000, " (music)"),
          seg(3000, 4000, " [ Silence ]"),
          seg(4000, 5000, " [MUSIC] (applause)"),
          seg(5000, 6000, " ♪♪"),
          seg(6000, 7000, "   "),
        ],
      },
    });
    const result = await createWhisperCppEngine({ whisperModel: MODEL }, {}, deps).transcribe(
      AUDIO,
      {},
    );
    expect(result).toEqual({ language: "en", text: "", segments: [], model: "ggml-small.bin" });
  });

  it("returns empty text and a null language for an empty transcription", async () => {
    const { deps } = machine({ output: { transcription: [] } });
    const result = await createWhisperCppEngine({ whisperModel: MODEL }, {}, deps).transcribe(
      AUDIO,
      {},
    );
    expect(result).toEqual({ language: null, text: "", segments: [], model: "ggml-small.bin" });
  });

  it("throws BACKEND_UNAVAILABLE without running when the binary is missing", async () => {
    const { deps, calls } = machine({ onPath: [] });
    const err = await failure(
      createWhisperCppEngine({ whisperModel: MODEL }, {}, deps).transcribe(AUDIO, {}),
    );
    expect(err.code).toBe("BACKEND_UNAVAILABLE");
    expect(err.hint).toContain("ig config set whisperBin <path>");
    expect(calls).toEqual([]);
  });

  it("throws BACKEND_UNAVAILABLE without running when the model is missing", async () => {
    for (const cfg of [{}, { whisperModel: join("gone", "ggml-base.bin") }]) {
      const { deps, calls } = machine();
      const err = await failure(createWhisperCppEngine(cfg, {}, deps).transcribe(AUDIO, {}));
      expect(err.code).toBe("BACKEND_UNAVAILABLE");
      expect(err.hint).toContain("ig config set whisperModel <path-to-ggml-model.bin>");
      expect(calls).toEqual([]);
    }
  });

  it("throws BACKEND_UNAVAILABLE when the binary cannot be started", async () => {
    const { deps } = machine({ runError: new Error("spawn whisper-cli ENOENT") });
    const err = await failure(
      createWhisperCppEngine({ whisperModel: MODEL }, {}, deps).transcribe(AUDIO, {}),
    );
    expect(err.code).toBe("BACKEND_UNAVAILABLE");
    expect(err.message).toContain("ENOENT");
  });

  it("turns a non-zero exit into INTERNAL with the last stderr line, on one line", async () => {
    const { deps } = machine({
      code: 3,
      stderr:
        "whisper_init_from_file: loading model\r\nerror: failed to\tinitialize \u001b[31mwhisper context\n",
    });
    const err = await failure(
      createWhisperCppEngine({ whisperModel: MODEL }, {}, deps).transcribe(AUDIO, {}),
    );
    expect(err.code).toBe("INTERNAL");
    expect(err.message).toContain("error: failed to initialize");
    expect(err.message).not.toContain("loading model");
    expect(err.message).not.toMatch(/[\r\n\t\u001b]/);
    expect(err.hint).toBeTruthy();
    expect(err.details).toEqual({ exitCode: 3 });
  });

  it("names the exit code when stderr is empty", async () => {
    const { deps } = machine({ code: 11 });
    const err = await failure(
      createWhisperCppEngine({ whisperModel: MODEL }, {}, deps).transcribe(AUDIO, {}),
    );
    expect(err.code).toBe("INTERNAL");
    expect(err.message).toContain("exited with code 11");
  });

  it("throws UPSTREAM_CHANGED when no JSON file was written", async () => {
    const { deps } = machine({ rawOutput: null });
    const err = await failure(
      createWhisperCppEngine({ whisperModel: MODEL }, {}, deps).transcribe(AUDIO, {}),
    );
    expect(err.code).toBe("UPSTREAM_CHANGED");
    expect(err.hint).toBeTruthy();
  });

  it("throws UPSTREAM_CHANGED when the JSON does not parse", async () => {
    const { deps } = machine({ rawOutput: '{ "transcription": [' });
    const err = await failure(
      createWhisperCppEngine({ whisperModel: MODEL }, {}, deps).transcribe(AUDIO, {}),
    );
    expect(err.code).toBe("UPSTREAM_CHANGED");
  });

  it("throws UPSTREAM_CHANGED when the JSON has another shape", async () => {
    for (const output of [{ segments: [] }, { transcription: [{ text: "hola" }] }]) {
      const { deps } = machine({ rawOutput: JSON.stringify(output) });
      const err = await failure(
        createWhisperCppEngine({ whisperModel: MODEL }, {}, deps).transcribe(AUDIO, {}),
      );
      expect(err.code).toBe("UPSTREAM_CHANGED");
    }
  });
});
