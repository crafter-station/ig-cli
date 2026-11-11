import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/db/store.js";
import { IgError } from "../src/lib/errors.js";
import { creator, video } from "./helpers.js";

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => store.close());

describe("niches", () => {
  it("rejects a duplicate slug", () => {
    store.createNiche({ slug: "cocina", name: "Cocina" });
    expect(() => store.createNiche({ slug: "cocina", name: "x" })).toThrowError(IgError);
  });

  it("reports NOT_FOUND with a hint for an unknown niche", () => {
    try {
      store.getNiche("nope");
      expect.unreachable();
    } catch (err) {
      expect((err as IgError).code).toBe("NOT_FOUND");
      expect((err as IgError).hint).toContain("ig niche create nope");
    }
  });

  it("counts creators and videos, and a creator can be in several niches", () => {
    store.createNiche({ slug: "cocina", name: "Cocina" });
    store.createNiche({ slug: "gta-6", name: "GTA 6" });
    store.upsertCreator(creator({ id: "1", username: "ana" }));
    store.upsertCreator(creator({ id: "2", username: "beto" }));
    expect(store.addCreatorToNiche("1", "cocina")).toBe(true);
    expect(store.addCreatorToNiche("1", "cocina")).toBe(false);
    store.addCreatorToNiche("1", "gta-6");
    store.addCreatorToNiche("2", "cocina");
    store.upsertVideos([video({ id: "10", creatorId: "1", creatorUsername: "ana" })]);

    const bySlug = Object.fromEntries(store.listNiches().map((n) => [n.slug, n]));
    expect(bySlug.cocina).toMatchObject({ creatorCount: 2, videoCount: 1 });
    expect(bySlug["gta-6"]).toMatchObject({ creatorCount: 1, videoCount: 1 });
    expect(store.getCreator("ana").niches).toEqual(["cocina", "gta-6"]);
    expect(store.listCreators({ niche: "gta-6" }).map((c) => c.username)).toEqual(["ana"]);
  });
});

describe("creators", () => {
  it("a partial upsert never erases known values", () => {
    store.upsertCreator(creator({ id: "1", username: "ana", followers: 5000, biography: "chef" }));
    store.upsertCreator(creator({ id: "1", username: "ana", followers: null, biography: null }), {
      refreshed: false,
    });
    const got = store.getCreator("ana");
    expect(got.followers).toBe(5000);
    expect(got.biography).toBe("chef");
    expect(got.refreshedAt).not.toBeNull();
  });

  it("a creator stored from a search hit has no refreshedAt", () => {
    store.upsertCreator(creator({ id: "1", username: "ana" }), { refreshed: false });
    expect(store.getCreator("1").refreshedAt).toBeNull();
  });

  it("sorts by followers with unknown counts last", () => {
    store.upsertCreator(creator({ id: "1", username: "small", followers: 10 }));
    store.upsertCreator(creator({ id: "2", username: "unknown", followers: null }));
    store.upsertCreator(creator({ id: "3", username: "big", followers: 9000 }));
    expect(store.listCreators().map((c) => c.username)).toEqual(["big", "small", "unknown"]);
  });

  it("deleting a creator removes videos and search rows, and reports files left on disk", () => {
    store.upsertCreator(creator({ id: "1", username: "ana" }));
    store.upsertVideos([
      video({ id: "10", creatorId: "1", creatorUsername: "ana", caption: "pasta fresca" }),
      video({ id: "11", creatorId: "1", creatorUsername: "ana" }),
    ]);
    store.markDownloaded("10", "/media/ana/sc10.mp4");
    const result = store.deleteCreator("1");
    expect(result).toEqual({ videos: 2, localPaths: ["/media/ana/sc10.mp4"] });
    expect(store.findCreator("ana")).toBeNull();
    expect(store.listVideos()).toEqual([]);
    expect(store.searchVideos("pasta")).toEqual([]);
  });
});

describe("videos", () => {
  const ana = { creatorId: "1", creatorUsername: "ana" };
  beforeEach(() => {
    store.upsertCreator(creator({ id: "1", username: "ana" }));
  });

  it("re-upserting updates metrics, keeps one row, and reports inserted vs updated", () => {
    const v = video({ id: "10", ...ana, plays: 100 });
    expect(store.upsertVideos([v])).toEqual({ inserted: 1, updated: 0 });
    expect(store.upsertVideos([{ ...v, plays: 250 }])).toEqual({ inserted: 0, updated: 1 });
    expect(store.listVideos()).toHaveLength(1);
    expect(store.findVideo("sc10")?.plays).toBe(250);
    const snaps = store.db.prepare("SELECT plays FROM video_snapshots ORDER BY id").all();
    expect(snaps.map((s) => s.plays)).toEqual([100, 250]);
  });

  it("a hidden count on refresh does not erase the last known value", () => {
    const v = video({ id: "10", ...ana, plays: 100 });
    store.upsertVideos([v]);
    store.upsertVideos([{ ...v, plays: null }]);
    expect(store.findVideo("10")?.plays).toBe(100);
  });

  it("lists newest first across month and year boundaries, undated last", () => {
    store.upsertVideos([
      video({ id: "1", ...ana, takenAt: "2026-10-31T23:00:00.000Z" }),
      video({ id: "2", ...ana, takenAt: "2026-11-01T01:00:00.000Z" }),
      video({ id: "3", ...ana, takenAt: null }),
      video({ id: "4", ...ana, takenAt: "2025-12-31T23:59:00.000Z" }),
    ]);
    expect(store.listVideos().map((v) => v.id)).toEqual(["2", "1", "4", "3"]);
    expect(store.listVideos({ since: "2026-11-01T00:00:00.000Z" }).map((v) => v.id)).toEqual(["2"]);
  });

  it("searches captions ignoring accents and case, requiring every word", () => {
    store.upsertVideos([
      video({ id: "1", ...ana, caption: "Receta FÁCIL de pasta" }),
      video({ id: "2", ...ana, caption: "pasta difícil" }),
      video({ id: "3", ...ana, caption: null }),
    ]);
    expect(store.searchVideos("facil pasta").map((v) => v.id)).toEqual(["1"]);
    expect(store.searchVideos("pasta")).toHaveLength(2);
  });

  it("treats FTS operators in a query as plain text instead of failing", () => {
    store.upsertVideos([video({ id: "1", ...ana, caption: "gta 6 trailer" })]);
    expect(() => store.searchVideos('gta" OR NEAR( * -6')).not.toThrow();
    expect(store.searchVideos("!!! ???")).toEqual([]);
    expect(store.searchVideos("gta 6").map((v) => v.id)).toEqual(["1"]);
  });

  it("a re-upsert with a new caption replaces the searchable text", () => {
    const v = video({ id: "1", ...ana, caption: "viejo" });
    store.upsertVideos([v]);
    store.upsertVideos([{ ...v, caption: "nuevo" }]);
    expect(store.searchVideos("viejo")).toEqual([]);
    expect(store.searchVideos("nuevo")).toHaveLength(1);
  });
});

describe("request budget", () => {
  it("counts per backend", () => {
    expect(store.requestsToday("browser")).toBe(0);
    store.countRequest("browser");
    expect(store.countRequest("browser")).toBe(2);
    expect(store.requestsToday("hiker")).toBe(0);
  });
});
