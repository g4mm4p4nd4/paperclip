import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { HttpError } from "../errors.js";
import { trackErrorHandlerCrash } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";
import {
  sanitizeHttpErrorForLogs,
  sanitizeHttpFailureForLogs,
  sanitizeHttpRequestBodyForLogs,
  sanitizeValue,
} from "../redaction.js";

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
    error: sanitizeHttpFailureForLogs(
      req.method,
      req.originalUrl,
      req.body,
      payload,
    ) as ErrorContext["error"],
    method: req.method,
    url: req.originalUrl,
    reqBody: sanitizeHttpRequestBodyForLogs(req.method, req.originalUrl, req.body),
    reqParams: sanitizeValue(req.params),
    reqQuery: sanitizeValue(req.query),
  } satisfies ErrorContext;
  if (rawError) {
    (res as any).err = sanitizeHttpErrorForLogs(
      req.method,
      req.originalUrl,
      req.body,
      rawError,
    );
  }
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof HttpError) {
    if (err.status >= 500) {
      attachErrorContext(
        req,
        res,
        { message: err.message, stack: err.stack, name: err.name, details: err.details },
        err,
      );
      const tc = getTelemetryClient();
      if (tc) trackErrorHandlerCrash(tc, { errorCode: err.name });
    }
    const machineCode = err.details && typeof err.details === "object" && "code" in err.details
      ? String((err.details as { code: unknown }).code)
      : null;
    res.status(err.status).json(machineCode?.startsWith("profit_flywheel_") ? {
      error: "Profit Flywheel request rejected",
      details: { code: machineCode },
    } : {
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
