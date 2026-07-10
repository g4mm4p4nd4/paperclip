export type NormalizedAgentPermissions = Record<string, unknown> & {
  canCreateAgents: boolean;
  canBypassExecutionApprovals: boolean;
};

export function defaultPermissionsForRole(role: string): NormalizedAgentPermissions {
  return {
    canCreateAgents: role === "ceo",
    canBypassExecutionApprovals: false,
  };
}

export function normalizeAgentPermissions(
  permissions: unknown,
  role: string,
): NormalizedAgentPermissions {
  const defaults = defaultPermissionsForRole(role);
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
    return defaults;
  }

  const record = permissions as Record<string, unknown>;
  return {
    canCreateAgents:
      typeof record.canCreateAgents === "boolean"
        ? record.canCreateAgents
        : defaults.canCreateAgents,
    canBypassExecutionApprovals:
      typeof record.canBypassExecutionApprovals === "boolean"
        ? record.canBypassExecutionApprovals
        : defaults.canBypassExecutionApprovals,
  };
}
