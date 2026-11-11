import { afterEach, describe, expect, it } from "vitest";
import type { CreatorCandidate } from "../src/backends/types.js";
import {
  byFollowersDesc,
  type DiscoveryOptions,
  discoverCreators,
  hashtagFromQuery,
} from "../src/core/discovery.js";
import { IgError } from "../src/lib/errors.js";
import { type TestEnv, testEnv } from "./fake-backend.js";
import { video } from "./helpers.js";

let env: TestEnv;
// The pure-function tests below never create an environment.
afterEach(async () => {
  await (env as TestEnv | undefined)?.cleanup();
});

const cand = (id: string, username: string, followers: number | null = 1000): CreatorCandidate => ({
  id,
  username,
  fullName: null,
  followers,
  isVerified: false,
  isPrivate: false,
});
const reelBy = (videoId: string, id: string, username: string) =>
  video({ id: videoId, creatorId: id, creatorUsername: username });

const opts = (over: Partial<DiscoveryOptions> = {}): DiscoveryOptions => ({
  query: "cocina",
  expand: false,
  also: [],
  hashtags: [],
  limit: 30,
  ...over,
});

const unsupported = (what: string) => async () => {
  throw new IgError("UNSUPPORTED", `${what} is not supported`);
};

describe("byFollowersDesc", () => {
  it("puts the largest first and unknown counts last, never as zero", () => {
    const rows = [{ followers: null }, { followers: 0 }, { followers: 900 }, { followers: 50 }];
    expect(rows.sort(byFollowersDesc).map((r) => r.followers)).toEqual([900, 50, 0, null]);
  });

  it("keeps the relative order of unknowns", () => {
    const rows = [
      { followers: null, n: "a" },
      { followers: 5, n: "b" },
      { followers: null, n: "c" },
    ];
    expect(rows.sort(byFollowersDesc).map((r) => r.n)).toEqual(["b", "a", "c"]);
  });
});

describe("hashtagFromQuery", () => {
  it("lowercases and drops spaces and punctuation, keeping accented letters", () => {
    expect(hashtagFromQuery("GTA 6")).toBe("gta6");
    expect(hashtagFromQuery("Cocina Fácil!")).toBe("cocinafácil");
    expect(hashtagFromQuery(" - ")).toBe("");
  });
});

describe("discoverCreators without expand", () => {
  it("makes exactly one keyword search", async () => {
    env = testEnv({ creatorSearch: { cocina: [cand("1", "ana"), cand("2", "beto")] } });
    const result = await discoverCreators(
      env.backend,
      opts({ also: ["recetas"], hashtags: ["x"] }),
    );
    expect(env.backend.calls).toEqual(["searchCreators:cocina"]);
    expect(result.candidates.map((c) => [c.username, c.source])).toEqual([
      ["ana", "keyword"],
      ["beto", "keyword"],
    ]);
    expect(result.sources).toEqual([{ source: "keyword:cocina", found: 2, added: 2 }]);
  });

  it("returns an empty set, with the source still reported, when nothing matches", async () => {
    env = testEnv({});
    const result = await discoverCreators(env.backend, opts());
    expect(result.candidates).toEqual([]);
    expect(result.sources).toEqual([{ source: "keyword:cocina", found: 0, added: 0 }]);
  });

  it("does not swallow UNSUPPORTED: the only source failing is the answer", async () => {
    env = testEnv({});
    env.backend.searchCreators = unsupported("search");
    await expect(discoverCreators(env.backend, opts())).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  });
});

