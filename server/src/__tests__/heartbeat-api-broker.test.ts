import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createRunScopedPaperclipApiBroker } from "../services/heartbeat.js";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

describe("run-scoped Paperclip API auth broker", () => {
  it("keeps the real run JWT out of the provider environment and injects it only upstream", async () => {
    const realToken = "test.paperclip.run.jwt-that-must-never-enter-child-env";
    let observedAuthorization: string | null = null;
    let observedRunId: string | null = null;
    const upstream = createServer((request, response) => {
      observedAuthorization = request.headers.authorization ?? null;
      observedRunId = typeof request.headers["x-paperclip-run-id"] === "string"
        ? request.headers["x-paperclip-run-id"]
        : null;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    closeCallbacks.push(() => new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve())));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    const broker = await createRunScopedPaperclipApiBroker({
      upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
      authToken: realToken,
      runId: "run-broker-test",
    });
    closeCallbacks.push(() => broker.close());

    expect(broker.childAuthToken).not.toContain(realToken);
    expect(broker.childAuthToken).toMatch(/^paperclip-broker-/);
    expect(broker.url).not.toContain(realToken);
    const response = await fetch(`${broker.url}/api/agents/me`, {
      headers: { authorization: `Bearer ${broker.childAuthToken}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(observedAuthorization).toBe(`Bearer ${realToken}`);
    expect(observedRunId).toBe("run-broker-test");
  });

  it("refuses proxy targets outside the Paperclip API path", async () => {
    const upstream = createServer((_request, response) => response.end("unexpected"));
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    closeCallbacks.push(() => new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve())));
    const broker = await createRunScopedPaperclipApiBroker({
      upstreamUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      authToken: "test-token",
      runId: "run-broker-test",
    });
    closeCallbacks.push(() => broker.close());

    expect((await fetch(`${broker.url}/api/agents/me`)).status).toBe(401);
    expect((await fetch(`${broker.url}/not-api`, {
      headers: { authorization: `Bearer ${broker.childAuthToken}` },
    })).status).toBe(403);
  });

  it("confines method, pathname, and exact query when a run scope is supplied", async () => {
    let upstreamRequests = 0;
    const upstream = createServer((_request, response) => {
      upstreamRequests += 1;
      response.writeHead(200).end("ok");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    closeCallbacks.push(() => new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve())));
    const broker = await createRunScopedPaperclipApiBroker({
      upstreamUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      authToken: "test-token",
      runId: "run-query-scope-test",
      allowedRequests: [{
        method: "GET",
        pathname: "/api/companies/company-1/profit-flywheel/workflows",
        search: "?correlation_id=profit-canary%3Arun-1&limit=10",
      }],
    });
    closeCallbacks.push(() => broker.close());
    const headers = { authorization: `Bearer ${broker.childAuthToken}` };
    const exact = `${broker.url}/api/companies/company-1/profit-flywheel/workflows?correlation_id=profit-canary%3Arun-1&limit=10`;

    expect((await fetch(exact, { headers })).status).toBe(200);
    expect((await fetch(exact, { method: "POST", headers })).status).toBe(403);
    expect((await fetch(`${broker.url}/api/companies/company-1/profit-flywheel/workflows?correlation_id=profit-canary%3Aother&limit=10`, { headers })).status).toBe(403);
    expect((await fetch(`${exact}&include=all`, { headers })).status).toBe(403);
    expect((await fetch(`${broker.url}/api/companies/company-1/profit-flywheel/workflows/extra?correlation_id=profit-canary%3Arun-1&limit=10`, { headers })).status).toBe(403);
    expect(upstreamRequests).toBe(1);
  });
});
