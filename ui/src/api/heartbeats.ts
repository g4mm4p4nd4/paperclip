import type {
  HeartbeatRun,
  HeartbeatRunEvent,
  InstanceSchedulerHeartbeatAgent,
  WorkspaceOperation,
} from "@paperclipai/shared";
import { api } from "./client";

export interface ActiveRunForIssue {
  id: string;
  status: string;
  invocationSource: string;
  triggerDetail: string | null;
  startedAt: string | Date | null;
  finishedAt: string | Date | null;
  createdAt: string | Date;
  agentId: string;
  agentName: string;
  adapterType: string;
  issueId?: string | null;
}

export interface LiveRunForIssue {
  id: string;
  status: string;
  invocationSource: string;
  triggerDetail: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  agentId: string;
  agentName: string;
  adapterType: string;
  issueId?: string | null;
}

export interface ContextLedgerComponent {
  id: string;
  name: string;
  componentType: string;
  contentSha256: string;
  chars: number;
  estimatedTokens: number;
  truncated: boolean;
  evidenceSliceCount: number;
  artifactRef?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

export interface ContextLedgerEntry {
  id: string;
  runId: string | null;
  agentId: string | null;
  issueId: string | null;
  taskKey: string | null;
  cwd: string | null;
  branch: string | null;
  adapterType: string;
  adapterVersion: string | null;
  promptClass: string;
  promptBudgetVersion: string;
  promptFingerprint: string;
  promptChars: number;
  estimatedPromptTokens: number;
  componentHashes?: Record<string, unknown> | null;
  artifactRefs?: Record<string, unknown>[] | null;
  contextPackRefs?: Record<string, unknown>[] | null;
  sessionIdBefore: string | null;
  sessionIdAfter: string | null;
  budgetStatus: string;
  budgetLimitTokens: number | null;
  actualInputTokens: number | null;
  actualOutputTokens: number | null;
  cachedInputTokens: number | null;
  responseClass: string;
  outputBudgetVersion: string;
  estimatedOutputTokens: number | null;
  outputBudgetStatus: string;
  outputBudgetLimitTokens: number | null;
  finalResponseChars: number | null;
  finalResponseSentenceCount: number | null;
  finalResponseSha256: string | null;
  finalResponseArtifactRefs?: Record<string, unknown>[] | null;
  finalOutcome: string | null;
  finalBlocker: string | null;
  receiptPaths?: string[] | null;
  redactionApplied: boolean;
  metadata?: Record<string, unknown> | null;
  components: ContextLedgerComponent[];
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface FlywheelHealthReport {
  companyId: string;
  window: { since: string; until: string; hours: number };
  tasksAttempted: number;
  tasksCompleted: number;
  issuesCompleted: number;
  providerFailures: {
    count: number;
    recent: Array<Record<string, unknown>>;
  };
  promptTokensByClass: Array<{
    promptClass: string;
    count: number;
    meanEstimatedTokens: number;
    p95EstimatedTokens: number;
  }>;
  outputTokensByResponseClass?: Array<{
    responseClass: string;
    count: number;
    meanOutputTokens: number;
    p95OutputTokens: number;
  }>;
  cachedInputTokens: number;
  totalOutputTokens?: number;
  outputBudgetViolations?: {
    count: number;
    examples: Array<Record<string, unknown>>;
  };
  artifactCoverage: {
    entries: number;
    artifactBackedEntries: number;
    percent: number;
  };
  ledgerCompleteness: {
    runs: number;
    runsWithLedger: number;
    percent: number;
  };
  receipts: {
    count: number;
    paths: string[];
  };
  canaryReadiness?: {
    contextPackMatrix?: Array<{
      repoSlug: string;
      ok: boolean;
      reasons: string[];
      proof?: Record<string, unknown> | null;
    }>;
    targetCompletionMatrix?: Array<{
      repoSlug: string;
      ok: boolean;
      readyCount: number;
      runIds: string[];
      issueIdentifiers: string[];
      reasons: string[];
    }>;
    issueLinkedSucceededRuns: number;
    completedIssuesWithLedger: number;
    completedIssueRunsWithReceipts: number;
    completedIssueRunsWithTests: number;
    completedIssueRunsWithChangedFiles: number;
    completedIssueRunsWithContextPacks: number;
    providerReroutedSuccesses: number;
    promptSloViolations: number;
    readyCount: number;
    examples: Array<Record<string, unknown>>;
    missing: Array<{
      runId: string;
      issueId: string;
      issueIdentifier: string | null;
      issueStatus?: string | null;
      missing: string[];
    }>;
  };
  tests: {
    passed: number;
    failed: number;
  };
  prsResolved: number | null;
  generatedAt: string;
}

export interface FlywheelHealthSnapshot {
  id: string;
  companyId: string;
  windowStart: string | Date;
  windowEnd: string | Date;
  windowHours: number;
  source: string;
  reportJson: FlywheelHealthReport | Record<string, unknown>;
  tasksAttempted: number;
  tasksCompleted: number;
  providerFailureCount: number;
  ledgerCompletenessPercent: number;
  artifactCoveragePercent: number;
  receiptsProduced: number;
  testsPassed: number;
  testsFailed: number;
  generatedAt: string | Date;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export const heartbeatsApi = {
  list: (companyId: string, agentId?: string, limit?: number) => {
    const searchParams = new URLSearchParams();
    if (agentId) searchParams.set("agentId", agentId);
    if (limit) searchParams.set("limit", String(limit));
    const qs = searchParams.toString();
    return api.get<HeartbeatRun[]>(`/companies/${companyId}/heartbeat-runs${qs ? `?${qs}` : ""}`);
  },
  flywheelHealth: (companyId: string, hours = 1) =>
    api.get<FlywheelHealthReport>(`/companies/${companyId}/flywheel-health?hours=${encodeURIComponent(String(hours))}`),
  flywheelHealthReports: (companyId: string, limit = 24) =>
    api.get<FlywheelHealthSnapshot[]>(
      `/companies/${companyId}/flywheel-health/reports?limit=${encodeURIComponent(String(limit))}`,
    ),
  get: (runId: string) => api.get<HeartbeatRun>(`/heartbeat-runs/${runId}`),
  events: (runId: string, afterSeq = 0, limit = 200) =>
    api.get<HeartbeatRunEvent[]>(
      `/heartbeat-runs/${runId}/events?afterSeq=${encodeURIComponent(String(afterSeq))}&limit=${encodeURIComponent(String(limit))}`,
    ),
  log: (runId: string, offset = 0, limitBytes = 256000) =>
    api.get<{ runId: string; store: string; logRef: string; content: string; nextOffset?: number }>(
      `/heartbeat-runs/${runId}/log?offset=${encodeURIComponent(String(offset))}&limitBytes=${encodeURIComponent(String(limitBytes))}`,
    ),
  workspaceOperations: (runId: string) =>
    api.get<WorkspaceOperation[]>(`/heartbeat-runs/${runId}/workspace-operations`),
  contextLedger: (runId: string) =>
    api.get<ContextLedgerEntry[]>(`/heartbeat-runs/${runId}/context-ledger`),
  issueContextLedger: (issueId: string) =>
    api.get<ContextLedgerEntry[]>(`/issues/${issueId}/context-ledger`),
  workspaceOperationLog: (operationId: string, offset = 0, limitBytes = 256000) =>
    api.get<{ operationId: string; store: string; logRef: string; content: string; nextOffset?: number }>(
      `/workspace-operations/${operationId}/log?offset=${encodeURIComponent(String(offset))}&limitBytes=${encodeURIComponent(String(limitBytes))}`,
    ),
  cancel: (runId: string) => api.post<void>(`/heartbeat-runs/${runId}/cancel`, {}),
  liveRunsForIssue: (issueId: string) =>
    api.get<LiveRunForIssue[]>(`/issues/${issueId}/live-runs`),
  activeRunForIssue: (issueId: string) =>
    api.get<ActiveRunForIssue | null>(`/issues/${issueId}/active-run`),
  liveRunsForCompany: (companyId: string, minCount?: number) =>
    api.get<LiveRunForIssue[]>(`/companies/${companyId}/live-runs${minCount ? `?minCount=${minCount}` : ""}`),
  listInstanceSchedulerAgents: () =>
    api.get<InstanceSchedulerHeartbeatAgent[]>("/instance/scheduler-heartbeats"),
};
