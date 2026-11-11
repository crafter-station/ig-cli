// Pure normalizers: HikerAPI JSON in, core entities out. No I/O, no gate.
//
// HikerAPI serves two families of shapes and both show up here:
//   - "typed" (v1 endpoints): the provider's own models, documented as
//     `User`, `Media`, `UserShort`, `Balance` in its OpenAPI document.
//   - "raw" (v2, g2 endpoints): Instagram's private-API dictionaries passed
//     through. Documented only by the example responses in the handbook.
// Every field read below appears in one of those two sources; see
// test/fixtures/hiker/README.md for which.
//
// Rules: counts that are absent or hidden become null, never 0. An item with
// no id, no shortcode or no owner is rejected with UPSTREAM_CHANGED instead of
// being emitted half-formed. Upstream text never goes into an error message.

import { type Creator, profileUrl, reelUrl, type Video } from "../../core/types.js";
import { IgError } from "../../lib/errors.js";
import type { CreatorCandidate } from "../types.js";

type Json = Record<string, unknown>;

/** Instagram's media_type for a video. 1 is a photo, 8 a carousel. */
const MEDIA_TYPE_VIDEO = 2;

export function upstreamChanged(endpoint: string, problem: string): IgError {
  return new IgError(
    "UPSTREAM_CHANGED",
    `HikerAPI ${endpoint} did not answer as documented: ${problem}.`,
    {
      hint: "HikerAPI may have changed this response. Nothing was stored. Try `--backend browser` and report the endpoint.",
      details: { endpoint, problem },
    },
  );
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown, endpoint: string, what: string): Json {
  if (!isObject(value)) throw upstreamChanged(endpoint, `${what} is not an object`);
  return value;
}

