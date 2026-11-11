import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearHalt, Gate } from "../src/core/gate.js";
import { Store } from "../src/db/store.js";
import { ConfigSchema } from "../src/lib/config.js";
import type { IgError } from "../src/lib/errors.js";
import { tempHome } from "./helpers.js";

let store: Store;
let home: ReturnType<typeof tempHome>;
let haltFile: string;
let slept: number[];

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    return (err as IgError).code;
  }
  return "none";
};

function gate(budget = 3) {
  const config = ConfigSchema.parse({
    limits: { browser: { dailyBudget: budget, delayMs: [1000, 3000] } },
  });
  return new Gate("browser", {
    store,
    config,
    haltFile,
    sleep: async (ms) => void slept.push(ms),
    random: () => 0.5,
  });
}

beforeEach(() => {
  store = new Store(":memory:");
  home = tempHome();
  haltFile = join(home.dir, "halt.json");
  slept = [];
});
afterEach(() => {
  store.close();
  home.cleanup();
});

describe("Gate", () => {
  it("counts each request and pauses within the configured range", async () => {
    const g = gate();
    await g.before();
    await g.before();
    expect(g.budget).toEqual({ used: 2, limit: 3, remaining: 1 });
    expect(slept).toEqual([2000, 2000]);
  });

  it("refuses once the daily budget is spent, without counting further", async () => {
    const g = gate(2);
    await g.before();
    await g.before();
    await expect(g.before()).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED" });
    expect(g.budget.used).toBe(2);
  });

  it("block() halts the backend for every later gate until resumed", async () => {
    const g = gate();
    expect(code(() => g.block("RATE_LIMITED", "HTTP 429"))).toBe("RATE_LIMITED");
    expect(existsSync(haltFile)).toBe(true);

    const later = gate();
    await expect(later.before()).rejects.toMatchObject({ code: "HALTED" });
    expect(later.budget.used).toBe(0);

    expect(clearHalt(haltFile, "browser")).toBe(true);
    expect(clearHalt(haltFile, "browser")).toBe(false);
    expect(existsSync(haltFile)).toBe(false);
    await expect(later.before()).resolves.toBeUndefined();
  });

  it("halting one backend leaves the other usable", () => {
    code(() => gate().block("CHECKPOINT", "challenge"));
    const hiker = new Gate("hiker", { store, config: ConfigSchema.parse({}), haltFile });
    expect(() => hiker.check()).not.toThrow();
  });

  it("fails closed when the halt file is corrupt", () => {
    writeFileSync(haltFile, "{not json");
    expect(code(() => gate().check())).toBe("HALTED");
  });
});
