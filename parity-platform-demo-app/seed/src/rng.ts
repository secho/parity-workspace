// Deterministic PRNG. Hard rule 5: same seed, same numbers, every run.
// Math.random() must not appear anywhere in the seed or the traffic generator.

export const SEED = 0x9e3779b9;

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A named stream so that adding data to one area cannot shift another area's values. */
export function stream(name: string) {
  let h = SEED;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193) >>> 0;
  const next = mulberry32(h);

  return {
    next,
    /** integer in [min, max] inclusive */
    int(min: number, max: number): number {
      return min + Math.floor(next() * (max - min + 1));
    },
    /** float in [min, max), rounded to `dp` decimal places */
    float(min: number, max: number, dp = 2): number {
      const v = min + next() * (max - min);
      const m = 10 ** dp;
      return Math.round(v * m) / m;
    },
    pick<T>(items: readonly T[]): T {
      return items[Math.floor(next() * items.length)];
    },
    /** true with probability p */
    chance(p: number): boolean {
      return next() < p;
    },
    /** Power-law-ish index into [0, n): small indices far more likely. */
    zipf(n: number, exponent = 1.4): number {
      const u = next();
      const idx = Math.floor(n * Math.pow(u, exponent));
      return Math.min(idx, n - 1);
    },
  };
}
