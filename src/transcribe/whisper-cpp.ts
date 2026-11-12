// Local transcription with the whisper.cpp CLI. Nothing leaves the machine.
//
// Flags, exit codes and the JSON file shape were checked against:
//   https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/examples/cli/cli.cpp
//   https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/README.md
//   https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/models/README.md
// and against `whisper-cli -h` of a January 2026 build.
//
// What `-oj` writes (cli.cpp, output_json), reduced to what is read here:
//   { "result": { "language": "es" },
//     "transcription": [ { "timestamps": { "from": "00:00:00,000", "to": "..." },
//                          "offsets": { "from": 0, "to": 2480 },   // milliseconds
//                          "text": " Hola a todos" } ] }
// The file is `<-of value>.json`: the extension is appended, nothing is stripped.
//
// The binary is found as `whisper-cli` (current name) or `whisper-cpp`. Old
// builds called it `main`; that name is never auto-detected, because a `main`
// on PATH is as likely to be an unrelated program. A legacy binary works only
// when `whisperBin` points at it explicitly.

import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { hasCommand } from "../cligentic/platform/detect.js";
import { WHISPER_BIN_ENV, WHISPER_MODEL_ENV } from "../lib/config.js";
import { IgError } from "../lib/errors.js";
import { oneLine } from "../lib/output.js";
import type { Engine, EngineAvailability, EngineResult, Env } from "./types.js";

export type WhisperCppConfig = { whisperBin?: string; whisperModel?: string };

export type WhisperCppDeps = {
  /** Runs the binary to completion. Rejects only when it cannot be started. */
  run: (bin: string, args: string[]) => Promise<{ code: number; stderr: string }>;
  /** Whether a command name resolves on PATH. */
  hasCommand: (name: string) => boolean;
  /** Whether a path exists and is a regular file. */
  isFile: (path: string) => boolean;
  /** Reads a UTF-8 text file. Throws when it is missing. */
  readFile: (path: string) => string;
};

/** In order of preference. `main` is deliberately absent; see the header. */
const AUTO_BINARIES = ["whisper-cli", "whisper-cpp"] as const;
/** A long video on a CPU-only machine with a large model is slow, not stuck. */
const RUN_TIMEOUT_MS = 30 * 60_000;
const STDERR_TAIL = 4000;

const BIN_HINT =
  "Install whisper.cpp: download a build from https://github.com/ggml-org/whisper.cpp/releases " +
  "or build it from source (https://github.com/ggml-org/whisper.cpp#quick-start), then put " +
  "`whisper-cli` on PATH or run `ig config set whisperBin <path>`. A legacy binary named " +
  "`main` is never picked up on its own: point whisperBin at it.";

const MODEL_HINT =
  "Download a ggml model, with whisper.cpp's `models/download-ggml-model.sh small` " +
  "(`models\\download-ggml-model.cmd small` on Windows) or from " +
  "https://huggingface.co/ggerganov/whisper.cpp/tree/main, then run " +
  "`ig config set whisperModel <path-to-ggml-model.bin>`.";

/**
 * Runs whisper.cpp with an argument array, never a shell string, so nothing in
 * a path or a language hint is interpreted. Only the tail of stderr is kept:
 * a model load can print a lot and only the last line explains a failure.
 */
export function runWhisperCpp(
  bin: string,
  args: string[],
): Promise<{ code: number; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(bin, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
      timeout: RUN_TIMEOUT_MS,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-STDERR_TAIL);
    });
    child.on("error", fail);
    child.on("close", (code, signal) => {
      if (code !== null) return done({ code, stderr });
      // No exit code means it was killed; the timeout is the usual reason.
      done({ code: -1, stderr: `${stderr}\nkilled by ${signal ?? "a signal"} (timeout?)` });
    });
  });
}

const defaults: WhisperCppDeps = {
  run: runWhisperCpp,
  hasCommand,
  isFile: (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  readFile: (path) => readFileSync(path, "utf8"),
};

/** Unknown keys are ignored: whisper.cpp adds fields between releases. */
const OutputSchema = z.object({
  result: z.object({ language: z.string().nullish() }).nullish(),
  transcription: z.array(
    z.object({
      offsets: z.object({ from: z.number(), to: z.number() }),
      text: z.string(),
    }),
  ),
});

/**
 * Whisper labels what is not speech: [BLANK_AUDIO], [MUSIC], (music),
 * [ Silence ], or a row of music notes. A segment made only of such
 * annotations says nothing.
 */
const NON_SPEECH = /^(?:\s*(?:\[[^\]]*\]|\([^)]*\)|[♪♫]+)\s*)+$/;

type Resolved =
  | { ok: true; bin: string; model: string }
  | { ok: false; what: "binary" | "model"; detail: string; hint: string };

/** A value with a directory part is a path; a bare word is looked up on PATH. */
const looksLikePath = (value: string): boolean => isAbsolute(value) || /[\\/]/.test(value);