describe("discoverCreators with expand", () => {
  const data = () => ({
    creatorSearch: {
      cocina: [cand("1", "ana", 500), cand("2", "beto", 9000), cand("3", "caro", null)],
      recetas: [cand("2", "beto", 9000), cand("4", "dani", 7000), cand("5", "eva", 8000)],
    },
    reelSearch: {
      cocina: [reelBy("r1", "3", "caro"), reelBy("r2", "6", "fede"), reelBy("r3", "6", "fede")],
    },
    hashtags: { cocina: [reelBy("h1", "6", "fede"), reelBy("h2", "7", "gabi")] },
    related: {
      "2": [cand("8", "hugo", 300), cand("1", "ana", 500)],
      "5": [cand("7", "gabi", 4200)],
      "4": [],
    },
  });

  it("queries every source in order and seeds related accounts from the three largest keyword hits", async () => {
    env = testEnv(data());
    await discoverCreators(env.backend, opts({ expand: true, also: ["recetas"] }));
    expect(env.backend.calls).toEqual([
      "searchCreators:cocina",
      "searchCreators:recetas",
      "searchReels:cocina",
      "hashtagReels:cocina",
      // beto 9000, eva 8000, dani 7000. ana (500) and caro (unknown) are not seeds.
      "relatedCreators:beto",
      "relatedCreators:eva",
      "relatedCreators:dani",
    ]);
  });

  it("de-duplicates across sources and keeps the first source that named each account", async () => {
    env = testEnv(data());
    const result = await discoverCreators(env.backend, opts({ expand: true, also: ["recetas"] }));
    expect(Object.fromEntries(result.candidates.map((c) => [c.username, c.source]))).toEqual({
      ana: "keyword",
      beto: "keyword",
      caro: "keyword",
      dani: "keyword",
      eva: "keyword",
      fede: "reels:cocina",
      gabi: "hashtag:cocina",
      hugo: "related:beto",
    });
    expect(new Set(result.candidates.map((c) => c.id)).size).toBe(result.candidates.length);
  });

  it("reports per source how many it found and how many were new", async () => {
    env = testEnv(data());
    const result = await discoverCreators(env.backend, opts({ expand: true, also: ["recetas"] }));
    expect(result.sources).toEqual([
      { source: "keyword:cocina", found: 3, added: 3 },
      { source: "keyword:recetas", found: 3, added: 2 },
      // fede posted two matching reels: one account, not two.
      { source: "reels:cocina", found: 2, added: 1 },
      { source: "hashtag:cocina", found: 2, added: 1 },
      { source: "related:beto", found: 2, added: 1 },
      { source: "related:eva", found: 1, added: 0 },
      { source: "related:dani", found: 0, added: 0 },
    ]);
  });

  it("leaves followers unknown for reel authors, and fills it when a later source knows", async () => {
    env = testEnv(data());
    const result = await discoverCreators(env.backend, opts({ expand: true, also: ["recetas"] }));
    const by = Object.fromEntries(result.candidates.map((c) => [c.username, c]));
    expect(by.fede?.followers).toBeNull();
    expect(by.caro?.followers).toBeNull();
    // gabi was first seen as a hashtag reel author, then related:eva supplied the count.
    expect(by.gabi).toMatchObject({ followers: 4200, source: "hashtag:cocina" });
  });

  it("derives the default hashtag from the query, and normalises explicit ones", async () => {
    env = testEnv({});
    await discoverCreators(env.backend, opts({ query: "GTA 6", expand: true }));
    expect(env.backend.calls).toContain("hashtagReels:gta6");

    env.backend.calls.length = 0;
    await discoverCreators(
      env.backend,
      opts({ query: "GTA 6", expand: true, hashtags: ["#GTA6", "gta6", "RockStar"] }),
    );
    expect(env.backend.calls.filter((c) => c.startsWith("hashtag"))).toEqual([
      "hashtagReels:gta6",
      "hashtagReels:rockstar",
    ]);
  });

  it("does not repeat a keyword variant equal to the query", async () => {
    env = testEnv({});
    await discoverCreators(
      env.backend,
      opts({ expand: true, also: ["Cocina", "recetas", "recetas"] }),
    );
    expect(env.backend.calls.filter((c) => c.startsWith("searchCreators"))).toEqual([
      "searchCreators:cocina",
      "searchCreators:recetas",
    ]);
  });

  it("makes no related request when the keyword search found nobody", async () => {
    env = testEnv({ hashtags: { cocina: [reelBy("h1", "6", "fede")] } });
    const result = await discoverCreators(env.backend, opts({ expand: true }));
    expect(env.backend.calls.some((c) => c.startsWith("relatedCreators"))).toBe(false);
    expect(result.candidates.map((c) => c.username)).toEqual(["fede"]);
  });

  it("skips a source the backend does not support and keeps the rest", async () => {
    env = testEnv(data());
    env.backend.hashtagReels = unsupported("hashtags");
    const logged: string[] = [];
    const result = await discoverCreators(env.backend, opts({ expand: true }), (m) =>
      logged.push(m),
    );
    expect(result.skipped).toEqual([
      { source: "hashtag:cocina", reason: "hashtags is not supported" },
    ]);
    expect(result.sources.map((s) => s.source)).not.toContain("hashtag:cocina");
    expect(result.candidates.map((c) => c.username)).toContain("fede");
    expect(logged.some((m) => m.includes("hashtag:cocina") && m.includes("skipped"))).toBe(true);
    // Later sources still ran.
    expect(env.backend.calls).toContain("relatedCreators:beto");
  });

  it("fails with UNSUPPORTED when every source is unsupported, never an empty success", async () => {
    env = testEnv({});
    env.backend.searchCreators = unsupported("search");
    env.backend.searchReels = unsupported("reel search");
    env.backend.hashtagReels = unsupported("hashtags");
    await expect(discoverCreators(env.backend, opts({ expand: true }))).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  });

  it("a block stops everything: no later source is asked", async () => {
    env = testEnv(data());
    const searchReels = env.backend.searchReels.bind(env.backend);
    env.backend.searchReels = async (query, o) => {
      env.backend.blockNext = "RATE_LIMITED";
      return searchReels(query, o);
    };
    await expect(discoverCreators(env.backend, opts({ expand: true }))).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(env.backend.calls).toEqual(["searchCreators:cocina", "searchReels:cocina"]);
  });

  it("an error that is neither a block nor UNSUPPORTED is not swallowed", async () => {
    env = testEnv(data());
    env.backend.searchReels = async () => {
      throw new IgError("UPSTREAM_CHANGED", "reel search returned an unknown shape");
    };
    await expect(discoverCreators(env.backend, opts({ expand: true }))).rejects.toMatchObject({
      code: "UPSTREAM_CHANGED",
    });
  });
});
