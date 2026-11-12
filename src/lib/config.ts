import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { atomicWriteJson } from "../cligentic/foundation/atomic-write.js";
import { IgError } from "./errors.js";
import type { IgPaths } from "./paths.js";

export const BACKEND_NAMES = ["browser", "hiker"] as const;
export const BackendName = z.enum(BACKEND_NAMES);
export type BackendName = z.infer<typeof BackendName>;

const BackendLimits = z.object({
  /** Requests allowed per local calendar day before the backend refuses. */
  dailyBudget: z.number().int().positive(),
  /** Random pause before each request, in milliseconds: [min, max]. */
  delayMs: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
});

export const ConfigSchema = z.object({
  /** Backend used when a command gets no `--backend`. */
  backend: BackendName.default("browser"),
  /** Where downloaded videos go. Defaults to the state directory's `media`. */
  mediaDir: z.string().optional(),
  /**
   * The browser backend refuses to refresh a creator updated more recently
   * than this many days, unless `--force`. Protects the logged-in account.
   */
  minRefreshDays: z.number().min(0).default(5),
  /**
   * Where the browser backend's Chrome window goes. `offscreen` keeps it out
   * of the way; `visible` shows it, which helps when diagnosing a problem.
   * `ig auth login` always shows it.
   */
  browserWindow: z.enum(["offscreen", "visible"]).default("offscreen"),
  /**
   * After an ordinary command, install or update this CLI's agent skill for
   * every agent found in the home directory. `ig skill uninstall` turns it off.
   */
  autoInstallSkill: z.boolean().default(true),
  /**
   * What transcribes downloaded videos. `auto` takes the first usable one:
   * local whisper.cpp (free, private), then ElevenLabs, then OpenAI, whichever
   * has its API key in the environment. API keys never live here.
   */
  transcribeEngine: z.enum(["auto", "whisper-cpp", "openai", "elevenlabs"]).default("auto"),
  /** whisper.cpp binary: a name on PATH or a path. Default: whisper-cli, then whisper-cpp. */
  whisperBin: z.string().optional(),
  /** Path of a whisper.cpp ggml model file, e.g. ggml-small.bin. */
  whisperModel: z.string().optional(),
  /** Model id sent to OpenAI's transcription API. */
  openaiTranscribeModel: z.string().min(1).default("whisper-1"),
  /** Model id sent to ElevenLabs speech-to-text. */
  elevenlabsTranscribeModel: z.string().min(1).default("scribe_v3"),
  /** A transcript's hook is what is said in this many opening seconds. */
  hookSeconds: z.number().positive().max(60).default(3),
  limits: z
    .object({
      browser: BackendLimits.default({ dailyBudget: 400, delayMs: [2500, 6000] }),
      hiker: BackendLimits.default({ dailyBudget: 2000, delayMs: [0, 250] }),
    })
    .default({
      browser: { dailyBudget: 400, delayMs: [2500, 6000] },
      hiker: { dailyBudget: 2000, delayMs: [0, 250] },
    }),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Secrets never live in config.json. The HikerAPI key comes from the
 * environment only.
 */
export const HIKER_KEY_ENV = "HIKERAPI_KEY";
/** Keys of the paid transcription engines. Environment only, like the HikerAPI key. */
export const OPENAI_KEY_ENV = "OPENAI_API_KEY";
export const ELEVENLABS_KEY_ENV = "ELEVENLABS_API_KEY";
/** Overrides `whisperBin` and `whisperModel` for one run. */
export const WHISPER_BIN_ENV = "IG_WHISPER_BIN";
export const WHISPER_MODEL_ENV = "IG_WHISPER_MODEL";

export function loadConfig(paths: IgPaths): Config {
  let raw: unknown = {};
  if (existsSync(paths.configFile)) {
    try {
      raw = JSON.parse(readFileSync(paths.configFile, "utf8"));
    } catch (cause) {
      throw new IgError("INVALID_INPUT", `config.json is not valid JSON: ${paths.configFile}`, {
        hint: "Fix or delete the file, then run `ig config show`.",
        cause,
      });
    }
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new IgError("INVALID_INPUT", `config.json is invalid: ${z.prettifyError(parsed.error)}`, {
      hint: `Edit ${paths.configFile} or set values with \`ig config set <key> <value>\`.`,
    });
  }
  // zod hands back the same default objects on every parse; a copy keeps one
  // Context from seeing another's changes.
  return structuredClone(parsed.data);
}

export function saveConfig(paths: IgPaths, config: Config): void {
  atomicWriteJson(paths.configFile, ConfigSchema.parse(config));
}

/** Keys settable through `ig config set`. Dotted paths into the config object. */
export const SETTABLE_KEYS = [
  "backend",
  "mediaDir",
  "minRefreshDays",
  "browserWindow",
  "autoInstallSkill",
  "transcribeEngine",
  "whisperBin",
  "whisperModel",
  "openaiTranscribeModel",
  "elevenlabsTranscribeModel",
  "hookSeconds",
  "limits.browser.dailyBudget",
  "limits.hiker.dailyBudget",
] as const;

export function setConfigValue(config: Config, key: string, value: string): Config {
  if (!(SETTABLE_KEYS as readonly string[]).includes(key)) {
    throw new IgError("INVALID_INPUT", `Unknown config key: ${key}`, {
      hint: `Settable keys: ${SETTABLE_KEYS.join(", ")}`,
    });
  }
  const next = structuredClone(config) as Record<string, unknown>;
  const parts = key.split(".");
  let cursor = next;
  for (const part of parts.slice(0, -1)) {
    cursor = cursor[part] as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1] as string;
  const numeric = key === "minRefreshDays" || key === "hookSeconds" || key.endsWith("dailyBudget");
  const boolean = key === "autoInstallSkill";
  if (boolean && value !== "true" && value !== "false") {
    throw new IgError("INVALID_INPUT", `Invalid value for ${key}: ${value}`, {
      hint: "Use true or false.",
    });
  }
  cursor[leaf] = boolean ? value === "true" : numeric ? Number(value) : value;

  const parsed = ConfigSchema.safeParse(next);
  if (!parsed.success) {
    throw new IgError("INVALID_INPUT", `Invalid value for ${key}: ${value}`, {
      hint: z.prettifyError(parsed.error),
    });
  }
  return parsed.data;
}
