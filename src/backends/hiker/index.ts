// HikerAPI backend: public Instagram data over a paid HTTP API.
//
// Endpoint choices (why each one, and what is verified against which
// document) are recorded in test/fixtures/hiker/README.md. In short: where a
// typed v1 endpoint exists it is preferred, because its response is a schema
// in the provider's OpenAPI document rather than a pass-through dictionary.
//
// Cost: every method is one request, except the paginated ones, which make one
// request per page and stop as soon as `limit` is met.

import type { Video } from "../../core/types.js";
import { HIKER_KEY_ENV } from "../../lib/config.js";
import type { BackendFactoryDeps, SessionBackend } from "../index.js";
import type { BackendStatus, CreatorCandidate, ListOptions } from "../types.js";
import { HIKER_SIGNUP_URL, HikerClient, missingKeyError } from "./client.js";
import {
  normalizeUser,
  normalizeVideo,
  type Page,
  parseAccountsPage,
  parseBalance,
  parseClipsChunk,
  parseHashtagPage,
  parseReelsSearchPage,
  parseSuggestedProfiles,
  type ReelsCursor,
  upstreamChanged,
} from "./normalize.js";

export const ENDPOINTS = {
  balance: "/sys/balance",
  profile: "/v1/user/by/username",
  clips: "/v1/user/clips/chunk",
  media: "/v1/media/by/code",
  searchAccounts: "/v2/fbsearch/accounts",
  searchReels: "/v2/fbsearch/reels",
  hashtag: "/g2/hashtag/medias",
  suggested: "/v2/user/suggested/profiles",
} as const;

/** Test seams. Production passes none of these. */
export type HikerOverrides = {
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  baseUrl?: string;
  timeoutMs?: number;
};

/**
 * Upper bound on pages for one call, so a feed that keeps returning items we
 * filter out (photos under a hashtag) cannot spend the day's credit. Pages
 * hold 8 to 20 items; this allows roughly three times the pages `limit` needs.
 */
export function maxPages(limit: number): number {
  return Math.ceil(limit / 6) + 2;
}

/**
 * Collects items page by page until `limit`. Stops on the last page (no
 * cursor), on an empty page, on a cursor that repeats, and at `maxPages`.
 * Duplicates across pages are dropped: search pagination can repeat items.
 */
