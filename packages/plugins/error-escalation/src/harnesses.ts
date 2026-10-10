import { HARNESS_ORDER } from "./constants.js";

/**
 * Take the next `count` harnesses after the one that failed, wrapping around
 * the configured order and never including the failed adapter.
 */
/**
 * Grok and Kimi run through the process adapter, so a failure reports
 * `process` instead of `grok_build` or `kimi`. Match the configured agent id
 * before choosing the next harnesses.
 */
export function resolveFailedHarness(input: {
  adapterType: string;
  agentId: string;
  harnessAgents: Record<string, string>;
  order: readonly string[];
}): string {
  const adapter = input.adapterType.trim();
  if (adapter && adapter !== "process" && input.order.includes(adapter)) return adapter;
  for (const harness of input.order) {
    const configured = input.harnessAgents[harness]?.trim();
    if (configured && configured === input.agentId) return harness;
  }
  return adapter || "unknown";
}

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
