import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueWorkProducts } from "@paperclipai/db";
import type { IssueWorkProduct } from "@paperclipai/shared";

type IssueWorkProductRow = typeof issueWorkProducts.$inferSelect;
type IssueWorkProductInsert = typeof issueWorkProducts.$inferInsert;

type LedgerArtifactWorkProductInput = {
  companyId: string;
  issueId: string;
  projectId?: string | null;
  createdByRunId?: string | null;
  contextLedgerEntryId: string;
  artifactRef: Record<string, unknown>;
  finalOutcome?: string | null;
};

function toIssueWorkProduct(row: IssueWorkProductRow): IssueWorkProduct {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId ?? null,
    issueId: row.issueId,
    executionWorkspaceId: row.executionWorkspaceId ?? null,
    runtimeServiceId: row.runtimeServiceId ?? null,
    type: row.type as IssueWorkProduct["type"],
    provider: row.provider,
    externalId: row.externalId ?? null,
    title: row.title,
    url: row.url ?? null,
    status: row.status,
    reviewState: row.reviewState as IssueWorkProduct["reviewState"],
    isPrimary: row.isPrimary,
    healthStatus: row.healthStatus as IssueWorkProduct["healthStatus"],
    summary: row.summary ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    createdByRunId: row.createdByRunId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function basename(value: string | null) {
  if (!value) return null;
  const trimmed = value.replace(/\/+$/, "");
  return trimmed.split("/").filter(Boolean).pop() ?? trimmed;
}

function urlIfValid(value: string | null) {
  if (!value) return null;
  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}

function inferProvider(ref: Record<string, unknown>, url: string | null) {
  const explicit = readString(ref.provider) ?? readString(ref.source);
  if (explicit) return explicit;
  if (url) {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("github.com")) return "github";
    if (host.includes("vercel.app")) return "vercel";
    if (host.includes("netlify.app")) return "netlify";
  }
  return "paperclip-context-ledger";
}

