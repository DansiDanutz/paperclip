export type PluginBridgeCompanyScope =
  | { ok: true; companyId: string | null; params: Record<string, unknown> }
  | { ok: false; error: string };

function readCompanyId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Authorize one company for a plugin data/action call.
 *
 * The route used to check only the top-level `companyId` and then forward
 * `params` unchanged. A board user limited to company A could pass A at the
 * top level and company B inside `params`.
 */
export function resolvePluginBridgeCompanyScope(body: {
  companyId?: unknown;
  params?: Record<string, unknown> | null;
} | null | undefined): PluginBridgeCompanyScope {
  const source = body ?? {};
  const top = readCompanyId(source.companyId);
  const params: Record<string, unknown> = { ...(source.params ?? {}) };
  const nested = readCompanyId(params.companyId);
  if (top && nested && top !== nested) {
    return { ok: false, error: "Company scope mismatch" };
  }
  const companyId = top ?? nested;
  if (companyId) params.companyId = companyId;
  return { ok: true, companyId, params };
}