export async function collect<T extends { id: string }, C>(
  limit: number,
  fetchPage: (cursor: C | null) => Promise<{ items: T[]; rawCount: number; next: C | null }>,
): Promise<T[]> {
  const out: T[] = [];
  if (limit <= 0) return out;
  const seen = new Set<string>();
  let cursor: C | null = null;
  let previous: string | null = null;

  for (let page = 0; page < maxPages(limit); page++) {
    const result = await fetchPage(cursor);
    for (const item of result.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
    if (out.length >= limit || result.next === null || result.rawCount === 0) break;
    const fingerprint = JSON.stringify(result.next);
    if (fingerprint === previous) break;
    previous = fingerprint;
    cursor = result.next;
  }
  return out;
}

/** Newest first; undated items last. */
function byNewest(a: Video, b: Video): number {
  if (a.takenAt === b.takenAt) return 0;
  if (a.takenAt === null) return 1;
  if (b.takenAt === null) return -1;
  return a.takenAt < b.takenAt ? 1 : -1;
}

export function createHikerBackend(
  deps: BackendFactoryDeps,
  overrides: HikerOverrides = {},
): SessionBackend {
  const env = overrides.env ?? process.env;
  // Read from the environment at the moment of use. Never stored, never logged.
  const key = (): string | undefined => env[HIKER_KEY_ENV]?.trim() || undefined;
  const client = new HikerClient({
    gate: deps.gate,
    key,
    fetch: overrides.fetch,
    baseUrl: overrides.baseUrl,
    timeoutMs: overrides.timeoutMs,
    log: deps.log,
  });

  const localStatus = (): BackendStatus =>
    key()
      ? {
          backend: "hiker",
          ready: true,
          account: null,
          detail: `${HIKER_KEY_ENV} is set. Run \`ig auth login hiker\` to check it against the API.`,
        }
      : {
          backend: "hiker",
          ready: false,
          account: null,
          detail: `${HIKER_KEY_ENV} is not set. Get a key at ${HIKER_SIGNUP_URL} and export it as ${HIKER_KEY_ENV}.`,
        };

  return {
    name: "hiker",

    // Local only: no request, no budget.
    async status() {
      return localStatus();
    },

    // One request to the balance endpoint, which the provider does not bill.
    // There is nothing to type, so `interactive` and `timeoutMs` do not apply.
    async login() {
      if (!key()) throw missingKeyError();
      const body = await client.get({
        path: ENDPOINTS.balance,
        notFound: "HikerAPI has no balance endpoint at /sys/balance.",
      });
      const balance = parseBalance(body, ENDPOINTS.balance);
      const money =
        balance.amount !== null && balance.currency
          ? ` (${balance.amount.toFixed(2)} ${balance.currency})`
          : "";
      const rate = balance.rate !== null ? ` Rate limit: ${balance.rate} requests/second.` : "";
      if (balance.requests <= 0) {
        return {
          backend: "hiker",
          ready: false,
          account: null,
          detail: `The key is valid but the account has no requests left${money}. Top up at ${HIKER_SIGNUP_URL}.`,
        };
      }
      return {
        backend: "hiker",
        ready: true,
        account: null,
        detail: `The key is valid. ${balance.requests} requests left${money}.${rate}`,
      };
    },

    // Nothing is stored locally: the key lives in the caller's environment and
    // only the caller can unset it. So there is never anything to forget.
    async logout() {
      return false;
    },

    async getProfile(username) {
      const body = await client.get({
        path: ENDPOINTS.profile,
        query: { username },
        notFound: `No Instagram account named ${username}.`,
        privateTarget: `HikerAPI will not serve the account ${username}.`,
      });
      return normalizeUser(body, ENDPOINTS.profile);
    },

    async listReels(creator, opts: ListOptions) {
      const reels = await collect<Video, string>(opts.limit, async (cursor) =>
        parseClipsChunk(
          await client.get({
            path: ENDPOINTS.clips,
            query: { user_id: creator.id, end_cursor: cursor ?? undefined },
            notFound: `No Instagram account with id ${creator.id} (${creator.username}).`,
            privateTarget: `The account ${creator.username} is private, so its reels cannot be listed.`,
          }),
          ENDPOINTS.clips,
        ),
      );
      // Pinned reels come first upstream regardless of age.
      return reels.sort(byNewest).slice(0, opts.limit);
    },

    async getVideo(shortcode) {
      const body = await client.get({
        path: ENDPOINTS.media,
        query: { code: shortcode },
        notFound: `No post with shortcode ${shortcode}. It may have been deleted.`,
        privateTarget: `The post ${shortcode} belongs to a private account.`,
      });
      const video = normalizeVideo(body, ENDPOINTS.media);
      if (!video.videoUrl) {
        throw upstreamChanged(ENDPOINTS.media, "the video has no video URL");
      }
      return video;
    },

    async searchCreators(query, opts: ListOptions) {
      const found = await collect<CreatorCandidate, string>(opts.limit, async (cursor) =>
        parseAccountsPage(
          await client.get({
            path: ENDPOINTS.searchAccounts,
            query: { query, page_token: cursor ?? undefined },
            notFound: "HikerAPI found no accounts for that search.",
          }),
          ENDPOINTS.searchAccounts,
        ),
      );
      return found.slice(0, opts.limit);
    },

    async searchReels(query, opts: ListOptions) {
      const found = await collect<Video, ReelsCursor>(opts.limit, async (cursor) =>
        parseReelsSearchPage(
          await client.get({
            path: ENDPOINTS.searchReels,
            query: {
              query,
              reels_max_id: cursor?.reelsMaxId,
              rank_token: cursor?.rankToken ?? undefined,
            },
            notFound: "HikerAPI found no reels for that search.",
          }),
          ENDPOINTS.searchReels,
        ),
      );
      return found.slice(0, opts.limit);
    },

    async hashtagReels(tag, opts: ListOptions) {
      const name = tag.replace(/^#/, "");
      const found = await collect<Video, string>(
        opts.limit,
        async (cursor): Promise<Page<Video>> =>
          parseHashtagPage(
            await client.get({
              path: ENDPOINTS.hashtag,
              query: { name, page_id: cursor ?? undefined },
              notFound: `Instagram has no content for the hashtag ${name}.`,
            }),
            ENDPOINTS.hashtag,
          ),
      );
      return found.slice(0, opts.limit);
    },

    // One request, one page: the endpoint has no cursor.
    async relatedCreators(creator, opts: ListOptions) {
      if (opts.limit <= 0) return [];
      const body = await client.get({
        path: ENDPOINTS.suggested,
        query: { user_id: creator.id },
        notFound: `No Instagram account with id ${creator.id} (${creator.username}).`,
        privateTarget: `The account ${creator.username} is private, so its suggestions cannot be read.`,
      });
      return parseSuggestedProfiles(body, ENDPOINTS.suggested).slice(0, opts.limit);
    },

    async close() {},
  };
}
