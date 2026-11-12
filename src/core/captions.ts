// Complete captions. A backend whose reel list cannot caption every reel
// (browser: only the 12 latest posts come with a caption) offers
// `fetchCaptions`, which reads further into the post timeline at one request
// per page of 12 posts. Everything here decides how little of that to ask for,
// merges what came back, and counts what it bought.
//
// Two rules keep the cost down over time:
//   - One reel left over is fetched by itself (`getVideo`, one request)
//     instead of paging on for it. That is how a pinned reel from years ago
//     gets its caption without reading the whole timeline.
//   - A reel that was looked at and has no caption text is stored with the
//     caption "" instead of null. null means "not known yet"; "" means "known
//     to have none", so it is never asked for again.

import { z } from "zod";
import type { Backend, CaptionOptions, CaptionPass } from "../backends/types.js";
import type { Context } from "../context.js";
import type { BackendName } from "../lib/config.js";
import { toIgError } from "../lib/errors.js";
import type { StoredCreator, StoredVideo, Video } from "./types.js";

/**
 * Most extra requests one creator may cost in a refresh with `--captions`.
 * Each is one page of 12 posts, so this reaches about 100 posts back.
 */
export const CAPTION_MAX_REQUESTS = 8;

/** Up to this many leftover reels are fetched one by one rather than paged for. */
const SINGLE_FETCH_MAX = 1;

export const CaptionOutcomeSchema = z.object({
  filled: z
    .number()
    .int()
    .describe("Reels with no caption stored before this run that got one from the extra requests"),
  missing: z.number().int().describe("Reels of this creator still stored without a caption"),
  requests: z.number().int().describe("Extra requests spent on captions"),
});
export type CaptionOutcome = z.infer<typeof CaptionOutcomeSchema>;

/** One line for flag help, so the cost is stated the same everywhere. */
export const CAPTIONS_FLAG_HELP = `also read older posts so every fetched reel gets its caption; browser: up to ${CAPTION_MAX_REQUESTS} extra requests per creator`;

/**
 * Whether a backend needs extra requests for complete captions. Answered from
 * the name so that a dry run can say so without creating the backend; it must
 * agree with which backends implement `fetchCaptions`.
 */
export function pagesForCaptions(backend: BackendName): boolean {
  return backend === "browser";
}

/** null is "not known yet". An empty caption is known: the reel has none. */
const unknown = (caption: string | null | undefined): boolean =>
  caption === null || caption === undefined;

/**
 * What a refresh asks the timeline for. `stored` is the creator's stored
 * videos, newest first.
 *
 *   - Nothing stored yet: read until `reels` videos were seen, since the reel
 *     list about to be fetched is that long.
 *   - Otherwise: cover the stored reels without a caption among the newest
 *     `reels`, and reach the newest stored reel, so reels posted since the
 *     last refresh are covered however many there are. Older gaps are left to
 *     `ig video captions`.
 *
 * One uncaptioned reel may be left for a fetch by itself, but never the newest
 * stored reel: the reading has to reach that one, or reels posted after it
 * could be skipped.
 */
export function refreshCaptionPlan(stored: StoredVideo[], reels: number): CaptionOptions {
  const newest = stored[0];
  const ids = stored
    .slice(0, reels)
    .filter((v) => unknown(v.caption))
    .map((v) => v.id);
  const marker = newest !== undefined && !ids.includes(newest.id);
  if (marker) ids.push(newest.id);
  return {
    ids,
    minVideos: stored.length === 0 ? reels : 0,
    maxRequests: CAPTION_MAX_REQUESTS,
    leave: marker && ids.length > 1 ? SINGLE_FETCH_MAX : 0,
  };
}

/** True when this creator can cost extra requests in a refresh with `--captions`. */
export function refreshNeedsCaptionPass(stored: StoredVideo[], reels: number): boolean {
  if (reels <= 0) return false;
  return stored.length === 0 || stored.slice(0, reels).some((v) => unknown(v.caption));
}

/** Fills what a reel-list entry lacks from the same video as the timeline has it. */
export function withTimeline(reel: Video, post: Video | undefined): Video {
  if (!post) return reel;
  const audio = reel.audio ?? post.audio;
  return {
    ...reel,
    caption: reel.caption ?? post.caption,
    takenAt: reel.takenAt ?? post.takenAt,
    durationSec: reel.durationSec ?? post.durationSec,
    likes: reel.likes ?? post.likes,
    comments: reel.comments ?? post.comments,
    thumbnailUrl: reel.thumbnailUrl ?? post.thumbnailUrl,
    videoUrl: reel.videoUrl ?? post.videoUrl,
    ...(audio ? { audio } : {}),
  };
}