function resolve(cfg: WhisperCppConfig, env: Env, deps: WhisperCppDeps): Resolved {
  const explicitBin = env[WHISPER_BIN_ENV]?.trim() || cfg.whisperBin?.trim() || null;
  let bin: string | null;
  if (explicitBin) {
    const found = looksLikePath(explicitBin)
      ? deps.isFile(explicitBin)
      : deps.hasCommand(explicitBin);
    if (!found) {
      return {
        ok: false,
        what: "binary",
        detail: `whisperBin "${oneLine(explicitBin)}" was not found`,
        hint: BIN_HINT,
      };
    }
    bin = explicitBin;
  } else {
    bin = AUTO_BINARIES.find((name) => deps.hasCommand(name)) ?? null;
    if (!bin) {
      return {
        ok: false,
        what: "binary",
        detail: `no whisper.cpp binary on PATH (looked for ${AUTO_BINARIES.join(", ")})`,
        hint: BIN_HINT,
      };
    }
  }

  const model = env[WHISPER_MODEL_ENV]?.trim() || cfg.whisperModel?.trim() || null;
  if (!model) {
    return {
      ok: false,
      what: "model",
      detail: `${bin} found, but no model is configured`,
      hint: MODEL_HINT,
    };
  }
  if (!deps.isFile(model)) {
    return {
      ok: false,
      what: "model",
      detail: `${bin} found, but the model file does not exist: ${oneLine(model)}`,
      hint: MODEL_HINT,
    };
  }
  return { ok: true, bin, model };
}

export function whisperCppAvailability(
  cfg: WhisperCppConfig,
  env: Env,
  deps: Partial<WhisperCppDeps> = {},
): EngineAvailability {
  const found = resolve(cfg, env, { ...defaults, ...deps });
  const base = { name: "whisper-cpp", local: true } as const;
  if (!found.ok) return { ...base, usable: false, detail: found.detail, hint: found.hint };
  return {
    ...base,
    usable: true,
    detail: `${found.bin} with ${basename(found.model)}`,
    hint: null,
  };
}

/** Turns the parsed `-oj` file into the engine contract. */
function toResult(output: z.infer<typeof OutputSchema>, model: string): EngineResult {
  const segments = [];
  for (const row of output.transcription) {
    const text = row.text.trim();
    if (!text || NON_SPEECH.test(text)) continue;
    const start = row.offsets.from / 1000;
    segments.push({ start, end: Math.max(start, row.offsets.to / 1000), text });
  }
  return {
    language: output.result?.language?.trim().toLowerCase() || null,
    text: segments.map((segment) => segment.text).join(" "),
    segments,
    model: basename(model),
  };
}

export function createWhisperCppEngine(
  cfg: WhisperCppConfig,
  env: Env,
  overrides: Partial<WhisperCppDeps> = {},
): Engine {
  const deps: WhisperCppDeps = { ...defaults, ...overrides };
  return {
    name: "whisper-cpp",
    local: true,
    audioFormat: "wav",
    maxBytes: null,
    async transcribe(audioPath, opts) {
      // Resolved per call, not at creation: the binary or the model can go
      // away between `ig doctor` and the transcription.
      const found = resolve(cfg, env, deps);
      if (!found.ok) {
        throw new IgError("BACKEND_UNAVAILABLE", `whisper.cpp is not usable: ${found.detail}`, {
          hint: found.hint,
        });
      }

      // Beside the audio, in the caller's temp directory, which the caller
      // deletes. whisper.cpp appends ".json" to this.
      const outBase = join(
        dirname(audioPath),
        `${basename(audioPath, extname(audioPath))}.whisper`,
      );
      const outFile = `${outBase}.json`;
      // Without -l whisper.cpp assumes English instead of detecting.
      const language = opts.language?.trim().toLowerCase() || "auto";
      const args = [
        "-m",
        found.model,
        "-f",
        audioPath,
        "-l",
        language,
        "-oj",
        "-of",
        outBase,
        "-np",
      ];

      let run: { code: number; stderr: string };
      try {
        run = await deps.run(found.bin, args);
      } catch (cause) {
        const why = oneLine(cause instanceof Error ? cause.message : String(cause));
        throw new IgError("BACKEND_UNAVAILABLE", `Could not start ${found.bin}: ${why}`, {
          hint: BIN_HINT,
          cause,
        });
      }
      if (run.code !== 0) {
        const last = oneLine(run.stderr.trim().split(/\r?\n/).pop());
        throw new IgError(
          "INTERNAL",
          `whisper.cpp failed: ${last || `exited with code ${run.code}`}`,
          {
            hint:
              "Check that whisperModel is a valid ggml model and the audio is 16-bit WAV. " +
              `To see the full output, run: ${found.bin} -m <model> -f <audio.wav>`,
            details: { exitCode: run.code },
          },
        );
      }

      const changed = (why: string, cause?: unknown): IgError =>
        new IgError("UPSTREAM_CHANGED", `whisper.cpp ${why}`, {
          hint:
            "This whisper.cpp build may not support `-oj`/`-of` as expected. " +
            "Update whisper.cpp, or point whisperBin at a current `whisper-cli`.",
          details: { outputFile: outFile },
          cause,
        });

      let raw: string;
      try {
        raw = deps.readFile(outFile);
      } catch (cause) {
        throw changed("exited cleanly but wrote no JSON output", cause);
      }
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch (cause) {
        throw changed("wrote JSON output that does not parse", cause);
      }
      const parsed = OutputSchema.safeParse(json);
      if (!parsed.success) {
        throw changed(
          `wrote JSON in an unexpected shape: ${oneLine(z.prettifyError(parsed.error))}`,
        );
      }
      return toResult(parsed.data, found.model);
    },
  };
}
