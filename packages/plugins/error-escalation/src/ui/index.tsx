import type { PluginDetailTabProps } from "@paperclipai/plugin-sdk/ui";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";

interface EscalationView {
  escalations: Array<{
    id: string;
    status: string;
    failedAdapterType: string;
    failedRunId: string;
    error: string | null;
    repoUrl: string | null;
    branchName: string | null;
    proposals: Array<{ adapterType: string; status: string; text: string | null; discardReason: string | null; error: string | null }>;
    judge: { model: string; decision: string; reason: string } | null;
    decision: { outcome: string; actorId: string; reason: string | null; at: string } | null;
    failureNote: string | null;
    slack: { channel: string; ts: string } | null;
  }>;
}

export function ErrorEscalationIssueTab({ context }: PluginDetailTabProps) {
  const { data, loading, error } = usePluginData<EscalationView>("escalation", {
    companyId: context.companyId,
    issueId: context.entityId,
  });

  if (loading) return <p>Loading escalation…</p>;
  if (error) return <p>Could not load escalation: {error.message}</p>;
  const escalations = data?.escalations ?? [];
  if (escalations.length === 0) return <p>No error escalations for this issue.</p>;

  return (
    <div>
      {escalations.map((record) => (
        <section key={record.id} style={{ marginBottom: 16 }}>
          <h3>Escalation {record.id}</h3>
          <p>Status: {record.status}</p>
          <p>Failed adapter: {record.failedAdapterType}</p>
          <p>Run: {record.failedRunId}</p>
          <p>Repo: {record.repoUrl ?? "unknown"} {record.branchName ? `(${record.branchName})` : ""}</p>
          <p>Error: {record.error ?? "none"}</p>
          {record.judge ? (
            <p>Judge ({record.judge.model}): {record.judge.decision} — {record.judge.reason}</p>
          ) : null}
          {record.decision ? (
            <p>Decision: {record.decision.outcome} by {record.decision.actorId}{record.decision.reason ? ` — ${record.decision.reason}` : ""}</p>
          ) : null}
          {record.failureNote ? <p>{record.failureNote}</p> : null}
          <ul>
            {record.proposals.map((proposal) => (
              <li key={proposal.adapterType}>
                <strong>{proposal.adapterType}</strong> ({proposal.status})
                {proposal.discardReason ? ` — discarded: ${proposal.discardReason}` : ""}
                {proposal.error ? ` — ${proposal.error}` : ""}
                {proposal.text ? <pre>{proposal.text}</pre> : null}
              </li>
            ))}
          </ul>
          <p>Approve only records the decision. Nothing is written to the repo.</p>
        </section>
      ))}
    </div>
  );
}
