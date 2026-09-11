import { and, eq, sql } from "drizzle-orm";
import { companyDispatchEpochs, companyFailoverPolicies, type Db } from "@paperclipai/db";
import {
  evaluatePrimaryHealth,
  resolveAdmissionPolicy,
  type FailoverPolicyDocument,
  type PrimaryHealthState,
  type ResolvedAdmissionPolicy,
} from "./admission-policy.js";

export type AdmissionRefusalCode =
  | "admission_not_configured"
  | "admission_refused_not_bound"
  | "admission_refused_primary_healthy"
  | "admission_refused_unknown"
  | "admission_refused_epoch_live";

export type AdmissionDecision =
  | { admitted: true; epoch: { epochValue: number; expiresAt: Date; dispatchBudgetRemaining: number } }
  | { admitted: false; code: AdmissionRefusalCode; reason: string };

type Executor = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type FailoverAdmissionService = {
  resolvePolicy(companyId: string): Promise<ResolvedAdmissionPolicy>;
  tryAdmitStandby(
    companyId: string,
    instanceId: string,
    primaryHealth: PrimaryHealthState,
  ): Promise<AdmissionDecision>;
  invalidateEpoch(companyId: string, byPrincipal: string, reason: string): Promise<boolean>;
  consumeDispatchSlot(companyId: string, instanceId: string): Promise<boolean>;
  isDispatchAllowed(companyId: string, instanceId: string): Promise<boolean>;
};

