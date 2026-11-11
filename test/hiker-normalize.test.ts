// Normalizers against fixtures built from HikerAPI's documentation. See
// test/fixtures/hiker/README.md: these are documented shapes, not live captures.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  followersFromSocialContext,
  normalizeCandidate,
  normalizeMedia,
  normalizeUser,
  normalizeVideo,
  parseAccountsPage,
  parseBalance,
  parseClipsChunk,
  parseHashtagPage,
  parseReelsSearchPage,
  parseSuggestedProfiles,
} from "../src/backends/hiker/normalize.js";
import { CreatorSchema, VideoSchema } from "../src/core/types.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/hiker/${name}.json`, import.meta.url), "utf8"));

const clone = <T>(value: T): T => structuredClone(value);
type Json = Record<string, unknown>;

const changed = (fn: () => unknown, endpoint: string) => {
  expect(fn).toThrowError(expect.objectContaining({ code: "UPSTREAM_CHANGED" }));
  expect(fn).toThrowError(endpoint);
};

describe("normalizeUser", () => {
  it("maps the documented profile", () => {
    const creator = normalizeUser(fixture("user-by-username"), "/v1/user/by/username");
    expect(creator).toEqual({
      id: "787132",
      username: "natgeo",
      fullName: "National Geographic",
      biography: "Step into wonder and find your inner explorer with National Geographic 🌎",
      followers: 274988955,
      following: 193,
      mediaCount: 31529,
      isVerified: true,
      isPrivate: false,
      category: null,
      externalUrl: "http://visitstore.bio/natgeo",
      profilePicUrl: "https://scontent-lis1-1.cdninstagram.com/...",
      url: "https://www.instagram.com/natgeo/",
    });
    expect(() => CreatorSchema.parse(creator)).not.toThrow();
  });

  it("keeps a private profile's hidden count null and its real zero a zero", () => {
    const creator = normalizeUser(fixture("user-by-username-private"), "/v1/user/by/username");
    expect(creator).toMatchObject({
      id: "5550001111",
      isPrivate: true,
      isVerified: false,
      followers: null,
      following: 312,
      mediaCount: 0,
      fullName: null,
      biography: null,
      externalUrl: null,
      category: "Artist",
      profilePicUrl: "https://cdn.example.com/hd.jpg",
    });
  });

  it("turns omitted, negative and fractional counts into null, never 0", () => {
    const raw = clone(fixture("user-by-username")) as Json;
    delete raw.follower_count;
    raw.following_count = -1;
    raw.media_count = 12.5;
    const creator = normalizeUser(raw, "/v1/user/by/username");
    expect([creator.followers, creator.following, creator.mediaCount]).toEqual([null, null, null]);
  });

  it("rejects a user with no id or no username, naming the endpoint", () => {
    const noId = clone(fixture("user-by-username")) as Json;
    delete noId.pk;
    changed(() => normalizeUser(noId, "/v1/user/by/username"), "/v1/user/by/username");

    const noName = clone(fixture("user-by-username")) as Json;
    noName.username = null;
    changed(() => normalizeUser(noName, "/v1/user/by/username"), "/v1/user/by/username");

    changed(() => normalizeUser({ state: false, error: "x" }, "/v1/user/by/username"), "/v1/user");
    changed(() => normalizeUser(null, "/v1/user/by/username"), "/v1/user");
  });
});

