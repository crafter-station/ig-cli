import type { BackendName, Config } from "../lib/config.js";
import type { IgPaths } from "../lib/paths.js";
import type { Backend, BackendDeps, BackendStatus } from "./types.js";

export type BackendFactoryDeps = BackendDeps & { paths: IgPaths; config: Config };

/**
 * Backends that hold credentials implement this too. `ig auth` drives it.
 */
export interface SessionBackend extends Backend {
  /**
   * Establishes credentials. The browser backend opens a visible window and
   * waits for a human to log in; it must fail with AUTH_REQUIRED instead of
   * waiting when `interactive` is false.
   */
  login(opts: { interactive: boolean; timeoutMs: number }): Promise<BackendStatus>;
  /** Forgets local credentials. Returns true if there was something to forget. */
  logout(): Promise<boolean>;
}

/**
 * Loaded on demand: the browser backend pulls in Playwright, which nothing
 * else should pay for.
 */
export async function createBackend(
  name: BackendName,
  deps: BackendFactoryDeps,
): Promise<SessionBackend> {
  switch (name) {
    case "browser": {
      const mod = await import("./browser/index.js");
      return mod.createBrowserBackend(deps);
    }
    case "hiker": {
      const mod = await import("./hiker/index.js");
      return mod.createHikerBackend(deps);
    }
  }
}
