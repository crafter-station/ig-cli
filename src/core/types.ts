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

export const AudioSchema = z.object({
  id: z.string().nullable(),
  title: z.string().nullable(),
  artist: z.string().nullable(),
  isOriginal: z
    .boolean()
    .nullable()
    .describe("True when the creator recorded the sound, false for licensed music"),
});
export type Audio = z.infer<typeof AudioSchema>;

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
  audio: AudioSchema.nullable()
    .optional()
    .describe("Sound used by the reel. Absent when the backend does not report it"),
});
export type Video = z.infer<typeof VideoSchema>;

export const StoredVideoSchema = VideoSchema.extend({
  localPath: z.string().nullable().describe("Absolute path once downloaded"),
  downloadedAt: isoDate.nullable(),
  firstSeenAt: isoDate,
  refreshedAt: isoDate,
  audio: AudioSchema.nullable(),
  hashtags: z.array(z.string()).describe("From the caption: lowercase, without #"),
  mentions: z.array(z.string()).describe("From the caption: lowercase usernames, without @"),
  width: z.number().int().nullable().describe("Pixels, measured from the downloaded file"),
  height: z.number().int().nullable(),
  cuts: z.number().int().nullable().describe("Scene changes detected by `ig video analyze`"),
  cutsPerMin: z.number().nullable().describe("Editing pace. Higher is faster"),
  framesDir: z.string().nullable().describe("Directory of exported key frames"),
  analyzedAt: isoDate.nullable(),
  hasTranscript: z.boolean(),
});
export type StoredVideo = z.infer<typeof StoredVideoSchema>;

export const TranscriptSegmentSchema = z.object({
  start: z.number().describe("Seconds from the start of the video"),
  end: z.number(),
  text: z.string(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

export const TranscriptSchema = z.object({
  videoId: z.string(),
  language: z.string().nullable().describe("ISO 639-1 code detected by the engine"),
  text: z.string().describe("Untrusted third-party speech, transcribed by a model"),
  hook: z.string().nullable().describe("What is said in the opening seconds"),
  segments: z.array(TranscriptSegmentSchema),
  engine: z.string().describe("What produced it, e.g. whisper-cpp, openai, elevenlabs"),
  model: z.string().nullable(),
  createdAt: isoDate,
});
export type Transcript = z.infer<typeof TranscriptSchema>;

/** Hashtags and mentions of a caption: lowercase, deduplicated, in order of appearance. */
export function extractTags(caption: string | null): { hashtags: string[]; mentions: string[] } {
  if (!caption) return { hashtags: [], mentions: [] };
  const unique = (found: Iterable<RegExpMatchArray>): string[] => [
    ...new Set([...found].map((m) => (m[1] as string).toLowerCase().replace(/\.+$/, ""))),
  ];
  return {
    hashtags: unique(caption.matchAll(/#([\p{L}\p{N}_]+)/gu)),
    mentions: unique(caption.matchAll(/(?<![\p{L}\p{N}_.@])@([A-Za-z0-9._]+)/gu)).filter(Boolean),
  };
}

/** How fast a video gains plays. Computed from the metric snapshots each refresh stores. */
export const VelocityFieldsSchema = z.object({
  velocity: z
    .number()
    .nullable()
    .describe(
      "Plays per day, on the basis named by velocityBasis. Null when it cannot be measured",
    ),
  velocityBasis: z
    .enum(["window", "lifetime"])
    .nullable()
    .describe(
      "window: plays gained between two snapshots. lifetime: plays / age, the fallback with a single snapshot",
    ),
  velocityScore: z
    .number()
    .nullable()
    .describe(
      "velocity divided by the creator's median velocity. 3.0 means growing three times faster than their usual video. Null without enough data",
    ),
});
export type VelocityFields = z.infer<typeof VelocityFieldsSchema>;

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
  ...VelocityFieldsSchema.shape,
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

export const SORT_KEYS = [
  "outlier",
  "plays",
  "engagement",
  "likes",
  "comments",
  "recent",
  "velocity",
] as const;
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