describe("normalizeMedia", () => {
  it("maps the documented typed reel", () => {
    const video = normalizeVideo(fixture("media-by-code"), "/v1/media/by/code");
    expect(video).toEqual({
      id: "3776832898280228145",
      shortcode: "DRqAYKuAIUx",
      url: "https://www.instagram.com/reel/DRqAYKuAIUx/",
      creatorId: "787132",
      creatorUsername: "natgeo",
      caption:
        "Even the heaviest rain feels peaceful here.\n\n#HostilePlanet is now streaming on @DisneyPlus.",
      takenAt: "2025-11-29T22:00:31.000Z",
      durationSec: 22.31399917602539,
      plays: 2866123,
      likes: 135428,
      comments: 485,
      thumbnailUrl: "https://scontent-lax3-1.cdninstagram.com/...",
      videoUrl: "https://scontent-lax3-1.cdninstagram.com/...",
    });
    expect(() => VideoSchema.parse(video)).not.toThrow();
  });

  it("reads the timestamp string when the integer one is missing, as UTC", () => {
    const raw = clone(fixture("media-by-code")) as Json;
    delete raw.taken_at_ts;
    expect(normalizeMedia(raw, "e")?.takenAt).toBe("2025-11-29T22:00:31.000Z");
    raw.taken_at = "2025-11-29T22:00:31";
    expect(normalizeMedia(raw, "e")?.takenAt).toBe("2025-11-29T22:00:31.000Z");
    raw.taken_at = "not a date";
    expect(normalizeMedia(raw, "e")?.takenAt).toBeNull();
  });

  it("takes a raw reel's id from the string, not the 19-digit number", () => {
    const page = parseReelsSearchPage(fixture("fbsearch-reels-page1"), "/v2/fbsearch/reels");
    expect(page.items[0]).toEqual({
      id: "3838197568999826383",
      shortcode: "DVEBFp2AKPP",
      url: "https://www.instagram.com/reel/DVEBFp2AKPP/",
      creatorId: "787132",
      creatorUsername: "natgeo",
      caption:
        "No matter the time of day, a butterfly is always a beautiful sight 🦋\n\n#IncredibleAnimalJourneys is streaming on @DisneyPlus.",
      takenAt: "2026-02-22T14:01:15.000Z",
      durationSec: 11.156999588012695,
      plays: 3314829,
      likes: 222423,
      comments: 573,
      thumbnailUrl: "https://scontent-dfw6-1.cdninstagram.com/...",
      videoUrl: "https://scontent-dfw6-1.cdninstagram.com/...",
    });
    expect(page.items[1]).toMatchObject({ id: "3806000000000000777", caption: null });
  });

  it("refuses a raw id that survives only as an imprecise number", () => {
    const raw = JSON.parse(
      '{"media_type":2,"pk":3838197568999826383,"code":"abc","user":{"pk":1,"username":"u"}}',
    );
    changed(() => normalizeMedia(raw, "/v2/fbsearch/reels"), "/v2/fbsearch/reels");
  });

  it("returns null for photos and carousels", () => {
    expect(normalizeMedia({ media_type: 1, pk: "1", code: "a" }, "e")).toBeNull();
    expect(normalizeMedia({ media_type: 8, pk: "1", code: "a" }, "e")).toBeNull();
  });

  it("keeps hidden and omitted counts null and a real zero a zero", () => {
    const { items } = parseClipsChunk(fixture("clips-chunk-page1"), "/v1/user/clips/chunk");
    const hidden = items.find((v) => v.shortcode === "HIDDENcnt03");
    expect(hidden).toMatchObject({
      likes: null,
      plays: null,
      comments: null,
      durationSec: null,
      caption: null,
      thumbnailUrl: "https://cdn.example.com/hidden-thumb.jpg",
      // No ready URL: the largest rendition wins.
      videoUrl: "https://cdn.example.com/hidden-720.mp4",
    });

    const page2 = parseClipsChunk(fixture("clips-chunk-page2"), "/v1/user/clips/chunk");
    expect(page2.items[0]).toMatchObject({ shortcode: "MARCHreel04", plays: 0, likes: 310 });

    const searched = parseReelsSearchPage(fixture("fbsearch-reels-page2"), "/v2/fbsearch/reels");
    expect(searched.items[1]).toMatchObject({
      shortcode: "HIDDENsrch1",
      likes: null,
      plays: null,
      comments: null,
      thumbnailUrl: null,
      videoUrl: null,
    });
  });

  it("keeps a zero like count when counts are not hidden", () => {
    const raw = clone(fixture("media-by-code")) as Json;
    raw.like_count = 0;
    expect(normalizeMedia(raw, "e")?.likes).toBe(0);
  });

  it("rejects a video with no id, no shortcode, no owner or no media_type", () => {
    const base = fixture("media-by-code") as Json;
    for (const strip of [["pk", "id"], ["code"], ["user"], ["media_type"]]) {
      const raw = clone(base);
      for (const key of strip) delete raw[key];
      changed(() => normalizeMedia(raw, "/v1/media/by/code"), "/v1/media/by/code");
    }
    const noOwnerName = clone(base);
    (noOwnerName.user as Json).username = "";
    changed(() => normalizeMedia(noOwnerName, "/v1/media/by/code"), "/v1/media/by/code");
  });

  it("normalizeVideo refuses a photo as NOT_FOUND", () => {
    const raw = clone(fixture("media-by-code")) as Json;
    raw.media_type = 1;
    expect(() => normalizeVideo(raw, "/v1/media/by/code")).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
  });
});

