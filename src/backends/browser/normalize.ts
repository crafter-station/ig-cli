// Pure functions: JSON captured from Instagram's web app in, entities out.
// Every shape here was observed live (see test/fixtures/browser); none is
// documented by Instagram, so each parser fails loudly with UPSTREAM_CHANGED
// when the part it needs is missing, instead of returning empty data.

import { type Audio, type Creator, profileUrl, reelUrl, type Video } from "../../core/types.js";
import { IgError } from "../../lib/errors.js";
import type { CreatorCandidate } from "../types.js";

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : null;
const int = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;

function changed(what: string): never {
  throw new IgError(
    "UPSTREAM_CHANGED",
    `Instagram's ${what} response no longer has the expected shape.`,
    {
      hint: "The web app changed. Check for an ig-cli update, or use `--backend hiker`.",
    },
  );
}

/** Walks `path` through nested objects; undefined if any step is missing. */
function dig(root: unknown, ...path: string[]): unknown {
  let cur = root;
  for (const key of path) {
    if (!isObj(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** Depth-first search for the first value stored under `key`. */
export function findKey(root: unknown, key: string, depth = 0): unknown {
  if (root === null || typeof root !== "object" || depth > 60) return undefined;
  if (Array.isArray(root)) {
    for (const item of root) {
      const found = findKey(item, key, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const obj = root as Json;
  if (key in obj) return obj[key];
  for (const value of Object.values(obj)) {
    const found = findKey(value, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

// Instagram media ids embed their creation time: the top 41 bits are
// milliseconds since this epoch. The reels grid omits `taken_at`, so this is
// how a reel gets a date without one extra request per reel. It is the upload
// time, observed about a minute before the published `taken_at`.
const IG_EPOCH_MS = 1314220021721n;

/** Upload time of a media id in epoch milliseconds, or null for anything that is not one. */
export function uploadMs(pk: string | null): number | null {
  if (!pk || !/^\d{10,}$/.test(pk)) return null;
  return Number((BigInt(pk) >> 23n) + IG_EPOCH_MS);
}

export function takenAtFromPk(pk: string): string | null {
  const ms = uploadMs(pk);
  return ms === null ? null : new Date(ms).toISOString();
}

const isoFromSeconds = (v: unknown): string | null =>
  typeof v === "number" && v > 0 ? new Date(v * 1000).toISOString() : null;

function videoUrlOf(media: Json): string | null {
  const versions = media.video_versions;
  if (!Array.isArray(versions)) return null;
  for (const v of versions) {
    const url = isObj(v) ? str(v.url) : null;
    if (url) return url;
  }
  return null;
}

function thumbnailOf(media: Json): string | null {
  const candidates = dig(media, "image_versions2", "candidates");
  if (!Array.isArray(candidates)) return null;
  const first = candidates[0];
  return isObj(first) ? str(first.url) : null;
}

/**
 * The sound of a reel, from `clips_metadata`. The profile timeline and the
 * reel page carry it; the reels tab and keyword results do not. Returns
 * undefined when the node has no `clips_metadata` at all, so a surface that
 * omits it never erases what another surface stored.
 */
export function audioOf(media: Json): Audio | null | undefined {
  if (!("clips_metadata" in media)) return undefined;
  const meta = media.clips_metadata;
  if (!isObj(meta)) return null;
  const music = dig(meta, "music_info", "music_asset_info");
  if (isObj(music)) {
    return {
      id: str(music.audio_cluster_id),
      title: str(music.title),
      artist: str(music.display_artist),
      isOriginal: false,
    };
  }
  const sound = meta.original_sound_info;
  if (isObj(sound)) {
    return {
      id: str(sound.audio_asset_id),
      // Localized by Instagram when the creator did not name it ("Audio original").
      title: str(sound.original_audio_title),
      artist: str(dig(sound, "ig_artist", "username")),
      isOriginal: true,
    };
  }
  return null;
}

/** Counts are null, not 0, when the owner hides them. */
function countOf(media: Json, key: string): number | null {
  const value = int(media[key]);
  if (value === null) return null;
  if (media.like_and_view_counts_disabled === true && key !== "comment_count") return null;
  return value;
}

/**
 * One media node to a Video. Returns null for anything that is not a video
 * (photos and carousels share these lists). `owner` supplies the creator when
 * the node carries no `user`.
 */
export function videoFromMedia(
  media: unknown,
  owner?: { id: string; username: string },
): Video | null {
  if (!isObj(media)) return null;
  if (media.media_type !== 2) return null;
  const id = str(media.pk);
  const shortcode = str(media.code);
  const user = isObj(media.user) ? media.user : undefined;
  const creatorId = str(user?.pk) ?? str(user?.id) ?? owner?.id ?? null;
  const creatorUsername = str(user?.username) ?? owner?.username ?? null;
  if (!id || !shortcode || !creatorId || !creatorUsername) return null;
  const audio = audioOf(media);

  return {
    id,
    shortcode,
    url: reelUrl(shortcode),
    creatorId,
    creatorUsername,
    caption: str(dig(media, "caption", "text")),
    takenAt: isoFromSeconds(media.taken_at) ?? takenAtFromPk(id),
    durationSec: typeof media.video_duration === "number" ? media.video_duration : null,
    plays: countOf(media, "play_count"),
    likes: countOf(media, "like_count"),
    comments: countOf(media, "comment_count"),
    thumbnailUrl: thumbnailOf(media),
    videoUrl: videoUrlOf(media),
    ...(audio === undefined ? {} : { audio }),
  };
}

/** PolarisProfilePageContentQuery -> Creator. */
export function profileFromResponse(json: unknown): Creator {
  const user = dig(json, "data", "user");
  if (!isObj(user)) changed("profile");
  const id = str(user.pk) ?? str(user.id);
  const username = str(user.username);
  if (!id || !username) changed("profile");
  return {
    id,
    username,
    fullName: str(user.full_name),
    biography: str(user.biography),
    followers: int(user.follower_count),
    following: int(user.following_count),
    mediaCount: int(user.media_count),
    isVerified: user.is_verified === true,
    isPrivate: user.is_private === true,
    category: str(user.category),
    externalUrl: str(user.external_url),
    profilePicUrl: str(dig(user, "hd_profile_pic_url_info", "url")) ?? str(user.profile_pic_url),
    url: profileUrl(username),
  };
}

export type Page<T> = { items: T[]; hasNext: boolean };

function edgesOf(connection: unknown, what: string): { edges: unknown[]; hasNext: boolean } {
  if (!isObj(connection) || !Array.isArray(connection.edges)) changed(what);
  return {
    edges: connection.edges,
    hasNext: dig(connection, "page_info", "has_next_page") === true,
  };
}

/**
 * PolarisProfileReelsTabContentQuery (and its `_connection` pagination) ->
 * reels with play counts. This surface has no caption, date or video URL;
 * `mergeTimeline` fills those in where the profile timeline has them.
 */
export function reelsFromResponse(
  json: unknown,
  owner: { id: string; username: string },
): Page<Video> {
  const { edges, hasNext } = edgesOf(
    dig(json, "data", "fetch__XDTUserDict", "clips_connection"),
    "reels",
  );
  const items: Video[] = [];
  for (const edge of edges) {
    const video = videoFromMedia(dig(edge, "node", "media"), owner);
    // A collaboration is listed on this creator's tab but names the other
    // account as its user. It is filed under the creator whose tab it is on,
    // which is also the only creator guaranteed to be stored.
    if (video) items.push({ ...video, creatorId: owner.id, creatorUsername: owner.username });
  }
  if (edges.length > 0 && items.length === 0) changed("reels");
  return { items, hasNext };
}

export type TimelinePage = {
  /** The videos among the posts of this page, keyed by media id. */
  videos: Map<string, Video>;
  /** Posts on the page, photos and carousels included. */
  posts: number;
  hasNext: boolean;
  /**
   * Publication time (ms) of the oldest post on the page that is not pinned,
   * or null when every post is pinned. Posts come newest first after the
   * pinned ones, so everything on later pages is older than this.
   */
  oldestMs: number | null;
};

const TIMELINE_KEY = "xdt_api__v1__feed__user_timeline_graphql_connection";

/**
 * PolarisProfilePostsQuery, and the pagination query the app fires when the
 * profile grid is scrolled, -> one page of the post timeline: 12 posts with
 * caption, date, video URL and sound, no play count.
 */
export function timelinePageFromResponse(json: unknown): TimelinePage {
  const { edges, hasNext } = edgesOf(dig(json, "data", TIMELINE_KEY), "timeline");
  const videos = new Map<string, Video>();
  let oldestMs: number | null = null;
  for (const edge of edges) {
    const node = dig(edge, "node");
    if (!isObj(node)) continue;
    const video = videoFromMedia(node);
    if (video) videos.set(video.id, video);
    const pinned =
      Array.isArray(node.timeline_pinned_user_ids) && node.timeline_pinned_user_ids.length > 0;
    // `taken_at` is what the grid is ordered by; the id's upload time can be
    // days earlier for a scheduled post, so it is only the fallback.
    const takenAt = typeof node.taken_at === "number" && node.taken_at > 0 ? node.taken_at : null;
    const at = pinned ? null : takenAt !== null ? takenAt * 1000 : uploadMs(str(node.pk));
    if (at !== null && (oldestMs === null || at < oldestMs)) oldestMs = at;
  }
  return { videos, posts: edges.length, hasNext, oldestMs };
}

/** True for a payload that holds a page of the post timeline, whatever query produced it. */
export function isTimelinePayload(json: unknown): boolean {
  return isObj(dig(json, "data", TIMELINE_KEY));
}

/** PolarisProfilePostsQuery -> the videos among the latest posts, keyed by media id. */
export function timelineFromResponse(json: unknown): Map<string, Video> {
  return timelinePageFromResponse(json).videos;
}

/** Fills caption, date, thumbnail, video URL and sound from the timeline; keeps the reel's own counts. */
export function mergeTimeline(reels: Video[], timeline: Map<string, Video> | undefined): Video[] {
  if (!timeline) return reels;
  return reels.map((reel) => {
    const post = timeline.get(reel.id);
    if (!post) return reel;
    return {
      ...reel,
      caption: reel.caption ?? post.caption,
      takenAt: post.takenAt ?? reel.takenAt,
      durationSec: reel.durationSec ?? post.durationSec,
      likes: reel.likes ?? post.likes,
      comments: reel.comments ?? post.comments,
      thumbnailUrl: reel.thumbnailUrl ?? post.thumbnailUrl,
      videoUrl: post.videoUrl ?? reel.videoUrl,
      ...(reel.audio || post.audio ? { audio: reel.audio ?? post.audio } : {}),
    };
  });
}

/** PolarisKeywordSearchExplorePageRelayQuery (+ pagination) -> videos in the result grid. */
export function serpFromResponse(json: unknown): Page<Video> {
  const { edges, hasNext } = edgesOf(dig(json, "data", "xdt_fbsearch__top_serp_graphql"), "search");
  const items: Video[] = [];
  let seen = 0;
  for (const edge of edges) {
    const row = dig(edge, "node", "items");
    if (!Array.isArray(row)) continue;
    for (const media of row) {
      seen++;
      const video = videoFromMedia(media);
      if (video) items.push(video);
    }
  }
  if (edges.length > 0 && seen === 0) changed("search");
  return { items, hasNext };
}

/** The reel page's embedded `xdt_api__v1__media__shortcode__web_info` -> Video, or null if absent. */
export function videoFromWebInfo(embedded: unknown): Video | null {
  const info = findKey(embedded, "xdt_api__v1__media__shortcode__web_info");
  if (info === undefined) return null;
  const items = isObj(info) ? info.items : undefined;
  if (!Array.isArray(items) || items.length === 0) return null;
  return videoFromMedia(items[0]);
}

const UNITS: [RegExp, number][] = [
  [/^(k|mil)$/i, 1e3],
  [/^(m|mill\.?|millones|millón|mm)$/i, 1e6],
  [/^(b|bn)$/i, 1e9],
];

/**
 * "207 mil seguidores", "1,8 mill. seguidores", "12.3K followers",
 * "1,234 followers" -> a number. The typeahead only gives the count as
 * localized text; anything unrecognized is null rather than a wrong number.
 */
export function parseFollowerText(text: unknown): number | null {
  if (typeof text !== "string") return null;
  const match = text.match(/^\s*([\d.,]+)\s*([^\s\d.,]+\.?)?\s+(seguidores|followers)\s*$/i);
  if (!match) return null;
  const [, digits = "", unit] = match;
  if (unit) {
    const factor = UNITS.find(([re]) => re.test(unit))?.[1];
    if (!factor) return null;
    const value = Number.parseFloat(digits.replace(",", "."));
    return Number.isFinite(value) ? Math.round(value * factor) : null;
  }
  const value = Number.parseInt(digits.replace(/[.,]/g, ""), 10);
  return Number.isFinite(value) ? value : null;
}

function candidateFromUser(user: unknown, followers: number | null): CreatorCandidate | null {
  if (!isObj(user)) return null;
  const id = str(user.pk) ?? str(user.id);
  const username = str(user.username);
  if (!id || !username) return null;
  return {
    id,
    username,
    fullName: str(user.full_name),
    followers,
    isVerified: user.is_verified === true,
    isPrivate: user.is_private === true,
  };
}

/** PolarisSearchBoxRefetchableQuery -> accounts, in Instagram's order. */
export function candidatesFromSearch(json: unknown): CreatorCandidate[] {
  const users = dig(json, "data", "xdt_api__v1__fbsearch__topsearch_connection", "users");
  if (!Array.isArray(users)) changed("account search");
  const out: CreatorCandidate[] = [];
  for (const entry of users) {
    const user = dig(entry, "user");
    // Only the follower-count snippet is read. Other snippets describe the
    // logged-in account's own social graph and are deliberately ignored.
    const isCount =
      isObj(user) && user.search_social_context_snippet_type === "typeahead_follow_count";
    const followers = isCount ? parseFollowerText((user as Json).search_social_context) : null;
    const candidate = candidateFromUser(user, followers);
    if (candidate) out.push(candidate);
  }
  if (users.length > 0 && out.length === 0) changed("account search");
  return out;
}

/** PolarisProfileSuggestedUsersWithPreloadableQuery -> related accounts. */
export function candidatesFromChaining(json: unknown): CreatorCandidate[] {
  const users = dig(json, "data", "xdt_api__v1__discover__chaining", "users");
  if (!Array.isArray(users)) changed("related accounts");
  const out: CreatorCandidate[] = [];
  for (const user of users) {
    const candidate = candidateFromUser(user, null);
    if (candidate) out.push(candidate);
  }
  return out;
}

/**
 * Upstream's own refusal inside a 200 response, e.g.
 * `{"message":"Please wait a few minutes before you try again.","status":"fail"}`.
 */
export function blockSignal(
  json: unknown,
): { reason: "RATE_LIMITED" | "CHECKPOINT"; detail: string } | null {
  if (!isObj(json)) return null;
  const message = str(json.message) ?? "";
  if (json.status !== "fail" && !message) return null;
  if (/checkpoint|challenge/i.test(message) || "checkpoint_url" in json) {
    return { reason: "CHECKPOINT", detail: "Instagram asked for a checkpoint" };
  }
  if (
    /wait a few minutes|feedback_required|rate limit|espera unos minutos/i.test(message) ||
    json.spam === true
  ) {
    return { reason: "RATE_LIMITED", detail: "Instagram asked to wait before trying again" };
  }
  return null;
}
