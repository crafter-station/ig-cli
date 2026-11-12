// The output contract. One envelope, every command:
//
//   { "ok": true,  "data": ..., "meta": { "nextSteps": [...] } }
//   { "ok": false, "error": { "code": "...", "message": "...", "hint": "..." } }
//
// stdout carries the envelope (machine mode) or the human view. Everything
// else, including errors in human mode, goes to stderr.

import { detectMode, type OutputMode } from "../cligentic/platform/detect.js";
import { danger, dim, info, muted } from "../cligentic/platform/style.js";
import { IgError } from "./errors.js";

export type NextStep = { command: string; description: string };

export type Meta = Record<string, unknown> & { nextSteps?: NextStep[] };

export type OutputOptions = {
  json?: boolean;
  quiet?: boolean;
  fields?: string;
};

export function resolveMode(opts: OutputOptions): OutputMode {
  return detectMode({ json: opts.json });
}

/**
 * Removes control characters, including ANSI escapes, from third-party text
 * before it reaches a terminal. Captions and bios are attacker-controlled.
 */
export function sanitize(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

/** Single-line, sanitized, for table cells. */
export function oneLine(text: string | null | undefined): string {
  return sanitize(text).replace(/\s+/g, " ").trim();
}

/** An error (or anything thrown) as one sanitized line, for an item's `reason`. */
export function errorLine(err: unknown): string {
  return oneLine(err instanceof Error ? err.message : String(err));
}

function pick(row: unknown, fields: string[]): unknown {
  if (row === null || typeof row !== "object") return row;
  const source = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f] = source[f];
  return out;
}

/**
 * Applies `--fields a,b,c`. Works on an object or on each element of an array.
 * An unknown field is an error, never an empty object under `ok: true`.
 */
export function applyFields<T>(
  data: T,
  fieldsFlag: string | undefined,
  declared: string[],
): unknown {
  if (!fieldsFlag) return data;
  // An open-ended output (such as `ig schema`) declares no fixed keys, so
  // validate against what is actually there.
  const sample = Array.isArray(data) ? data[0] : data;
  const known =
    declared.length > 0
      ? declared
      : sample !== null && typeof sample === "object"
        ? Object.keys(sample)
        : [];
  const fields = fieldsFlag
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  if (fields.length === 0) {
    throw new IgError("INVALID_FIELDS", "--fields was given without any field name.", {
      hint: `Available fields: ${known.join(", ")}`,
    });
  }
  const unknown = fields.filter((f) => !known.includes(f));
  if (unknown.length > 0) {
    throw new IgError("INVALID_FIELDS", `Unknown field(s): ${unknown.join(", ")}`, {
      hint: `Available fields: ${known.join(", ")}`,
    });
  }
  return Array.isArray(data) ? data.map((row) => pick(row, fields)) : pick(data, fields);
}

export function writeEnvelope(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

export function printNextSteps(steps: NextStep[] | undefined): void {
  if (!steps || steps.length === 0) return;
  process.stderr.write(`\n${muted("Next:")}\n`);
  for (const s of steps) {
    process.stderr.write(`  ${info(s.command)}  ${dim(s.description)}\n`);
  }
}

export function printError(err: IgError, mode: OutputMode): void {
  if (mode === "json") {
    writeEnvelope({
      ok: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.hint ? { hint: err.hint } : {}),
        ...(err.details ? { details: err.details } : {}),
      },
    });
    return;
  }
  process.stderr.write(`${danger("error")} ${err.message} ${dim(`[${err.code}]`)}\n`);
  if (err.hint) process.stderr.write(`${muted("hint")}  ${err.hint}\n`);
}

/** Diagnostic line on stderr. Silent in machine mode and under --quiet. */
export function makeLogger(mode: OutputMode, quiet: boolean | undefined) {
  return (message: string): void => {
    if (mode === "json" || quiet) return;
    process.stderr.write(`${dim(message)}\n`);
  };
}
