import type { Issue, IssueWorkProduct } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { Link } from "@/lib/router";
import { cn, formatDateTime, relativeTime } from "@/lib/utils";
import {
  ExternalLink,
  FileText,
  FolderGit2,
  GitBranch,
  GitCommit,
  GitPullRequest,
  Globe,
  Hammer,
} from "lucide-react";

type WorkProductSectionKey =
  | "runtimeServices"
  | "previews"
  | "pullRequests"
  | "branchesAndCommits"
  | "artifactsAndDocuments";

type WorkProductSection = {
  key: WorkProductSectionKey;
  title: string;
  products: IssueWorkProduct[];
};

const SECTION_ORDER: WorkProductSectionKey[] = [
  "runtimeServices",
  "previews",
  "pullRequests",
  "branchesAndCommits",
  "artifactsAndDocuments",
];

function workspaceModeLabel(mode: string | null | undefined) {
  switch (mode) {
    case "isolated_workspace":
      return "Isolated workspace";
    case "operator_branch":
      return "Operator branch";
    case "cloud_sandbox":
      return "Cloud sandbox";
    case "adapter_managed":
      return "Adapter managed";
    default:
      return "Shared workspace";
  }
}

function workProductTypeLabel(type: IssueWorkProduct["type"]) {
  switch (type) {
    case "preview_url":
      return "Preview";
    case "runtime_service":
      return "Runtime service";
    case "pull_request":
      return "Pull request";
    case "branch":
      return "Branch";
    case "commit":
      return "Commit";
    case "artifact":
      return "Artifact";
    case "document":
      return "Document";
    default:
      return type;
  }
}

function workProductSectionKey(type: IssueWorkProduct["type"]): WorkProductSectionKey {
  switch (type) {
    case "runtime_service":
      return "runtimeServices";
    case "preview_url":
      return "previews";
    case "pull_request":
      return "pullRequests";
    case "branch":
    case "commit":
      return "branchesAndCommits";
    case "artifact":
    case "document":
    default:
      return "artifactsAndDocuments";
  }
}

function workProductIcon(type: IssueWorkProduct["type"]) {
  switch (type) {
    case "preview_url":
      return Globe;
    case "runtime_service":
      return Hammer;
    case "pull_request":
      return GitPullRequest;
    case "branch":
      return GitBranch;
    case "commit":
      return GitCommit;
    case "artifact":
      return FolderGit2;
    case "document":
    default:
      return FileText;
  }
}

