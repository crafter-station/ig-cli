import type { CommandDef } from "../lib/command.js";
import { analyzeCommands } from "./analyze.js";
import { authCommands } from "./auth.js";
import { creatorCommands } from "./creator.js";
import { mediaCommands } from "./media.js";
import { metaCommands } from "./meta.js";
import { nicheCommands } from "./niche.js";
import { skillCommands } from "./skill.js";
import { transcriptCommands } from "./transcript.js";
import { trendsCommands } from "./trends.js";
import { videoCommands } from "./video.js";

/** Help text for each command group. */
export const GROUPS: Record<string, string> = {
  auth: "Backend credentials, status and halts",
  niche: "Named groups of creators",
  creator: "Discover and track creators",
  video: "Rank, search, discover and download reels",
  skill: "Install this CLI's manual for coding agents",
  config: "Configuration",
};

export const commands: CommandDef[] = [
  ...(authCommands as CommandDef[]),
  ...(nicheCommands as CommandDef[]),
  ...(creatorCommands as CommandDef[]),
  ...(videoCommands as CommandDef[]),
  ...(mediaCommands as CommandDef[]),
  ...(transcriptCommands as CommandDef[]),
  ...(analyzeCommands as CommandDef[]),
  ...(trendsCommands as CommandDef[]),
  ...(skillCommands as CommandDef[]),
];
commands.push(...(metaCommands(() => commands) as CommandDef[]));
