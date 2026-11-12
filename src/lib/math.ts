// Small numeric helpers shared by the core modules.

/** 3.14159 -> 3.14. `digits` decimals, 2 by default. */
export function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
