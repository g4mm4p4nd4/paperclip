import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { HttpError } from "../errors.js";
import { trackErrorHandlerCrash } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";

export interface ErrorContext {
  error: { message: string; stack?: string; name?: string; details?: unknown; raw?: unknown };
  method: string;
  url: string;
  reqBody?: unknown;
  reqParams?: unknown;
  reqQuery?: unknown;
}

function attachErrorContext(
  req: Request,
  res: Response,
  payload: ErrorContext["error"],
  rawError?: Error,
) {
  (res as any).__errorContext = {
    error: payload,
    method: req.method,
    url: req.originalUrl,
    reqBody: req.body,
    reqParams: req.params,
    reqQuery: req.query,
  } satisfies ErrorContext;
  if (rawError) {
    (res as any).err = rawError;
  }
}

function isHttpErrorLike(err: unknown): err is {
  status: number;
  message: string;
  details?: unknown;
  stack?: string;
  name?: string;
} {
  if (!(err instanceof Error) && (typeof err !== "object" || err === null)) return false;
  const status = (err as { status?: unknown }).status;
  return Number.isInteger(status) && Number(status) >= 400 && Number(status) <= 599;
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof HttpError || isHttpErrorLike(err)) {
    if (err.status >= 500) {
      attachErrorContext(
        req,
        res,
        { message: err.message, stack: err.stack, name: err.name, details: err.details },
        err instanceof Error ? err : undefined,
      );
      const tc = getTelemetryClient();
      if (tc) trackErrorHandlerCrash(tc, { errorCode: err.name ?? "HttpError" });
    }
    res.status(err.status).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({ error: "Validation error", details: err.errors });
    return;
  }

  const rootError = err instanceof Error ? err : new Error(String(err));
  attachErrorContext(
    req,
    res,
    err instanceof Error
      ? { message: err.message, stack: err.stack, name: err.name }
      : { message: String(err), raw: err, stack: rootError.stack, name: rootError.name },
    rootError,
  );

  const tc = getTelemetryClient();
  if (tc) trackErrorHandlerCrash(tc, { errorCode: rootError.name });

  res.status(500).json({ error: "Internal server error" });
}
