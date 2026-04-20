import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  OperatingContractAction,
  OperatingContractActionGroup,
  OperatingContractConfig,
  OperatingContractPreviewResult,
} from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "../components/EmptyState";
import { companiesApi } from "../api/companies";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDateTime } from "../lib/utils";
import { AlertTriangle, CheckCircle2, FolderGit2, RefreshCcw, ShieldAlert } from "lucide-react";

const ACTION_GROUP_ORDER: OperatingContractActionGroup[] = [
  "company_metadata",
  "goals",
  "project_goal_links",
  "issue_goal_backfills",
  "agents",
  "staffing_recommendations",
];

const ACTION_GROUP_LABELS: Record<OperatingContractActionGroup, string> = {
  company_metadata: "Company metadata",
  goals: "Goals",
  project_goal_links: "Project goal links",
  issue_goal_backfills: "Issue goal backfills",
  agents: "Agents from contract",
  staffing_recommendations: "Staffing recommendations",
};

const ACTION_GROUP_DESCRIPTIONS: Record<OperatingContractActionGroup, string> = {
  company_metadata: "Bring company name and description back to the reviewed contract.",
  goals: "Create or update canonical company goals from the contract.",
  project_goal_links: "Repair project-to-goal links for active projects.",
  issue_goal_backfills: "Backfill goal IDs only where the mapping is unambiguous.",
  agents: "Create or update contract-defined agents.",
  staffing_recommendations: "Apply optional board-approved staffing recommendations.",
};

function getReviewStatus(config: OperatingContractConfig) {
  if (!config.projectWorkspaceId) return "unconfigured";
  if (config.sourceChangedSinceReview) return "needs_review";
  return config.lastReviewSummary?.status ?? "needs_review";
}

function statusBadgeVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "healthy") return "default";
  if (status === "warning") return "destructive";
  if (status === "needs_review") return "secondary";
  return "outline";
}

function statusLabel(status: string) {
  switch (status) {
    case "healthy":
      return "Healthy";
    case "warning":
      return "Warning";
    case "needs_review":
      return "Needs review";
    case "unconfigured":
    default:
      return "Unconfigured";
  }
}

function countForGroup(preview: OperatingContractPreviewResult, group: OperatingContractActionGroup) {
  switch (group) {
    case "company_metadata":
      return preview.counts.companyMetadata;
    case "goals":
      return preview.counts.goals;
    case "project_goal_links":
      return preview.counts.projectGoalLinks;
    case "issue_goal_backfills":
      return preview.counts.issueGoalBackfills;
    case "agents":
      return preview.counts.agents;
    case "staffing_recommendations":
      return preview.counts.staffingRecommendations;
  }
}

function defaultSelectedGroups(preview: OperatingContractPreviewResult): OperatingContractActionGroup[] {
  return ACTION_GROUP_ORDER.filter((group) =>
    group !== "staffing_recommendations" && countForGroup(preview, group) > 0,
  );
}