export function missingCaptions(ctx: Context, creatorId: string): StoredVideo[] {
  return ctx.store.listVideos({ creatorId }).filter((v) => unknown(v.caption));
}

type Who = { id: string; username: string };

/**
 * Fetches one reel by itself for its caption: one request. A reel without
 * caption text, and a reel that no longer exists, are both settled as "" so
 * they are not asked for again. Returns whether a caption was found. Any
 * failure other than NOT_FOUND propagates.
 */
async function fetchSingle(
  ctx: Context,
  backend: Backend,
  who: Who,
  target: Pick<Video, "id" | "shortcode" | "url">,
): Promise<boolean> {
  const mine = { id: target.id, creatorId: who.id, creatorUsername: who.username };
  let fetched: Video;
  try {
    fetched = await backend.getVideo(target.shortcode);
  } catch (err) {
    if (toIgError(err).code !== "NOT_FOUND") throw err;
    ctx.store.upsertVideos([
      {
        ...mine,
        shortcode: target.shortcode,
        url: target.url,
        caption: "",
        takenAt: null,
        durationSec: null,
        plays: null,
        likes: null,
        comments: null,
        thumbnailUrl: null,
        videoUrl: null,
      },
    ]);
    return false;
  }
  ctx.store.upsertVideos([{ ...fetched, ...mine, caption: fetched.caption ?? "" }]);
  return Boolean(fetched.caption);
}

/**
 * A timeline post as the row to store for a reel that is already stored, or
 * null when it would add nothing. It adds something when the stored reel has
 * no known caption, or no sound and the post names one. Stored as the timeline
 * gives it: `plays` is null there, which leaves the stored play count alone.
 */
function gain(post: Video, stored: StoredVideo | undefined, who: Who): Video | null {
  if (!stored) return null;
  const needsCaption = unknown(stored.caption);
  const needsAudio = stored.audio === null && post.audio !== null && post.audio !== undefined;
  if (!needsCaption && !needsAudio) return null;
  return {
    ...post,
    // Looked at and without caption text: settled, not unknown.
    caption: needsCaption ? (post.caption ?? "") : post.caption,
    creatorId: who.id,
    creatorUsername: who.username,
  };
}

// --- during a refresh -----------------------------------------------------------

/** What a refresh carries between the caption pass and the stored reel list. */
export type CaptionRun = {
  who: Who;
  /** Every video stored for the creator before the refresh, by id. */
  before: Map<string, StoredVideo>;
  /** Stored reels the pass was asked to cover. */
  wanted: StoredVideo[];
  pass: CaptionPass;
  /** False for a backend that already returns captions: nothing extra is ever spent. */
  paged: boolean;
};

/**
 * Call between `getProfile` and `listReels`: the browser is still on the
 * profile page then, so reading its timeline further needs no page load.
 */
export async function beginCaptions(
  ctx: Context,
  backend: Backend,
  who: Who,
  reels: number,
): Promise<CaptionRun> {
  const stored = ctx.store.listVideos({ creatorId: who.id });
  const before = new Map(stored.map((v) => [v.id, v]));
  const wanted = stored.slice(0, reels).filter((v) => unknown(v.caption));
  let pass: CaptionPass = { videos: [], loaded: [], requests: 0 };
  if (backend.fetchCaptions) {
    pass = await backend.fetchCaptions(who, refreshCaptionPlan(stored, reels));
  }
  return { who, before, wanted, pass, paged: backend.fetchCaptions !== undefined };
}

/**
 * A listed reel with what the timeline knows about it. A reel the timeline
 * showed and that still has no caption has none: it is settled as "".
 */
export function captioned(run: CaptionRun, reel: Video): Video {
  const post = run.pass.videos.find((v) => v.id === reel.id);
  if (!post) return reel;
  const merged = withTimeline(reel, post);
  return unknown(merged.caption) ? { ...merged, caption: "" } : merged;
}

/**
 * Call after the listed reels were stored. Stores what the timeline has for
 * stored reels that are no longer listed, fetches a single leftover by itself,
 * and counts.
 */
