/**
 * @fileoverview Frontend API client for external adapter management.
 */

import { api } from "./client";

export interface AdapterInfo {
  type: string;
  label: string;
  source: "builtin" | "external";
  modelsCount: number;
  loaded: boolean;
  disabled: boolean;
  /** Installed version (for external npm adapters) */
  version?: string;
  /** Package name (for external adapters) */
  packageName?: string;
  /** Whether the adapter was installed from a local path (vs npm). */
  isLocalPath?: boolean;
  /** True when an external plugin has replaced a built-in adapter of the same type. */
  overriddenBuiltin?: boolean;
  /** True when the external override for a builtin type is currently paused. */
  overridePaused?: boolean;
  /** Installation authority for external adapters. */
  installKind?: "npm" | "local_path" | "managed_immutable_bundle";
  /** Exact active managed bundle identity. */
  bundleSha256?: string;
  manifestSha256?: string;
  installReceiptSha256?: string;
  /** Server-derived instance-admin capability for managed runtime transitions. */
  canManageManagedRuntime?: boolean;
  /** Prior managed bundles recorded as rollback candidates; the server re-verifies bytes before swapping. */
  rollbackTargets?: ManagedAdapterRollbackTarget[];
}

export interface ManagedAdapterRollbackTarget {
  bundleSha256: string;
  packageVersion: string;
  manifestSha256: string;
}

export interface ManagedAdapterRollbackResult {
  type: string;
  installKind: "managed_immutable_bundle";
  priorBundleSha256: string;
  activeBundleSha256: string;
  activeVersion: string;
  rollbackTargetCount: number;
  transitionReceiptPath: string;
  transitionReceiptSha256: string;
}

export interface AdapterInstallResult {
  type: string;
  packageName: string;
  version?: string;
  installedAt: string;
}

export const adaptersApi = {
  /** List all registered adapters (built-in + external). */
  list: () => api.get<AdapterInfo[]>("/adapters"),

  /** Install an external adapter from npm or a local path. */
  install: (params: { packageName: string; version?: string; isLocalPath?: boolean }) =>
    api.post<AdapterInstallResult>("/adapters/install", params),

  /** Remove an external adapter by type. */
  remove: (type: string) => api.delete<{ type: string; removed: boolean }>(`/adapters/${type}`),

  /** Enable or disable an adapter (disabled adapters hidden from agent menus). */
  setDisabled: (type: string, disabled: boolean) =>
    api.patch<{ type: string; disabled: boolean; changed: boolean }>(`/adapters/${type}`, { disabled }),

  /** Pause or resume an external override of a builtin type. */
  setOverridePaused: (type: string, paused: boolean) =>
    api.patch<{ type: string; paused: boolean; changed: boolean }>(`/adapters/${type}/override`, { paused }),

  /** Reload an external adapter (bust server + client caches). */
  reload: (type: string) =>
    api.post<{ type: string; version?: string; reloaded: boolean }>(`/adapters/${type}/reload`, {}),

  /** Reinstall an npm-sourced adapter (pulls latest from registry, then reloads). */
  reinstall: (type: string) =>
    api.post<{ type: string; version?: string; reinstalled: boolean }>(`/adapters/${type}/reinstall`, {}),

  /** Atomically swap a managed adapter to a previously recorded target after server-side re-verification. */
  rollbackManaged: (type: string, input: { expectedCurrentBundleSha256: string; targetBundleSha256: string }) =>
    api.post<ManagedAdapterRollbackResult>(`/adapters/${encodeURIComponent(type)}/managed-rollback`, {
      ...input,
      confirm: true,
    }),
};
