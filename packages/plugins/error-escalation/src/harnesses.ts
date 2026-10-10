import { HARNESS_ORDER } from "./constants.js";

/**
 * Take the next `count` harnesses after the one that failed, wrapping around
 * the configured order and never including the failed adapter.
 */
export function selectNextHarnesses(failedAdapter: string, order: readonly string[], count: number): string[] {
  if (count <= 0) return [];
  const cleaned: string[] = [];
  for (const entry of order) {
    const name = entry.trim();
    if (!name || cleaned.includes(name)) continue;
    cleaned.push(name);
  }
  const known = cleaned.length > 0 ? cleaned : [...HARNESS_ORDER];
  const start = known.indexOf(failedAdapter);
  const rotated = start === -1 ? known : [...known.slice(start + 1), ...known.slice(0, start)];
  return rotated.filter((name) => name !== failedAdapter).slice(0, count);
}
