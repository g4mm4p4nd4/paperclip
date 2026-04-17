import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

describe("Express 5 /api/auth wildcard route", () => {
  function buildApp() {
    const app = express();
    const handler = vi.fn((_req: express.Request, res: express.Response) => {
      res.status(200).json({ ok: true });
    });
    app.all("/api/auth/{*authPath}", handler);
    return { app, handler };
  }

  it("matches a shallow auth sub-path", async () => {
    const { app } = buildApp();
    const res = await request(app).post("/api/auth/sign-in/email");
    expect(res.status).toBe(200);
  });

  it("matches a deep auth sub-path", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/api/auth/callback/credentials/sign-in");
    expect(res.status).toBe(200);
  });

  it("does not match unrelated paths outside /api/auth", async () => {
    const { app, handler } = buildApp();
    const res = await request(app).get("/api/other/endpoint");
    expect(res.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });

  it("invokes the handler for every matched sub-path", async () => {
    const { app, handler } = buildApp();
    await request(app).post("/api/auth/sign-out");
    await request(app).get("/api/auth/session");
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
