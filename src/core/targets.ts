// What a user types to name a video: a stored media id, a shortcode or a reel
// URL. Shared by every command that takes video targets.

import type { Store } from "../db/store.js";
import { parseShortcode, type StoredVideo } from "./types.js";

/**
 * Looks a target up in the local database, first as typed (a media id or a
 * shortcode), then by the shortcode inside a URL. `shortcode` is null when the
 * target cannot be one, which is how a caller tells "unknown" from "malformed".
 */
export function findStoredVideo(
  store: Pick<Store, "findVideo">,
  target: string,
): { video: StoredVideo | null; shortcode: string | null } {
  const shortcode = parseShortcode(target);
  const video = store.findVideo(target.trim()) ?? (shortcode ? store.findVideo(shortcode) : null);
  return { video, shortcode };
}

/** Trimmed, without blanks or repeats, in the order given. */
export function uniqueTargets(targets: string[]): string[] {
  return [...new Set(targets.map((t) => t.trim()).filter(Boolean))];
}

/**
 * Shortcodes and ids come from upstream. Only a well-formed one is ever put
 * into a suggested command.
 */
export function isSafeShortcode(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}
