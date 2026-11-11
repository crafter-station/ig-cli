// Refreshing one creator: fetch the profile, fetch recent reels, store both
// with a metrics snapshot. Shared by `niche refresh`, `creator get --refresh`
// and `video list --refresh` so the freshness rule lives in one place.

import type { Backend } from "../backends/types.js";
import type { Context } from "../context.js";
import { ago } from "../lib/format.js";
import type { StoredCreator } from "./types.js";

export type RefreshOutcome = {
  username: string;
  status: "refreshed" | "skipped";
  /** Why it was skipped; null when refreshed. */
  reason: string | null;
  followers: number | null;
  newVideos: number;
  totalVideos: number;
};

const DAY_MS = 86_400_000;

/**
 * The browser backend spends a real account's goodwill, so it will not
 * re-fetch a creator refreshed within `minRefreshDays`. Paid backends carry no
 * such risk and are never held back.
 */
export function isFresh(ctx: Context, backend: Backend, creator: StoredCreator): boolean {
  if (backend.name !== "browser" || !creator.refreshedAt) return false;
  const age = Date.now() - Date.parse(creator.refreshedAt);
  return age < ctx.config.minRefreshDays * DAY_MS;
}

/**
 * Costs one request for the profile plus one or more for reels. Skips without
 * any request when the creator is fresh and `force` is false. Backend errors
 * propagate: the caller decides whether one failure ends a batch. Block errors
 * (exit code BLOCKED) must always end it.
 */
export async function refreshCreator(
  ctx: Context,
  backend: Backend,
  creator: StoredCreator,
  opts: { reels: number; force: boolean },
): Promise<RefreshOutcome> {
  if (!opts.force && isFresh(ctx, backend, creator)) {
    return {
      username: creator.username,
      status: "skipped",
      reason: `refreshed ${ago(creator.refreshedAt)}; use --force to refresh anyway`,
      followers: creator.followers,
      newVideos: 0,
      totalVideos: creator.videoCount,
    };
  }

  const profile = await backend.getProfile(creator.username);
  let newVideos = 0;
  if (opts.reels > 0 && !profile.isPrivate) {
    const reels = await backend.listReels(
      { id: profile.id, username: profile.username },
      { limit: opts.reels },
    );
    // Store the profile first: videos reference the creator row.
    ctx.store.upsertCreator(profile);
    newVideos = ctx.store.upsertVideos(reels).inserted;
  } else {
    ctx.store.upsertCreator(profile);
  }

  const stored = ctx.store.getCreator(profile.id);
  return {
    username: stored.username,
    status: "refreshed",
    reason: null,
    followers: stored.followers,
    newVideos,
    totalVideos: stored.videoCount,
  };
}