describe("page parsers", () => {
  it("clips chunk: skips the photo, keeps the cursor, reports the raw count", () => {
    const page = parseClipsChunk(fixture("clips-chunk-page1"), "/v1/user/clips/chunk");
    expect(page.items.map((v) => v.shortcode)).toEqual([
      "PINNEDold01",
      "DW1F7dciplI",
      "HIDDENcnt03",
    ]);
    expect(page.rawCount).toBe(4);
    expect(page.next).toMatch(/^QVFBS1/);
    expect(parseClipsChunk(fixture("clips-chunk-page2"), "e").next).toBeNull();
  });

  it("clips chunk: rejects anything that is not [items, cursor]", () => {
    const endpoint = "/v1/user/clips/chunk";
    changed(() => parseClipsChunk({ items: [] }, endpoint), endpoint);
    changed(() => parseClipsChunk([[]], endpoint), endpoint);
    changed(() => parseClipsChunk([{}, null], endpoint), endpoint);
    changed(() => parseClipsChunk([[], 7], endpoint), endpoint);
    expect(parseClipsChunk([[], null], endpoint)).toEqual({ items: [], rawCount: 0, next: null });
  });

  it("accounts: parses rounded follower text and nulls what is not a count", () => {
    const page1 = parseAccountsPage(fixture("fbsearch-accounts-page1"), "/v2/fbsearch/accounts");
    expect(page1.next).toBe("e129a3f7111a4420a8b747d255c4e32c");
    expect(page1.items[0]).toEqual({
      id: "787132",
      username: "natgeo",
      fullName: "National Geographic",
      followers: 274_000_000,
      isVerified: true,
      isPrivate: false,
    });
    expect(page1.items.map((u) => u.followers)).toEqual([274_000_000, 7_300_000, 45_500_000]);

    const page2 = parseAccountsPage(fixture("fbsearch-accounts-page2"), "/v2/fbsearch/accounts");
    // has_more is false: the page_token that is still present must be ignored.
    expect(page2.next).toBeNull();
    expect(page2.items.map((u) => [u.username, u.followers, u.isPrivate])).toEqual([
      ["natgeotravel", 45_500_000, false],
      ["natgeo.fan.private", null, true],
      ["smallnatgeoclub", 1234, false],
      ["nocontext", null, false],
    ]);
    expect(page2.items[1]?.fullName).toBeNull();
  });

  it("followersFromSocialContext accepts only the documented form", () => {
    expect(followersFromSocialContext("1 follower")).toBe(1);
    expect(followersFromSocialContext("999 followers")).toBe(999);
    expect(followersFromSocialContext("12.5K followers")).toBe(12_500);
    expect(followersFromSocialContext("1.2B followers")).toBe(1_200_000_000);
    for (const bad of [
      "Justin Bieber",
      "274M seguidores",
      "followers",
      "-5 followers",
      "",
      12,
      null,
    ]) {
      expect(followersFromSocialContext(bad)).toBeNull();
    }
  });

  it("accounts and suggestions: reject a wrong envelope or a half-formed user", () => {
    changed(
      () => parseAccountsPage({ status: "ok" }, "/v2/fbsearch/accounts"),
      "/v2/fbsearch/accounts",
    );
    changed(() => parseAccountsPage([], "/v2/fbsearch/accounts"), "/v2/fbsearch/accounts");
    changed(() => normalizeCandidate({ username: "x" }, "/v2/fbsearch/accounts"), "/v2/fbsearch");
    changed(() => normalizeCandidate({ id: "1" }, "/v2/fbsearch/accounts"), "/v2/fbsearch");
    changed(
      () => parseSuggestedProfiles({ users: null }, "/v2/user/suggested/profiles"),
      "/v2/user/suggested/profiles",
    );
  });

  it("suggested profiles: a display name in social_context is not a follower count", () => {
    const users = parseSuggestedProfiles(
      fixture("suggested-profiles"),
      "/v2/user/suggested/profiles",
    );
    expect(users).toHaveLength(3);
    expect(users[1]).toEqual({
      id: "6860189",
      username: "lilbieber",
      fullName: "Justin Bieber",
      followers: null,
      isVerified: true,
      isPrivate: false,
    });
  });

  it("reel search: carries both cursor values and stops when has_more is false", () => {
    const page1 = parseReelsSearchPage(fixture("fbsearch-reels-page1"), "/v2/fbsearch/reels");
    expect(page1.next).toEqual({
      reelsMaxId: "r:80d6f6da6d8246fda9ad58a8e8d3c6c7",
      rankToken: "47d590f0-b44c-4428-952d-4e5422909af8",
    });
    expect(page1.rawCount).toBe(2);
    const page2 = parseReelsSearchPage(fixture("fbsearch-reels-page2"), "/v2/fbsearch/reels");
    expect(page2.next).toBeNull();
  });

  it("reel search: rejects a missing module list or a clip with no media", () => {
    const endpoint = "/v2/fbsearch/reels";
    changed(() => parseReelsSearchPage({ status: "ok" }, endpoint), endpoint);
    changed(
      () => parseReelsSearchPage({ reels_serp_modules: [{ clips: [{}] }] }, endpoint),
      endpoint,
    );
    expect(
      parseReelsSearchPage({ reels_serp_modules: [{ module_type: "other" }] }, endpoint),
    ).toEqual({
      items: [],
      rawCount: 0,
      next: null,
    });
  });

  it("hashtag: skips the carousel and leaves an omitted play count null", () => {
    const page = parseHashtagPage(fixture("hashtag-medias-page1"), "/g2/hashtag/medias");
    expect(page.rawCount).toBe(3);
    expect(page.items.map((v) => [v.id, v.shortcode, v.plays, v.comments])).toEqual([
      ["3000000000000000001", "SYN00000001", 4694710, 641],
      ["3000000000000000044", "SYN00000004", null, 0],
    ]);
    expect(page.items[0]).toMatchObject({
      creatorId: "10000000002",
      creatorUsername: "user_001",
      takenAt: "2025-09-18T20:33:17.000Z",
      videoUrl: "https://cdn.example.com/syn-001.mp4",
    });
    expect(page.next).toMatch(/^d922f3/);
    changed(() => parseHashtagPage({ items: [] }, "/g2/hashtag/medias"), "/g2/hashtag/medias");
  });

  it("balance: requires the request count", () => {
    expect(parseBalance(fixture("balance"), "/sys/balance")).toEqual({
      requests: 1992006,
      rate: 15,
      currency: "USD",
      amount: 916.3235,
    });
    changed(() => parseBalance(fixture("error-401"), "/sys/balance"), "/sys/balance");
  });
});
