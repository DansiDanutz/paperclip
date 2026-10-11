export type PluginBridgeCompanyScope =
  | { ok: true; companyId: string | null; params: Record<string, unknown> }
  | { ok: false; error: string };

function readCompanyId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Read the company a plugin data/action call is allowed to use.
 *
 * Authorization uses the top-level `companyId` only. The route checks that id
 * against the actor, then action handlers overwrite `params.companyId` with it.
 * A nested id that names another company is replaced here when the caller
 * already supplied one, and is not promoted into the authorized scope. Params
 * that do not name a company are left unchanged so data calls keep their body.
 */
export function resolvePluginBridgeCompanyScope(body: {
  companyId?: unknown;
  params?: Record<string, unknown> | null;
} | null | undefined): PluginBridgeCompanyScope {
  const source = body ?? {};
  const companyId = readCompanyId(source.companyId);
  const params: Record<string, unknown> = { ...(source.params ?? {}) };
  if (companyId && readCompanyId(params.companyId)) {
    params.companyId = companyId;
  }
  return { ok: true, companyId, params };
}
