import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  addFilterOptions,
  checkFilters,
  filterFlags,
  filterFlagsText,
  filterVideos,
  hasDurationFilter,
  hasFilters,
  normalizeTags,
  usedFilterFlags,
} from "../src/core/filters.js";
import type { StoredVideo } from "../src/core/types.js";
import { jsonSchema } from "../src/lib/command.js";

function stored(id: string, over: Partial<StoredVideo> = {}): StoredVideo {
  return {
    id,
    shortcode: id,
    url: `https://www.instagram.com/reel/${id}/`,
    creatorId: "1",
    creatorUsername: "ana",
    caption: null,
    takenAt: null,
    durationSec: null,
    plays: null,
    likes: null,
    comments: null,
    thumbnailUrl: null,
    videoUrl: null,
    localPath: null,
    downloadedAt: null,
    firstSeenAt: "2026-11-01T00:00:00.000Z",
    refreshedAt: "2026-11-01T00:00:00.000Z",
    audio: null,
    hashtags: [],
    mentions: [],
    width: null,
    height: null,
    cuts: null,
    cutsPerMin: null,
    framesDir: null,
    analyzedAt: null,
    hasTranscript: false,
    ...over,
  };
}

const schema = z.object({ ...filterFlags });
const ids = (rows: StoredVideo[]) => rows.map((r) => r.id);

describe("filter flags: input", () => {
  it("normalizes tags: split, trim, strip the sigil, lowercase, dedupe", () => {
    expect(normalizeTags("#Pasta, receta,,PASTA ", "#")).toEqual(["pasta", "receta"]);
    expect(normalizeTags(["##Pan", "pan,#Queso"], "#")).toEqual(["pan", "queso"]);
    expect(normalizeTags("@Ana.Cocina", "@")).toEqual(["ana.cocina"]);
    // Only the flag's own sigil is stripped.
    expect(normalizeTags("@x", "#")).toEqual(["@x"]);
    expect(normalizeTags(" , #", "#")).toEqual([]);
  });

  it("accepts a string or a list and coerces durations", () => {
    expect(
      schema.parse({ hashtag: "#A,b", mention: ["@Ana", "beto"], minDuration: "15", audio: " x " }),
    ).toEqual({ hashtag: ["a", "b"], mention: ["ana", "beto"], minDuration: 15, audio: "x" });
    expect(schema.parse({})).toEqual({});
  });

  it("rejects a flag that names nothing, and a negative duration", () => {
    const empty = schema.safeParse({ hashtag: "#" });
    expect(empty.success).toBe(false);
    expect(empty.error?.issues[0]?.message).toBe("give at least one hashtag");
    expect(schema.safeParse({ mention: [] }).error?.issues[0]?.message).toBe(
      "give at least one username",
    );
    expect(schema.safeParse({ audio: "  " }).success).toBe(false);
    expect(schema.safeParse({ maxDuration: -1 }).success).toBe(false);
  });

  it("publishes every flag with a description in the JSON Schema", () => {
    const published = jsonSchema(schema, "input") as {
      properties: Record<string, { description?: string }>;
    };
    for (const key of ["hashtag", "mention", "audio", "minDuration", "maxDuration"]) {
      expect(published.properties[key]?.description, key).toBeTruthy();
    }
  });

  it("commander collects a repeated flag into a list", () => {
    const cmd = addFilterOptions(new Command("x"), "with --top: ");
    cmd.parse(["--hashtag", "a", "--hashtag", "#b,c", "--mention", "@d", "--min-duration", "5"], {
      from: "user",
    });
    expect(cmd.opts()).toEqual({ hashtag: ["a", "#b,c"], mention: ["@d"], minDuration: "5" });
    expect(schema.parse(cmd.opts())).toEqual({
      hashtag: ["a", "b", "c"],
      mention: ["d"],
      minDuration: 5,
    });
    expect(cmd.helpInformation()).toContain("with --top: only videos using this hashtag");
  });

  it("checkFilters rejects min above max and nothing else", () => {
    expect(() => checkFilters({ minDuration: 30, maxDuration: 10 })).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(() => checkFilters({ minDuration: 10, maxDuration: 10 })).not.toThrow();
    expect(() => checkFilters({ maxDuration: 0 })).not.toThrow();
    expect(() => checkFilters({})).not.toThrow();
  });
});

