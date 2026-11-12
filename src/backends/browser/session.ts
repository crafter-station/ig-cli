// Drives a real, visible Chrome on a dedicated persistent profile and records
// the JSON the Instagram web app requests for itself. Nothing here builds a
// request: pages are opened and scrolled as a person would, and the app's own
// GraphQL responses are read by their `x-fb-friendly-name`. That keeps the
// backend independent of query ids, which Instagram rotates.

import { existsSync } from "node:fs";
import type { BrowserContext, Page, Response } from "playwright-core";
import type { Gate } from "../../core/gate.js";
import { IgError } from "../../lib/errors.js";
import { blockSignal, isTimelinePayload } from "./normalize.js";

export const ORIGIN = "https://www.instagram.com";

/** GraphQL operations this backend reads, by friendly name. */
export const OPS = {
  profile: "PolarisProfilePageContentQuery",
  timeline: "PolarisProfilePostsQuery",
  related: "PolarisProfileSuggestedUsersWithPreloadableQuery",
  reels: "PolarisProfileReelsTabContentQuery",
  reelsMore: "PolarisProfileReelsTabContentQuery_connection",
  accountSearch: "PolarisSearchBoxRefetchableQuery",
  serp: "PolarisKeywordSearchExplorePageRelayQuery",
  serpMore: "PolarisKeywordSearchExplorePageRelayPaginationQuery",
} as const;

const WATCHED = new Set<string>(Object.values(OPS));

/**
 * Scrolling the profile grid loads further timeline pages through a
 * pagination query of the same family (observed live:
 * `PolarisProfilePostsTabContentQuery_connection`). Any query of the family
 * whose payload is a timeline page is filed under `OPS.timeline`, so a rename
 * of the pagination query alone does not break paging.
 */
const TIMELINE_FAMILY = "PolarisProfilePosts";

// Still a real, headed Chrome, only parked where it does not cover the user's
// work. Chrome stops rendering windows it believes nobody can see, and a page
// that is not rendering does not load more items on scroll, so that detection
// is switched off for this window.
const OFFSCREEN_ARGS = [
  "--window-position=-32000,-32000",
  "--window-size=1280,900",
  "--disable-features=CalculateNativeWinOcclusion",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
];

