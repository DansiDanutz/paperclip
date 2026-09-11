# Failover Admission and Conditional Stale Recovery

Status: implemented, disabled by default. Not activated.
Audience: engineering and operations.

This document describes the failover admission fencing and conditional stale-task
recovery machinery. Everything here is **inert until a company has a complete,
enabled admission policy**; absent, disabled, or invalid policy is a fixed
`admission_not_configured` refusal — never default-healthy, never default-admitted.

## What it gates

- Standby dispatch: a standby instance may dispatch or wake company work only
  while it holds a live, policy-admitted dispatch epoch for that company.
- Conditional stale reset: an assigned agent issue may be returned to actionable
  state only through the governed evaluator (strictly beyond 2× the configured
  heartbeat interval, no live run, no external blocker, scheduled-retry waits
  respected per policy, pause holds honored, complete owner/reviewer/goal
  governance required).
- Ordinary primary/user/worker writes, already-produced outcome recording, and
  safety finalization are never blocked by admission state.

## Invariants (approved; not configurable)

- Primary healthy means no standby admission.
- Unknown primary health never means down.
- Exactly one server-fenced dispatcher per company (one live epoch).
- Primary recovery invalidates the standby epoch; the monotonic epoch counter
  prevents a superseded standby from renewing stale authority.
- Running work is never interrupted by admission transitions.

## Policy fields (all required before `enabled` may be true)

`standbyInstanceId`, `primaryInstanceId`, `trustedObserverKeys`,
`health.maxObservationAgeMs`, `health.maxFutureSkewMs`,
`health.consecutiveUnavailableSamples`, `health.unknownBreaksUnhealthySequence`,
`epoch.ttlMs` (≥ 2 × `epoch.renewalCadenceMs`), `epoch.renewalCadenceMs`,
`epoch.maxDispatchesPerEpoch`, `staleRecovery.enabled`,
`staleRecovery.heartbeatIntervalMs`, `staleRecovery.anchorMultiplier` (fixed 2),
`staleRecovery.pauseHoldRequired`, `staleRecovery.respectScheduledRetries`.

Activation (installing a real policy, provisioning health observers/credentials,
enabling a standby deployment) is a separate, separately-authorized operational
act with an auditable policy revision; this repository ships only the machinery.
