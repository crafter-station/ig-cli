import { describe, expect, it } from "vitest";
import { z } from "zod";
import { normalizeUsername, parseShortcode, slugify } from "../src/core/types.js";
import { outputFields } from "../src/lib/command.js";
import { ConfigSchema, setConfigValue } from "../src/lib/config.js";
import type { IgError } from "../src/lib/errors.js";
import { ago, compact, parseSince } from "../src/lib/format.js";
import { applyFields, oneLine, sanitize } from "../src/lib/output.js";
import { renderTable } from "../src/lib/table.js";

const errCode = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    return (err as IgError).code;
  }
  return "none";
};

const ESC = String.fromCharCode(27);

describe("applyFields", () => {
  const rows = [
    { a: 1, b: 2, c: 3 },
    { a: 4, b: 5, c: 6 },
  ];

  it("keeps only the requested fields of each element", () => {
    expect(applyFields(rows, "a, c", ["a", "b", "c"])).toEqual([
      { a: 1, c: 3 },
      { a: 4, c: 6 },
    ]);
  });

  it("rejects an unknown field instead of returning empty objects", () => {
    expect(errCode(() => applyFields(rows, "a,zzz", ["a", "b", "c"]))).toBe("INVALID_FIELDS");
    expect(errCode(() => applyFields(rows, " , ", ["a"]))).toBe("INVALID_FIELDS");
  });

  it("rejects an unknown field even when the result set is empty", () => {
    expect(errCode(() => applyFields([], "zzz", ["a"]))).toBe("INVALID_FIELDS");
  });

  it("validates against the data itself when the output declares no fixed keys", () => {
    expect(applyFields({ version: "1", extra: true }, "extra", [])).toEqual({ extra: true });
    expect(errCode(() => applyFields({ version: "1" }, "nope", []))).toBe("INVALID_FIELDS");
  });

  it("derives field names from object and array-of-object outputs", () => {
    const item = z.object({ id: z.string(), n: z.number() });
    expect(outputFields(item)).toEqual(["id", "n"]);
    expect(outputFields(z.array(item))).toEqual(["id", "n"]);
    expect(outputFields(z.looseObject({ version: z.string() }))).toEqual([]);
  });
});

describe("third-party text", () => {
  it("strips ANSI escapes and control characters", () => {
    const hostile = `${ESC}[31mred${ESC}[0m ${ESC}[2Jwipe${String.fromCharCode(7)}`;
    expect(sanitize(hostile)).toBe("red wipe");
    expect(oneLine("line one\n\n  line\ttwo ")).toBe("line one line two");
    expect(sanitize(null)).toBe("");
  });
});

describe("table", () => {
  it("aligns columns by visible width when cells carry color escapes", () => {
    const out = renderTable(
      [
        { n: `${ESC}[38;5;114mok${ESC}[0m`, v: "1" },
        { n: "plain-long", v: "22" },
      ],
      [
        { header: "N", cell: (r) => r.n },
        { header: "V", cell: (r) => r.v, align: "right" },
      ],
    );
    const strip = (line: string) => line.split(/\u001b\[[0-9;]*m/).join("");
    expect(out.split("\n").map(strip)).toEqual([
      "N            V",
      "ok           1",
      "plain-long  22",
    ]);
  });
});

describe("format", () => {
  it("abbreviates counts and renders null as a dash, not zero", () => {
    expect([999, 1000, 1234, 15_500, 1_500_000, 2_000_000_000].map(compact)).toEqual([
      "999",
      "1K",
      "1.2K",
      "15.5K",
      "1.5M",
      "2B",
    ]);
    expect(compact(null)).toBe("–");
    expect(compact(0)).toBe("0");
  });

  it("describes age relative to now", () => {
    const now = Date.parse("2026-11-11T12:00:00Z");
    expect(ago("2026-11-11T11:59:40Z", now)).toBe("just now");
    expect(ago("2026-11-11T07:00:00Z", now)).toBe("5h ago");
    expect(ago("2026-11-08T12:00:00Z", now)).toBe("3d ago");
    expect(ago(null, now)).toBe("never");
  });

  it("parses relative and absolute --since values and rejects garbage", () => {
    const now = Date.parse("2026-11-02T00:00:00Z");
    expect(parseSince("2d", now)).toBe("2026-10-31T00:00:00.000Z");
    expect(parseSince("2026-01-15", now)).toBe("2026-01-15T00:00:00.000Z");
    expect(parseSince("soon", now)).toBeNull();
  });
});

describe("identifiers", () => {
  it("slugifies names with accents and spaces", () => {
    expect(slugify("GTA 6")).toBe("gta-6");
    expect(slugify("  Cocina Fácil!! ")).toBe("cocina-facil");
  });

  it("normalizes usernames from handles and URLs", () => {
    expect(normalizeUsername("@Ana.Cocina")).toBe("ana.cocina");
    expect(normalizeUsername("https://www.instagram.com/ana_cocina/?hl=es")).toBe("ana_cocina");
  });

  it("extracts shortcodes from URLs and refuses numeric ids", () => {
    expect(parseShortcode("https://www.instagram.com/reel/DAbc-1_xY/?igsh=x")).toBe("DAbc-1_xY");
    expect(parseShortcode("https://www.instagram.com/ana/reel/DAbc12345/")).toBe("DAbc12345");
    expect(parseShortcode("DAbc12345")).toBe("DAbc12345");
    expect(parseShortcode("3141592653589793")).toBeNull();
  });
});

describe("config", () => {
  it("sets nested numeric values and rejects unknown keys and bad values", () => {
    const base = ConfigSchema.parse({});
    const next = setConfigValue(base, "limits.browser.dailyBudget", "50");
    expect(next.limits.browser.dailyBudget).toBe(50);
    expect(base.limits.browser.dailyBudget).toBe(400);
    expect(errCode(() => setConfigValue(base, "limits.browser.delayMs", "1"))).toBe(
      "INVALID_INPUT",
    );
    expect(errCode(() => setConfigValue(base, "backend", "carrier-pigeon"))).toBe("INVALID_INPUT");
    expect(errCode(() => setConfigValue(base, "minRefreshDays", "abc"))).toBe("INVALID_INPUT");
  });
});
