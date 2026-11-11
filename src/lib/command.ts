// Every command is a CommandDef. That one object is what commander registers,
// what `ig schema` publishes, and what the runner executes, so the published
// contract cannot drift from the behaviour.

import type { Command } from "commander";
import { z } from "zod";
import type { Context } from "../context.js";
import { IgError } from "./errors.js";
import type { Meta, NextStep } from "./output.js";

export type Result<O> = {
  data: O;
  meta?: Meta;
  nextSteps?: NextStep[];
};

export type CommandDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> = {
  /** Dotted id: "creator.search" is invoked as `ig creator search`. */
  id: string;
  summary: string;
  /** Longer help text shown under the summary in --help. */
  description?: string;
  /** Validated input. Positional arguments and flags are merged into one object. */
  input: I;
  /** Shape of `data` in the success envelope. */
  output: O;
  /** True when the command calls a backend and spends request budget. */
  network: boolean;
  /**
   * What the command changes on this machine.
   *   none        reads only
   *   local       adds or updates rows or files; safe to repeat
   *   destructive deletes local data; supports --dry-run and needs --yes
   */
  writes: "none" | "local" | "destructive";
  /** Declares positional arguments and flags on the commander command. */
  configure?: (cmd: Command) => void;
  /**
   * Maps commander's positional args to named input keys. Flags are merged
   * in automatically by their camelCase name.
   */
  args?: (positional: unknown[]) => Record<string, unknown>;
  handler: (input: z.output<I>, ctx: Context) => Promise<Result<z.output<O>>>;
  /** Human view, written to stdout. Without it the data prints as indented JSON. */
  human?: (data: z.output<O>, ctx: Context, meta: Meta) => void;
};

export function defineCommand<I extends z.ZodType, O extends z.ZodType>(
  def: CommandDef<I, O>,
): CommandDef<I, O> {
  return def;
}

/** Field names `--fields` may select: keys of the output object, or of its array element. */
export function outputFields(output: z.ZodType): string[] {
  let schema: unknown = output;
  if (schema instanceof z.ZodArray) schema = schema.element;
  // A loose object accepts extra keys, so its declared shape is not the full list.
  if (schema instanceof z.ZodObject && schema.def.catchall === undefined) {
    return Object.keys(schema.shape);
  }
  return [];
}

export function parseInput<I extends z.ZodType>(def: CommandDef<I>, raw: unknown): z.output<I> {
  const parsed = def.input.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
      .join("; ");
    throw new IgError("INVALID_INPUT", `Invalid input for \`ig ${cliPath(def.id)}\`: ${issues}`, {
      hint: `Run \`ig schema ${def.id}\` for the exact input shape.`,
    });
  }
  return parsed.data;
}

export function cliPath(id: string): string {
  return id.split(".").join(" ");
}

export function notImplemented(id: string): never {
  throw new IgError("NOT_IMPLEMENTED", `\`ig ${cliPath(id)}\` is not implemented yet.`);
}

/** JSON Schema for one side of a command contract. */
export function jsonSchema(schema: z.ZodType, io: "input" | "output"): unknown {
  return z.toJSONSchema(schema, { io, unrepresentable: "any" });
}

/** Shared flag schemas, so the same flag means the same thing everywhere. */
export const flags = {
  limit: (def: number, max = 500) =>
    z.coerce.number().int().min(1).max(max).default(def).describe("Maximum results"),
  backend: z
    .enum(["browser", "hiker"])
    .optional()
    .describe("Data source. Defaults to `backend` in config"),
  niche: z.string().optional().describe("Niche slug"),
  dryRun: z.boolean().default(false).describe("Report what would change without changing it"),
  yes: z.boolean().default(false).describe("Confirm a destructive operation"),
  force: z.boolean().default(false),
};
