// The browser backend: a logged-in Chrome reading what Instagram's web app
// loads for itself. What each surface gives, as observed live:
//
//   /<username>/         profile, the 12 latest posts (caption, date, video
//                        URL, no play count), ~80 related accounts
//   /<username>/reels/   reels with play, like and comment counts; 12, then 3
//                        more per scroll. No caption, date or video URL
//   /reel/<code>/        one reel with caption, date, counts and video URL,
//                        no play count
//   search box           a handful of accounts for a keyword
//   keyword results page ~24 mixed posts per page, with authors and video
//                        URLs, no play counts. "#tag" works as a query
//
// So a reel's play count comes from the reels tab and its caption from the
// profile timeline; reels older than the 12 latest posts have no caption
// until they are fetched individually (`ig video download` does that) or the
// timeline is paged further (`--captions`, see captions.ts): scrolling the
// profile grid loads 12 more posts per scroll, with caption, date, video URL
// and sound.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "../../cligentic/foundation/atomic-write.js";
import type { Creator, Video } from "../../core/types.js";
import { IgError } from "../../lib/errors.js";
import type { BackendFactoryDeps, SessionBackend } from "../index.js";
import type {
  BackendStatus,
  CaptionOptions,
  CaptionPass,
  CreatorCandidate,
  ListOptions,
} from "../types.js";
import { pageTimeline, passOf, type TimelineState, timelineState } from "./captions.js";
import {
  candidatesFromChaining,
  candidatesFromSearch,
  mergeTimeline,
  profileFromResponse,
  reelsFromResponse,
  serpFromResponse,
  timelinePageFromResponse,
  videoFromWebInfo,
} from "./normalize.js";
import { OPS, Session } from "./session.js";

type Marker = { userId: string; loggedInAt: string };

const first = (captured: Map<string, unknown[]>, name: string): unknown | undefined =>
  captured.get(name)?.[0];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Scrolls stop here even if `limit` is not reached, so one call cannot drain the budget. */
const MAX_SCROLLS = 30;

class BrowserBackend implements SessionBackend {
  readonly name = "browser" as const;
  private readonly session: Session;
  private readonly markerFile: string;
  /** What was read of each creator's post timeline, by creator id; used to caption reels. */
  private readonly timelines = new Map<string, TimelineState>();
  /** Related accounts per creator id; they arrive with the profile page for free. */
  private readonly related = new Map<string, CreatorCandidate[]>();

  constructor(private readonly deps: BackendFactoryDeps) {
    this.session = new Session(
      deps.paths.browserProfile,
      deps.gate,
      deps.log,
      deps.config.browserWindow,
    );
    // Beside the profile, not inside it: Chrome owns that directory.
    this.markerFile = join(deps.paths.state, "browser-session.json");
  }

  private marker(): Marker | null {
    if (!existsSync(this.markerFile)) return null;
    try {
      return JSON.parse(readFileSync(this.markerFile, "utf8")) as Marker;
    } catch {
      return null;
    }
  }

  /** Answered from disk: no browser is launched and no request is made. */
  async status(): Promise<BackendStatus> {
    const marker = this.marker();
    if (!marker || !this.session.hasProfile) {
      return {
        backend: this.name,
        ready: false,
        account: null,
        detail: "not logged in",
      };
    }
    return {
      backend: this.name,
      ready: true,
      account: null,
      detail: `logged in as user id ${marker.userId} since ${marker.loggedInAt.slice(0, 10)}`,
    };
  }

