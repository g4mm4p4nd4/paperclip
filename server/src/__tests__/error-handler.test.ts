import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import { errorHandler } from "../middleware/error-handler.js";

function makeReq(): Request {
  return {
    method: "GET",
    originalUrl: "/api/test",
    body: { a: 1 },
    params: { id: "123" },
    query: { q: "x" },
  } as unknown as Request;
}

function makeRes(): Response {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as Response;
  (res.status as unknown as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

describe("errorHandler", () => {
  it("attaches the original Error to res.err for 500s", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const err = new Error("boom");

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Internal server error" });
    expect(res.err).toBe(err);
    expect(res.__errorContext?.error?.message).toBe("boom");
  });

  it("attaches HttpError instances for 500 responses", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const err = new HttpError(500, "db exploded");

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "db exploded" });
    expect(res.err).toBe(err);
    expect(res.__errorContext?.error?.message).toBe("db exploded");
  });

  it("recursively redacts a failed ACK claim nonce before attaching log context", () => {
    const req = makeReq();
    req.body = {
      event_id: "event-1",
      claim_nonce: "raw-claim-capability-must-not-log",
      nested: { authorization: "Bearer eyJheader.payload.signature" },
    };
    const res = makeRes() as any;
    errorHandler(new Error("failed ACK"), req, res, vi.fn() as unknown as NextFunction);

    expect(res.__errorContext.reqBody).toEqual({
      event_id: "event-1",
      claim_nonce: "***REDACTED***",
      nested: { authorization: "***REDACTED***" },
    });
  });

  it("redacts an unstructured secret value from failed secret-write context", () => {
    const req = makeReq();
    req.method = "POST";
    req.originalUrl = "/api/companies/company-1/secrets";
    req.body = {
      name: "HOSTINGER_API_KEY",
      provider: "local_encrypted",
      value: "unstructured-hostinger-token-1234567890",
    };
    const res = makeRes() as any;

    const secret = "unstructured-hostinger-token-1234567890";
    errorHandler(
      new Error(`secret write failed for ${secret}`),
      req,
      res,
      vi.fn() as unknown as NextFunction,
    );

    expect(res.__errorContext.reqBody).toEqual({
      name: "HOSTINGER_API_KEY",
      provider: "local_encrypted",
      value: "***REDACTED***",
    });
    expect(JSON.stringify(res.__errorContext)).not.toContain(
      secret,
    );
    expect(res.err.message).not.toContain(secret);
    expect(res.err.stack).not.toContain(secret);
    expect(res.err.message).toContain("***REDACTED***");
  });
});
