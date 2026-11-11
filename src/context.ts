// Per-invocation runtime: paths, config, the store, and backends. Everything
// is created lazily so `ig schema` never opens the database and `ig niche list`
// never launches a browser.

import { resolve } from "node:path";
import { createBackend } from "./backends/index.js";
import type { Backend } from "./backends/types.js";
import type { OutputMode } from "./cligentic/platform/detect.js";
import { Gate } from "./core/gate.js";
import { Store } from "./db/store.js";
import { type BackendName, type Config, loadConfig } from "./lib/config.js";
import { ensureDirs, getPaths, type IgPaths } from "./lib/paths.js";

export type GlobalOptions = {
  json?: boolean;
  quiet?: boolean;
  fields?: string;
  params?: string;
};

export class Context {
  readonly paths: IgPaths;
  private _config?: Config;
  private _store?: Store;
  private readonly backends = new Map<BackendName, Backend>();

  constructor(
    readonly mode: OutputMode,
    readonly options: GlobalOptions,
    /** Diagnostics to stderr. Silent in machine mode and under --quiet. */
    readonly log: (message: string) => void,
  ) {
    this.paths = getPaths();
  }

  get config(): Config {
    this._config ??= loadConfig(this.paths);
    return this._config;
  }

  /** Call after writing config.json so later reads see the new values. */
  reloadConfig(): Config {
    this._config = loadConfig(this.paths);
    return this._config;
  }

  get store(): Store {
    if (!this._store) {
      ensureDirs(this.paths);
      this._store = new Store(this.paths.db);
    }
    return this._store;
  }

  /** Absolute directory downloads go to. */
  get mediaDir(): string {
    return this.config.mediaDir ? resolve(this.config.mediaDir) : this.paths.media;
  }

  gate(name: BackendName): Gate {
    return new Gate(name, { store: this.store, config: this.config, haltFile: this.paths.halt });
  }

  /**
   * The backend to use: the explicit name, else the configured default.
   * Instances are cached for the invocation and closed by `close()`.
   */
  async backend(name?: BackendName): Promise<Backend> {
    const resolved = name ?? this.config.backend;
    const cached = this.backends.get(resolved);
    if (cached) return cached;
    ensureDirs(this.paths);
    const backend = await createBackend(resolved, {
      gate: this.gate(resolved),
      log: this.log,
      paths: this.paths,
      config: this.config,
    });
    this.backends.set(resolved, backend);
    return backend;
  }

  async close(): Promise<void> {
    for (const backend of this.backends.values()) {
      try {
        await backend.close();
      } catch {
        // Closing is best-effort; the command's own result already stands.
      }
    }
    this.backends.clear();
    this._store?.close();
    this._store = undefined;
  }
}