export type Captured = Map<string, unknown[]>;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class Session {
  private context?: BrowserContext;
  private page?: Page;
  private captured: Captured = new Map();
  private rateLimited = false;
  private refusal: ReturnType<typeof blockSignal> = null;

  constructor(
    private readonly profileDir: string,
    private readonly gate: Gate,
    private readonly log: (message: string) => void,
    private readonly window: "offscreen" | "visible" = "offscreen",
  ) {}

  get hasProfile(): boolean {
    return existsSync(this.profileDir);
  }

  /** Path of the page the browser is on, or null before the first visit. */
  get path(): string | null {
    if (!this.page) return null;
    try {
      return new URL(this.page.url()).pathname;
    } catch {
      return null;
    }
  }

  /** Launches Chrome on first use. */
  async open(opts: { visible?: boolean } = {}): Promise<Page> {
    if (this.page) return this.page;
    const offscreen = this.window === "offscreen" && !opts.visible;
    let chromium: typeof import("playwright-core").chromium;
    try {
      ({ chromium } = await import("playwright-core"));
    } catch (cause) {
      throw new IgError(
        "BACKEND_UNAVAILABLE",
        "The browser backend needs the playwright-core package.",
        {
          hint: "Reinstall ig-cli, or use `--backend hiker`.",
          cause,
        },
      );
    }
    try {
      this.context = await chromium.launchPersistentContext(this.profileDir, {
        channel: "chrome",
        headless: false,
        viewport: null,
        args: [
          "--disable-blink-features=AutomationControlled",
          ...(offscreen ? OFFSCREEN_ARGS : []),
        ],
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const inUse = /already in use|ProcessSingleton|user data directory/i.test(message);
      throw new IgError(
        "BACKEND_UNAVAILABLE",
        inUse
          ? "The ig-cli Chrome profile is already open in another window or process."
          : "Could not start Google Chrome.",
        {
          hint: inUse
            ? "Close that Chrome window (or wait for the other ig command) and retry."
            : "Install Google Chrome, then run `ig doctor`.",
          cause,
        },
      );
    }
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    this.page.on("response", (res) => void this.record(res));
    return this.page;
  }

  private async record(res: Response): Promise<void> {
    const url = res.url();
    if (!url.startsWith(ORIGIN)) return;
    const isApi = /\/(api\/graphql|graphql\/query|api\/v1\/)/.test(url);
    if (!isApi) return;
    if (res.status() === 429) {
      this.rateLimited = true;
      return;
    }
    const sent = res.request().headers()["x-fb-friendly-name"];
    if (!sent) return;
    const family = !WATCHED.has(sent) && sent.startsWith(TIMELINE_FAMILY);
    if (!WATCHED.has(sent) && !family) return;
    try {
      const json: unknown = await res.json();
      this.refusal ??= blockSignal(json);
      if (family && !isTimelinePayload(json)) return;
      const name = family ? OPS.timeline : sent;
      if (family) this.log(`timeline page from ${sent}`);
      const list = this.captured.get(name) ?? [];
      list.push(json);
      this.captured.set(name, list);
    } catch {
      // A body that is gone or not JSON is simply not captured; the caller
      // reports the missing operation.
    }
  }

  /** Halts the backend if Instagram pushed back on the last action. Never retries. */
  private async assertNotBlocked(): Promise<void> {
    const page = this.page;
    if (!page) return;
    const url = page.url();
    if (/\/(challenge|accounts\/suspended|accounts\/disabled|checkpoint)/.test(url)) {
      this.gate.block("CHECKPOINT", "Instagram redirected to an account challenge page");
    }
    if (this.rateLimited) this.gate.block("RATE_LIMITED", "Instagram answered HTTP 429");
    if (this.refusal) this.gate.block(this.refusal.reason, this.refusal.detail);
    if (/\/accounts\/login/.test(url)) {
      throw new IgError(
        "AUTH_REQUIRED",
        "The Instagram session has expired or was never created.",
        {
          hint: "Run `ig auth login browser` in a terminal and log in.",
        },
      );
    }
  }

  private async waitFor(names: string[], timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (names.every((n) => (this.captured.get(n)?.length ?? 0) > 0)) return true;
      if (this.rateLimited || this.refusal) return false;
      await sleep(150);
    }
    return false;
  }

  /**
   * Opens a page (one budgeted request) and returns what the app loaded.
   * Waits for every operation in `need`; the caller decides what a missing one
   * means, since "profile query never fired" is how a non-existent account
   * looks.
   */
  async visit(path: string, need: string[], opts: { settleMs?: number } = {}): Promise<Captured> {
    const page = await this.open();
    await this.gate.before();
    this.captured = new Map();
    this.log(`open ${path}`);
    try {
      await page.goto(`${ORIGIN}${path}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    } catch (cause) {
      throw new IgError("NETWORK", `Could not load instagram.com${path}`, {
        hint: "Check the connection and retry.",
        cause,
      });
    }
    await this.waitFor(need, 20_000);
    // Secondary operations (timeline, related accounts) land just after.
    await sleep(opts.settleMs ?? 1500);
    await this.assertNotBlocked();
    return this.captured;
  }

  /**
   * Scrolls down once (one budgeted request) and waits for a new response of
   * `name`. Returns the new payloads, empty when nothing more loaded.
   */
  async scrollFor(name: string): Promise<unknown[]> {
    const page = await this.open();
    await this.gate.before();
    const before = this.captured.get(name)?.length ?? 0;
    await page.mouse.wheel(0, 2600);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if ((this.captured.get(name)?.length ?? 0) > before) break;
      if (this.rateLimited || this.refusal) break;
      await sleep(150);
    }
    await sleep(600);
    await this.assertNotBlocked();
    return (this.captured.get(name) ?? []).slice(before);
  }

  /**
   * Types into Instagram's own search box (one budgeted request) and returns
   * the account results the app fetched for the full query.
   */
  async typeSearch(query: string): Promise<unknown | null> {
    const page = await this.open();
    await this.gate.before();
    this.captured.delete(OPS.accountSearch);
    const icon = page
      .locator('svg[aria-label="Search"], svg[aria-label="Buscar"], svg[aria-label="Búsqueda"]')
      .first();
    if ((await icon.count()) === 0) return null;
    await icon.click();
    const input = page
      .locator(
        'input[aria-label*="earch"], input[aria-label*="usca"], input[aria-label*="úsqueda"], input[placeholder*="earch"], input[placeholder*="usca"]',
      )
      .first();
    try {
      await input.waitFor({ state: "visible", timeout: 5000 });
    } catch {
      return null;
    }
    this.log(`search "${query}"`);
    await input.pressSequentially(query, { delay: 110 + Math.floor(Math.random() * 60) });
    await this.waitFor([OPS.accountSearch], 10_000);
    // Typing fires intermediate lookups; the last response is the full query.
    await sleep(1800);
    await this.assertNotBlocked();
    const all = this.captured.get(OPS.accountSearch) ?? [];
    return all.length > 0 ? all[all.length - 1] : null;
  }

  /** Parsed `<script type="application/json">` blocks whose text contains `marker`. */
  async embedded(marker: string): Promise<unknown[]> {
    const page = await this.open();
    // Passed as source text: this project compiles without DOM types.
    const blocks = (await page.evaluate(
      `[...document.querySelectorAll('script[type="application/json"]')]
        .map((s) => s.textContent || "")
        .filter((t) => t.includes(${JSON.stringify(marker)}))`,
    )) as string[];
    const out: unknown[] = [];
    for (const text of blocks) {
      try {
        out.push(JSON.parse(text));
      } catch {
        // Not JSON after all; skip it.
      }
    }
    return out;
  }

  /** The logged-in user id from the session cookies, or null when logged out. */
  async loggedInUserId(): Promise<string | null> {
    if (!this.context) return null;
    const cookies = await this.context.cookies(ORIGIN);
    const has = (name: string) => cookies.find((c) => c.name === name && c.value)?.value ?? null;
    return has("sessionid") ? has("ds_user_id") : null;
  }

  async close(): Promise<void> {
    const context = this.context;
    this.context = undefined;
    this.page = undefined;
    if (context) await context.close();
  }
}