function array(value: unknown, endpoint: string, what: string): unknown[] {
  if (!Array.isArray(value)) throw upstreamChanged(endpoint, `${what} is not a list`);
  return value;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** A non-negative integer count, or null. Never coerces a missing value to 0. */
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Instagram ids as strings. A JSON number above 2^53 has already lost digits
 * by the time it is parsed, so it is refused rather than stored wrong.
 */
function idString(value: unknown): string | null {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}

function isoFromSeconds(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isoFromString(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  // A timestamp with no zone is UTC upstream; without this it would be read as local time.
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`;
  const ms = Date.parse(zoned);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// ---------------------------------------------------------------- users

/** `User` from /v1/user/by/username. */
export function normalizeUser(raw: unknown, endpoint: string): Creator {
  const user = object(raw, endpoint, "the user");
  const id = idString(user.pk) ?? idString(user.id);
  if (!id) throw upstreamChanged(endpoint, "the user has no usable id");
  const username = text(user.username);
  if (!username) throw upstreamChanged(endpoint, "the user has no username");

  return {
    id,
    username,
    fullName: text(user.full_name),
    biography: text(user.biography),
    followers: count(user.follower_count),
    following: count(user.following_count),
    mediaCount: count(user.media_count),
    isVerified: user.is_verified === true,
    isPrivate: user.is_private === true,
    category: text(user.category_name) ?? text(user.category) ?? text(user.business_category_name),
    externalUrl: text(user.external_url),
    profilePicUrl: text(user.profile_pic_url_hd) ?? text(user.profile_pic_url),
    url: profileUrl(username),
  };
}

const FOLLOWER_SUFFIX: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9 };

/**
 * Account search carries the follower count only as display text such as
 * "274M followers" (documented example). It is parsed when it has exactly that
 * form, which makes it a rounded figure: 7.3M becomes 7300000. Anything else,
 * including a display name in the same field, yields null.
 */
export function followersFromSocialContext(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)([KMB])? followers?$/);
  if (!match) return null;
  const digits = (match[1] as string).replace(/,/g, "");
  const scaled = Number(digits) * (match[2] ? (FOLLOWER_SUFFIX[match[2]] as number) : 1);
  return Number.isFinite(scaled) ? Math.round(scaled) : null;
}

/** A user as it appears in account search and in suggested profiles. */
export function normalizeCandidate(raw: unknown, endpoint: string): CreatorCandidate {
  const user = object(raw, endpoint, "a user in the list");
  const id = idString(user.id) ?? idString(user.pk_id) ?? idString(user.pk);
  if (!id) throw upstreamChanged(endpoint, "a user in the list has no usable id");
  const username = text(user.username);
  if (!username) throw upstreamChanged(endpoint, "a user in the list has no username");

  return {
    id,
    username,
    fullName: text(user.full_name),
    followers:
      count(user.follower_count) ??
      (user.search_social_context_snippet_type === "typeahead_follow_count"
        ? followersFromSocialContext(user.search_social_context)
        : null),
    isVerified: user.is_verified === true,
    isPrivate: user.is_private === true,
  };
}

// ---------------------------------------------------------------- media

function mediaId(media: Json): string | null {
  // Typed media: `pk` is already a string. Raw media: `pk` is a 19-digit JSON
  // number that no longer holds its last digits, while `id` is the string
  // "<pk>_<owner id>" and does.
  if (typeof media.pk === "string") return idString(media.pk);
  if (typeof media.id === "string") {
    const match = media.id.match(/^(\d+)(?:_\d+)?$/);
    if (match?.[1]) return match[1];
  }
  return idString(media.pk);
}

function firstUrl(list: unknown): string | null {
  if (!Array.isArray(list)) return null;
  for (const entry of list) {
    if (isObject(entry)) {
      const url = text(entry.url);
      if (url) return url;
    }
  }
  return null;
}

/** The largest rendition, as instagrapi's extractor picks it; else the first. */
function bestVideoUrl(list: unknown): string | null {
  if (!Array.isArray(list)) return null;
  let best: { url: string; area: number } | null = null;
  for (const entry of list) {
    if (!isObject(entry)) continue;
    const url = text(entry.url);
    if (!url) continue;
    const area =
      typeof entry.width === "number" && typeof entry.height === "number"
        ? entry.width * entry.height
        : 0;
    if (!best || area > best.area) best = { url, area };
  }
  return best?.url ?? null;
}

/**
 * One media item, typed (`Media`) or raw, to a Video. Returns null for a
 * photo or carousel so list callers can skip it.
 */
export function normalizeMedia(raw: unknown, endpoint: string): Video | null {
  const media = object(raw, endpoint, "a media item");
  if (typeof media.media_type !== "number") {
    throw upstreamChanged(endpoint, "a media item has no media_type");
  }
  if (media.media_type !== MEDIA_TYPE_VIDEO) return null;

  const id = mediaId(media);
  if (!id) throw upstreamChanged(endpoint, "a video has no usable id");
  const shortcode = text(media.code);
  if (!shortcode) throw upstreamChanged(endpoint, "a video has no shortcode");

  const owner = isObject(media.user) ? media.user : null;
  const creatorId = owner
    ? (idString(owner.pk) ?? idString(owner.id) ?? idString(owner.pk_id))
    : null;
  const creatorUsername = owner ? text(owner.username) : null;
  if (!creatorId || !creatorUsername) throw upstreamChanged(endpoint, "a video has no owner");

  // When the owner hides counts the flag is set and the like count may arrive
  // as 0 or a negative placeholder. That is "hidden", not "nobody liked it".
  const hidden = media.like_and_view_counts_disabled === true;
  const likes = count(media.like_count);
  const duration = media.video_duration;
  const imageVersions2 = isObject(media.image_versions2) ? media.image_versions2 : null;

  return {
    id,
    shortcode,
    url: reelUrl(shortcode),
    creatorId,
    creatorUsername,
    caption:
      text(media.caption_text) ?? (isObject(media.caption) ? text(media.caption.text) : null),
    takenAt:
      isoFromSeconds(media.taken_at_ts) ??
      isoFromSeconds(media.taken_at) ??
      isoFromString(media.taken_at),
    durationSec:
      typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? duration : null,
    plays: count(media.play_count) ?? count(media.ig_play_count),
    likes: hidden && likes === 0 ? null : likes,
    comments: count(media.comment_count),
    thumbnailUrl:
      text(media.thumbnail_url) ??
      firstUrl(imageVersions2?.candidates) ??
      firstUrl(media.image_versions),
    videoUrl: text(media.video_url) ?? bestVideoUrl(media.video_versions),
  };
}

/** A single media that must be a video. */
export function normalizeVideo(raw: unknown, endpoint: string): Video {
  const video = normalizeMedia(raw, endpoint);
  if (!video) {
    throw new IgError("NOT_FOUND", "That post is a photo or a carousel, not a video.", {
      hint: "Pass the shortcode of a reel.",
      details: { endpoint },
    });
  }
  return video;
}

// ---------------------------------------------------------------- pages

/** One page of anything paginated. `rawCount` is the item count before filtering. */
export type Page<T> = { items: T[]; rawCount: number; next: string | null };

function videos(items: unknown[], endpoint: string): Video[] {
  const out: Video[] = [];
  for (const item of items) {
    const video = normalizeMedia(item, endpoint);
    if (video) out.push(video);
  }
  return out;
}

/** /v1/user/clips/chunk answers with a two-element list: [Media[], cursor | null]. */
export function parseClipsChunk(body: unknown, endpoint: string): Page<Video> {
  const pair = array(body, endpoint, "the response");
  if (pair.length !== 2) throw upstreamChanged(endpoint, "the response is not [items, cursor]");
  const items = array(pair[0], endpoint, "the item list");
  const cursor = pair[1];
  if (cursor !== null && typeof cursor !== "string") {
    throw upstreamChanged(endpoint, "the cursor is neither text nor null");
  }
  return { items: videos(items, endpoint), rawCount: items.length, next: text(cursor) };
}

/** /v2/fbsearch/accounts: { users, has_more, page_token }. */
export function parseAccountsPage(body: unknown, endpoint: string): Page<CreatorCandidate> {
  const root = object(body, endpoint, "the response");
  const users = array(root.users, endpoint, "`users`");
  return {
    items: users.map((user) => normalizeCandidate(user, endpoint)),
    rawCount: users.length,
    next: root.has_more === true ? text(root.page_token) : null,
  };
}

/** Cursor for /v2/fbsearch/reels: both values go back on the next request. */
export type ReelsCursor = { reelsMaxId: string; rankToken: string | null };

/** /v2/fbsearch/reels: { reels_serp_modules: [{ clips: [{ media }] }], has_more, reels_max_id, rank_token }. */
export function parseReelsSearchPage(
  body: unknown,
  endpoint: string,
): Omit<Page<Video>, "next"> & { next: ReelsCursor | null } {
  const root = object(body, endpoint, "the response");
  const modules = array(root.reels_serp_modules, endpoint, "`reels_serp_modules`");
  const medias: unknown[] = [];
  for (const entry of modules) {
    const module = object(entry, endpoint, "a search module");
    // Modules of another kind (none documented today) carry no clips.
    if (module.clips === undefined) continue;
    for (const clip of array(module.clips, endpoint, "`clips`")) {
      medias.push(object(clip, endpoint, "a clip").media);
    }
  }
  const reelsMaxId = root.has_more === true ? text(root.reels_max_id) : null;
  return {
    items: videos(medias, endpoint),
    rawCount: medias.length,
    next: reelsMaxId ? { reelsMaxId, rankToken: text(root.rank_token) } : null,
  };
}

/** /g2/hashtag/medias: { response: { items }, next_page_id }. Posts and reels mixed. */
export function parseHashtagPage(body: unknown, endpoint: string): Page<Video> {
  const root = object(body, endpoint, "the response");
  const inner = object(root.response, endpoint, "`response`");
  const items = array(inner.items, endpoint, "`response.items`");
  return { items: videos(items, endpoint), rawCount: items.length, next: text(root.next_page_id) };
}

/** /v2/user/suggested/profiles: { users }. */
export function parseSuggestedProfiles(body: unknown, endpoint: string): CreatorCandidate[] {
  const root = object(body, endpoint, "the response");
  return array(root.users, endpoint, "`users`").map((user) => normalizeCandidate(user, endpoint));
}

export type Balance = {
  requests: number;
  rate: number | null;
  currency: string | null;
  amount: number | null;
};

/** `Balance` from /sys/balance. */
export function parseBalance(body: unknown, endpoint: string): Balance {
  const root = object(body, endpoint, "the response");
  if (typeof root.requests !== "number" || !Number.isFinite(root.requests)) {
    throw upstreamChanged(endpoint, "`requests` is not a number");
  }
  return {
    requests: root.requests,
    rate: typeof root.rate === "number" ? root.rate : null,
    currency:
      typeof root.currency === "string" && /^[A-Z]{3}$/.test(root.currency) ? root.currency : null,
    amount: typeof root.amount === "number" && Number.isFinite(root.amount) ? root.amount : null,
  };
}