  async login(opts: { interactive: boolean; timeoutMs: number }): Promise<BackendStatus> {
    if (!opts.interactive) {
      throw new IgError("AUTH_REQUIRED", "Logging in to Instagram needs a person at a terminal.", {
        hint: "Ask the user to run `ig auth login browser` themselves and log in in the window that opens.",
      });
    }
    // Logging in needs the window in front of the person.
    const page = await this.session.open({ visible: true });
    await page.goto("https://www.instagram.com/accounts/login/", {
      waitUntil: "domcontentloaded",
    });
    process.stderr.write(
      "A Chrome window opened. Log in to Instagram there with a SECONDARY account.\n" +
        "This window closes by itself once the login is detected.\n",
    );
    const deadline = Date.now() + opts.timeoutMs;
    let userId: string | null = null;
    while (Date.now() < deadline) {
      userId = await this.session.loggedInUserId();
      if (userId) break;
      await sleep(2000);
    }
    if (!userId) {
      throw new IgError("AUTH_REQUIRED", "No Instagram login was detected before the timeout.", {
        hint: "Run `ig auth login browser` again; use --timeout <seconds> for more time.",
      });
    }
    // Let the post-login redirects and prompts finish so the session is saved.
    await sleep(6000);
    atomicWriteJson(this.markerFile, {
      userId,
      loggedInAt: new Date().toISOString(),
    } satisfies Marker);
    return this.status();
  }

  async logout(): Promise<boolean> {
    await this.session.close();
    const had = this.session.hasProfile || existsSync(this.markerFile);
    rmSync(this.deps.paths.browserProfile, { recursive: true, force: true });
    rmSync(this.markerFile, { force: true });
    return had;
  }

  private requireLogin(): void {
    if (!this.marker() || !this.session.hasProfile) {
      throw new IgError("AUTH_REQUIRED", "The browser backend is not logged in.", {
        hint: "Run `ig auth login browser` in a terminal and log in.",
      });
    }
  }

  async getProfile(username: string): Promise<Creator> {
    this.requireLogin();
    const captured = await this.session.visit(`/${encodeURIComponent(username)}/`, [OPS.profile], {
      settleMs: 2500,
    });
    const profileJson = first(captured, OPS.profile);
    if (profileJson === undefined) {
      // The app only skips this query for a page that does not exist.
      throw new IgError("NOT_FOUND", `No Instagram account named ${username}`, {
        hint: "The account may have been renamed or removed. Check the username.",
      });
    }
    const profile = profileFromResponse(profileJson);

    const timelineJson = first(captured, OPS.timeline);
    // Replaced, not merged: the page was reloaded, so scrolling starts over.
    if (timelineJson !== undefined) {
      this.timelines.set(profile.id, timelineState(timelinePageFromResponse(timelineJson)));
    } else {
      this.timelines.delete(profile.id);
    }
    const relatedJson = first(captured, OPS.related);
    if (relatedJson !== undefined)
      this.related.set(profile.id, candidatesFromChaining(relatedJson));
    return profile;
  }

  /**
   * Scrolls the creator's profile grid for the posts beyond the first 12.
   * One request per scroll; plus one to open the profile when the browser is
   * not already on it, which it is right after `getProfile`.
   */
  async fetchCaptions(
    creator: { id: string; username: string },
    opts: CaptionOptions,
  ): Promise<CaptionPass> {
    this.requireLogin();
    const path = `/${encodeURIComponent(creator.username)}/`;
    let opened: string[] = [];
    let requests = 0;
    const onProfile = this.session.path?.toLowerCase() === path.toLowerCase();
    if (!onProfile || !this.timelines.has(creator.id)) {
      if (opts.maxRequests <= 0) return passOf(undefined, [], 0);
      const profile = await this.getProfile(creator.username);
      requests = 1;
      // A different id means the username now belongs to another account.
      if (profile.id !== creator.id) return passOf(undefined, [], requests);
      opened = [...(this.timelines.get(creator.id)?.videos.keys() ?? [])];
    }
    const state = this.timelines.get(creator.id);
    // No timeline query fired: the account has no posts, or is private.
    if (!state) return passOf(undefined, [], requests);

    const paged = await pageTimeline(
      state,
      { ...opts, maxRequests: opts.maxRequests - requests },
      {
        scroll: () => this.session.scrollFor(OPS.timeline),
        remaining: () => this.deps.gate.budget.remaining,
      },
    );
    return passOf(state, [...opened, ...paged.loaded], requests + paged.requests);
  }

