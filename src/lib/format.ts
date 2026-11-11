// Formatting for the human view only. Machine output always carries raw values.

/** 1234 -> "1.2K", 1500000 -> "1.5M". Null renders as a dash, never as 0. */
export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined) return "–";
  const abs = Math.abs(n);
  if (abs < 1000) return String(n);
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) {
      const value = n / size;
      const text = Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1);
      return `${text.replace(/\.0$/, "")}${suffix}`;
    }
  }
  return String(n);
}

/** 0.0345 -> "3.5%". */
export function percent(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined) return "–";
  return `${(n * 100).toFixed(digits)}%`;
}

/** 3.2 -> "3.2x". */
export function multiple(n: number | null | undefined): string {
  if (n === null || n === undefined) return "–";
  return `${n.toFixed(1)}x`;
}

/** "3d ago", "5h ago", "just now"; "never" for null. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const ms = now - Date.parse(iso);
  if (Number.isNaN(ms)) return "–";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 24) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** 83 -> "1:23". */
export function duration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return "–";
  const total = Math.round(sec);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * Parses "30d", "12h", "2w" into an ISO timestamp that far in the past, or
 * passes an ISO date through. Returns null if it is neither.
 */
export function parseSince(value: string, now = Date.now()): string | null {
  const rel = value.match(/^(\d+)([hdw])$/);
  if (rel) {
    const unit = { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[rel[2] as "h" | "d" | "w"];
    return new Date(now - Number(rel[1]) * unit).toISOString();
  }
  const abs = Date.parse(value);
  return Number.isNaN(abs) ? null : new Date(abs).toISOString();
}