export async function finishCaptions(
  ctx: Context,
  backend: Backend,
  run: CaptionRun,
  listed: Video[],
): Promise<CaptionOutcome> {
  const { who, before, pass } = run;
  const listedIds = new Set(listed.map((v) => v.id));

  const older: Video[] = [];
  for (const post of pass.videos) {
    const row = listedIds.has(post.id) ? null : gain(post, before.get(post.id), who);
    if (row) older.push(row);
  }
  ctx.store.upsertVideos(older);

  // Counted: reels with no caption before that the extra pages captioned.
  // What the first page gave for free is not this flag's doing.
  const paidFor = new Set(pass.loaded);
  const captionedByPages = new Set(
    pass.videos.filter((v) => v.caption && paidFor.has(v.id)).map((v) => v.id),
  );
  let filled = 0;
  for (const id of [...listedIds, ...older.map((v) => v.id)]) {
    if (captionedByPages.has(id) && unknown(before.get(id)?.caption)) filled++;
  }

  // What neither the reel list nor the timeline could settle, among the reels
  // this refresh is about.
  const inScope = new Set([...listedIds, ...run.wanted.map((v) => v.id)]);
  const leftover = missingCaptions(ctx, who.id).filter((v) => inScope.has(v.id));
  let requests = pass.requests;
  if (run.paged && leftover.length <= SINGLE_FETCH_MAX) {
    for (const target of leftover) {
      if (requests >= CAPTION_MAX_REQUESTS) break;
      requests++;
      if (await fetchSingle(ctx, backend, who, target)) filled++;
    }
  }
  return { filled, missing: missingCaptions(ctx, who.id).length, requests };
}

// --- on its own -----------------------------------------------------------------

export type BackfillOutcome = {
  username: string;
  status: "filled" | "nothing-missing" | "unsupported";
  /** Why nothing was done; null otherwise. */
  reason: string | null;
  /** Stored reels without a caption before the run. */
  missingBefore: number;
  /** Reels that got caption text. */
  filled: number;
  /** Stored reels still without a known caption. */
  missing: number;
  requests: number;
};

/**
 * Fills captions of one tracked creator's stored reels without touching the
 * reels tab. One reel missing: it is fetched by itself, one request. More: one
 * request to open the profile plus one per timeline page until they are
 * covered, and a single leftover is fetched by itself. Never more than
 * `maxRequests`. Costs nothing when no stored reel lacks a caption or the
 * backend has no caption pass. Backend errors propagate.
 */
export async function backfillCaptions(
  ctx: Context,
  backend: Backend,
  creator: StoredCreator,
  opts: { maxRequests: number },
): Promise<BackfillOutcome> {
  const who = { id: creator.id, username: creator.username };
  const lacking = missingCaptions(ctx, creator.id);
  const base = {
    username: creator.username,
    reason: null,
    missingBefore: lacking.length,
    filled: 0,
    missing: lacking.length,
    requests: 0,
  };
  if (lacking.length === 0) return { ...base, status: "nothing-missing" };
  if (!backend.fetchCaptions) {
    return {
      ...base,
      status: "unsupported",
      reason: `the ${backend.name} backend returns captions with the reels; refresh the creator instead`,
    };
  }

  let filled = 0;
  let requests = 0;
  let pending = lacking;
  if (lacking.length > SINGLE_FETCH_MAX) {
    const pass = await backend.fetchCaptions(who, {
      ids: lacking.map((v) => v.id),
      minVideos: 0,
      // One request is kept back for a leftover reel.
      maxRequests: opts.maxRequests - SINGLE_FETCH_MAX,
      leave: SINGLE_FETCH_MAX,
    });
    requests = pass.requests;
    const wanted = new Set(lacking.map((v) => v.id));
    const stored = new Map(ctx.store.listVideos({ creatorId: creator.id }).map((v) => [v.id, v]));
    // The sound of stored reels comes along for free with the pages read.
    const found: Video[] = [];
    for (const post of pass.videos) {
      const row = gain(post, stored.get(post.id), who);
      if (row) found.push(row);
    }
    ctx.store.upsertVideos(found);
    filled = found.filter((v) => wanted.has(v.id) && v.caption).length;
    const seen = new Set(pass.videos.map((v) => v.id));
    pending = lacking.filter((v) => !seen.has(v.id));
  }
  if (pending.length <= SINGLE_FETCH_MAX) {
    for (const target of pending) {
      if (requests >= opts.maxRequests) break;
      requests++;
      if (await fetchSingle(ctx, backend, who, target)) filled++;
    }
  }
  return {
    ...base,
    status: "filled",
    filled,
    missing: missingCaptions(ctx, creator.id).length,
    requests,
  };
}
