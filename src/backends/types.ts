// The one interface every data source implements. Commands talk to this and
// never to Playwright or HTTP directly, so backends are interchangeable.
//
// Contract for implementers:
//   - Call `gate.before()` immediately before EVERY upstream request.
//   - On a block signal call `gate.block(...)`. Do not retry, do not swallow.
//   - Return normalized entities from core/types. No upstream shapes leak out.
//   - Counts that upstream hides or omits are `null`, never 0.
//   - When upstream returns a shape you cannot parse, throw UPSTREAM_CHANGED
//     naming the endpoint, rather than returning partial or empty data.
//   - A method the backend cannot support throws UNSUPPORTED.

import type { Gate } from "../core/gate.js";
import type { Creator, Video } from "../core/types.js";
import type { BackendName } from "../lib/config.js";

/** A search result before it is checked against the local store. */
export type CreatorCandidate = {
  id: string;
  username: string;
  fullName: string | null;
  followers: number | null;
  isVerified: boolean;
  isPrivate: boolean;
};

export type BackendStatus = {
  backend: BackendName;
  /** True when the backend can make requests right now. */
  ready: boolean;
  /** Logged-in username for session backends; null otherwise or when unknown. */
  account: string | null;
  /** One line a human can act on. */
  detail: string;
};

export type ListOptions = { limit: number };

export interface Backend {
  readonly name: BackendName;

  /**
   * Whether credentials or a session exist. Must not spend budget when it can
   * be answered locally (cookie present, key set).
   */
  status(): Promise<BackendStatus>;

  /** Full profile by username. Throws NOT_FOUND if the account does not exist. */
  getProfile(username: string): Promise<Creator>;

  /** A creator's reels, newest first, up to `limit`. */
  listReels(creator: { id: string; username: string }, opts: ListOptions): Promise<Video[]>;

  /** One video by shortcode, with a fresh `videoUrl`. */
  getVideo(shortcode: string): Promise<Video>;

  /** Accounts matching a keyword. */
  searchCreators(query: string, opts: ListOptions): Promise<CreatorCandidate[]>;

  /** Reels matching a keyword. Play counts may be null on this surface. */
  searchReels(query: string, opts: ListOptions): Promise<Video[]>;

  /** Top reels for a hashtag (without the #). */
  hashtagReels(tag: string, opts: ListOptions): Promise<Video[]>;

  /** Accounts Instagram suggests as similar to this one. */
  relatedCreators(
    creator: { id: string; username: string },
    opts: ListOptions,
  ): Promise<CreatorCandidate[]>;

  /** Releases resources (closes the browser). Safe to call more than once. */
  close(): Promise<void>;
}

export type BackendDeps = {
  gate: Gate;
  /** Progress and diagnostics. Always goes to stderr; silent in machine mode. */
  log: (message: string) => void;
};
