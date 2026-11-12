// Paging the profile's post timeline for captions. The first page (12 posts)
// arrives with the profile for free; every further page is one scroll, which
// is one budgeted request. This module decides when to stop, so that
// `--captions` costs as few scrolls as the creator's posting mix allows.

import type { Video } from "../../core/types.js";
import type { CaptionOptions, CaptionPass } from "../types.js";
import { type TimelinePage, timelinePageFromResponse, uploadMs } from "./normalize.js";

/** What has been read of one creator's timeline so far. */
export type TimelineState = {
  videos: Map<string, Video>;
  hasNext: boolean;
  /** Publication time (ms) of the oldest unpinned post read; null if none yet. */
  oldestMs: number | null;
};

export function timelineState(page: TimelinePage): TimelineState {
  return { videos: new Map(page.videos), hasNext: page.hasNext, oldestMs: page.oldestMs };
}

/** Folds one more page into the state and returns the videos it brought. */
export function addPage(state: TimelineState, page: TimelinePage): Video[] {
  for (const [id, video] of page.videos) state.videos.set(id, video);
  state.hasNext = page.hasNext;
  if (page.oldestMs !== null && (state.oldestMs === null || page.oldestMs < state.oldestMs)) {
    state.oldestMs = page.oldestMs;
  }
  return [...page.videos.values()];
}

/**
 * True when nothing more is worth reading: the minimum number of videos was
 * seen, and every wanted id was either seen or is newer than the oldest post
 * read. The grid is ordered newest first, so a wanted reel that is newer than
 * where the reading has got to, and was not seen, is not on the grid at all
 * (deleted, a trial reel, or kept off the grid) and reading on cannot find it.
 * With `leave`, that many wanted reels may still lie ahead.
 *
 * An id's upload time is at or before its publication time, so comparing it
 * with the publication time of the oldest post read can only make the reading
 * go a little too far, never stop short.
 */
export function timelineCovers(
  state: TimelineState,
  opts: Pick<CaptionOptions, "ids" | "minVideos" | "leave">,
): boolean {
  if (state.videos.size < opts.minVideos) return false;
  const oldest = state.oldestMs;
  let ahead = 0;
  for (const id of opts.ids) {
    if (state.videos.has(id)) continue;
    const uploaded = uploadMs(id);
    // Not a media id: nothing can be said about where it would be. Skip it.
    if (uploaded === null) continue;
    if (oldest === null || uploaded <= oldest) ahead++;
  }
  // The few that may still lie ahead are cheaper to fetch one by one.
  return ahead <= (opts.leave ?? 0);
}

export type PagingDeps = {
  /** Scrolls once (one budgeted request) and returns the new timeline payloads. */
  scroll: () => Promise<unknown[]>;
  /** Requests left in today's budget. */
  remaining: () => number;
};

/**
 * Requests kept back from the caption pass: the reels tab is opened right
 * after it, and a refresh that spent everything on captions would store none.
 */
export const BUDGET_RESERVE = 2;

/**
 * Scrolls until `timelineCovers`, the timeline ends, a scroll loads nothing,
 * `maxRequests` is reached or the daily budget is nearly spent. A block
 * raised by `scroll` propagates untouched: nothing is retried.
 */
export async function pageTimeline(
  state: TimelineState,
  opts: CaptionOptions,
  deps: PagingDeps,
): Promise<Pick<CaptionPass, "loaded" | "requests">> {
  const loaded = new Set<string>();
  let requests = 0;
  while (requests < opts.maxRequests && state.hasNext && !timelineCovers(state, opts)) {
    if (deps.remaining() <= BUDGET_RESERVE) break;
    requests++;
    const payloads = await deps.scroll();
    if (payloads.length === 0) break;
    for (const json of payloads) {
      for (const video of addPage(state, timelinePageFromResponse(json))) {
        loaded.add(video.id);
      }
    }
  }
  return { loaded: [...loaded], requests };
}

/** The pass as the backend returns it: everything read so far, and what this call paid for. */
export function passOf(
  state: TimelineState | undefined,
  loaded: Iterable<string>,
  requests: number,
): CaptionPass {
  return { videos: [...(state?.videos.values() ?? [])], loaded: [...new Set(loaded)], requests };
}
