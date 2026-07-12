import path from "node:path";
import fs from "node:fs";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";
import { sanitizeRecord, sanitizeValue } from "../redaction.js";

function resolveServerLogDir(): string {
  const envOverride = process.env.PAPERCLIP_LOG_DIR?.trim();
  if (envOverride) return resolveHomeAwarePath(envOverride);

  const fileLogDir = readConfigFile()?.logging.logDir?.trim();
  if (fileLogDir) return resolveHomeAwarePath(fileLogDir);

  return resolveDefaultLogsDir();
}

const logDir = resolveServerLogDir();
fs.mkdirSync(logDir, { recursive: true });

const logFile = path.join(logDir, "server.log");

const sharedOpts = {
  translateTime: "HH:MM:ss",
  ignore: "pid,hostname",
  singleLine: true,
};

const MODEL_PSEUDO_ISSUE_IDENTIFIER_RE =
  /^(?:GEMINI|GPT|SONNET|OPUS|HAIKU|CLAUDE|CODEX|KIMI|DEEPSEEK)-\d+$/i;

export function isStaleModelIssueReference404(
  req: { method?: string; params?: unknown; route?: unknown },
  res: { statusCode?: number },
) {
  if (res.statusCode !== 404 || req.method !== "GET") return false;
  const routePath = (req.route as { path?: unknown } | undefined)?.path;
  if (routePath !== "/issues/:id") return false;
  const rawId = (req.params as { id?: unknown } | undefined)?.id;
  return typeof rawId === "string" && MODEL_PSEUDO_ISSUE_IDENTIFIER_RE.test(rawId);
}

export function serializeHttpRequestForLogs(req: {
  id?: unknown;
  method?: unknown;
  url?: unknown;
  headers?: Record<string, unknown>;
  remoteAddress?: unknown;
  remotePort?: unknown;
}) {
  return {
    id: req.id,
    method: req.method,
    url: sanitizeHttpLogUrl(req.url),
    headers: sanitizeRecord(req.headers ?? {}),
    remoteAddress: req.remoteAddress,
    remotePort: req.remotePort,
  };
}

export function sanitizeHttpLogUrl(value: unknown) {
  if (typeof value !== "string") return value;
  const withoutFragment = value.split("#", 1)[0] ?? "";
  return withoutFragment.split("?", 1)[0] ?? "";
}

export const logger = pino({
  level: "debug",
  hooks: {
    logMethod(args, method) {
      method.apply(this, args.map((value) => sanitizeValue(value)) as Parameters<typeof method>);
    },
  },
}, pino.transport({
  targets: [
    {
      target: "pino-pretty",
      options: { ...sharedOpts, ignore: "pid,hostname,req,res,responseTime", colorize: true, destination: 1 },
      level: "info",
    },
    {
      target: "pino-pretty",
      options: { ...sharedOpts, colorize: false, destination: logFile, mkdir: true },
      level: "debug",
    },
  ],
}));

export const httpLogger = pinoHttp({
  logger,
  serializers: {
    req(req) {
      return serializeHttpRequestForLogs(req as Parameters<typeof serializeHttpRequestForLogs>[0]);
    },
    res(res) {
      return {
        statusCode: res.statusCode,
        headers: sanitizeRecord((res.getHeaders?.() ?? {}) as Record<string, unknown>),
      };
    },
    err(err) {
      return sanitizeValue(pino.stdSerializers.err(err));
    },
  },
  customLogLevel(_req, res, err) {
    if (err || res.statusCode >= 500) return "error";
    if (isStaleModelIssueReference404(_req, res)) return "info";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage(req, res) {
    return `${req.method} ${sanitizeHttpLogUrl(req.url)} ${res.statusCode}`;
  },
  customErrorMessage(req, res, err) {
    const ctx = (res as any).__errorContext;
    const errMsg = ctx?.error?.message || err?.message || (res as any).err?.message || "unknown error";
    return `${req.method} ${sanitizeHttpLogUrl(req.url)} ${res.statusCode} — ${String(sanitizeValue(errMsg))}`;
  },
  customProps(req, res) {
    if (res.statusCode >= 400) {
      const ctx = (res as any).__errorContext;
      if (ctx) {
        return {
          errorContext: sanitizeValue(ctx.error),
          reqBody: sanitizeValue(ctx.reqBody),
          reqParams: sanitizeValue(ctx.reqParams),
          reqQuery: sanitizeValue(ctx.reqQuery),
        };
      }
      const props: Record<string, unknown> = {};
      const { body, params, query } = req as any;
      if (body && typeof body === "object" && Object.keys(body).length > 0) {
        props.reqBody = sanitizeValue(body);
      }
      if (params && typeof params === "object" && Object.keys(params).length > 0) {
        props.reqParams = sanitizeValue(params);
      }
      if (query && typeof query === "object" && Object.keys(query).length > 0) {
        props.reqQuery = sanitizeValue(query);
      }
      if ((req as any).route?.path) {
        props.routePath = (req as any).route.path;
      }
      return props;
    }
    return {};
  },
});