export function createFailoverAdmissionService(db: Db): FailoverAdmissionService {
  async function resolvePolicy(companyId: string): Promise<ResolvedAdmissionPolicy> {
    const row = await db
      .select()
      .from(companyFailoverPolicies)
      .where(eq(companyFailoverPolicies.companyId, companyId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row ? resolveAdmissionPolicy(row) : { state: "admission_not_configured", reason: "no policy row" };
  }

  /**
   * Admits (or renews) the calling standby instance's dispatch epoch for the
   * company inside one transaction. Primary-healthy and unknown never admit;
   * a live epoch owned by another instance refuses; an expired or invalidated
   * epoch is superseded with a strictly monotonic epoch counter.
   */
  async function tryAdmitStandby(
    companyId: string,
    instanceId: string,
    primaryHealth: PrimaryHealthState,
  ): Promise<AdmissionDecision> {
    return db.transaction(async (tx): Promise<AdmissionDecision> => {
      const row = await tx
        .select()
        .from(companyFailoverPolicies)
        .where(eq(companyFailoverPolicies.companyId, companyId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      const resolved: ResolvedAdmissionPolicy = row
        ? resolveAdmissionPolicy(row)
        : { state: "admission_not_configured", reason: "no policy row" };
      if (resolved.state !== "configured") {
        return { admitted: false, code: "admission_not_configured", reason: resolved.reason };
      }
      const policy: FailoverPolicyDocument = resolved.policy;
      if (policy.standbyInstanceId !== instanceId) {
        return {
          admitted: false,
          code: "admission_refused_not_bound",
          reason: "instance is not the policy-bound standby",
        };
      }
      if (primaryHealth === "healthy") {
        return {
          admitted: false,
          code: "admission_refused_primary_healthy",
          reason: "primary healthy means no standby admission",
        };
      }
      if (primaryHealth === "unknown") {
        return {
          admitted: false,
          code: "admission_refused_unknown",
          reason: "unknown primary health never means down",
        };
      }

      const now = new Date();
      const [existing] = await tx
        .select()
        .from(companyDispatchEpochs)
        .where(and(
          eq(companyDispatchEpochs.companyId, companyId),
          eq(companyDispatchEpochs.state, "active"),
        ))
        .for("update")
        .then((rows) => rows);

      if (existing && existing.ownerInstanceId !== instanceId && existing.expiresAt > now) {
        return {
          admitted: false,
          code: "admission_refused_epoch_live",
          reason: "another instance holds the live dispatch epoch",
        };
      }

      if (existing && existing.ownerInstanceId === instanceId && existing.expiresAt > now) {
        const expiresAt = new Date(now.getTime() + policy.epoch.ttlMs);
        const [renewed] = await tx
          .update(companyDispatchEpochs)
          .set({ renewedAt: now, expiresAt, updatedAt: now })
          .where(eq(companyDispatchEpochs.id, existing.id))
          .returning();
        return {
          admitted: true,
          epoch: {
            epochValue: renewed.epoch,
            expiresAt: renewed.expiresAt,
            dispatchBudgetRemaining: renewed.maxDispatches - renewed.dispatchCount,
          },
        };
      }

      if (existing) {
        await tx
          .update(companyDispatchEpochs)
          .set({ state: "expired", updatedAt: now })
          .where(eq(companyDispatchEpochs.id, existing.id));
      }

      const [maxRow] = await tx
        .select({ maxEpoch: sql<number | null>`coalesce(max(${companyDispatchEpochs.epoch}), 0)` })
        .from(companyDispatchEpochs)
        .where(eq(companyDispatchEpochs.companyId, companyId));
      const epochValue = Number(maxRow?.maxEpoch ?? 0) + 1;
      const expiresAt = new Date(now.getTime() + policy.epoch.ttlMs);
      const [inserted] = await tx
        .insert(companyDispatchEpochs)
        .values({
          companyId,
          epoch: epochValue,
          ownerInstanceId: instanceId,
          state: "active",
          maxDispatches: policy.epoch.maxDispatchesPerEpoch,
          dispatchCount: 0,
          expiresAt,
        })
        .returning();
      return {
        admitted: true,
        epoch: {
          epochValue: inserted.epoch,
          expiresAt: inserted.expiresAt,
          dispatchBudgetRemaining: inserted.maxDispatches - inserted.dispatchCount,
        },
      };
    });
  }

  async function invalidateEpoch(companyId: string, byPrincipal: string, reason: string): Promise<boolean> {
    const now = new Date();
    const updated = await db
      .update(companyDispatchEpochs)
      .set({
        state: "invalidated",
        invalidatedAt: now,
        invalidationReason: `${byPrincipal}: ${reason}`,
        updatedAt: now,
      })
      .where(and(
        eq(companyDispatchEpochs.companyId, companyId),
        eq(companyDispatchEpochs.state, "active"),
      ))
      .returning();
    return updated.length > 0;
  }

  async function consumeDispatchSlot(companyId: string, instanceId: string): Promise<boolean> {
    const updated = await db
      .update(companyDispatchEpochs)
      .set({ dispatchCount: sql`${companyDispatchEpochs.dispatchCount} + 1`, updatedAt: new Date() })
      .where(and(
        eq(companyDispatchEpochs.companyId, companyId),
        eq(companyDispatchEpochs.ownerInstanceId, instanceId),
        eq(companyDispatchEpochs.state, "active"),
        sql`${companyDispatchEpochs.expiresAt} > now()`,
        sql`${companyDispatchEpochs.dispatchCount} < ${companyDispatchEpochs.maxDispatches}`,
      ))
      .returning();
    return updated.length > 0;
  }

  async function isDispatchAllowed(companyId: string, instanceId: string): Promise<boolean> {
    const [epoch] = await db
      .select({ id: companyDispatchEpochs.id })
      .from(companyDispatchEpochs)
      .where(and(
        eq(companyDispatchEpochs.companyId, companyId),
        eq(companyDispatchEpochs.ownerInstanceId, instanceId),
        eq(companyDispatchEpochs.state, "active"),
        sql`${companyDispatchEpochs.expiresAt} > now()`,
      ))
      .limit(1);
    return epoch !== undefined;
  }

  return {
    resolvePolicy,
    tryAdmitStandby,
    invalidateEpoch,
    consumeDispatchSlot,
    isDispatchAllowed,
  };
}
