// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProfitFlywheelFactoryHealth } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterInfo } from "@/api/adapters";

const mocks = vi.hoisted(() => ({
  factoryHealth: vi.fn(),
  pauseFactory: vi.fn(),
  factoryWorkflow: vi.fn(),
  resumeFactoryStage: vi.fn(),
  listAdapters: vi.fn(),
  rollbackManaged: vi.fn(),
  setBreadcrumbs: vi.fn(),
}));

vi.mock("@/api/profitFlywheel", () => ({
  profitFlywheelApi: {
    factoryHealth: mocks.factoryHealth,
    pauseFactory: mocks.pauseFactory,
    factoryWorkflow: mocks.factoryWorkflow,
    resumeFactoryStage: mocks.resumeFactoryStage,
  },
}));

vi.mock("@/api/adapters", () => ({
  adaptersApi: {
    list: mocks.listAdapters,
    rollbackManaged: mocks.rollbackManaged,
  },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mocks.setBreadcrumbs }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <div>{children}</div> : null,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

import { SoftwareFactory } from "./SoftwareFactory";
import { queryKeys } from "@/lib/queryKeys";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const activeSha256 = "a".repeat(64);
const targetSha256 = "b".repeat(64);
const targetManifestSha256 = "c".repeat(64);

const snapshot: ProfitFlywheelFactoryHealth = {
  schemaVersion: "paperclip.profit_flywheel_factory_health.v1",
  companyId: "company-1",
  generatedAt: "2026-07-15T12:00:00.000Z",
  state: "paused",
  mode: "fixture",
  pauseNewWork: true,
  freshness: { ageSeconds: 0, maxAgeSeconds: 60, stale: false },
  identities: [],
  pipeline: [],
  blockers: [],
  activeWork: [],
  providerReadiness: [],
  economics: {
    tokensPerCompletedDeliverable: null,
    costPerCompletedDeliverableUsd: null,
    artifactBackedPercentage: null,
    falseSuccessPercentage: null,
    secondIterationCompletionRate: null,
    highBurnEventCount: null,
    tokenomicsStatus: "healthy",
    tokenomicsGeneratedAt: "2026-07-15T12:00:00.000Z",
  },
  host: {
    diskAvailableBytes: 64 * 1024 ** 3,
    diskFreePercent: 50,
    diskState: "healthy",
    databaseBytes: 0,
    logBytes: 0,
    archiveBacklogBytes: 0,
    factoryBrowserProcessCount: 0,
  },
  closeouts: { twoIteration: null, shadow: null, production: null },
  approvalGates: [],
};

function adapter(canManageManagedRuntime: boolean): AdapterInfo {
  return {
    type: "hermes_local",
    label: "Hermes",
    source: "external",
    modelsCount: 0,
    loaded: true,
    disabled: false,
    version: "0.3.0",
    installKind: "managed_immutable_bundle",
    bundleSha256: activeSha256,
    canManageManagedRuntime,
    rollbackTargets: [{
      bundleSha256: targetSha256,
      packageVersion: "0.2.0",
      manifestSha256: targetManifestSha256,
    }],
  };
}

function findButton(container: HTMLElement, label: string) {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(label));
}

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForButton(container: HTMLElement, label: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const button = findButton(container, label);
    if (button) return button;
    await act(async () => flush());
  }
  throw new Error(`Button not rendered: ${label}. Current text: ${container.textContent ?? ""}`);
}

describe("SoftwareFactory managed runtime controls", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.factoryHealth.mockResolvedValue(snapshot);
    mocks.rollbackManaged.mockResolvedValue({
      type: "hermes_local",
      installKind: "managed_immutable_bundle",
      priorBundleSha256: activeSha256,
      activeBundleSha256: targetSha256,
      activeVersion: "0.2.0",
      rollbackTargetCount: 1,
      transitionReceiptPath: "/receipts/transition.json",
      transitionReceiptSha256: "d".repeat(64),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(adapters: AdapterInfo[]) {
    mocks.listAdapters.mockResolvedValue(adapters);
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}><SoftwareFactory /></QueryClientProvider>);
      await flush();
    });
  }

  it("does not render the instance-admin action for an ordinary board capability", async () => {
    await render([adapter(false)]);
    expect(findButton(container, "Rollback runtime")).toBeUndefined();
    expect(container.textContent).not.toContain(targetSha256);
  });

  it("binds exact hashes, supports cancel, and invalidates every company snapshot after success", async () => {
    await render([adapter(true)]);
    const rollbackButton = await waitForButton(container, "Rollback runtime");
    await act(async () => rollbackButton.click());
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(activeSha256);
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(targetSha256);
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(targetManifestSha256);

    await act(async () => (await waitForButton(container, "Cancel")).click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await act(async () => (await waitForButton(container, "Rollback runtime")).click());
    await act(async () => {
      (await waitForButton(container, "Confirm verified rollback")).click();
      await flush();
    });
    expect(mocks.rollbackManaged).toHaveBeenCalledWith("hermes_local", {
      expectedCurrentBundleSha256: activeSha256,
      targetBundleSha256: targetSha256,
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.softwareFactoryAll });
  });

  it("keeps the dialog open and surfaces a server authority or stale-binding rejection", async () => {
    mocks.rollbackManaged.mockRejectedValueOnce(new Error("Instance admin access required"));
    await render([adapter(true)]);
    await act(async () => (await waitForButton(container, "Rollback runtime")).click());
    await act(async () => {
      (await waitForButton(container, "Confirm verified rollback")).click();
      await flush();
    });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Instance admin access required");
  });
});
