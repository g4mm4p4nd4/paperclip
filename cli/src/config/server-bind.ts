import { execFileSync } from "node:child_process";
import {
  ALL_INTERFACES_BIND_HOST,
  LOOPBACK_BIND_HOST,
  inferBindModeFromHost,
  isAllInterfacesHost,
  isLoopbackHost,
  type BindMode,
  type DeploymentExposure,
  type DeploymentMode,
} from "@paperclipai/shared";
import type { AuthConfig, ServerConfig } from "./schema.js";

const TAILSCALE_DETECT_TIMEOUT_MS = 3000;

type BaseServerInput = {
  port: number;
  allowedHostnames: string[];
  serveUi: boolean;
};

export function inferConfiguredBind(server?: Partial<ServerConfig>): BindMode {
  if (server?.bind) return server.bind;
  return inferBindModeFromHost(server?.customBindHost ?? server?.host);
}

export function detectTailnetBindHost(): string | undefined {
  const explicit = process.env.PAPERCLIP_TAILNET_BIND_HOST?.trim();
  if (explicit) return explicit;

  try {
    const stdout = execFileSync("tailscale", ["ip", "-4"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: TAILSCALE_DETECT_TIMEOUT_MS,
    });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
  } catch {
    return undefined;
  }
}

export function buildPresetServerConfig(
  bind: Exclude<BindMode, "custom">,
  input: BaseServerInput,
): { server: ServerConfig; auth: AuthConfig } {
  const host =
    bind === "loopback"
      ? LOOPBACK_BIND_HOST
      : bind === "tailnet"
        ? (detectTailnetBindHost() ?? LOOPBACK_BIND_HOST)
        : ALL_INTERFACES_BIND_HOST;

  return {
    server: {
      deploymentMode: bind === "loopback" ? "local_trusted" : "authenticated",
      exposure: "private",
      bind,
      customBindHost: undefined,
      host,
      port: input.port,
      allowedHostnames: input.allowedHostnames,
      serveUi: input.serveUi,
    },
    auth: {
      baseUrlMode: "auto",
      disableSignUp: false,
    },
  };
}

export function buildCustomServerConfig(input: BaseServerInput & {
  deploymentMode: DeploymentMode;
  exposure: DeploymentExposure;
  host: string;
  publicBaseUrl?: string;
}): { server: ServerConfig; auth: AuthConfig } {
  const normalizedHost = input.host.trim();
  const bind = isLoopbackHost(normalizedHost)
    ? "loopback"
    : isAllInterfacesHost(normalizedHost)
      ? "lan"
      : "custom";

  return {
    server: {
      deploymentMode: input.deploymentMode,
      exposure: input.deploymentMode === "local_trusted" ? "private" : input.exposure,
      bind,
      customBindHost: bind === "custom" ? normalizedHost : undefined,
      host: normalizedHost,
      port: input.port,
      allowedHostnames: input.allowedHostnames,
      serveUi: input.serveUi,
    },
    auth:
      input.deploymentMode === "authenticated" && input.exposure === "public"
        ? {
            baseUrlMode: "explicit",
            disableSignUp: false,
            publicBaseUrl: input.publicBaseUrl,
          }
        : {
            baseUrlMode: "auto",
            disableSignUp: false,
          },
  };
}
