import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ProfitFlywheelFactoryActiveWork,
  ProfitFlywheelFactoryBlocker,
  ProfitFlywheelFactoryHealth,
  ProfitFlywheelFactoryWorkflowDetail,
} from "@paperclipai/shared";
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock3,
  Coins,
  Database,
  FileCheck2,
  HardDrive,
  PauseCircle,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import { adaptersApi } from "@/api/adapters";
import { profitFlywheelApi } from "@/api/profitFlywheel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { EmptyState } from "@/components/EmptyState";
import { MetricCard } from "@/components/MetricCard";
import { PageSkeleton } from "@/components/PageSkeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import {
  formatFactoryBytes,
  formatFactoryDuration,
  formatFactoryMetric,
  managedAdapterRollbackTargets,
  shortFactoryIdentity,
  sortedFactoryBlockers,
} from "@/lib/software-factory";
import { cn } from "@/lib/utils";

type FactorySelection =
  | { kind: "blocker"; value: ProfitFlywheelFactoryBlocker }
  | { kind: "active"; value: ProfitFlywheelFactoryActiveWork }
  | null;

function timestamp(value: string | null) {
  if (!value) return "Unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));
}

function SectionHeading({ id, title, detail }: { id: string; title: string; detail: string }) {
  return (
    <div>
      <h2 id={id} className="text-base font-semibold">{title}</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function IdentityStrip({ snapshot }: { snapshot: ProfitFlywheelFactoryHealth }) {
  return (
    <dl className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 xl:grid-cols-5">
      {snapshot.identities.map((identity) => (
        <div key={identity.component} className="min-w-0 bg-card px-3 py-3">
          <dt className="flex items-center justify-between gap-2 text-xs font-medium capitalize text-muted-foreground">
            {identity.component.replaceAll("_", " ")}
            <span className={cn("text-[11px]", identity.verified ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300")}>
              {identity.verified ? "Verified" : "Unverified"}
            </span>
          </dt>
          <dd className="mt-1 truncate font-mono text-xs" title={identity.sha256 ?? identity.version ?? identity.detail ?? undefined}>
            {shortFactoryIdentity(identity.sha256 ?? identity.version)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Pipeline({
  snapshot,
  selectedStage,
  onSelect,
}: {
  snapshot: ProfitFlywheelFactoryHealth;
  selectedStage: string | null;
  onSelect: (stage: string | null) => void;
}) {
  return (
    <section aria-labelledby="factory-pipeline-title" className="space-y-3">
      <SectionHeading id="factory-pipeline-title" title="Pipeline" detail="Canonical stage order; select a stage to filter active work and blockers." />
      <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {snapshot.pipeline.map((entry, index) => {
          const alertCount = entry.counts.blocked + entry.counts.failed + entry.counts.degraded;
          const activeCount = entry.counts.pending + entry.counts.running + entry.counts.retry;
          const selected = selectedStage === entry.stage;
          return (
            <li key={entry.stage}>
              <button
                type="button"
                aria-pressed={selected}
                aria-label={`${index + 1}. ${entry.stage.replaceAll("_", " ")}: ${entry.counts.succeeded} succeeded, ${activeCount} active, ${alertCount} needs attention`}
                onClick={() => onSelect(selected ? null : entry.stage)}
                className={cn(
                  "h-full w-full rounded-lg border px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected ? "border-foreground bg-accent" : "border-border bg-card hover:bg-accent/50",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-[11px] font-medium text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
                  {alertCount > 0 ? <StatusBadge status="blocked" /> : activeCount > 0 ? <StatusBadge status="running" /> : <StatusBadge status={entry.counts.succeeded > 0 ? "succeeded" : "unknown"} />}
                </div>
                <p className="mt-2 text-sm font-medium capitalize">{entry.stage.replaceAll("_", " ")}</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {entry.counts.succeeded} succeeded · {activeCount} active · {alertCount} alert
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Conversion {entry.conversionFromDispatch === null ? "n/a" : `${(entry.conversionFromDispatch * 100).toFixed(0)}%`}
                </p>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function NeedsAttention({
  blockers,
  onSelect,
}: {
  blockers: ProfitFlywheelFactoryBlocker[];
  onSelect: (value: ProfitFlywheelFactoryBlocker) => void;
}) {
  return (
    <section aria-labelledby="factory-attention-title" className="space-y-3">
      <SectionHeading id="factory-attention-title" title="Needs attention" detail="Terminal blockers first, then retryable work by age." />
      {blockers.length === 0 ? (
        <div className="rounded-lg border border-border bg-card"><EmptyState icon={CheckCircle2} message="No blockers match the current stage filter." /></div>
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-lg border border-border md:block">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Software factory blockers with owners, retry timing, and evidence</caption>
              <thead className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
                <tr><th className="px-3 py-2 font-medium">Stage / blocker</th><th className="px-3 py-2 font-medium">Owner</th><th className="px-3 py-2 font-medium">Next action</th><th className="px-3 py-2 font-medium">Age</th><th className="px-3 py-2 font-medium">Evidence</th></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {blockers.map((blocker) => (
                  <tr key={blocker.stageRunId} className="bg-card align-top">
                    <td className="px-3 py-3"><button className="text-left font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onSelect(blocker)}>{blocker.code}</button><p className="mt-1 text-xs capitalize text-muted-foreground">{blocker.stage.replaceAll("_", " ")}</p></td>
                    <td className="px-3 py-3">{blocker.nextOwner}</td>
                    <td className="max-w-sm px-3 py-3 text-xs text-muted-foreground"><p>{blocker.resumeCondition}</p><p className="mt-1">{blocker.retryable ? blocker.nextAttemptAt ? `Retry ${timestamp(blocker.nextAttemptAt)}` : "Retryable when condition is satisfied" : "Manual decision required"}</p></td>
                    <td className="px-3 py-3 tabular-nums">{formatFactoryDuration(blocker.ageSeconds)}</td>
                    <td className="px-3 py-3"><button onClick={() => onSelect(blocker)} className="text-xs font-medium underline underline-offset-2">View receipt</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid gap-2 md:hidden">
            {blockers.map((blocker) => (
              <button key={blocker.stageRunId} onClick={() => onSelect(blocker)} className="rounded-lg border border-border bg-card p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <div className="flex items-start justify-between gap-2"><span className="text-sm font-medium">{blocker.code}</span><StatusBadge status={blocker.retryable ? "retry" : "blocked"} /></div>
                <p className="mt-2 text-xs text-muted-foreground">Owner {blocker.nextOwner} · age {formatFactoryDuration(blocker.ageSeconds)}</p>
                <p className="mt-2 text-xs">{blocker.resumeCondition}</p>
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function ActiveWork({ work, onSelect }: { work: ProfitFlywheelFactoryActiveWork[]; onSelect: (value: ProfitFlywheelFactoryActiveWork) => void }) {
  return (
    <section aria-labelledby="factory-active-title" className="space-y-3">
      <SectionHeading id="factory-active-title" title="Active work" detail="Lease, route, budget, heartbeat, and latest useful activity." />
      {work.length === 0 ? (
        <div className="rounded-lg border border-border bg-card"><EmptyState icon={PauseCircle} message="No active work matches the current stage filter." /></div>
      ) : (
        <div className="grid gap-2 lg:grid-cols-2">
          {work.map((entry) => (
            <button key={entry.stageRunId} onClick={() => onSelect(entry)} className="rounded-lg border border-border bg-card p-4 text-left hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <div className="flex items-start justify-between gap-2"><div><p className="text-sm font-medium">{entry.targetRepo}</p><p className="mt-1 text-xs capitalize text-muted-foreground">{entry.stage.replaceAll("_", " ")}</p></div><StatusBadge status={entry.state} /></div>
              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
                <div><dt className="text-muted-foreground">Route</dt><dd className="mt-0.5 truncate">{entry.routeId ?? "Unbound"}</dd></div>
                <div><dt className="text-muted-foreground">Elapsed</dt><dd className="mt-0.5">{formatFactoryDuration(entry.elapsedSeconds)}</dd></div>
                <div><dt className="text-muted-foreground">Heartbeat</dt><dd className="mt-0.5">{timestamp(entry.heartbeatAt)}</dd></div>
                <div><dt className="text-muted-foreground">Budget</dt><dd className="mt-0.5 tabular-nums">{entry.budgetConsumedTokens ?? "Unknown"} / {entry.budgetLimitTokens ?? "Unknown"}</dd></div>
              </dl>
              <p className="mt-3 line-clamp-2 text-xs text-muted-foreground">{entry.lastUsefulAction ?? "No useful action has been recorded"}</p>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function ProviderReadiness({ snapshot }: { snapshot: ProfitFlywheelFactoryHealth }) {
  return (
    <section aria-labelledby="factory-providers-title" className="space-y-3">
      <SectionHeading id="factory-providers-title" title="Provider readiness" detail="Observed route bindings and fresh canaries; no credentials are exposed." />
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[720px] text-left text-sm">
          <caption className="sr-only">Provider capability aliases and verified route readiness</caption>
          <thead className="border-b border-border bg-muted/30 text-xs text-muted-foreground"><tr><th className="px-3 py-2 font-medium">Alias</th><th className="px-3 py-2 font-medium">Status</th><th className="px-3 py-2 font-medium">Routes</th><th className="px-3 py-2 font-medium">Families</th><th className="px-3 py-2 font-medium">Independent review</th><th className="px-3 py-2 font-medium">Evidence</th></tr></thead>
          <tbody className="divide-y divide-border">
            {snapshot.providerReadiness.map((alias) => (
              <tr key={alias.alias} className="bg-card"><td className="px-3 py-3 font-medium capitalize">{alias.alias.replaceAll("_", " ")}</td><td className="px-3 py-3"><StatusBadge status={alias.status} /></td><td className="px-3 py-3 tabular-nums">{alias.eligibleRouteCount}</td><td className="px-3 py-3 tabular-nums">{alias.distinctProviderFamilies}</td><td className="px-3 py-3">{alias.independentReviewReady ? "Ready" : "Not proven"}</td><td className="px-3 py-3 text-xs capitalize text-muted-foreground">{alias.evidence.replaceAll("_", " ")}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function WorkflowTimeline({ detail }: { detail: ProfitFlywheelFactoryWorkflowDetail }) {
  const receiptsByStage = useMemo(() => detail.receipts.reduce<Map<string, typeof detail.receipts>>((index, receipt) => {
    const current = index.get(receipt.stageRunId) ?? [];
    current.push(receipt);
    index.set(receipt.stageRunId, current);
    return index;
  }, new Map()), [detail.receipts]);
  return (
    <section aria-labelledby="factory-workflow-timeline-title" className="space-y-3">
      <div><h3 id="factory-workflow-timeline-title" className="text-sm font-medium">Complete workflow timeline</h3><p className="mt-1 text-xs text-muted-foreground">Attempts, immutable input and route hashes, artifacts, receipts, and append-only audit history.</p></div>
      <ol className="space-y-3">
        {detail.stages.map((stage, index) => (
          <li key={stage.id} className="rounded-lg border border-border p-3">
            <div className="flex items-start justify-between gap-2"><div><p className="text-xs text-muted-foreground">{String(index + 1).padStart(2, "0")} · {stage.ownerPlane}</p><p className="mt-0.5 text-sm font-medium capitalize">{stage.stage.replaceAll("_", " ")}</p></div><StatusBadge status={stage.state} /></div>
            <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
              <div><dt className="text-muted-foreground">Attempt</dt><dd>{stage.attempt} / {stage.maxAttempts}</dd></div>
              <div><dt className="text-muted-foreground">Route / family</dt><dd>{stage.routeId ?? "Deterministic"} / {stage.providerFamily ?? "n/a"}</dd></div>
              <div className="sm:col-span-2"><dt className="text-muted-foreground">Input SHA-256</dt><dd className="break-all font-mono">{stage.inputHash}</dd></div>
              <div className="sm:col-span-2"><dt className="text-muted-foreground">Route SHA-256</dt><dd className="break-all font-mono">{stage.providerRouteSha256 ?? "Not applicable"}</dd></div>
              <div><dt className="text-muted-foreground">Started</dt><dd>{timestamp(stage.startedAt)}</dd></div>
              <div><dt className="text-muted-foreground">Completed</dt><dd>{timestamp(stage.completedAt)}</dd></div>
            </dl>
            {stage.blockerCode ? <div className="mt-3 rounded border border-amber-300/50 bg-amber-50/50 p-2 text-xs text-amber-950 dark:border-amber-500/30 dark:bg-amber-950/25 dark:text-amber-100"><p className="font-medium">{stage.blockerCode}</p><p className="mt-1">{stage.blockerDetail}</p><p className="mt-1">Resume when: {stage.resumeCondition ?? "No condition recorded"}</p></div> : null}
            <div className="mt-3 space-y-1"><p className="text-xs font-medium">Receipts and artifacts</p>{(receiptsByStage.get(stage.id) ?? []).length === 0 ? <p className="text-xs text-muted-foreground">No receipt persisted.</p> : (receiptsByStage.get(stage.id) ?? []).map((receipt) => <div key={receipt.id} className="rounded bg-muted/30 p-2 text-xs"><div className="flex justify-between gap-2"><span>{receipt.type}</span><StatusBadge status={receipt.status} /></div><p className="mt-1 break-all font-mono text-muted-foreground">{receipt.contentHash}</p><p className="mt-1 break-all text-muted-foreground">{receipt.artifactRef ?? "No artifact reference"}</p></div>)}</div>
          </li>
        ))}
      </ol>
      <div className="space-y-2"><h3 className="text-sm font-medium">Audit history</h3>{detail.audit.length === 0 ? <p className="text-xs text-muted-foreground">No audit event is persisted.</p> : <ol className="space-y-1">{detail.audit.map((event) => <li key={event.id} className="rounded border border-border px-3 py-2 text-xs"><div className="flex items-center justify-between gap-2"><span className="font-medium">{event.eventType}</span><time className="text-muted-foreground">{timestamp(event.createdAt)}</time></div><p className="mt-1 text-muted-foreground">{event.fromState ?? "start"} → {event.toState ?? "recorded"} · attempt {event.attempt}</p>{event.lastError ? <p className="mt-1 text-destructive">{event.lastError}</p> : null}</li>)}</ol>}</div>
    </section>
  );
}

function FactoryDetails({ companyId, selection, onOpenChange }: { companyId: string; selection: FactorySelection; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const blocker = selection?.kind === "blocker" ? selection.value : null;
  const active = selection?.kind === "active" ? selection.value : null;
  const workflowId = blocker?.workflowId ?? active?.workflowId ?? null;
  const detailQuery = useQuery({
    queryKey: queryKeys.softwareFactoryWorkflow(companyId, workflowId ?? "none"),
    queryFn: () => profitFlywheelApi.factoryWorkflow(companyId, workflowId!),
    enabled: Boolean(workflowId),
    staleTime: 5_000,
  });
  const resumeEligible = Boolean(blocker &&
    ["profit_flywheel_stage_agent_missing", "profit_flywheel_linked_issue_missing"].includes(blocker.code) &&
    blocker.receiptId && blocker.receiptSha256);
  const resumeMutation = useMutation({
    mutationFn: () => profitFlywheelApi.resumeFactoryStage({
      stageRunId: blocker!.stageRunId,
      inputHash: blocker!.inputHash,
      expectedBlockerCode: blocker!.code,
      expectedReceiptId: blocker!.receiptId!,
      expectedReceiptHash: blocker!.receiptSha256!,
    }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.softwareFactory(companyId) }),
        workflowId ? queryClient.invalidateQueries({ queryKey: queryKeys.softwareFactoryWorkflow(companyId, workflowId) }) : Promise.resolve(),
      ]);
    },
  });
  return (
    <Sheet open={selection !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader className="border-b border-border">
          <SheetTitle>{blocker ? blocker.code : active ? `${active.targetRepo} · ${active.stage.replaceAll("_", " ")}` : "Factory work"}</SheetTitle>
          <SheetDescription>{blocker ? "Exact persisted blocker and immutable evidence binding." : "Current lease, route, budget, and useful activity."}</SheetDescription>
        </SheetHeader>
        {blocker ? (
          <div className="space-y-5 px-4 pb-6">
            <StatusBadge status={blocker.retryable ? "retry" : "blocked"} />
            <dl className="grid gap-4 text-sm sm:grid-cols-2">
              <div><dt className="text-xs text-muted-foreground">Workflow</dt><dd className="mt-1 break-all font-mono text-xs">{blocker.workflowId}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Stage run</dt><dd className="mt-1 break-all font-mono text-xs">{blocker.stageRunId}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Next owner</dt><dd className="mt-1">{blocker.nextOwner}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Next attempt</dt><dd className="mt-1">{timestamp(blocker.nextAttemptAt)}</dd></div>
            </dl>
            <div><h3 className="text-sm font-medium">Cause</h3><p className="mt-1 text-sm text-muted-foreground">{blocker.detail}</p></div>
            <div><h3 className="text-sm font-medium">Resume condition</h3><p className="mt-1 text-sm text-muted-foreground">{blocker.resumeCondition}</p></div>
            {blocker.issueId ? <Button variant="outline" asChild><Link to={`/issues/${blocker.issueId}`}>Open linked issue</Link></Button> : null}
            <div className="rounded-lg border border-border bg-muted/20 p-3"><h3 className="flex items-center gap-2 text-sm font-medium"><FileCheck2 className="h-4 w-4" />Immutable evidence</h3><p className="mt-2 break-all font-mono text-xs text-muted-foreground">{blocker.receiptPath ?? (blocker.receiptId ? `Database receipt ${blocker.receiptId}` : "No receipt is linked")}</p><p className="mt-1 break-all font-mono text-xs text-muted-foreground">SHA-256 {blocker.receiptSha256 ?? "Unavailable"}</p></div>
            <Button disabled={!resumeEligible || resumeMutation.isPending} onClick={() => void resumeMutation.mutateAsync()} title="The server revalidates the current blocker, input hash, actor, latest valid receipt, and deterministic condition before mutation.">{resumeMutation.isPending ? "Revalidating…" : "Resume same input"}</Button>
            {resumeMutation.error ? <p role="alert" className="text-xs text-destructive">Resume was rejected because the condition or immutable binding is no longer valid.</p> : <p className="text-xs text-muted-foreground">Available only for deterministic assignment blockers with the latest valid blocker receipt.</p>}
          </div>
        ) : active ? (
          <div className="space-y-5 px-4 pb-6">
            <StatusBadge status={active.state} />
            <dl className="grid gap-4 text-sm sm:grid-cols-2">
              <div><dt className="text-xs text-muted-foreground">Workflow</dt><dd className="mt-1 break-all font-mono text-xs">{active.workflowId}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Stage run</dt><dd className="mt-1 break-all font-mono text-xs">{active.stageRunId}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Agent</dt><dd className="mt-1">{active.agentId ?? "Unassigned"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Route / family</dt><dd className="mt-1">{active.routeId ?? "Unbound"} / {active.providerFamily ?? "Unknown"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Heartbeat</dt><dd className="mt-1">{timestamp(active.heartbeatAt)}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Lease expires</dt><dd className="mt-1">{timestamp(active.leaseExpiresAt)}</dd></div>
            </dl>
            <div><h3 className="text-sm font-medium">Last useful action</h3><p className="mt-1 text-sm text-muted-foreground">{active.lastUsefulAction ?? "No useful action has been recorded"}</p></div>
          </div>
        ) : null}
        {workflowId ? <div className="border-t border-border px-4 py-5">{detailQuery.isLoading ? <p role="status" className="text-sm text-muted-foreground">Loading complete workflow evidence…</p> : detailQuery.error || !detailQuery.data ? <div role="alert" className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">Workflow evidence could not be validated. <Button variant="outline" size="sm" className="ml-2" onClick={() => void detailQuery.refetch()}>Retry</Button></div> : <WorkflowTimeline detail={detailQuery.data} />}</div> : null}
      </SheetContent>
    </Sheet>
  );
}

export function SoftwareFactory() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [selectedStage, setSelectedStage] = useState<string | null>(null);
  const [selection, setSelection] = useState<FactorySelection>(null);
  const [rollbackDialogOpen, setRollbackDialogOpen] = useState(false);
  const [rollbackTargetSha256, setRollbackTargetSha256] = useState<string | null>(null);
  useEffect(() => setBreadcrumbs([{ label: "Factory" }]), [setBreadcrumbs]);
  useEffect(() => {
    setSelectedStage(null);
    setSelection(null);
    setRollbackDialogOpen(false);
    setRollbackTargetSha256(null);
  }, [selectedCompanyId]);
  const query = useQuery({
    queryKey: queryKeys.softwareFactory(selectedCompanyId!),
    queryFn: () => profitFlywheelApi.factoryHealth(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: 10_000,
    refetchIntervalInBackground: true,
  });
  const adaptersQuery = useQuery({
    queryKey: queryKeys.adapters.all,
    queryFn: () => adaptersApi.list(),
    staleTime: 10_000,
  });
  const snapshot = query.data;
  const managedAdapter = adaptersQuery.data?.find((adapter) => adapter.type === "hermes_local");
  const rollbackTargets = useMemo(() => managedAdapterRollbackTargets(managedAdapter), [managedAdapter]);
  const rollbackTarget = rollbackTargets.find((candidate) => candidate.bundleSha256 === rollbackTargetSha256) ?? null;
  useEffect(() => {
    if (!rollbackDialogOpen) return;
    setRollbackTargetSha256((current) =>
      rollbackTargets.some((candidate) => candidate.bundleSha256 === current)
        ? current
        : rollbackTargets[0]?.bundleSha256 ?? null);
  }, [rollbackDialogOpen, rollbackTargets]);
  const pauseMutation = useMutation({
    mutationFn: () => profitFlywheelApi.pauseFactory(selectedCompanyId!),
    onSuccess: (next) => queryClient.setQueryData(queryKeys.softwareFactory(selectedCompanyId!), next),
  });
  const rollbackMutation = useMutation({
    mutationFn: () => {
      if (!managedAdapter?.bundleSha256 || !rollbackTargetSha256) {
        throw new Error("A current managed bundle and verified rollback target are required.");
      }
      return adaptersApi.rollbackManaged("hermes_local", {
        expectedCurrentBundleSha256: managedAdapter.bundleSha256,
        targetBundleSha256: rollbackTargetSha256,
      });
    },
    onSuccess: async () => {
      setRollbackDialogOpen(false);
      setRollbackTargetSha256(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.adapters.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.softwareFactoryAll }),
      ]);
    },
  });
  const blockers = useMemo(() => sortedFactoryBlockers((snapshot?.blockers ?? []).filter((entry) => !selectedStage || entry.stage === selectedStage)), [snapshot?.blockers, selectedStage]);
  const activeWork = useMemo(() => (snapshot?.activeWork ?? []).filter((entry) => !selectedStage || entry.stage === selectedStage), [snapshot?.activeWork, selectedStage]);

  if (query.isLoading) return <PageSkeleton variant="dashboard" />;
  if (query.error || !snapshot) return <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">Factory health could not be loaded. Protected data is not reused as a healthy snapshot. <Button variant="outline" size="sm" className="ml-2" onClick={() => void query.refetch()}>Retry</Button></div>;

  const stale = snapshot.freshness.stale || snapshot.economics.tokenomicsStatus === "stale" || snapshot.economics.tokenomicsStatus === "unknown";
  const blockedStages = snapshot.pipeline.filter((entry) => entry.counts.blocked + entry.counts.failed > 0).length;
  return (
    <div className="space-y-8 pb-10">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div><div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-semibold tracking-tight">Software Factory</h1><StatusBadge status={snapshot.mode} /><StatusBadge status={snapshot.state} /></div><p className="mt-1 text-sm text-muted-foreground">Server-owned operational truth for the Profit Flywheel.</p></div>
        <div className="flex flex-wrap items-center gap-2"><p aria-live="polite" className="text-xs text-muted-foreground">{query.isFetching ? "Refreshing…" : `Refreshed ${timestamp(snapshot.generatedAt)}`}</p><Button variant="outline" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}><RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", query.isFetching && "animate-spin motion-reduce:animate-none")} />Refresh</Button><Button variant="outline" size="sm" disabled={snapshot.pauseNewWork || pauseMutation.isPending} onClick={() => pauseMutation.mutate()} title="Persistently stop new claims and launches; active leases continue to checkpoint or drain."><PauseCircle className="mr-1.5 h-3.5 w-3.5" />{snapshot.pauseNewWork ? "New work paused" : pauseMutation.isPending ? "Pausing…" : "Pause new work"}</Button>{managedAdapter?.canManageManagedRuntime ? <Button variant="outline" size="sm" disabled={!managedAdapter.bundleSha256 || rollbackTargets.length === 0 || rollbackMutation.isPending} onClick={() => { setRollbackTargetSha256(rollbackTargets[0]?.bundleSha256 ?? null); setRollbackDialogOpen(true); }} title="Select a previously verified immutable adapter bundle. The server re-verifies every byte and atomically fences the active pointer before rollback."><RotateCcw className="mr-1.5 h-3.5 w-3.5" />{rollbackTargets.length > 0 ? "Rollback runtime" : "No verified rollback"}</Button> : null}</div>
      </div>

      {pauseMutation.error ? <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">Pause was not persisted; runtime posture was left unchanged.</div> : null}
      {rollbackMutation.data ? <div role="status" className="rounded-lg border border-emerald-300/50 bg-emerald-50/60 p-3 text-sm text-emerald-950 dark:border-emerald-500/30 dark:bg-emerald-950/30 dark:text-emerald-100">Adapter runtime rolled back to <span className="font-mono">{shortFactoryIdentity(rollbackMutation.data.activeBundleSha256)}</span>. Transition receipt <span className="break-all font-mono text-xs">{rollbackMutation.data.transitionReceiptSha256}</span>.</div> : null}

      {stale ? <div role="alert" className="flex items-start gap-3 rounded-lg border border-amber-300/60 bg-amber-50/80 p-4 text-amber-950 dark:border-amber-500/30 dark:bg-amber-950/35 dark:text-amber-100"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><div><p className="text-sm font-medium">Stale or incomplete operational evidence</p><p className="mt-1 text-xs">Factory snapshot age {formatFactoryDuration(snapshot.freshness.ageSeconds)}; tokenomics is {snapshot.economics.tokenomicsStatus}. Resume and promotion controls remain unavailable.</p></div></div> : null}
      {snapshot.host.diskState === "hard_stop" ? <div role="alert" className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-destructive"><HardDrive className="mt-0.5 h-4 w-4 shrink-0" /><div><p className="text-sm font-medium">Disk hard stop — new dispatch is paused</p><p className="mt-1 text-xs">{formatFactoryBytes(snapshot.host.diskAvailableBytes)} available. Reconciliation, verified archive, operator access, and approved retention review remain available.</p></div></div> : null}

      <IdentityStrip snapshot={snapshot} />
      <div className="grid overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 xl:grid-cols-4">
        <div className="bg-card"><MetricCard icon={Workflow} value={snapshot.pipeline.reduce((sum, entry) => sum + entry.total, 0)} label="Stage attempts" description={`${blockedStages} stages have blocked or failed work`} /></div>
        <div className="bg-card"><MetricCard icon={Activity} value={snapshot.activeWork.length} label="Active work" description={snapshot.pauseNewWork ? "New dispatch paused" : "Dispatch enabled by mode and gates"} /></div>
        <div className="bg-card"><MetricCard icon={AlertTriangle} value={snapshot.blockers.length} label="Blockers" description="Exact persisted blockers, not log inference" /></div>
        <div className="bg-card"><MetricCard icon={ShieldCheck} value={snapshot.providerReadiness.filter((entry) => entry.status === "ready").length} label="Ready aliases" description={`of ${snapshot.providerReadiness.length} capability aliases`} /></div>
      </div>

      <Pipeline snapshot={snapshot} selectedStage={selectedStage} onSelect={setSelectedStage} />
      <NeedsAttention blockers={blockers} onSelect={(value) => setSelection({ kind: "blocker", value })} />
      <ActiveWork work={activeWork} onSelect={(value) => setSelection({ kind: "active", value })} />
      <ProviderReadiness snapshot={snapshot} />

      <section aria-labelledby="factory-economics-title" className="space-y-3"><SectionHeading id="factory-economics-title" title="Outcome economics" detail="Work-bearing measurements only; absent samples remain unmeasured." /><div className="grid overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 xl:grid-cols-4"><div className="bg-card"><MetricCard icon={Coins} value={formatFactoryMetric(snapshot.economics.tokensPerCompletedDeliverable)} label="Tokens / deliverable" /></div><div className="bg-card"><MetricCard icon={Coins} value={formatFactoryMetric(snapshot.economics.costPerCompletedDeliverableUsd, { currency: true })} label="Cost / deliverable" /></div><div className="bg-card"><MetricCard icon={FileCheck2} value={formatFactoryMetric(snapshot.economics.artifactBackedPercentage, { percent: true })} label="Artifact backed" /></div><div className="bg-card"><MetricCard icon={AlertTriangle} value={snapshot.economics.highBurnEventCount ?? "Unknown"} label="High-burn events" /></div></div></section>

      <section aria-labelledby="factory-host-title" className="space-y-3"><SectionHeading id="factory-host-title" title="Host durability" detail="Capacity and owned-process evidence from the immutable baseline." /><div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">{[
        [HardDrive, "Disk available", formatFactoryBytes(snapshot.host.diskAvailableBytes), snapshot.host.diskState],
        [Database, "Database", formatFactoryBytes(snapshot.host.databaseBytes), null],
        [FileCheck2, "Logs", formatFactoryBytes(snapshot.host.logBytes), null],
        [Workflow, "Archive backlog", formatFactoryBytes(snapshot.host.archiveBacklogBytes), null],
        [Bot, "Owned browsers", snapshot.host.factoryBrowserProcessCount ?? "Unknown", null],
      ].map(([Icon, label, value, status]) => { const HostIcon = Icon as typeof HardDrive; return <div key={String(label)} className="rounded-lg border border-border bg-card p-4"><div className="flex items-start justify-between gap-2"><HostIcon className="h-4 w-4 text-muted-foreground" />{status ? <StatusBadge status={String(status)} /> : null}</div><p className="mt-3 text-xl font-semibold tabular-nums">{String(value)}</p><p className="mt-1 text-xs text-muted-foreground">{String(label)}</p></div>; })}</div></section>

      <section aria-labelledby="factory-approvals-title" className="space-y-3"><SectionHeading id="factory-approvals-title" title="Approval gates" detail="Human authority boundaries remain explicit and cannot be bypassed from this page." />{snapshot.approvalGates.length === 0 ? <div className="rounded-lg border border-border bg-card"><EmptyState icon={ShieldCheck} message="No human approval gate is currently reported." /></div> : <div className="grid gap-2 lg:grid-cols-2">{snapshot.approvalGates.map((gate) => <article key={gate.code} className="rounded-lg border border-border bg-card p-4"><div className="flex items-start justify-between gap-2"><h3 className="text-sm font-medium">{gate.title}</h3><StatusBadge status="approval_required" /></div><p className="mt-2 text-xs text-muted-foreground">{gate.detail}</p><p className="mt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Action class: {gate.action}</p></article>)}</div>}</section>

      <section aria-labelledby="factory-closeouts-title" className="space-y-3"><SectionHeading id="factory-closeouts-title" title="Promotion evidence" detail="Most recent two-iteration, shadow, and production closeouts." /><div className="grid gap-2 md:grid-cols-3">{Object.entries(snapshot.closeouts).map(([name, receipt]) => <article key={name} className="rounded-lg border border-border bg-card p-4"><div className="flex items-start justify-between"><h3 className="text-sm font-medium capitalize">{name.replaceAll("_", " ")}</h3><StatusBadge status={receipt ? "verified" : "missing"} /></div>{receipt ? <><p className="mt-3 break-all font-mono text-xs">{shortFactoryIdentity(receipt.contentHash)}</p><p className="mt-1 text-xs text-muted-foreground">Observed {timestamp(receipt.observedAt)}</p></> : <p className="mt-3 text-xs text-muted-foreground">No verified closeout is available.</p>}</article>)}</div></section>

      <Dialog open={rollbackDialogOpen} onOpenChange={(open) => { if (!rollbackMutation.isPending) setRollbackDialogOpen(open); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rollback adapter runtime</DialogTitle>
            <DialogDescription>
              This instance-admin action atomically swaps the global Hermes adapter pointer. The server re-verifies the target bundle, manifest, install receipt, and active fencing hash before mutation.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <dl className="rounded-lg border border-border bg-muted/20 p-3 text-xs">
              <div><dt className="text-muted-foreground">Current version</dt><dd className="mt-1">{managedAdapter?.version ?? "Unknown"}</dd></div>
              <div className="mt-3"><dt className="text-muted-foreground">Current bundle SHA-256</dt><dd className="mt-1 break-all font-mono">{managedAdapter?.bundleSha256 ?? "Unavailable"}</dd></div>
            </dl>
            <div>
              <label htmlFor="factory-rollback-target" className="text-sm font-medium">Verified rollback target</label>
              <select id="factory-rollback-target" className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={rollbackTargetSha256 ?? ""} onChange={(event) => setRollbackTargetSha256(event.target.value)} disabled={rollbackMutation.isPending}>
                {rollbackTargets.map((candidate) => <option key={candidate.bundleSha256} value={candidate.bundleSha256}>v{candidate.packageVersion} · {shortFactoryIdentity(candidate.bundleSha256)}</option>)}
              </select>
            </div>
            {rollbackTarget ? <dl className="rounded-lg border border-border p-3 text-xs"><div><dt className="text-muted-foreground">Target bundle SHA-256</dt><dd className="mt-1 break-all font-mono">{rollbackTarget.bundleSha256}</dd></div><div className="mt-3"><dt className="text-muted-foreground">Target manifest SHA-256</dt><dd className="mt-1 break-all font-mono">{rollbackTarget.manifestSha256}</dd></div></dl> : null}
            {rollbackMutation.error ? <p role="alert" className="text-sm text-destructive">Rollback was rejected: {rollbackMutation.error instanceof Error ? rollbackMutation.error.message : "the authority or immutable binding changed"}. Refresh the Factory page before selecting a target again.</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={rollbackMutation.isPending} onClick={() => setRollbackDialogOpen(false)}>Cancel</Button>
            <Button variant="destructive" disabled={!rollbackTarget || rollbackMutation.isPending} onClick={() => rollbackMutation.mutate()}>{rollbackMutation.isPending ? "Verifying and rolling back…" : "Confirm verified rollback"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <FactoryDetails companyId={selectedCompanyId!} selection={selection} onOpenChange={(open) => { if (!open) setSelection(null); }} />
      <div aria-live="polite" className="sr-only">{selectedStage ? `Filtered to ${selectedStage.replaceAll("_", " ")}` : "Showing all factory stages"}</div>
    </div>
  );
}
