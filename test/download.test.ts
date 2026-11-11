import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "../src/backends/types.js";
import { videoCommands } from "../src/commands/video.js";
import {
  type DownloadDeps,
  type DownloadRequest,
  type DownloadSummary,
  destinationFor,
  downloadVideos,
} from "../src/core/download.js";
import type { Video } from "../src/core/types.js";
import type { CommandDef } from "../src/lib/command.js";
import { IgError } from "../src/lib/errors.js";
import { byId, type FakeData, type TestEnv, testEnv } from "./fake-backend.js";
import { creator, video } from "./helpers.js";

const download = byId(videoCommands as CommandDef[], "video.download");

let env: TestEnv;
afterEach(async () => {
  vi.restoreAllMocks();
  await env.cleanup();
});

const ana = creator({ id: "1", username: "ana", followers: 10_000 });
const beto = creator({ id: "2", username: "beto", followers: 100 });

const OLD = "https://cdn.test/old";
const FRESH = "https://cdn.test/fresh";

const reel = (id: string, over: Partial<Video> = {}) =>
  video({
    id,
    shortcode: `sc${id}`,
    creatorId: "1",
    creatorUsername: "ana",
    videoUrl: `${OLD}/${id}`,
    ...over,
  });

/** What the backend would return for each shortcode: the same reel with a fresh URL. */
const freshOf = (...videos: Video[]) => videos.map((v) => ({ ...v, videoUrl: `${FRESH}/${v.id}` }));

function setup(stored: Video[], data: FakeData = {}): TestEnv {
  const e = testEnv(data);
  e.ctx.store.upsertCreator(ana, { refreshed: false });
  e.ctx.store.upsertCreator(beto, { refreshed: false });
  e.ctx.store.upsertVideos(stored);
  return e;
}

const mp4 = (size = 2048) =>
  new Response(new Uint8Array(size).fill(7), { headers: { "content-type": "video/mp4" } });
const status = (code: number) => new Response("denied", { status: code });

type Harness = {
  dir: string;
  urls: string[];
  logs: string[];
  pauses: number;
  ytDlpCalls: [string, string][];
  run: (
    targets: DownloadRequest["targets"],
    opts?: Partial<DownloadRequest>,
  ) => Promise<DownloadSummary>;
};

/** Injected fetch, pause and yt-dlp: no network, no waiting, no binary. */
function harness(
  respond: (url: string) => Response | Promise<Response>,
  over: Partial<DownloadDeps> = {},
): Harness {
  const h: Harness = {
    dir: join(env.ctx.paths.state, "out"),
    urls: [],
    logs: [],
    pauses: 0,
    ytDlpCalls: [],
    run: (targets, opts = {}) =>
      downloadVideos(
        { store: env.ctx.store, log: (m) => h.logs.push(m), backend: async () => env.backend },
        { targets, dir: h.dir, force: false, dryRun: false, ...opts },
        {
          fetch: async (url) => {
            h.urls.push(url);
            return respond(url);
          },
          pause: async () => {
            h.pauses++;
          },
          hasYtDlp: () => false,
          ytDlp: async (url, dest) => {
            h.ytDlpCalls.push([url, dest]);
            throw new Error("no binary in tests");
          },
          ...over,
        },
      ),
  };
  return h;
}

/** Every file under `dir`, as forward-slash relative paths. Empty if it does not exist. */
function tree(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[])
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
}