function inferType(ref: Record<string, unknown>, url: string | null): IssueWorkProduct["type"] {
  const kind = (readString(ref.kind) ?? readString(ref.type) ?? "").toLowerCase().replace(/[\s_-]+/g, "");
  if (kind === "pullrequest" || kind === "pr") return "pull_request";
  if (kind === "branch") return "branch";
  if (kind === "commit") return "commit";
  if (kind === "document" || kind === "doc") return "document";
  if (kind === "preview" || kind === "previewurl") return "preview_url";
  if (url && /^https?:\/\//i.test(url) && /(preview|deploy|vercel|netlify)/i.test(url)) return "preview_url";
  return "artifact";
}

function statusForOutcome(outcome: string | null | undefined): IssueWorkProduct["status"] {
  const normalized = outcome?.trim().toLowerCase();
  if (normalized === "succeeded" || normalized === "success" || normalized === "completed" || normalized === "done") {
    return "ready_for_review";
  }
  if (normalized === "failed" || normalized === "blocked") return "failed";
  return "active";
}

export function ledgerArtifactWorkProductDraft(
  input: LedgerArtifactWorkProductInput,
): Omit<IssueWorkProductInsert, "companyId" | "issueId"> | null {
  const ref = input.artifactRef;
  const path = readString(ref.path) ?? readString(ref.filePath) ?? readString(ref.receiptPath);
  const url = urlIfValid(readString(ref.url) ?? readString(ref.href));
  const sha = readString(ref.sha256) ?? readString(ref.sha) ?? readString(ref.hash);
  const externalId = readString(ref.externalId) ?? `ledger-artifact:${sha256(stableStringify({
    kind: readString(ref.kind) ?? readString(ref.type),
    path,
    url,
    sha,
  }))}`;
  if (!path && !url && !sha) return null;

  const type = inferType(ref, url);
  const provider = inferProvider(ref, url);
  const label = readString(ref.title) ?? readString(ref.name) ?? basename(path) ?? basename(url) ?? externalId;
  const kind = readString(ref.kind) ?? readString(ref.type) ?? type;
  const titlePrefix = kind.toLowerCase().includes("receipt") ? "Receipt" : "Artifact";
  const title = `${titlePrefix}: ${label}`.slice(0, 240);
  const summaryParts = [
    path ? `path=${path}` : null,
    url ? `url=${url}` : null,
    sha ? `sha256=${sha.slice(0, 12)}` : null,
  ].filter(Boolean);

  return {
    projectId: input.projectId ?? null,
    type,
    provider,
    externalId,
    title,
    url,
    status: statusForOutcome(input.finalOutcome),
    reviewState: "none",
    isPrimary: false,
    healthStatus: "unknown",
    summary: summaryParts.length > 0 ? summaryParts.join(" ") : null,
    metadata: {
      source: "context_ledger",
      contextLedgerEntryId: input.contextLedgerEntryId,
      artifactRef: ref,
    },
    createdByRunId: input.createdByRunId ?? null,
  };
}

export function workProductService(db: Db) {
  return {
    listForIssue: async (issueId: string) => {
      const rows = await db
        .select()
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId))
        .orderBy(desc(issueWorkProducts.isPrimary), desc(issueWorkProducts.updatedAt));
      return rows.map(toIssueWorkProduct);
    },

    getById: async (id: string) => {
      const row = await db
        .select()
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.id, id))
        .then((rows) => rows[0] ?? null);
      return row ? toIssueWorkProduct(row) : null;
    },

    createForIssue: async (issueId: string, companyId: string, data: Omit<typeof issueWorkProducts.$inferInsert, "issueId" | "companyId">) => {
      const row = await db.transaction(async (tx) => {
        if (data.isPrimary) {
          await tx
            .update(issueWorkProducts)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(issueWorkProducts.companyId, companyId),
                eq(issueWorkProducts.issueId, issueId),
                eq(issueWorkProducts.type, data.type),
              ),
            );
        }
        return await tx
          .insert(issueWorkProducts)
          .values({
            ...data,
            companyId,
            issueId,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
      });
      return row ? toIssueWorkProduct(row) : null;
    },

    upsertLedgerArtifactForIssue: async (input: LedgerArtifactWorkProductInput) => {
      const data = ledgerArtifactWorkProductDraft(input);
      const externalId = data?.externalId;
      if (!data || typeof externalId !== "string" || externalId.length === 0) return null;
      const row = await db.transaction(async (tx) => {
        const existing = await tx
          .select()
          .from(issueWorkProducts)
          .where(
            and(
              eq(issueWorkProducts.companyId, input.companyId),
              eq(issueWorkProducts.issueId, input.issueId),
              eq(issueWorkProducts.provider, data.provider),
              eq(issueWorkProducts.externalId, externalId),
            ),
          )
          .orderBy(desc(issueWorkProducts.updatedAt))
          .then((rows) => rows[0] ?? null);
        if (existing) {
          return await tx
            .update(issueWorkProducts)
            .set({
              projectId: data.projectId,
              type: data.type,
              title: data.title,
              url: data.url,
              status: data.status,
              healthStatus: data.healthStatus,
              summary: data.summary,
              metadata: {
                ...((existing.metadata as Record<string, unknown> | null) ?? {}),
                ...((data.metadata as Record<string, unknown> | null) ?? {}),
                lastSeenRunId: input.createdByRunId ?? null,
              },
              updatedAt: new Date(),
            })
            .where(eq(issueWorkProducts.id, existing.id))
            .returning()
            .then((rows) => rows[0] ?? null);
        }
        return await tx
          .insert(issueWorkProducts)
          .values({
            ...data,
            companyId: input.companyId,
            issueId: input.issueId,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
      });
      return row ? toIssueWorkProduct(row) : null;
    },

    update: async (id: string, patch: Partial<typeof issueWorkProducts.$inferInsert>) => {
      const row = await db.transaction(async (tx) => {
        const existing = await tx
          .select()
          .from(issueWorkProducts)
          .where(eq(issueWorkProducts.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        if (patch.isPrimary === true) {
          await tx
            .update(issueWorkProducts)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(issueWorkProducts.companyId, existing.companyId),
                eq(issueWorkProducts.issueId, existing.issueId),
                eq(issueWorkProducts.type, existing.type),
              ),
            );
        }

        return await tx
          .update(issueWorkProducts)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(issueWorkProducts.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
      });
      return row ? toIssueWorkProduct(row) : null;
    },

    remove: async (id: string) => {
      const row = await db
        .delete(issueWorkProducts)
        .where(eq(issueWorkProducts.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toIssueWorkProduct(row) : null;
    },
  };
}

export { toIssueWorkProduct };
