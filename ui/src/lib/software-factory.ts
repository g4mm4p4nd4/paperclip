import type { ProfitFlywheelFactoryBlocker } from "@paperclipai/shared";
import type { AdapterInfo, ManagedAdapterRollbackTarget } from "@/api/adapters";

export function formatFactoryBytes(value: number | null): string {
  if (value === null) return "Unknown";
  if (value === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / 1024 ** index;
  return `${scaled >= 10 || index === 0 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[index]}`;
}

export function formatFactoryDuration(seconds: number | null): string {
  if (seconds === null) return "Unknown";
  const rounded = Math.max(0, Math.floor(seconds));
  if (rounded < 60) return `${rounded}s`;
  if (rounded < 3600) return `${Math.floor(rounded / 60)}m ${rounded % 60}s`;
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

export function formatFactoryMetric(value: number | null, options: { currency?: boolean; percent?: boolean } = {}): string {
  if (value === null) return "Not measured";
  if (options.currency) return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(value);
  if (options.percent) return `${(value * 100).toFixed(1)}%`;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

export function shortFactoryIdentity(value: string | null): string {
  if (!value) return "Unavailable";
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

export function blockerSeverity(blocker: ProfitFlywheelFactoryBlocker): number {
  if (!blocker.retryable) return 3;
  if (!blocker.nextAttemptAt) return 2;
  return 1;
}

export function sortedFactoryBlockers(blockers: ProfitFlywheelFactoryBlocker[]) {
  return [...blockers].sort((left, right) =>
    blockerSeverity(right) - blockerSeverity(left) || right.ageSeconds - left.ageSeconds);
}

export function managedAdapterRollbackTargets(adapter: AdapterInfo | undefined): ManagedAdapterRollbackTarget[] {
  if (adapter?.type !== "hermes_local" || adapter.installKind !== "managed_immutable_bundle" ||
      adapter.canManageManagedRuntime !== true || !adapter.bundleSha256) {
    return [];
  }
  return (adapter.rollbackTargets ?? []).filter((candidate, index, all) =>
    candidate.bundleSha256 !== adapter.bundleSha256 &&
    /^[a-f0-9]{64}$/.test(candidate.bundleSha256) &&
    /^[a-f0-9]{64}$/.test(candidate.manifestSha256) &&
    all.findIndex((entry) => entry.bundleSha256 === candidate.bundleSha256) === index);
}
