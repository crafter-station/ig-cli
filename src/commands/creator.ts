import { z } from "zod";
import { CreatorHitSchema, StoredCreatorSchema } from "../core/types.js";
import { defineCommand, flags, notImplemented } from "../lib/command.js";

const list = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) =>
    (Array.isArray(v) ? v : v ? v.split(",") : []).map((s) => s.trim()).filter(Boolean),
  );

const search = defineCommand({
  id: "creator.search",
  summary: "Discover creators on Instagram by keyword",
  description:
    "Lists candidates only; nothing is stored until `ig creator add`.\n" +
    "Instagram search is personalised and incomplete. For breadth, pass --expand\n" +
    "with extra keyword variants (--also) and hashtags (--hashtags).",
  input: z.object({
    query: z.string().min(1),
    limit: flags.limit(30, 200),
    backend: flags.backend,
    expand: z
      .boolean()
      .default(false)
      .describe(
        "Also collect authors of matching reels, authors of hashtag reels, and accounts related to the top hits. Costs more requests",
      ),
    also: list.describe("Extra keyword variants, comma-separated. Used with --expand"),
    hashtags: list.describe(
      "Hashtags without #, comma-separated. Used with --expand. Defaults to the query without spaces",
    ),
    minFollowers: z.coerce.number().int().min(0).optional(),
    maxFollowers: z.coerce.number().int().min(0).optional(),
    resolve: z
      .boolean()
      .default(false)
      .describe(
        "Fetch each hit's profile to fill in a missing follower count. One request per hit. Without it, hits with unknown followers pass the follower filters",
      ),
  }),
  output: z.array(CreatorHitSchema),
  network: true,
  writes: "none",
  configure: (cmd) =>
    cmd
      .argument("<query>", 'keyword, e.g. "cocina" or "gta 6"')
      .option("--limit <n>", "maximum results (default 30)")
      .option("--backend <name>", "browser | hiker")
      .option("--expand", "combine keyword, reels, hashtag and related-account sources")
      .option("--also <keywords>", "extra keyword variants, comma-separated")
      .option("--hashtags <tags>", "hashtags to mine, comma-separated, without #")
      .option("--min-followers <n>", "drop accounts below this")
      .option("--max-followers <n>", "drop accounts above this")
      .option("--resolve", "fetch profiles to fill unknown follower counts"),
  args: ([query]) => ({ query }),
  handler: async () => notImplemented("creator.search"),
});

const add = defineCommand({
  id: "creator.add",
  summary: "Track creators, optionally inside a niche",
  description:
    "Fetches each profile (one request per new creator) and stores it. A creator\n" +
    "already tracked is not fetched again; it is only added to the niche.",
  input: z.object({
    usernames: z.array(z.string()).min(1).describe("Usernames, @handles or profile URLs"),
    niche: flags.niche.describe("Niche to add them to. Must exist"),
    backend: flags.backend,
  }),
  output: z.object({
    added: z.array(StoredCreatorSchema).describe("Creators tracked after this call"),
    failed: z.array(z.object({ username: z.string(), code: z.string(), message: z.string() })),
  }),
  network: true,
  writes: "local",
  configure: (cmd) =>
    cmd
      .argument("<usernames...>", "usernames, @handles or profile URLs")
      .option("--niche <slug>", "niche to add them to")
      .option("--backend <name>", "browser | hiker"),
  args: ([usernames]) => ({ usernames }),
  handler: async () => notImplemented("creator.add"),
});

const get = defineCommand({
  id: "creator.get",
  summary: "Show a tracked creator",
  input: z.object({
    username: z.string(),
    refresh: z.boolean().default(false).describe("Fetch profile and reels first"),
    reels: z.coerce
      .number()
      .int()
      .min(0)
      .max(100)
      .default(15)
      .describe("Reels to fetch on refresh"),
    backend: flags.backend,
    force: flags.force.describe("Refresh even if refreshed recently"),
  }),
  output: StoredCreatorSchema,
  network: true,
  writes: "local",
  configure: (cmd) =>
    cmd
      .argument("<username>")
      .option("--refresh", "fetch profile and reels first")
      .option("--reels <n>", "reels to fetch on refresh (default 15)")
      .option("--backend <name>", "browser | hiker")
      .option("--force", "refresh even if refreshed recently"),
  args: ([username]) => ({ username }),
  handler: async () => notImplemented("creator.get"),
});

const listCmd = defineCommand({
  id: "creator.list",
  summary: "List tracked creators",
  input: z.object({
    niche: flags.niche,
    sort: z.enum(["followers", "username", "refreshed"]).default("followers"),
    limit: flags.limit(100, 5000),
  }),
  output: z.array(StoredCreatorSchema),
  network: false,
  writes: "none",
  configure: (cmd) =>
    cmd
      .option("--niche <slug>", "only this niche")
      .option("--sort <key>", "followers | username | refreshed (stalest first)")
      .option("--limit <n>", "maximum results (default 100)"),
  handler: async () => notImplemented("creator.list"),
});

const remove = defineCommand({
  id: "creator.remove",
  summary: "Remove a creator from a niche, or stop tracking them entirely",
  description:
    "With --niche: removes the membership only; the creator and videos stay.\n" +
    "Without --niche: deletes the creator, their videos and metric history from\n" +
    "the database. That needs --yes. Downloaded files are never deleted.",
  input: z.object({
    username: z.string(),
    niche: flags.niche.describe("Remove from this niche only"),
    dryRun: flags.dryRun,
    yes: flags.yes,
  }),
  output: z.object({
    username: z.string(),
    action: z.enum(["removed-from-niche", "deleted", "would-remove-from-niche", "would-delete"]),
    niche: z.string().nullable(),
    videosDeleted: z.number().int(),
    filesLeftOnDisk: z.array(z.string()).describe("Downloaded files that were not deleted"),
  }),
  network: false,
  writes: "destructive",
  configure: (cmd) =>
    cmd
      .argument("<username>")
      .option("--niche <slug>", "remove from this niche only")
      .option("--dry-run", "report what would be removed")
      .option("--yes", "confirm deleting the creator and their data"),
  args: ([username]) => ({ username }),
  handler: async () => notImplemented("creator.remove"),
});

export const creatorCommands = [search, add, get, listCmd, remove];
