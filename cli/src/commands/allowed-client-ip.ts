import * as p from "@clack/prompts";
import pc from "picocolors";
import { readConfig, resolveConfigPath, writeConfig } from "../config/store.js";

function normalizeClientIpInput(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) throw new Error("Client IP is required");
  return normalized;
}

export async function addAllowedClientIp(clientIp: string, opts: { config?: string }): Promise<void> {
  const configPath = resolveConfigPath(opts.config);
  const config = readConfig(opts.config);

  if (!config) {
    p.log.error(`No config found at ${configPath}. Run ${pc.cyan("paperclip onboard")} first.`);
    return;
  }

  const normalized = normalizeClientIpInput(clientIp);
  const current = new Set((config.server.allowedClientIps ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean));
  const existed = current.has(normalized);
  current.add(normalized);

  config.server.allowedClientIps = Array.from(current).sort();
  config.$meta.updatedAt = new Date().toISOString();
  config.$meta.source = "configure";
  writeConfig(config, opts.config);

  if (existed) {
    p.log.info(`Client IP ${pc.cyan(normalized)} is already allowed.`);
  } else {
    p.log.success(`Added allowed client IP: ${pc.cyan(normalized)}`);
    p.log.message(pc.dim("Restart the Paperclip server for this change to take effect."));
  }

  if (!(config.server.deploymentMode === "authenticated" && config.server.exposure === "private")) {
    p.log.message(pc.dim("Note: allowed client IPs are enforced only in authenticated/private mode."));
  }
}
