import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Creator, Video } from "../src/core/types.js";
import { profileUrl, reelUrl } from "../src/core/types.js";

export function tempHome(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ig-cli-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function creator(over: Partial<Creator> & { id: string; username: string }): Creator {
  return {
    fullName: null,
    biography: null,
    followers: 1000,
    following: 10,
    mediaCount: 5,
    isVerified: false,
    isPrivate: false,
    category: null,
    externalUrl: null,
    profilePicUrl: null,
    url: profileUrl(over.username),
    ...over,
  };
}

export function video(
  over: Partial<Video> & { id: string; creatorId: string; creatorUsername: string },
): Video {
  const shortcode = over.shortcode ?? `sc${over.id}`;
  return {
    shortcode,
    url: reelUrl(shortcode),
    caption: null,
    takenAt: "2026-11-01T00:00:00.000Z",
    durationSec: 30,
    plays: 100,
    likes: 10,
    comments: 1,
    thumbnailUrl: null,
    videoUrl: null,
    ...over,
  };
}