describe("downloadVideos", () => {
  it("downloads from the stored URL with no backend request", async () => {
    env = setup([reel("10")]);
    const h = harness(() => mp4(3000));
    const result = await h.run(["sc10"]);

    const path = join(h.dir, "ana", "sc10.mp4");
    expect(result).toEqual({
      downloaded: 1,
      skipped: 0,
      failed: 0,
      bytes: 3000,
      dir: h.dir,
      items: [
        {
          id: "10",
          shortcode: "sc10",
          creatorUsername: "ana",
          status: "downloaded",
          reason: null,
          path,
          bytes: 3000,
        },
      ],
    });
    expect(h.urls).toEqual([`${OLD}/10`]);
    expect(env.backend.calls).toEqual([]);
    expect(env.ctx.gate("browser").budget.used).toBe(0);
    expect(readFileSync(path)).toHaveLength(3000);
    expect(tree(h.dir)).toEqual(["ana/sc10.mp4"]);
    expect(env.ctx.store.findVideo("10")).toMatchObject({ localPath: path });
    expect(env.ctx.store.findVideo("10")?.downloadedAt).not.toBeNull();
    expect(h.logs).toEqual(["1/1 ana/sc10 3 KB"]);
  });

  it("resolves a media id, a shortcode and a reel URL to stored videos", async () => {
    env = setup([reel("10"), reel("11"), reel("12")]);
    const h = harness(() => mp4());
    const result = await h.run(["10", "sc11", "https://www.instagram.com/ana/reel/sc12/?igsh=x"]);
    expect(result.items.map((i) => [i.id, i.status])).toEqual([
      ["10", "downloaded"],
      ["11", "downloaded"],
      ["12", "downloaded"],
    ]);
    expect(env.backend.calls).toEqual([]);
    // One pause between files, none before the first or after the last.
    expect(h.pauses).toBe(2);
    expect(h.logs.map((l) => l.split(" ")[0])).toEqual(["1/3", "2/3", "3/3"]);
  });

  it.each([403, 404, 410])(
    "an expired URL (HTTP %i) is re-fetched once and retried",
    async (code) => {
      const stored = reel("10");
      env = setup([stored], { reels: { "1": freshOf(stored) } });
      const h = harness((url) => (url.startsWith(OLD) ? status(code) : mp4()));
      const result = await h.run(["sc10"]);

      expect(result.items[0]).toMatchObject({ status: "downloaded", bytes: 2048 });
      expect(h.urls).toEqual([`${OLD}/10`, `${FRESH}/10`]);
      expect(env.backend.calls).toEqual(["getVideo:sc10"]);
      expect(env.ctx.gate("browser").budget.used).toBe(1);
      // The fresh URL is kept for next time.
      expect(env.ctx.store.findVideo("10")?.videoUrl).toBe(`${FRESH}/10`);
      expect(tree(h.dir)).toEqual(["ana/sc10.mp4"]);
    },
  );

  it("a missing URL costs one backend request, not a CDN attempt", async () => {
    const stored = reel("10", { videoUrl: null });
    env = setup([stored], { reels: { "1": freshOf(stored) } });
    const h = harness(() => mp4());
    expect((await h.run(["sc10"])).downloaded).toBe(1);
    expect(env.backend.calls).toEqual(["getVideo:sc10"]);
    expect(h.urls).toEqual([`${FRESH}/10`]);
  });

  it("a server error is not treated as an expired URL", async () => {
    const stored = reel("10");
    env = setup([stored], { reels: { "1": freshOf(stored) } });
    const h = harness(() => status(500));
    const result = await h.run(["sc10"]);
    expect(result.items[0]).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("HTTP 500"),
    });
    expect(env.backend.calls).toEqual([]);
  });

  it("when the fresh URL is dead too it fails after exactly one re-fetch, leaving no file", async () => {
    const stored = reel("10");
    env = setup([stored], { reels: { "1": freshOf(stored) } });
    const h = harness(() => status(403));
    const result = await h.run(["sc10"]);

    expect(result).toMatchObject({ downloaded: 0, failed: 1, bytes: 0 });
    expect(result.items[0]).toMatchObject({ status: "failed", path: null, bytes: null });
    expect(result.items[0]?.reason).toContain("HTTP 403");
    expect(result.items[0]?.reason).toContain("yt-dlp is not installed");
    expect(env.backend.calls).toEqual(["getVideo:sc10"]);
    expect(h.urls).toHaveLength(2);
    expect(h.ytDlpCalls).toEqual([]);
    expect(tree(h.dir)).toEqual([]);
    expect(env.ctx.store.findVideo("10")?.localPath).toBeNull();
  });

  it("falls back to yt-dlp with the permalink when no URL works", async () => {
    const stored = reel("10", { videoUrl: null });
    env = setup([stored], { reels: { "1": [stored] } });
    const calls: [string, string][] = [];
    const h = harness(() => mp4(), {
      hasYtDlp: () => true,
      ytDlp: async (url, dest) => {
        calls.push([url, dest]);
        writeFileSync(dest, Buffer.alloc(5000));
      },
    });
    const result = await h.run(["sc10"]);

    expect(result.items[0]).toMatchObject({
      status: "downloaded",
      bytes: 5000,
      path: join(h.dir, "ana", "sc10.mp4"),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("https://www.instagram.com/reel/sc10/");
    // yt-dlp writes to a temp file in the destination directory, renamed after.
    expect(calls[0]?.[1]).not.toBe(join(h.dir, "ana", "sc10.mp4"));
    expect(calls[0]?.[1].startsWith(join(h.dir, "ana"))).toBe(true);
    expect(h.urls).toEqual([]);
    expect(tree(h.dir)).toEqual(["ana/sc10.mp4"]);
    expect(env.ctx.store.findVideo("10")?.localPath).toBe(join(h.dir, "ana", "sc10.mp4"));
  });

  it("a failing or empty yt-dlp run leaves nothing behind", async () => {
    const stored = [reel("10", { videoUrl: null }), reel("11", { videoUrl: null })];
    env = setup(stored, { reels: { "1": stored } });
    let n = 0;
    const h = harness(() => mp4(), {
      hasYtDlp: () => true,
      ytDlp: async (_url, dest) => {
        if (n++ === 0) {
          writeFileSync(dest, Buffer.alloc(100));
          throw new Error("ERROR: login required\x1b[31m");
        }
        writeFileSync(dest, "");
      },
    });
    const result = await h.run(["sc10", "sc11"]);
    expect(result.items.map((i) => i.status)).toEqual(["failed", "failed"]);
    expect(result.items[0]?.reason).toContain("yt-dlp failed: ERROR: login required");
    expect(result.items[0]?.reason).not.toContain("\x1b");
    expect(result.items[1]?.reason).toContain("produced no file");
    expect(tree(h.dir)).toEqual([]);
  });

  it("a download that breaks mid-stream removes its temp file", async () => {
    env = setup([reel("10")]);
    const broken = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(4096));
          },
          pull(controller) {
            controller.error(new Error("socket hang up"));
          },
        }),
        { headers: { "content-type": "video/mp4" } },
      );
    const h = harness(broken);
    const result = await h.run(["sc10"]);

    expect(result.items[0]).toMatchObject({ status: "failed", path: null });
    expect(result.items[0]?.reason).toContain("socket hang up");
    expect(tree(h.dir)).toEqual([]);
    expect(env.ctx.store.findVideo("10")?.localPath).toBeNull();
  });

  it("a failed --force download keeps the previous file intact", async () => {
    env = setup([reel("10")]);
    const path = join(env.ctx.paths.state, "out", "ana", "sc10.mp4");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "previous");
    const h = harness(() => status(500));
    const result = await h.run(["sc10"], { force: true });
    expect(result.items[0]?.status).toBe("failed");
    expect(readFileSync(path, "utf8")).toBe("previous");
    expect(tree(h.dir)).toEqual(["ana/sc10.mp4"]);
  });

  it("rejects a response that is not a video", async () => {
    env = setup([reel("10"), reel("11"), reel("12"), reel("13"), reel("14")]);
    const bodies: Record<string, Response> = {
      [`${OLD}/10`]: new Response("<html>login</html>".repeat(200), {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      [`${OLD}/11`]: new Response(new Uint8Array(0), { headers: { "content-type": "video/mp4" } }),
      // No content-type and tiny: an error page, not a reel.
      [`${OLD}/12`]: new Response(new Uint8Array(200), { headers: { "content-type": "" } }),
      // No useful content-type but a real size: accepted.
      [`${OLD}/13`]: new Response(new Uint8Array(4096), {
        headers: { "content-type": "application/octet-stream" },
      }),
      [`${OLD}/14`]: new Response('{"error":"nope"}'.repeat(200), {
        headers: { "content-type": "application/json" },
      }),
    };
    const h = harness((url) => bodies[url] as Response);
    const result = await h.run(["sc10", "sc11", "sc12", "sc13", "sc14"]);
    expect(result.items.map((i) => i.status)).toEqual([
      "failed",
      "failed",
      "failed",
      "downloaded",
      "failed",
    ]);
    expect(result.items[0]?.reason).toContain("text/html");
    expect(result.items[1]?.reason).toContain("0 bytes");
    expect(result.items[2]?.reason).toContain("200 bytes");
    expect(tree(h.dir)).toEqual(["ana/sc13.mp4"]);
    expect(result).toMatchObject({ downloaded: 1, failed: 4, bytes: 4096 });
  });

  it("a network error fails the item and the batch goes on", async () => {
    env = setup([reel("10"), reel("11")]);
    const h = harness((url) => {
      if (url.endsWith("/10")) throw new TypeError("fetch failed");
      return mp4();
    });
    const result = await h.run(["sc10", "sc11"]);
    expect(result.items.map((i) => i.status)).toEqual(["failed", "downloaded"]);
    expect(result.items[0]?.reason).toContain("network error: fetch failed");
    expect(h.logs[0]).toMatch(/^1\/2 ana\/sc10 failed: /);
  });

  describe("already on disk", () => {
    it("skips a recorded file with zero requests of any kind", async () => {
      env = setup([reel("10"), reel("11")]);
      const first = harness(() => mp4());
      await first.run(["sc10"]);

      const h = harness(() => mp4());
      const result = await h.run(["sc10", "sc11"]);
      expect(result).toMatchObject({ downloaded: 1, skipped: 1, failed: 0, bytes: 2048 });
      expect(result.items[0]).toMatchObject({
        status: "skipped",
        reason: expect.stringContaining("--force"),
        path: join(h.dir, "ana", "sc10.mp4"),
        bytes: 2048,
      });
      expect(h.urls).toEqual([`${OLD}/11`]);
      expect(h.pauses).toBe(0);
      expect(env.backend.calls).toEqual([]);
    });

    it("skips a file found at the destination and records it", async () => {
      env = setup([reel("10", { videoUrl: null })]);
      const path = join(env.ctx.paths.state, "out", "ana", "sc10.mp4");
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, Buffer.alloc(777));
      const h = harness(() => mp4());
      const result = await h.run(["sc10"]);
      expect(result.items[0]).toMatchObject({ status: "skipped", path, bytes: 777 });
      expect(result.bytes).toBe(0);
      expect(h.urls).toEqual([]);
      expect(env.backend.calls).toEqual([]);
      expect(env.ctx.store.findVideo("10")?.localPath).toBe(path);
    });

    it("downloads again when the recorded file is gone", async () => {
      env = setup([reel("10")]);
      env.ctx.store.markDownloaded("10", join(env.ctx.paths.state, "moved-away.mp4"));
      const h = harness(() => mp4());
      expect((await h.run(["sc10"])).items[0]?.status).toBe("downloaded");
    });

    it("--force downloads again and replaces the file", async () => {
      env = setup([reel("10")]);
      await harness(() => mp4(100)).run(["sc10"]);
      const h = harness(() => mp4(9000));
      const result = await h.run(["sc10"], { force: true });
      expect(result.items[0]).toMatchObject({ status: "downloaded", bytes: 9000 });
      expect(readFileSync(join(h.dir, "ana", "sc10.mp4"))).toHaveLength(9000);
      expect(tree(h.dir)).toEqual(["ana/sc10.mp4"]);
    });
  });

  describe("targets not in the store", () => {
    const outsider = video({
      id: "77",
      shortcode: "scNEW",
      creatorId: "9",
      creatorUsername: "nuevo",
      videoUrl: `${FRESH}/77`,
    });

    it("fetches the reel, stores a minimal creator and the video, then downloads", async () => {
      env = setup([], { reelSearch: { any: [outsider] } });
      const h = harness(() => mp4());
      const result = await h.run(["https://www.instagram.com/reel/scNEW/"]);

      expect(result.items[0]).toMatchObject({
        id: "77",
        shortcode: "scNEW",
        creatorUsername: "nuevo",
        status: "downloaded",
        path: join(h.dir, "nuevo", "scNEW.mp4"),
      });
      // One request: the URL it came with is fresh, so it is not fetched twice.
      expect(env.backend.calls).toEqual(["getVideo:scNEW"]);
      expect(h.urls).toEqual([`${FRESH}/77`]);
      expect(env.ctx.store.getCreator("nuevo")).toMatchObject({
        id: "9",
        followers: null,
        refreshedAt: null,
        videoCount: 1,
        url: "https://www.instagram.com/nuevo/",
      });
      expect(env.ctx.store.findVideo("scNEW")?.localPath).toBe(join(h.dir, "nuevo", "scNEW.mp4"));
    });

    it("does not overwrite a creator that is already tracked", async () => {
      const fromAna = { ...outsider, creatorId: "1", creatorUsername: "ana" };
      env = setup([], { reelSearch: { any: [fromAna] } });
      env.ctx.store.upsertCreator({ ...ana, isVerified: true });
      const h = harness(() => mp4());
      await h.run(["scNEW"]);
      expect(env.ctx.store.getCreator("ana")).toMatchObject({
        isVerified: true,
        followers: 10_000,
      });
    });

    it("does not re-fetch when the just-fetched URL is refused", async () => {
      env = setup([], { reelSearch: { any: [outsider] } });
      const h = harness(() => status(403));
      const result = await h.run(["scNEW"]);
      expect(result.items[0]?.status).toBe("failed");
      expect(env.backend.calls).toEqual(["getVideo:scNEW"]);
    });

    it("an unknown shortcode, an unknown numeric id and garbage each fail; the rest continues", async () => {
      env = setup([reel("10")]);
      const h = harness(() => mp4());
      const result = await h.run(["scMISSING", "123456789", "!!", "", "sc10"]);
      expect(result.items.map((i) => [i.shortcode, i.status])).toEqual([
        ["scMISSING", "failed"],
        ["123456789", "failed"],
        ["!!", "failed"],
        ["", "failed"],
        ["sc10", "downloaded"],
      ]);
      expect(result.items[0]?.reason).toContain("No reel with shortcode scMISSING");
      expect(result.items[1]?.reason).toContain("not a stored video id");
      expect(result).toMatchObject({ downloaded: 1, failed: 4 });
      // Only the plausible shortcode cost a request.
      expect(env.backend.calls).toEqual(["getVideo:scMISSING"]);
    });
  });

  describe("stopping the batch", () => {
    it("a block in the middle stops at once and reports progress so far", async () => {
      const stored = [reel("10"), reel("11"), reel("12")].map((v) => ({ ...v, videoUrl: null }));
      env = setup(stored, { reels: { "1": freshOf(...stored) } });
      const h = harness(() => {
        // The first file is done; the next backend request hits a 429.
        env.backend.blockNext = "RATE_LIMITED";
        return mp4();
      });

      const err = await h.run(["sc10", "sc11", "sc12"]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IgError);
      const blocked = err as IgError;
      expect(blocked.code).toBe("RATE_LIMITED");
      expect(blocked.exitCode).toBe(4);
      expect(blocked.hint).toContain("ig auth resume browser");
      expect(blocked.details).toMatchObject({
        backend: "browser",
        remaining: 2,
        progress: { downloaded: 1, skipped: 0, failed: 0, bytes: 2048 },
      });
      const progress = blocked.details?.progress as DownloadSummary;
      expect(progress.items.map((i) => [i.shortcode, i.status])).toEqual([["sc10", "downloaded"]]);

      // The third video was never attempted, and the file already written stays.
      expect(env.backend.calls).toEqual(["getVideo:sc10", "getVideo:sc11"]);
      expect(tree(h.dir)).toEqual(["ana/sc10.mp4"]);
      expect(env.ctx.gate("browser").halted()?.reason).toBe("RATE_LIMITED");
    });

    it("a halted backend stops the batch with the halt's own code", async () => {
      const stored = reel("10", { videoUrl: null });
      env = setup([stored, reel("11")]);
      const h = harness(() => mp4());
      env.backend.blockNext = "CHECKPOINT";
      await expect(h.run(["sc10"])).rejects.toMatchObject({ code: "CHECKPOINT" });
      // Next run: the gate refuses before any request. Files with a URL would
      // still work, but one that needs the backend ends the batch.
      await expect(h.run(["sc10", "sc11"])).rejects.toMatchObject({
        code: "HALTED",
        details: { remaining: 2 },
      });
      expect(env.backend.calls).toEqual(["getVideo:sc10"]);
    });

    it("an auth error stops the batch too", async () => {
      env = setup([reel("10", { videoUrl: null }), reel("11")]);
      const needsLogin = {
        getVideo: async () => {
          throw new IgError("AUTH_REQUIRED", "Not logged in.", { hint: "Run `ig auth login`." });
        },
      } as unknown as Backend;
      const urls: string[] = [];
      const run = downloadVideos(
        { store: env.ctx.store, log: () => {}, backend: async () => needsLogin },
        {
          targets: ["sc10", "sc11"],
          dir: join(env.ctx.paths.state, "out"),
          force: false,
          dryRun: false,
        },
        {
          fetch: async (url) => {
            urls.push(url);
            return mp4();
          },
          pause: async () => {},
          hasYtDlp: () => false,
        },
      );
      await expect(run).rejects.toMatchObject({
        code: "AUTH_REQUIRED",
        hint: "Run `ig auth login`.",
        details: { remaining: 2, progress: { downloaded: 0 } },
      });
      expect(urls).toEqual([]);
    });

    it("any other backend error fails one item only", async () => {
      const stored = [reel("10", { videoUrl: null }), reel("11")];
      env = setup(stored);
      const h = harness(() => mp4());
      const result = await h.run(["sc10", "sc11"]);
      expect(result.items.map((i) => i.status)).toEqual(["failed", "downloaded"]);
      expect(result.items[0]?.reason).toContain("could not get a fresh URL");
    });
  });

  it("a dry run makes no request and writes nothing", async () => {
    env = setup([reel("10"), reel("11", { videoUrl: null })]);
    await harness(() => mp4()).run(["sc10"]);
    const before = tree(join(env.ctx.paths.state, "out"));

    const h = harness(() => mp4());
    const result = await h.run(["sc10", "sc11", "scUNKNOWN", "!!"], { dryRun: true, dir: h.dir });
    expect(result.items.map((i) => [i.shortcode, i.status, i.path])).toEqual([
      ["sc10", "skipped", join(h.dir, "ana", "sc10.mp4")],
      ["sc11", "would-download", join(h.dir, "ana", "sc11.mp4")],
      ["scUNKNOWN", "would-download", null],
      ["!!", "failed", null],
    ]);
    expect(result.items[2]?.reason).toContain("one request");
    expect(result).toMatchObject({ downloaded: 0, skipped: 1, failed: 1, bytes: 0 });
    expect(h.urls).toEqual([]);
    expect(h.pauses).toBe(0);
    expect(env.backend.calls).toEqual([]);
    expect(tree(h.dir)).toEqual(before);
    expect(env.ctx.store.findVideo("11")?.localPath).toBeNull();
    expect(env.ctx.store.findVideo("scUNKNOWN")).toBeNull();
  });

  it("a dry run into a directory that does not exist does not create it", async () => {
    env = setup([reel("10")]);
    const h = harness(() => mp4());
    const dir = join(env.ctx.paths.state, "never");
    await h.run(["sc10"], { dryRun: true, dir });
    expect(existsSync(dir)).toBe(false);
  });

  it("an upstream username cannot steer the path out of the directory", () => {
    const root = join("base", "media");
    for (const creatorUsername of ["../../etc", "..", "a/b\\c", ""]) {
      const dest = destinationFor(root, { creatorUsername, shortcode: "../x" });
      const rel = relative(join(process.cwd(), root), dest).split(sep);
      expect(rel).toHaveLength(2);
      expect(rel).not.toContain("..");
      expect(rel[1]?.endsWith(".mp4")).toBe(true);
    }
  });

  it("an empty batch is an empty summary", async () => {
    env = setup([]);
    const h = harness(() => mp4());
    expect(await h.run([])).toEqual({
      downloaded: 0,
      skipped: 0,
      failed: 0,
      bytes: 0,
      dir: h.dir,
      items: [],
    });
  });
});