  async listReels(creator: { id: string; username: string }, opts: ListOptions): Promise<Video[]> {
    this.requireLogin();
    const captured = await this.session.visit(`/${encodeURIComponent(creator.username)}/reels/`, [
      OPS.reels,
    ]);
    const firstPage = first(captured, OPS.reels);
    if (firstPage === undefined) {
      if (first(captured, OPS.profile) === undefined) {
        throw new IgError("NOT_FOUND", `No Instagram account named ${creator.username}`);
      }
      // The profile exists but has no reels tab content.
      return [];
    }

    const byId = new Map<string, Video>();
    let page = reelsFromResponse(firstPage, creator);
    for (const v of page.items) byId.set(v.id, v);

    let scrolls = 0;
    while (byId.size < opts.limit && page.hasNext && scrolls < MAX_SCROLLS) {
      scrolls++;
      const more = await this.session.scrollFor(OPS.reelsMore);
      if (more.length === 0) break;
      for (const json of more) {
        page = reelsFromResponse(json, creator);
        for (const v of page.items) byId.set(v.id, v);
      }
    }

    // Pinned reels lead the grid regardless of age; order by date instead.
    const merged = mergeTimeline([...byId.values()], this.timelines.get(creator.id)?.videos);
    merged.sort((a, b) => (b.takenAt ?? "").localeCompare(a.takenAt ?? ""));
    return merged.slice(0, opts.limit);
  }

  async getVideo(shortcode: string): Promise<Video> {
    this.requireLogin();
    await this.session.visit(`/reel/${encodeURIComponent(shortcode)}/`, [], { settleMs: 2500 });
    const marker = "xdt_api__v1__media__shortcode__web_info";
    for (const block of await this.session.embedded(marker)) {
      const video = videoFromWebInfo(block);
      if (video) return video;
    }
    throw new IgError("NOT_FOUND", `No reel with shortcode ${shortcode}`, {
      hint: "It may have been deleted, be private, or not be a video.",
    });
  }

  async searchCreators(query: string, opts: ListOptions): Promise<CreatorCandidate[]> {
    this.requireLogin();
    await this.session.visit("/", [], { settleMs: 2500 });
    const json = await this.session.typeSearch(query);
    if (json === null) {
      throw new IgError(
        "UPSTREAM_CHANGED",
        "Instagram's search box was not found or did not answer.",
        {
          hint: "The web app changed. Try `ig video discover` or `--backend hiker`.",
        },
      );
    }
    return candidatesFromSearch(json).slice(0, opts.limit);
  }

  private async keywordPage(query: string, opts: ListOptions): Promise<Video[]> {
    this.requireLogin();
    const captured = await this.session.visit(
      `/explore/search/keyword/?q=${encodeURIComponent(query)}`,
      [OPS.serp],
    );
    const firstPage = first(captured, OPS.serp);
    if (firstPage === undefined) {
      throw new IgError("UPSTREAM_CHANGED", "Instagram's keyword results did not load.", {
        hint: "The web app changed, or the query is restricted. Try another query or `--backend hiker`.",
      });
    }
    const byId = new Map<string, Video>();
    let page = serpFromResponse(firstPage);
    for (const v of page.items) byId.set(v.id, v);

    let scrolls = 0;
    while (byId.size < opts.limit && page.hasNext && scrolls < MAX_SCROLLS) {
      scrolls++;
      const more = await this.session.scrollFor(OPS.serpMore);
      if (more.length === 0) break;
      for (const json of more) {
        page = serpFromResponse(json);
        for (const v of page.items) byId.set(v.id, v);
      }
    }
    return [...byId.values()].slice(0, opts.limit);
  }

  searchReels(query: string, opts: ListOptions): Promise<Video[]> {
    return this.keywordPage(query, opts);
  }

  hashtagReels(tag: string, opts: ListOptions): Promise<Video[]> {
    return this.keywordPage(`#${tag.replace(/^#/, "")}`, opts);
  }

  async relatedCreators(
    creator: { id: string; username: string },
    opts: ListOptions,
  ): Promise<CreatorCandidate[]> {
    this.requireLogin();
    if (!this.related.has(creator.id)) await this.getProfile(creator.username);
    return (this.related.get(creator.id) ?? []).slice(0, opts.limit);
  }

  close(): Promise<void> {
    return this.session.close();
  }
}

export function createBrowserBackend(deps: BackendFactoryDeps): SessionBackend {
  return new BrowserBackend(deps);
}
