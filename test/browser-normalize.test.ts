// Fixtures are trimmed live captures of Instagram's web app (2026-11-11),
// stripped of viewer data and URL signatures. See test/fixtures/browser/README.md.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  blockSignal,
  candidatesFromChaining,
  candidatesFromSearch,
  mergeTimeline,
  parseFollowerText,
  profileFromResponse,
  reelsFromResponse,
  serpFromResponse,
  takenAtFromPk,
  timelineFromResponse,
  videoFromMedia,
  videoFromWebInfo,
} from "../src/backends/browser/normalize.js";
import type { IgError } from "../src/lib/errors.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "browser", name), "utf8"));

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    return (err as IgError).code;
  }
  return "none";
};

const owner = { id: "3532778", username: "jamieoliver" };

describe("profile", () => {
  it("reads the profile query", () => {
    const p = profileFromResponse(fixture("profile.json"));
    expect(p).toMatchObject({
      id: "3532778",
      username: "jamieoliver",
      fullName: "Jamie Oliver",
      followers: 10570949,
      following: 4385,
      mediaCount: 11681,
      isVerified: true,
      isPrivate: false,
      externalUrl: "https://linktr.ee/jamieoliver",
      url: "https://www.instagram.com/jamieoliver/",
    });
    expect(p.biography).toBeTruthy();
    expect(p.profilePicUrl).toMatch(/^https:\/\//);
  });

  it("fails loudly when the shape is gone, instead of returning an empty creator", () => {
    expect(code(() => profileFromResponse({ data: {} }))).toBe("UPSTREAM_CHANGED");
    expect(code(() => profileFromResponse({ data: { user: { username: "x" } } }))).toBe(
      "UPSTREAM_CHANGED",
    );
    expect(code(() => profileFromResponse(null))).toBe("UPSTREAM_CHANGED");
  });
});

describe("reels", () => {
  const page = reelsFromResponse(fixture("reels.json"), owner);

  it("reads play, like and comment counts from the reels tab", () => {
    expect(page.hasNext).toBe(true);
    expect(page.items).toHaveLength(5);
    expect(page.items[0]).toMatchObject({
      id: "3485895473040538296",
      shortcode: "DBgY3ayuTq4",
      url: "https://www.instagram.com/reel/DBgY3ayuTq4/",
      creatorId: "3532778",
      creatorUsername: "jamieoliver",
      plays: 782504,
      likes: 14681,
      comments: 203,
      caption: null,
      videoUrl: null,
    });
  });

  it("derives the date from the media id when the surface omits it", () => {
    // The reel page reports taken_at 1729771201 for this same reel.
    const derived = Date.parse(page.items[0]?.takenAt ?? "");
    expect(Math.abs(derived - 1729771201_000)).toBeLessThan(5 * 60_000);
    expect(takenAtFromPk("not-a-pk")).toBeNull();
  });

  it("reads the pagination response the same way", () => {
    const more = reelsFromResponse(fixture("reels-more.json"), owner);
    expect(more.items.length).toBeGreaterThan(0);
    expect(more.items.every((v) => v.plays !== null)).toBe(true);
  });

  it("files a collaboration under the creator whose tab lists it", () => {
    const raw = fixture("reels-more.json") as {
      data: {
        fetch__XDTUserDict: {
          clips_connection: { edges: { node: { media: { user: { pk: string } } } }[] };
        };
      };
    };
    const authors = raw.data.fetch__XDTUserDict.clips_connection.edges.map(
      (e) => e.node.media.user.pk,
    );
    expect(authors).toContain("24400264611");
    const more = reelsFromResponse(raw, owner);
    expect(new Set(more.items.map((v) => v.creatorId))).toEqual(new Set(["3532778"]));
    expect(new Set(more.items.map((v) => v.creatorUsername))).toEqual(new Set(["jamieoliver"]));
  });

  it("returns an empty page for an account with no reels, and fails on a changed shape", () => {
    const empty = { data: { fetch__XDTUserDict: { clips_connection: { edges: [] } } } };
    expect(reelsFromResponse(empty, owner)).toEqual({ items: [], hasNext: false });
    expect(code(() => reelsFromResponse({ data: {} }, owner))).toBe("UPSTREAM_CHANGED");
    const garbage = {
      data: { fetch__XDTUserDict: { clips_connection: { edges: [{ node: { other: 1 } }] } } },
    };
    expect(code(() => reelsFromResponse(garbage, owner))).toBe("UPSTREAM_CHANGED");
  });

  it("reports hidden like and play counts as null, never as zero", () => {
    const hidden = videoFromMedia({
      pk: "3485895473040538296",
      code: "abc",
      media_type: 2,
      user: { pk: "1", username: "u" },
      like_and_view_counts_disabled: true,
      play_count: 0,
      like_count: 0,
      comment_count: 7,
    });
    expect(hidden).toMatchObject({ plays: null, likes: null, comments: 7 });
  });
});

describe("timeline merge", () => {
  const timeline = timelineFromResponse(fixture("timeline.json"));
  const reels = reelsFromResponse(fixture("reels.json"), owner).items;

  it("keeps only videos from a timeline that mixes photos and carousels", () => {
    expect([...timeline.keys()].sort()).toEqual([
      "3927465820040561085",
      "4026641251917986362",
      "4027454424454836023",
    ]);
  });

  it("captions the reels the timeline knows and leaves the rest untouched", () => {
    const merged = mergeTimeline(reels, timeline);
    const known = merged.find((v) => v.id === "4027454424454836023");
    const unknown = merged.find((v) => v.id === "3485895473040538296");
    expect(known?.caption).toBeTruthy();
    expect(known?.videoUrl).toMatch(/^https:\/\//);
    expect(known?.plays).toBe(445852);
    expect(unknown?.caption).toBeNull();
    expect(unknown?.videoUrl).toBeNull();
    expect(unknown?.plays).toBe(782504);
    expect(mergeTimeline(reels, undefined)).toBe(reels);
  });
});

describe("keyword results", () => {
  it("returns the videos with their authors and skips photos", () => {
    const page = serpFromResponse(fixture("serp.json"));
    expect(page.hasNext).toBe(true);
    expect(page.items).toHaveLength(17);
    const v = page.items[0];
    expect(v).toMatchObject({
      shortcode: "DUb2fq8kWkO",
      creatorId: "72568863276",
      creatorUsername: "alejandrotuchef",
      plays: null,
      likes: 1936,
      comments: 7,
    });
    expect(v?.caption).toBeTruthy();
    expect(v?.videoUrl).toMatch(/^https:\/\//);
    expect(v?.takenAt).toBe("2026-02-06T23:40:12.000Z");
  });

  it("fails on a changed shape", () => {
    expect(code(() => serpFromResponse({ data: { something_else: {} } }))).toBe("UPSTREAM_CHANGED");
  });
});

describe("reel page", () => {
  it("finds the reel inside the embedded page data, however deep", () => {
    const v = videoFromWebInfo(fixture("reel-page.json"));
    expect(v).toMatchObject({
      id: "3485895473040538296",
      shortcode: "DBgY3ayuTq4",
      creatorUsername: "jamieoliver",
      takenAt: "2024-10-24T12:00:01.000Z",
      likes: 14681,
      plays: null,
    });
    expect(v?.videoUrl).toMatch(/^https:\/\//);
    expect(v?.caption).toBeTruthy();
  });

  it("returns null when the page carries no reel", () => {
    expect(videoFromWebInfo({ require: [] })).toBeNull();
    expect(videoFromWebInfo({ xdt_api__v1__media__shortcode__web_info: { items: [] } })).toBeNull();
  });
});

describe("account search", () => {
  it("reads accounts and only the follower-count snippet", () => {
    const hits = candidatesFromSearch(fixture("account-search.json"));
    expect(hits.map((h) => [h.username, h.followers])).toEqual([
      ["cocinaenuna", 207_000],
      ["pisu.cocina", 1_800_000],
      ["cocina.cesar", 1_400_000],
      ["cocina.lab", null],
      // This snippet is about the viewer's social graph: not a count, not read.
      ["galano.peru", null],
    ]);
    expect(hits[0]).toMatchObject({ id: "19502644402", isVerified: true, isPrivate: false });
  });

  it("parses localized follower text and refuses what it does not recognize", () => {
    expect(parseFollowerText("207 mil seguidores")).toBe(207_000);
    expect(parseFollowerText("1,8 mill. seguidores")).toBe(1_800_000);
    expect(parseFollowerText("12.3K followers")).toBe(12_300);
    expect(parseFollowerText("274M followers")).toBe(274_000_000);
    expect(parseFollowerText("1,234 followers")).toBe(1234);
    expect(parseFollowerText("987 seguidores")).toBe(987);
    expect(parseFollowerText("ana sigue a este usuario")).toBeNull();
    expect(parseFollowerText("3 zillion followers")).toBeNull();
    expect(parseFollowerText(null)).toBeNull();
  });

  it("fails on a changed shape", () => {
    expect(code(() => candidatesFromSearch({ data: {} }))).toBe("UPSTREAM_CHANGED");
  });
});

describe("related accounts", () => {
  it("reads suggested accounts without follower counts", () => {
    const related = candidatesFromChaining(fixture("related.json"));
    expect(related).toHaveLength(4);
    expect(related[0]).toMatchObject({
      username: "thegrahamnortonshowofficial",
      followers: null,
      isVerified: true,
    });
  });
});

describe("block signals", () => {
  it("recognizes Instagram's own refusals inside a 200 response", () => {
    expect(
      blockSignal({ message: "Please wait a few minutes before you try again.", status: "fail" }),
    ).toMatchObject({ reason: "RATE_LIMITED" });
    expect(blockSignal({ message: "checkpoint_required", status: "fail" })).toMatchObject({
      reason: "CHECKPOINT",
    });
    expect(blockSignal({ message: "feedback_required", spam: true, status: "fail" })).toMatchObject(
      { reason: "RATE_LIMITED" },
    );
  });

  it("does not mistake normal data for a refusal", () => {
    expect(blockSignal(fixture("profile.json"))).toBeNull();
    expect(blockSignal({ status: "ok" })).toBeNull();
    expect(blockSignal(null)).toBeNull();
  });
});