describe("video download command", () => {
  async function run(input: Record<string, unknown>) {
    const result = await env.run(download, input);
    return { ...result, data: result.data as DownloadSummary };
  }

  // Ana: median 200 over four reels. Beto: two reels, no outlier score.
  function ranked(): TestEnv {
    const e = setup([
      reel("a1", { takenAt: "2025-12-31T23:59:59.000Z", plays: 1000 }),
      reel("a2", { takenAt: "2026-01-01T00:00:00.000Z", plays: 100 }),
      reel("a3", { takenAt: "2026-01-31T12:00:00.000Z", plays: 100 }),
      reel("a4", { takenAt: "2026-02-01T00:00:00.000Z", plays: 300 }),
      reel("b1", { creatorId: "2", creatorUsername: "beto", plays: 5000 }),
      reel("b2", { creatorId: "2", creatorUsername: "beto", plays: 4000 }),
    ]);
    e.ctx.store.createNiche({ slug: "cocina", name: "Cocina" });
    e.ctx.store.addCreatorToNiche("2", "cocina");
    return e;
  }

  it("needs exactly one of targets or --top", async () => {
    env = ranked();
    await expect(run({})).rejects.toMatchObject({
      code: "INVALID_INPUT",
      hint: expect.stringContaining("--top 10"),
    });
    await expect(run({ targets: ["sca1"], top: 2 })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("not both"),
    });
    await expect(run({ top: 0 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(env.backend.calls).toEqual([]);
  });

  it.each([
    ["niche", { niche: "cocina" }, "--niche"],
    ["creator", { creator: "ana" }, "--creator"],
    ["since", { since: "30d" }, "--since"],
    ["perCreator", { perCreator: 1 }, "--per-creator"],
  ])("rejects --%s without --top", async (_name, extra, flag) => {
    env = ranked();
    await expect(run({ targets: ["sca1"], ...extra })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining(flag),
    });
  });

  it("--top selects exactly what `video top` ranks", async () => {
    env = ranked();
    const out = join(env.ctx.paths.state, "picked");
    const byOutlier = await run({ top: 2, dryRun: true, out });
    expect(byOutlier.data.items.map((i) => [i.shortcode, i.status])).toEqual([
      ["sca1", "would-download"],
      ["sca4", "would-download"],
    ]);
    expect(byOutlier.data.dir).toBe(out);
    expect(byOutlier.data.items[0]?.path).toBe(join(out, "ana", "sca1.mp4"));
    expect(byOutlier.nextSteps?.[0]?.command).toBe("ig video download --top 2");

    const filtered = await run({
      top: 5,
      sort: "plays",
      perCreator: 1,
      since: "2026-01-01",
      dryRun: true,
    });
    // a1 is before the cutoff, so Ana's best remaining reel is a4.
    expect(filtered.data.items.map((i) => i.shortcode)).toEqual(["scb1", "sca4"]);
    expect(filtered.nextSteps?.[0]?.command).toBe(
      "ig video download --top 5 --sort plays --since 2026-01-01 --per-creator 1",
    );

    const niche = await run({ top: 5, niche: "cocina", sort: "plays", dryRun: true });
    expect(niche.data.items.map((i) => i.shortcode)).toEqual(["scb1", "scb2"]);
    expect(niche.data.dir).toBe(env.ctx.mediaDir);

    expect(env.backend.calls).toEqual([]);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(env.ctx.mediaDir)).toBe(false);
  });

  it("--top with a bad --since or an unknown niche fails as `video top` does", async () => {
    env = ranked();
    await expect(run({ top: 3, since: "soon" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(run({ top: 3, niche: "nope" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("--top over an empty scope downloads nothing and says where to get data", async () => {
    env = testEnv();
    const { data, nextSteps } = await run({ top: 5 });
    expect(data).toMatchObject({ downloaded: 0, skipped: 0, failed: 0, items: [] });
    expect(nextSteps?.[0]?.command).toBe("ig niche refresh <slug>");
  });

  it("skips files already present without creating a backend or spending budget", async () => {
    env = ranked();
    for (const code of ["sca1", "sca4"]) {
      const path = join(env.ctx.mediaDir, "ana", `${code}.mp4`);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, Buffer.alloc(1500));
    }
    const backendSpy = vi.spyOn(env.ctx, "backend");
    const { data } = await run({ top: 2 });
    expect(data).toMatchObject({ downloaded: 0, skipped: 2, failed: 0, bytes: 0 });
    expect(backendSpy).not.toHaveBeenCalled();
    expect(env.backend.calls).toEqual([]);
    expect(env.ctx.gate("browser").budget.used).toBe(0);
  });

  it("repeated targets are downloaded once", async () => {
    env = ranked();
    const { data } = await run({ targets: ["sca1", " sca1 ", "sca4"], dryRun: true });
    expect(data.items.map((i) => i.shortcode)).toEqual(["sca1", "sca4"]);
    expect(data.items.every((i) => i.status === "would-download")).toBe(true);
  });

  it("when every item fails the command fails, with the reasons in details", async () => {
    env = ranked();
    const err = await run({ targets: ["!!", "987654321"] }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "DOWNLOAD_FAILED", exitCode: 1 });
    const details = (err as IgError).details as DownloadSummary;
    expect(details.failed).toBe(2);
    expect(details.items.map((i) => i.reason)).toEqual([
      expect.stringContaining("not a stored video id"),
      expect.stringContaining("not a stored video id"),
    ]);
    expect(env.backend.calls).toEqual([]);
  });

  it("human view: one line per item and a one-line total", async () => {
    env = ranked();
    const root = join(env.ctx.paths.state, "media");
    const elsewhere = join(env.ctx.paths.state, "old", "sca4.mp4");
    const data: DownloadSummary = {
      downloaded: 1,
      skipped: 1,
      failed: 1,
      bytes: 1_572_864,
      dir: root,
      items: [
        {
          id: "1",
          shortcode: "sca1",
          creatorUsername: "ana",
          status: "downloaded",
          reason: null,
          path: join(root, "ana", "sca1.mp4"),
          bytes: 1_572_864,
        },
        {
          id: "2",
          shortcode: "sca4",
          creatorUsername: "ana",
          status: "skipped",
          reason: "already on disk; use --force to download again",
          path: elsewhere,
          bytes: 2048,
        },
        {
          id: null,
          shortcode: "scX",
          creatorUsername: null,
          status: "failed",
          reason: "the CDN answered HTTP 500\x1b[2J",
          path: null,
          bytes: null,
        },
      ],
    };
    const chunks: string[] = [];
    const previous = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR };
    process.env.NO_COLOR = "1";
    delete process.env.FORCE_COLOR;
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      download.human?.(data as never, env.ctx, {});
    } finally {
      spy.mockRestore();
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    const lines = chunks.join("").trimEnd().split("\n");
    const cells = lines.map((line) => line.split(/\s{2,}/));
    // The directory appears once, in the total; rows show the path below it.
    expect(cells[1]).toEqual(["downloaded", "ana/sca1", "1.5 MB", join("ana", "sca1.mp4")]);
    expect(cells[2]).toEqual(["skipped", "ana/sca4", "2 KB", elsewhere]);
    expect(cells[3]).toEqual(["failed", "?/scX", "–", "the CDN answered HTTP 500"]);
    expect(lines.at(-1)).toBe(`1 downloaded, 1 skipped, 1 failed · 1.5 MB · ${root}`);
    expect(chunks.join("")).not.toContain("\x1b");
  });
});
