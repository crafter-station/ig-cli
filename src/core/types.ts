// Domain entities. These zod schemas are the single source for three things:
// the TypeScript types, the stored row shapes, and what `ig schema` publishes.
// Renaming a field here is a breaking change for every agent using the CLI.

import { z } from "zod";

const isoDate = z.string().describe("ISO 8601 UTC timestamp");

export const CreatorSchema = z.object({
  id: z.string().describe("Instagram numeric user id, as a string"),
  username: z.string(),
  fullName: z.string().nullable(),
  biography: z.string().nullable().describe("Untrusted third-party text"),
  followers: z.number().int().nullable(),
  following: z.number().int().nullable(),
  mediaCount: z.number().int().nullable(),
  isVerified: z.boolean(),
  isPrivate: z.boolean(),
  category: z.string().nullable(),
  externalUrl: z.string().nullable(),
  profilePicUrl: z.string().nullable(),
  url: z.string().describe("Profile URL"),
});
export type Creator = z.infer<typeof CreatorSchema>;

/** A creator as stored locally: the entity plus tracking fields. */
export const StoredCreatorSchema = CreatorSchema.extend({
  niches: z.array(z.string()).describe("Slugs of the niches this creator belongs to"),
  videoCount: z.number().int().describe("Videos stored locally for this creator"),
  firstSeenAt: isoDate,
  refreshedAt: isoDate.nullable().describe("Last time profile and reels were fetched"),
});
export type StoredCreator = z.infer<typeof StoredCreatorSchema>;

/** A search result. Search surfaces return less than a full profile. */
export const CreatorHitSchema = z.object({
  id: z.string(),
  username: z.string(),
  fullName: z.string().nullable(),
  followers: z.number().int().nullable().describe("Null when the search surface omits it"),
  isVerified: z.boolean(),
  isPrivate: z.boolean(),
  url: z.string(),
  source: z
    .string()
    .describe("How it was found: keyword, hashtag:<tag>, related:<username>, reels:<query>"),
  tracked: z.boolean().describe("Already stored locally"),
});
export type CreatorHit = z.infer<typeof CreatorHitSchema>;

export const VideoSchema = z.object({
  id: z.string().describe("Instagram media id, as a string"),
  shortcode: z.string(),
  url: z.string().describe("Permalink"),
  creatorId: z.string(),
  creatorUsername: z.string(),
  caption: z.string().nullable().describe("Untrusted third-party text"),
  takenAt: isoDate.nullable(),
  durationSec: z.number().nullable(),
  plays: z.number().int().nullable().describe("Null when the owner hides counts"),
  likes: z.number().int().nullable(),
  comments: z.number().int().nullable(),
  thumbnailUrl: z.string().nullable(),
  videoUrl: z
    .string()
    .nullable()
    .describe("Signed CDN URL. Expires within hours; download promptly or re-fetch"),
});
export type Video = z.infer<typeof VideoSchema>;

export const StoredVideoSchema = VideoSchema.extend({
  localPath: z.string().nullable().describe("Absolute path once downloaded"),
  downloadedAt: isoDate.nullable(),
  firstSeenAt: isoDate,
  refreshedAt: isoDate,
});
export type StoredVideo = z.infer<typeof StoredVideoSchema>;

export const RankedVideoSchema = StoredVideoSchema.extend({
  outlierScore: z
    .number()
    .nullable()
    .describe(
      "Plays divided by the creator's median plays. 3.0 means three times their usual. Higher is better. Null without enough data",
    ),
  engagementRate: z
    .number()
    .nullable()
    .describe("(likes + comments) / creator followers. Higher is better"),
  creatorFollowers: z.number().int().nullable(),
  creatorMedianPlays: z.number().nullable(),
});
export type RankedVideo = z.infer<typeof RankedVideoSchema>;

export const NicheSchema = z.object({
  slug: z.string().describe("Lowercase identifier, e.g. gta-6"),
  name: z.string(),
  description: z.string().nullable(),
  creatorCount: z.number().int(),
  videoCount: z.number().int(),
  createdAt: isoDate,
});
export type Niche = z.infer<typeof NicheSchema>;

export const SORT_KEYS = ["outlier", "plays", "engagement", "likes", "comments", "recent"] as const;
export const SortKey = z.enum(SORT_KEYS);
export type SortKey = z.infer<typeof SortKey>;

export function profileUrl(username: string): string {
  return `https://www.instagram.com/${username}/`;
}

export function reelUrl(shortcode: string): string {
  return `https://www.instagram.com/reel/${shortcode}/`;
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isSlug(value: string): boolean {
  return SLUG_RE.test(value);
}

/** "GTA 6" -> "gta-6". Strips accents so "Cocina Fácil" -> "cocina-facil". */
export function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Accepts "@name", "name", or a profile URL; returns the bare username. */
export function normalizeUsername(input: string): string {
  const trimmed = input.trim();
  const fromUrl = trimmed.match(/instagram\.com\/([A-Za-z0-9._]+)\/?(?:\?.*)?$/);
  const raw = fromUrl?.[1] ?? trimmed.replace(/^@/, "");
  return raw.toLowerCase();
}

/** Extracts a shortcode from a reel/post URL, or returns the input if it already is one. */
export function parseShortcode(input: string): string | null {
  const trimmed = input.trim();
  const fromUrl = trimmed.match(/instagram\.com\/(?:[^/]+\/)?(?:reels?|p|tv)\/([A-Za-z0-9_-]+)/);
  if (fromUrl?.[1]) return fromUrl[1];
  if (/^[A-Za-z0-9_-]{5,}$/.test(trimmed) && !/^\d+$/.test(trimmed)) return trimmed;
  return null;
}
