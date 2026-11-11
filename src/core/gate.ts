// The gate every backend request passes through. It is the proportionate
// version of a killswitch for a read-only tool: nothing here can lose data or
// money directly, but an over-eager run can cost the logged-in account.
//
// Rules:
//   1. A halted backend refuses everything until a human runs `ig auth resume`.
//   2. A backend over its daily budget refuses until local midnight.
//   3. Each request waits a random pause first.
//   4. A block signal halts the backend immediately. There are no retries.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { atomicWriteJson } from "../cligentic/foundation/atomic-write.js";
import type { Store } from "../db/store.js";
import type { BackendName, Config } from "../lib/config.js";
import { IgError } from "../lib/errors.js";

export type HaltReason = "RATE_LIMITED" | "CHECKPOINT";

export type HaltRecord = {
  backend: BackendName;
  reason: HaltReason;
  detail: string;
  at: string;
};

type HaltFile = Partial<Record<BackendName, HaltRecord>>;

export type GateDeps = {
  store: Store;
  config: Config;
  haltFile: string;
  /** Injectable for tests. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function readHalts(haltFile: string): HaltFile {
  if (!existsSync(haltFile)) return {};
  try {
    return JSON.parse(readFileSync(haltFile, "utf8")) as HaltFile;
  } catch {
    // An unreadable halt file must fail closed: treat every backend as halted.
    const at = new Date().toISOString();
    const detail = "halt.json is unreadable";
    return {
      browser: { backend: "browser", reason: "CHECKPOINT", detail, at },
      hiker: { backend: "hiker", reason: "CHECKPOINT", detail, at },
    };
  }
}

export function clearHalt(haltFile: string, backend: BackendName): boolean {
  const halts = readHalts(haltFile);
  if (!halts[backend]) return false;
  delete halts[backend];
  if (Object.keys(halts).length === 0) rmSync(haltFile, { force: true });
  else atomicWriteJson(haltFile, halts);
  return true;
}

export class Gate {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(
    readonly backend: BackendName,
    private readonly deps: GateDeps,
  ) {
    this.sleep = deps.sleep ?? realSleep;
    this.random = deps.random ?? Math.random;
  }

  get budget(): { used: number; limit: number; remaining: number } {
    const limit = this.deps.config.limits[this.backend].dailyBudget;
    const used = this.deps.store.requestsToday(this.backend);
    return { used, limit, remaining: Math.max(0, limit - used) };
  }

  halted(): HaltRecord | null {
    return readHalts(this.deps.haltFile)[this.backend] ?? null;
  }

  /** Throws if the backend may not make a request right now. Costs nothing. */
  check(): void {
    const halt = this.halted();
    if (halt) {
      throw new IgError("HALTED", `Backend "${this.backend}" is halted: ${halt.detail}`, {
        hint: `Check the account by hand first. Then run \`ig auth resume ${this.backend}\`.`,
        details: { ...halt },
      });
    }
    const { used, limit } = this.budget;
    if (used >= limit) {
      throw new IgError(
        "BUDGET_EXHAUSTED",
        `Backend "${this.backend}" used its daily budget (${used}/${limit} requests).`,
        {
          hint: `Wait until tomorrow, switch with \`--backend\`, or raise it: \`ig config set limits.${this.backend}.dailyBudget <n>\`.`,
          details: { used, limit },
        },
      );
    }
  }

  /**
   * Call immediately before every upstream request. Checks the halt marker and
   * budget, counts the request, then waits the configured random pause.
   */
  async before(): Promise<void> {
    this.check();
    this.deps.store.countRequest(this.backend);
    const [min, max] = this.deps.config.limits[this.backend].delayMs;
    const wait = min + Math.floor(this.random() * Math.max(0, max - min));
    if (wait > 0) await this.sleep(wait);
  }

  /**
   * Call when upstream signals a block: HTTP 429, a login or checkpoint
   * redirect, "please wait a few minutes", `feedback_required`. Writes the
   * halt marker and throws. Never returns.
   */
  block(reason: HaltReason, detail: string): never {
    const halts = readHalts(this.deps.haltFile);
    halts[this.backend] = {
      backend: this.backend,
      reason,
      detail,
      at: new Date().toISOString(),
    };
    atomicWriteJson(this.deps.haltFile, halts);
    throw new IgError(reason, `Backend "${this.backend}" was blocked: ${detail}`, {
      hint:
        reason === "CHECKPOINT"
          ? `Open Instagram by hand with that account and clear the challenge. Then run \`ig auth resume ${this.backend}\`.`
          : `Stop for at least an hour. Then run \`ig auth resume ${this.backend}\`.`,
      details: { backend: this.backend, reason },
    });
  }
}
