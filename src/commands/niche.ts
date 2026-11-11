import { z } from "zod";
import { NicheSchema, StoredCreatorSchema } from "../core/types.js";
import { defineCommand, flags, notImplemented } from "../lib/command.js";

const create = defineCommand({
  id: "niche.create",
  summary: "Create a niche: a named group of creators",
  input: z.object({
    slug: z.string().describe("Lowercase identifier: letters, digits, dashes. e.g. gta-6"),
    name: z.string().optional().describe("Display name. Defaults to the slug"),
    description: z.string().optional(),
  }),
  output: NicheSchema,
  network: false,
  writes: "local",
  configure: (cmd) =>
    cmd
      .argument("<slug>", "lowercase identifier, e.g. gta-6")
      .option("--name <name>", "display name")
      .option("--description <text>", "what belongs in this niche"),
  args: ([slug]) => ({ slug }),
  handler: async () => notImplemented("niche.create"),
});

const list = defineCommand({
  id: "niche.list",
  summary: "List niches with creator and video counts",
  input: z.object({}),
  output: z.array(NicheSchema),
  network: false,
  writes: "none",
  handler: async () => notImplemented("niche.list"),
});

const show = defineCommand({
  id: "niche.show",
  summary: "Show a niche and its creators",
  input: z.object({
    slug: z.string(),
    limit: flags.limit(100),
  }),
  output: z.object({
    niche: NicheSchema,
    creators: z.array(StoredCreatorSchema).describe("Largest first"),
  }),
  network: false,
  writes: "none",
  configure: (cmd) => cmd.argument("<slug>").option("--limit <n>", "maximum creators"),
  args: ([slug]) => ({ slug }),
  handler: async () => notImplemented("niche.show"),
});

export const RefreshItemSchema = z.object({
  username: z.string(),
  status: z.enum(["refreshed", "skipped", "failed", "would-refresh"]),
  reason: z
    .string()
    .nullable()
    .describe("Why it was skipped or failed, e.g. 'refreshed 2d ago', 'account not found'"),
  followers: z.number().int().nullable(),
  newVideos: z.number().int().describe("Videos seen for the first time in this run"),
  totalVideos: z.number().int().describe("Videos stored for this creator after the run"),
});

const refresh = defineCommand({
  id: "niche.refresh",
  summary: "Fetch fresh profile and reel metrics for every creator in a niche",
  description:
    "Creators refreshed more recently than `minRefreshDays` are skipped unless --force.\n" +
    "Stale creators go first. Progress is saved per creator, so a run stopped by a\n" +
    "block or the daily budget loses nothing and can be continued later.",
  input: z.object({
    slug: z.string(),
    reels: z.coerce.number().int().min(0).max(100).default(15).describe("Reels per creator"),
    maxCreators: z.coerce
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Stop after this many creators"),
    backend: flags.backend,
    force: flags.force.describe("Refresh even if refreshed recently"),
    dryRun: flags.dryRun,
  }),
  output: z.object({
    niche: z.string(),
    backend: z.string(),
    refreshed: z.number().int(),
    skipped: z.number().int(),
    failed: z.number().int(),
    requestsUsed: z.number().int().describe("Backend requests spent by this run"),
    items: z.array(RefreshItemSchema),
  }),
  network: true,
  writes: "local",
  configure: (cmd) =>
    cmd
      .argument("<slug>")
      .option("--reels <n>", "reels to fetch per creator (default 15)")
      .option("--max-creators <n>", "stop after this many creators")
      .option("--backend <name>", "browser | hiker")
      .option("--force", "refresh even if refreshed recently")
      .option("--dry-run", "list what would be refreshed; makes no requests"),
  args: ([slug]) => ({ slug }),
  handler: async () => notImplemented("niche.refresh"),
});

export const nicheCommands = [create, list, show, refresh];
