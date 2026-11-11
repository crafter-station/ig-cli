// A table whose columns stay aligned when cells contain color. Width is always
// measured as visible width, never string length.

import {
  bold,
  muted,
  padStartVisible,
  padVisible,
  truncateVisible,
  visibleWidth,
} from "../cligentic/platform/style.js";

export type Column<T> = {
  header: string;
  /** Returns the cell text. May include style escapes. */
  cell: (row: T, index: number) => string;
  align?: "left" | "right";
  /** Cells wider than this are truncated with an ellipsis. */
  maxWidth?: number;
};

export function renderTable<T>(rows: T[], columns: Column<T>[]): string {
  const cells = rows.map((row, i) =>
    columns.map((col) => {
      const text = col.cell(row, i);
      return col.maxWidth ? truncateVisible(text, col.maxWidth) : text;
    }),
  );
  const widths = columns.map((col, c) =>
    Math.max(visibleWidth(col.header), ...cells.map((r) => visibleWidth(r[c] ?? ""))),
  );
  const line = (values: string[]): string =>
    values
      .map((value, c) => {
        const width = widths[c] ?? 0;
        return columns[c]?.align === "right"
          ? padStartVisible(value, width)
          : padVisible(value, width);
      })
      .join("  ")
      .trimEnd();

  const header = line(columns.map((col) => bold(muted(col.header))));
  return [header, ...cells.map(line)].join("\n");
}

/** Writes a table to stdout, or `empty` to stderr when there are no rows. */
export function printTable<T>(rows: T[], columns: Column<T>[], empty: string): void {
  if (rows.length === 0) {
    process.stderr.write(`${muted(empty)}\n`);
    return;
  }
  process.stdout.write(`${renderTable(rows, columns)}\n`);
}

/** Aligned "label  value" lines for a single record. */
export function renderRecord(pairs: [string, string][]): string {
  const width = Math.max(...pairs.map(([label]) => label.length));
  return pairs.map(([label, value]) => `${muted(label.padEnd(width))}  ${value}`).join("\n");
}