function ActionGroupCard(input: {
  group: OperatingContractActionGroup;
  actions: OperatingContractAction[];
  selected: boolean;
  onToggle: (checked: boolean) => void;
}) {
  return (
    <label
      className={cn(
        "block rounded-lg border px-4 py-4 transition-colors",
        input.selected ? "border-primary/40 bg-primary/5" : "border-border bg-card",
      )}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 rounded border-border"
          checked={input.selected}
          onChange={(event) => input.onToggle(event.target.checked)}
        />
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{ACTION_GROUP_LABELS[input.group]}</span>
            <Badge variant="outline">{input.actions.length}</Badge>
            {input.group === "staffing_recommendations" ? (
              <Badge variant="secondary">Optional</Badge>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">{ACTION_GROUP_DESCRIPTIONS[input.group]}</p>
          <div className="space-y-2">
            {input.actions.map((action) => (
              <div key={action.id} className="rounded-md border border-border/70 bg-background/60 px-3 py-2">
                <div className="text-sm font-medium">{action.title}</div>
                <div className="text-xs text-muted-foreground">{action.description}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </label>
  );
}

export function CompanyOperatingContract() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState<OperatingContractPreviewResult | null>(null);
  const [selectedGroups, setSelectedGroups] = useState<OperatingContractActionGroup[]>([]);
  const [autoPreviewKey, setAutoPreviewKey] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Operating Contract" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const configQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.companies.operatingContract(selectedCompanyId) : ["companies", "operating-contract", "idle"],
    queryFn: () => companiesApi.getOperatingContract(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const previewMutation = useMutation({
    mutationFn: () => companiesApi.previewOperatingContract(selectedCompanyId!),
    onSuccess: (result) => {
      setPreview(result);
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.operatingContract(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(selectedCompanyId!) });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to preview operating contract",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const applyMutation = useMutation({
    mutationFn: (groups: OperatingContractActionGroup[]) =>
      companiesApi.applyOperatingContract(selectedCompanyId!, {
        previewHash: preview!.previewHash,
        selectedActionGroups: groups,
      }),
    onSuccess: async (result) => {
      setPreview(result.preview);
      setSelectedGroups(defaultSelectedGroups(result.preview));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companies.operatingContract(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.goals.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) }),
      ]);
      pushToast({
        title: "Operating contract applied",
        body: "Selected repair groups were applied successfully.",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to apply operating contract",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  useEffect(() => {
    setPreview(null);
    setSelectedGroups([]);
    setAutoPreviewKey(null);
  }, [selectedCompanyId]);

  useEffect(() => {
    if (!configQuery.data) return;
    const nextKey = `${configQuery.data.projectWorkspaceId ?? "none"}:${configQuery.data.packageRootPath}`;
    setPreview(null);
    setSelectedGroups([]);
    setAutoPreviewKey((current) => (current === nextKey ? current : null));
  }, [configQuery.data?.projectWorkspaceId, configQuery.data?.packageRootPath]);

  useEffect(() => {
    if (!configQuery.data?.projectWorkspaceId) return;
    const nextKey = `${configQuery.data.projectWorkspaceId}:${configQuery.data.packageRootPath}`;
    if (autoPreviewKey === nextKey || previewMutation.isPending || preview) return;
    setAutoPreviewKey(nextKey);
    previewMutation.mutate();
  }, [autoPreviewKey, configQuery.data, preview, previewMutation]);

  useEffect(() => {
    if (!preview) return;
    setSelectedGroups(defaultSelectedGroups(preview));
  }, [preview?.previewHash]);

  const currentPreview = preview;
  const actionGroups = useMemo(() => {
    if (!currentPreview) return [];
    return ACTION_GROUP_ORDER
      .map((group) => ({
        group,
        actions: currentPreview.actions.filter((action) => action.group === group),
      }))
      .filter((entry) => entry.actions.length > 0);
  }, [currentPreview]);

  const selectedActionCount = currentPreview
    ? selectedGroups.reduce((sum, group) => sum + countForGroup(currentPreview, group), 0)
    : 0;

  if (!selectedCompanyId) {
    return <EmptyState icon={FolderGit2} message="Select a company to review its operating contract." />;
  }

  if (configQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading operating contract…</div>;
  }

  if (configQuery.error) {
    return <div className="text-sm text-destructive">{configQuery.error.message}</div>;
  }

  const config = configQuery.data!;
  const reviewStatus = getReviewStatus(config);

  if (!config.projectWorkspaceId) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-2">
          <FolderGit2 className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Operating Contract</h1>
        </div>
        <EmptyState
          icon={ShieldAlert}
          message="This company does not have an operating contract source configured yet."
        />
        <div className="flex items-center gap-2">
          <Button asChild>
            <Link to="/company/settings">Configure in settings</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <FolderGit2 className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold">Operating Contract</h1>
            <Badge variant={statusBadgeVariant(reviewStatus)}>{statusLabel(reviewStatus)}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Review repo-backed contract drift, then apply only the repair groups you approve.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" asChild>
            <Link to="/company/settings">Edit source</Link>
          </Button>
          <Button variant="outline" onClick={() => previewMutation.mutate()} disabled={previewMutation.isPending}>
            <RefreshCcw className={cn("mr-1.5 h-4 w-4", previewMutation.isPending && "animate-spin")} />
            {previewMutation.isPending ? "Previewing..." : "Run preview"}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-lg border border-border px-4 py-4">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Source</div>
          <div className="mt-3 space-y-2 text-sm">
            <div>
              <span className="text-muted-foreground">Workspace:</span>{" "}
              {config.workspace ? `${config.workspace.projectName} / ${config.workspace.workspaceName}` : config.projectWorkspaceId}
            </div>
            <div>
              <span className="text-muted-foreground">Package root:</span> <code>{config.packageRootPath}</code>
            </div>
            {currentPreview ? (
              <>
                <div>
                  <span className="text-muted-foreground">COMPANY.md:</span> <code>{currentPreview.source.companyPath}</code>
                </div>
                <div>
                  <span className="text-muted-foreground">Extension:</span>{" "}
                  <code>{currentPreview.source.paperclipExtensionPath ?? ".paperclip.yaml not present"}</code>
                </div>
              </>
            ) : null}
          </div>
        </div>

        <div className="rounded-lg border border-border px-4 py-4">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Review state</div>
          <div className="mt-3 space-y-2 text-sm">
            <div>
              <span className="text-muted-foreground">Last reviewed:</span>{" "}
              {config.lastReviewedAt ? formatDateTime(config.lastReviewedAt) : "Never"}
            </div>
            <div>
              <span className="text-muted-foreground">Last status:</span>{" "}
              {config.lastReviewSummary ? statusLabel(config.lastReviewSummary.status) : "No stored review"}
            </div>
            {config.sourceChangedSinceReview ? (
              <div className="rounded-md border border-amber-300/60 bg-amber-50/70 px-3 py-2 text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-100">
                Contract source changed since the last review. Run a fresh preview before applying anything.
              </div>
            ) : null}
          </div>
        </div>

        <div className="rounded-lg border border-border px-4 py-4">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Remediation owner</div>
          <div className="mt-3 space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">Chief of Staff</span>
              <Badge variant={currentPreview?.remediationOwner.status === "assigned" ? "default" : "outline"}>
                {currentPreview?.remediationOwner.status === "assigned" ? "Assigned" : "Missing"}
              </Badge>
            </div>
            <div className="text-muted-foreground">
              {currentPreview
                ? currentPreview.remediationOwner.status === "assigned"
                  ? `${currentPreview.remediationOwner.agentName ?? "Chief of Staff"} is solely responsible for operating-contract warnings, errors, and remediation follow-through.`
                  : "No Chief of Staff is currently attached. This queue is missing its sole remediation owner until that role is present."
                : "Run preview to resolve the current Chief of Staff remediation owner for this company."}
            </div>
          </div>
        </div>
      </div>

      {currentPreview ? (
        <>
          <div className="grid gap-3 md:grid-cols-4">
            <div className="rounded-lg border border-border px-4 py-3">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Actions</div>
              <div className="mt-2 text-2xl font-semibold">{currentPreview.actions.length}</div>
            </div>
            <div className="rounded-lg border border-border px-4 py-3">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Warnings</div>
              <div className="mt-2 text-2xl font-semibold">{currentPreview.warnings.length}</div>
            </div>
            <div className="rounded-lg border border-border px-4 py-3">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Goals in contract</div>
              <div className="mt-2 text-2xl font-semibold">{currentPreview.contract.goals.length}</div>
            </div>
            <div className="rounded-lg border border-border px-4 py-3">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Preview hash</div>
              <div className="mt-2 truncate font-mono text-xs text-muted-foreground">{currentPreview.previewHash}</div>
            </div>
          </div>

          {actionGroups.length > 0 ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-base font-semibold">Repair plan</h2>
              </div>
              <div className="space-y-3">
                {actionGroups.map(({ group, actions }) => (
                  <ActionGroupCard
                    key={group}
                    group={group}
                    actions={actions}
                    selected={selectedGroups.includes(group)}
                    onToggle={(checked) => {
                      setSelectedGroups((current) => {
                        if (checked) return [...current, group].filter((value, index, values) => values.indexOf(value) === index);
                        return current.filter((value) => value !== group);
                      });
                    }}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-emerald-400/40 bg-emerald-50/60 px-4 py-4 text-sm text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-950/30 dark:text-emerald-100">
              No board-applied repair groups are currently suggested for this contract snapshot.
            </div>
          )}

          <div className="rounded-lg border border-border px-4 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1">
                <div className="text-sm font-medium">Apply selected groups</div>
                <div className="text-sm text-muted-foreground">
                  {selectedActionCount === 0
                    ? "Select one or more repair groups to apply. The Chief of Staff owns the remaining remediation queue."
                    : `${selectedActionCount} approved action${selectedActionCount === 1 ? "" : "s"} will be applied. The Chief of Staff remains responsible for unresolved warnings and follow-through.`}
                </div>
              </div>
              <Button
                onClick={() => applyMutation.mutate(selectedGroups)}
                disabled={applyMutation.isPending || selectedGroups.length === 0 || !currentPreview}
              >
                {applyMutation.isPending ? "Applying..." : "Apply selected groups"}
              </Button>
            </div>
          </div>

          {currentPreview.warnings.length > 0 ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                <h2 className="text-base font-semibold">Warnings</h2>
              </div>
              <div className="text-sm text-muted-foreground">
                {currentPreview.remediationOwner.status === "assigned"
                  ? `${currentPreview.remediationOwner.agentName ?? "Chief of Staff"} owns remediation for these warning-only findings.`
                  : "These warning-only findings do not currently have a live Chief of Staff attached as the remediation owner."}
              </div>
              <div className="space-y-3">
                {currentPreview.warnings.map((warning, index) => (
                  <div
                    key={`${warning.kind}:${warning.entityId ?? warning.entitySlug ?? index}`}
                    className="rounded-lg border border-amber-300/50 bg-amber-50/70 px-4 py-3 dark:border-amber-500/30 dark:bg-amber-950/30"
                  >
                    <div className="text-sm font-medium text-amber-950 dark:text-amber-100">{warning.title}</div>
                    <div className="mt-1 text-sm text-amber-900/80 dark:text-amber-100/80">{warning.description}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </>
      ) : previewMutation.isPending ? (
        <div className="rounded-lg border border-border px-4 py-8 text-sm text-muted-foreground">
          Generating repair preview…
        </div>
      ) : null}
    </div>
  );
}