describe("filterVideos", () => {
  const videos = [
    stored("v1", {
      hashtags: ["receta", "pasta"],
      mentions: ["beto"],
      durationSec: 10,
      audio: { id: "111", title: "Sonido Original", artist: "ana", isOriginal: true },
    }),
    stored("v2", {
      hashtags: ["receta"],
      durationSec: 30,
      audio: { id: "222", title: "Despacito", artist: "Luis Fonsi", isOriginal: false },
    }),
    stored("v3", { hashtags: ["pan"], mentions: ["cata", "beto"], durationSec: 60 }),
    stored("v4", { audio: { id: null, title: null, artist: "Fonsi Jr", isOriginal: null } }),
  ];

  it("returns everything, the same array, without filters", () => {
    expect(filterVideos(videos, {})).toBe(videos);
    expect(filterVideos(videos, { hashtag: [] })).toBe(videos);
    expect(hasFilters({ hashtag: [], mention: [] })).toBe(false);
  });

  it("matches any value within a flag", () => {
    expect(ids(filterVideos(videos, { hashtag: ["pasta", "pan"] }))).toEqual(["v1", "v3"]);
    expect(ids(filterVideos(videos, { hashtag: ["RECETA"] }))).toEqual(["v1", "v2"]);
    expect(ids(filterVideos(videos, { mention: ["cata", "nadie"] }))).toEqual(["v3"]);
    // A whole tag, not a substring of one.
    expect(filterVideos(videos, { hashtag: ["rece"] })).toEqual([]);
  });

  it("combines different flags with AND", () => {
    expect(ids(filterVideos(videos, { hashtag: ["receta", "pan"], mention: ["beto"] }))).toEqual([
      "v1",
      "v3",
    ]);
    expect(
      ids(filterVideos(videos, { hashtag: ["receta", "pan"], mention: ["beto"], minDuration: 30 })),
    ).toEqual(["v3"]);
    expect(filterVideos(videos, { hashtag: ["receta"], mention: ["cata"] })).toEqual([]);
  });

  it("audio: exact id, or a case-insensitive part of title or artist; never null audio", () => {
    expect(ids(filterVideos(videos, { audio: "222" }))).toEqual(["v2"]);
    // Part of an id is not a match.
    expect(filterVideos(videos, { audio: "22" })).toEqual([]);
    expect(ids(filterVideos(videos, { audio: "original" }))).toEqual(["v1"]);
    expect(ids(filterVideos(videos, { audio: "FONSI" }))).toEqual(["v2", "v4"]);
  });

  it("duration bounds are inclusive and skip unmeasured videos", () => {
    expect(ids(filterVideos(videos, { minDuration: 30 }))).toEqual(["v2", "v3"]);
    expect(ids(filterVideos(videos, { maxDuration: 30 }))).toEqual(["v1", "v2"]);
    expect(ids(filterVideos(videos, { minDuration: 10, maxDuration: 10 }))).toEqual(["v1"]);
    expect(ids(filterVideos(videos, { maxDuration: 0 }))).toEqual([]);
    expect(hasDurationFilter({ maxDuration: 0 })).toBe(true);
    expect(hasDurationFilter({ hashtag: ["a"] })).toBe(false);
  });
});

describe("filters as text", () => {
  it("prints the flags as they would be typed, quoting what a shell would split", () => {
    expect(filterFlagsText({})).toBe("");
    expect(
      filterFlagsText({
        hashtag: ["receta", "pan"],
        mention: ["ana.cocina"],
        audio: "222",
        minDuration: 15,
        maxDuration: 30.5,
      }),
    ).toBe(
      " --hashtag receta,pan --mention ana.cocina --audio 222 --min-duration 15 --max-duration 30.5",
    );
    expect(filterFlagsText({ audio: "luis fonsi" })).toBe(" --audio 'luis fonsi'");
    expect(filterFlagsText({ hashtag: ["a; rm -rf ~"] })).toBe(" --hashtag 'a; rm -rf ~'");
    expect(filterFlagsText({ audio: "it's $(x)\n`y`" })).toBe(" --audio 'its $(x) `y`'");
    expect(filterFlagsText({ hashtag: ["año"] })).toBe(" --hashtag año");
  });

  it("names the flags in use", () => {
    expect(usedFilterFlags({ hashtag: ["a"], maxDuration: 0 })).toEqual([
      "--hashtag",
      "--max-duration",
    ]);
    expect(usedFilterFlags({})).toEqual([]);
  });
});
