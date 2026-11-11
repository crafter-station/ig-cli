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
  const numeric = key === "minRefreshDays" || key.endsWith("dailyBudget");
  cursor[leaf] = numeric ? Number(value) : value;

  const parsed = ConfigSchema.safeParse(next);
  if (!parsed.success) {
    throw new IgError("INVALID_INPUT", `Invalid value for ${key}: ${value}`, {
      hint: z.prettifyError(parsed.error),
    });
  }
  return parsed.data;
}