function healthBadgeClass(healthStatus: IssueWorkProduct["healthStatus"]) {
  switch (healthStatus) {
    case "healthy":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
    case "unhealthy":
      return "border-destructive/30 bg-destructive/10 text-destructive";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

function productStatusClass(status: string) {
  switch (status) {
    case "approved":
    case "merged":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
    case "changes_requested":
    case "failed":
      return "border-destructive/30 bg-destructive/10 text-destructive";
    case "ready_for_review":
      return "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

function reviewStateClass(reviewState: string) {
  switch (reviewState) {
    case "approved":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
    case "changes_requested":
      return "border-destructive/30 bg-destructive/10 text-destructive";
    case "needs_board_review":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

function sectionTitle(key: WorkProductSectionKey) {
  switch (key) {
    case "runtimeServices":
      return "Runtime services";
    case "previews":
      return "Previews";
    case "pullRequests":
      return "Pull requests";
    case "branchesAndCommits":
      return "Branches and commits";
    case "artifactsAndDocuments":
    default:
      return "Artifacts and documents";
  }
}

function metadataRows(metadata: Record<string, unknown> | null) {
  if (!metadata) return [];
  const keys = [
    "branchName",
    "baseRef",
    "commitSha",
    "sha",
    "pullRequestNumber",
    "previewUrl",
    "artifactPath",
  ];
  const rows: Array<{ label: string; value: string }> = [];
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value !== "string" && typeof value !== "number") continue;
    rows.push({
      label: key.replace(/([A-Z])/g, " $1").replace(/_/g, " ").trim(),
      value: String(value),
    });
  }
  return rows.slice(0, 3);
}

function groupWorkProducts(products: IssueWorkProduct[]): WorkProductSection[] {
  const grouped = new Map<WorkProductSectionKey, IssueWorkProduct[]>();
  for (const product of products) {
    const key = workProductSectionKey(product.type);
    const bucket = grouped.get(key) ?? [];
    bucket.push(product);
    grouped.set(key, bucket);
  }

  return SECTION_ORDER
    .map((key) => ({
      key,
      title: sectionTitle(key),
      products:
        grouped.get(key)?.slice().sort((left, right) =>
          new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
        ) ?? [],
    }))
    .filter((section) => section.products.length > 0);
}

function ProductCard({ product }: { product: IssueWorkProduct }) {
  const Icon = workProductIcon(product.type);
  const metaRows = metadataRows(product.metadata);

  return (
    <div className="rounded-lg border border-border bg-card p-3" data-testid={`work-product-${product.type}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <div className="flex items-center gap-2">
            <Icon className="h-4 w-4 text-muted-foreground" />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{product.title}</div>
              <div className="mt-1 flex flex-wrap gap-1">
                <Badge variant="outline">{workProductTypeLabel(product.type)}</Badge>
                <Badge variant="outline">{product.provider}</Badge>
                <Badge variant="outline" className={productStatusClass(product.status)}>
                  {product.status.replace(/_/g, " ")}
                </Badge>
                {product.reviewState !== "none" ? (
                  <Badge variant="outline" className={reviewStateClass(product.reviewState)}>
                    {product.reviewState.replace(/_/g, " ")}
                  </Badge>
                ) : null}
                {product.isPrimary ? <Badge variant="outline">Primary</Badge> : null}
                {product.healthStatus !== "unknown" ? (
                  <Badge variant="outline" className={healthBadgeClass(product.healthStatus)}>
                    {product.healthStatus}
                  </Badge>
                ) : null}
              </div>
            </div>
          </div>

          {product.summary ? (
            <p className="text-sm text-muted-foreground">{product.summary}</p>
          ) : null}

          {(product.externalId || metaRows.length > 0) ? (
            <dl className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
              {product.externalId ? (
                <>
                  <dt className="font-medium text-foreground">External ID</dt>
                  <dd className="font-mono">{product.externalId}</dd>
                </>
              ) : null}
              {metaRows.map((row) => (
                <div key={row.label} className="contents">
                  <dt className="font-medium text-foreground">{row.label}</dt>
                  <dd className="break-all">{row.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>

        {product.url ? (
          <a
            href={product.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            Open
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
        <span title={formatDateTime(product.updatedAt)}>Updated {relativeTime(product.updatedAt)}</span>
        <span title={formatDateTime(product.createdAt)}>Created {relativeTime(product.createdAt)}</span>
      </div>
    </div>
  );
}

export function IssueWorkProductsPanel({ issue }: { issue: Issue }) {
  const workProducts = issue.workProducts ?? [];
  const sections = groupWorkProducts(workProducts);

  return (
    <div className="space-y-4" data-testid="issue-work-products-panel">
      {issue.currentExecutionWorkspace ? (
        <section className="space-y-2" data-testid="issue-work-products-current-workspace">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-muted-foreground">Current workspace</h3>
            <Link
              to={`/execution-workspaces/${issue.currentExecutionWorkspace.id}`}
              className="text-xs text-muted-foreground underline-offset-4 hover:underline"
            >
              Open workspace details
            </Link>
          </div>
          <div className="rounded-lg border border-border bg-card p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-2">
                <div>
                  <div className="truncate text-sm font-medium">{issue.currentExecutionWorkspace.name}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <Badge variant="outline">{workspaceModeLabel(issue.currentExecutionWorkspace.mode)}</Badge>
                    <Badge
                      variant="outline"
                      className={cn(
                        issue.currentExecutionWorkspace.status === "active"
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                          : "border-border bg-muted text-muted-foreground",
                      )}
                    >
                      {issue.currentExecutionWorkspace.status.replace(/_/g, " ")}
                    </Badge>
                    {issue.currentExecutionWorkspace.providerType !== "local_fs" ? (
                      <Badge variant="outline">{issue.currentExecutionWorkspace.providerType.replace(/_/g, " ")}</Badge>
                    ) : null}
                  </div>
                </div>
                <dl className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                  {issue.currentExecutionWorkspace.branchName ? (
                    <>
                      <dt className="font-medium text-foreground">Branch</dt>
                      <dd className="font-mono">{issue.currentExecutionWorkspace.branchName}</dd>
                    </>
                  ) : null}
                  {issue.currentExecutionWorkspace.baseRef ? (
                    <>
                      <dt className="font-medium text-foreground">Base ref</dt>
                      <dd className="font-mono">{issue.currentExecutionWorkspace.baseRef}</dd>
                    </>
                  ) : null}
                  {issue.currentExecutionWorkspace.cwd ? (
                    <>
                      <dt className="font-medium text-foreground">Path</dt>
                      <dd className="break-all">{issue.currentExecutionWorkspace.cwd}</dd>
                    </>
                  ) : null}
                  <dt className="font-medium text-foreground">Last used</dt>
                  <dd title={formatDateTime(issue.currentExecutionWorkspace.lastUsedAt)}>
                    {relativeTime(issue.currentExecutionWorkspace.lastUsedAt)}
                  </dd>
                </dl>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {sections.map((section) => (
        <section key={section.key} className="space-y-2" data-testid={`issue-work-products-section-${section.key}`}>
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-muted-foreground">{section.title}</h3>
            <span className="text-xs text-muted-foreground">{section.products.length}</span>
          </div>
          <div className="space-y-2">
            {section.products.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        </section>
      ))}

      {!issue.currentExecutionWorkspace && sections.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          No work products yet.
        </div>
      ) : null}
    </div>
  );
}
