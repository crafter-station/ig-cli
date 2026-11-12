import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAppPaths } from "../cligentic/foundation/xdg-paths.js";

export const APP_NAME = "ig-cli";

export type IgPaths = {
  /** Config directory: holds config.json. */
  config: string;
  /** State directory: database, browser profile, halt marker. */
  state: string;
  configFile: string;
  db: string;
  /** Persistent Chrome profile used by the browser backend. Holds the session. */
  browserProfile: string;
  /** Default media directory; `mediaDir` in config overrides it. */
  media: string;
  /** Present while a backend is halted after a block signal. */
  halt: string;
};

/**
 * Every path the CLI touches. `IG_CLI_HOME` relocates all of it, which is how
 * tests and live smoke runs stay out of the real profile.
 */
export function getPaths(): IgPaths {
  const base = getAppPaths(APP_NAME);
  return {
    config: base.config,
    state: base.state,
    configFile: join(base.config, "config.json"),
    db: join(base.state, "ig.db"),
    browserProfile: join(base.state, "browser-profile"),
    media: join(base.state, "media"),
    halt: join(base.state, "halt.json"),
  };
}

export function ensureDirs(paths: IgPaths): void {
  mkdirSync(paths.config, { recursive: true });
  mkdirSync(paths.state, { recursive: true });
}

/**
 * Usernames and shortcodes come from upstream; never let one steer a path.
 * Anything outside [A-Za-z0-9._-] becomes `_`, and a name of only dots too.
 */
export function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_");
  return /^\.*$/.test(cleaned) ? "_" : cleaned;
}
