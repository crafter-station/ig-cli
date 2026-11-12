// Filters over stored videos, shared by every command that lists or ranks
// them: one set of flags, one meaning. Different flags combine with AND;
// several values of one flag match ANY of them.

import type { Command } from "commander";
import { z } from "zod";
import { IgError } from "../lib/errors.js";
import type { StoredVideo } from "./types.js";

export type VideoFilters = {
  hashtag?: string[];
  mention?: string[];
  audio?: string;
  minDuration?: number;
  maxDuration?: number;
};

/** "#Pasta, receta" or ["#Pasta", "receta"] -> ["pasta", "receta"]. */
export function normalizeTags(value: string | string[], sigil: "#" | "@"): string[] {
  const parts = (Array.isArray(value) ? value : [value])
    .flatMap((v) => v.split(","))
    .map((v) =>
      v
        .trim()
        .replace(sigil === "#" ? /^#+/ : /^@+/, "")
        .toLowerCase(),
    )
    .filter(Boolean);
  return [...new Set(parts)];
}

const tagList = (sigil: "#" | "@", what: string) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform((value, ctx) => {
      const tags = normalizeTags(value, sigil);
      if (tags.length === 0) {
        ctx.addIssue({ code: "custom", message: `give at least one ${what}` });
        return z.NEVER;
      }
      return tags;
    })
    .optional();

/** Spread into a command's `z.object({ ... })`. */
export const filterFlags = {
  hashtag: tagList("#", "hashtag").describe(
    "Only videos whose caption uses any of these hashtags. Without #, case-insensitive; a list or comma-separated",
  ),
  mention: tagList("@", "username").describe(
    "Only videos whose caption mentions any of these usernames. Without @; a list or comma-separated",
  ),
  audio: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Only videos using this sound: an exact audio id, or part of its title or artist"),
  minDuration: z.coerce
    .number()
    .min(0)
    .optional()
    .describe("Only videos at least this many seconds long. Unmeasured videos never match"),
  maxDuration: z.coerce
    .number()
    .min(0)
    .optional()
    .describe("Only videos at most this many seconds long. Unmeasured videos never match"),
};

const collect = (value: string, previous: string[] | undefined): string[] => [
  ...(previous ?? []),
  value,
];

/** Declares the filter flags on a commander command. */
export function addFilterOptions(cmd: Command, prefix = ""): Command {
  return cmd
    .option(
      "--hashtag <tag>",
      `${prefix}only videos using this hashtag (repeat or comma-separate for any of several)`,
      collect,
    )
    .option(
      "--mention <username>",
      `${prefix}only videos mentioning this account (repeat or comma-separate)`,
      collect,
    )
    .option(
      "--audio <id-or-text>",
      `${prefix}only videos using this sound: id, or part of title/artist`,
    )
    .option("--min-duration <sec>", `${prefix}only videos at least this long`)
    .option("--max-duration <sec>", `${prefix}only videos at most this long`);
}

/** The flags in use, as their CLI names. */
export function usedFilterFlags(f: VideoFilters): string[] {
  const used: string[] = [];
  if (f.hashtag?.length) used.push("--hashtag");
  if (f.mention?.length) used.push("--mention");
  if (f.audio !== undefined && f.audio !== "") used.push("--audio");
  if (f.minDuration !== undefined) used.push("--min-duration");
  if (f.maxDuration !== undefined) used.push("--max-duration");
  return used;
}

export function hasFilters(f: VideoFilters): boolean {
  return usedFilterFlags(f).length > 0;
}

export function hasDurationFilter(f: VideoFilters): boolean {
  return f.minDuration !== undefined || f.maxDuration !== undefined;
}

export function checkFilters(f: VideoFilters): void {
  if (f.minDuration !== undefined && f.maxDuration !== undefined && f.minDuration > f.maxDuration) {
    throw new IgError(
      "INVALID_INPUT",
      `--min-duration (${f.minDuration}) is greater than --max-duration (${f.maxDuration}).`,
      { hint: "Swap them, e.g. `--min-duration 15 --max-duration 30`." },
    );
  }
}

export function filterVideos<T extends StoredVideo>(videos: T[], f: VideoFilters): T[] {
  if (!hasFilters(f)) return videos;
  const hashtags = f.hashtag?.length ? new Set(f.hashtag.map((t) => t.toLowerCase())) : null;
  const mentions = f.mention?.length ? new Set(f.mention.map((t) => t.toLowerCase())) : null;
  const audio = f.audio ? f.audio : null;
  const needle = audio?.toLowerCase() ?? "";
  const { minDuration: min, maxDuration: max } = f;

  return videos.filter((v) => {
    if (hashtags && !v.hashtags.some((t) => hashtags.has(t.toLowerCase()))) return false;
    if (mentions && !v.mentions.some((m) => mentions.has(m.toLowerCase()))) return false;
    if (audio !== null) {
      const a = v.audio;
      if (!a) return false;
      const matches =
        a.id === audio ||
        (a.title?.toLowerCase().includes(needle) ?? false) ||
        (a.artist?.toLowerCase().includes(needle) ?? false);
      if (!matches) return false;
    }
    if (min !== undefined || max !== undefined) {
      if (v.durationSec === null) return false;
      if (min !== undefined && v.durationSec < min) return false;
      if (max !== undefined && v.durationSec > max) return false;
    }
    return true;
  });
}

/**
 * Quoted unless plainly safe, so the text can be pasted into a shell line.
 * Single quotes: nothing inside them is expanded by sh or PowerShell.
 */
function shellValue(value: string): string {
  if (/^[\p{L}\p{N}_.,-]+$/u.test(value)) return value;
  return `'${value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/'/g, "")}'`;
}

/** The filters as they would be typed, with a leading space; "" when none. */
export function filterFlagsText(f: VideoFilters): string {
  const parts: string[] = [];
  if (f.hashtag?.length) parts.push(`--hashtag ${shellValue(f.hashtag.join(","))}`);
  if (f.mention?.length) parts.push(`--mention ${shellValue(f.mention.join(","))}`);
  if (f.audio !== undefined && f.audio !== "") parts.push(`--audio ${shellValue(f.audio)}`);
  if (f.minDuration !== undefined) parts.push(`--min-duration ${f.minDuration}`);
  if (f.maxDuration !== undefined) parts.push(`--max-duration ${f.maxDuration}`);
  return parts.length ? ` ${parts.join(" ")}` : "";
}
