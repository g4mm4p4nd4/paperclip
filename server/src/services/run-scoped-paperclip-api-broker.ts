import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const PAPERCLIP_API_BROKER_MAX_BODY_BYTES = 16 * 1024 * 1024;
const SUPPORTED_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

type SupportedMethod = typeof SUPPORTED_METHODS[number];

export type RunScopedPaperclipApiBrokerInput = {
  upstreamUrl: string;
  authToken: string;
  runId: string;
  allowedRequests?: ReadonlyArray<{
    method: SupportedMethod;
    pathname: string;
    /** Omit to allow any query string; use "" to require no query string. */
    search?: string;
  }>;
};

/**
 * Translate a random, process-child-only sentinel into the real Paperclip
 * bearer on an ephemeral 127.0.0.1 listener. Heartbeats omit allowedRequests
 * and retain their existing /api-wide behavior; bounded operators can narrow
 * authority to exact method/path/query tuples.
 */
export async function createRunScopedPaperclipApiBroker(input: RunScopedPaperclipApiBrokerInput) {
  const upstream = new URL(input.upstreamUrl);
  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
    throw new Error("Paperclip API broker upstream must use HTTP or HTTPS");
  }
  const allowedRequests = input.allowedRequests?.map((request) => {
    const method = request.method.toUpperCase();
    const pathname = request.pathname;
    const parsed = new URL(pathname, "http://paperclip-broker.invalid");
    if (
      !SUPPORTED_METHODS.includes(method as SupportedMethod) ||
      !pathname.startsWith("/api/") ||
      parsed.origin !== "http://paperclip-broker.invalid" ||
      parsed.pathname !== pathname ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("Paperclip API broker allowlist entries must be exact /api pathnames and supported methods");
    }
    if (request.search !== undefined && request.search !== "" && !request.search.startsWith("?")) {
      throw new Error("Paperclip API broker allowlist query strings must be empty or start with ?");
    }
    return { method, pathname, search: request.search };
  });
  if (allowedRequests && allowedRequests.length === 0) {
    throw new Error("Paperclip API broker allowlist must contain at least one request");
  }
  const childAuthToken = `paperclip-broker-${randomBytes(32).toString("base64url")}`;
  const expectedAuthorization = Buffer.from(`Bearer ${childAuthToken}`, "utf8");
  const server = createServer(async (request, response) => {
    try {
      const presentedAuthorization = Buffer.from(request.headers.authorization ?? "", "utf8");
      if (
        presentedAuthorization.length !== expectedAuthorization.length ||
        !timingSafeEqual(presentedAuthorization, expectedAuthorization)
      ) {
        response.writeHead(401).end("broker authorization required");
        return;
      }
      const requestPath = request.url ?? "/";
      if (!requestPath.startsWith("/") || requestPath.startsWith("//")) {
        response.writeHead(400).end("invalid request target");
        return;
      }
      const target = new URL(requestPath, upstream);
      if (
        target.origin !== upstream.origin ||
        (target.pathname !== "/api" && !target.pathname.startsWith("/api/"))
      ) {
        response.writeHead(403).end("broker target is outside the Paperclip API");
        return;
      }
      const chunks: Buffer[] = [];
      let bodyBytes = 0;
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bodyBytes += bytes.length;
        if (bodyBytes > PAPERCLIP_API_BROKER_MAX_BODY_BYTES) {
          response.writeHead(413).end("request body too large");
          return;
        }
        chunks.push(bytes);
      }
      const headers = new Headers();
      for (const [name, rawValue] of Object.entries(request.headers)) {
        const lower = name.toLowerCase();
        if (["authorization", "cookie", "host", "connection", "content-length", "accept-encoding"].includes(lower)) continue;
        for (const value of Array.isArray(rawValue) ? rawValue : rawValue == null ? [] : [rawValue]) {
          headers.append(name, value);
        }
      }
      headers.set("authorization", `Bearer ${input.authToken}`);
      headers.set("x-paperclip-run-id", input.runId);
      const method = (request.method ?? "GET").toUpperCase();
      if (!SUPPORTED_METHODS.includes(method as SupportedMethod)) {
        response.writeHead(405).end("method not allowed");
        return;
      }
      if (allowedRequests && !allowedRequests.some((allowed) => (
        allowed.method === method &&
        allowed.pathname === target.pathname &&
        (allowed.search === undefined || allowed.search === target.search)
      ))) {
        response.writeHead(403).end("broker request is outside the run scope");
        return;
      }
      const clientAbort = new AbortController();
      request.once("aborted", () => clientAbort.abort());
      const upstreamResponse = await fetch(target, {
        method,
        headers,
        body: ["GET", "HEAD"].includes(method) ? undefined : Buffer.concat(chunks),
        redirect: "manual",
        signal: AbortSignal.any([clientAbort.signal, AbortSignal.timeout(30_000)]),
      });
      const responseBytes = Buffer.from(await upstreamResponse.arrayBuffer());
      if (responseBytes.length > PAPERCLIP_API_BROKER_MAX_BODY_BYTES) {
        response.writeHead(502).end("upstream response too large");
        return;
      }
      const responseHeaders: Record<string, string> = {};
      for (const name of ["content-type", "cache-control", "etag", "location"]) {
        const value = upstreamResponse.headers.get(name);
        if (value) responseHeaders[name] = value;
      }
      response.writeHead(upstreamResponse.status, responseHeaders);
      response.end(responseBytes);
    } catch {
      if (!response.headersSent) response.writeHead(502);
      response.end("Paperclip API broker request failed");
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.unref();
  const address = server.address() as AddressInfo;
  let closed = false;
  return {
    url: `http://127.0.0.1:${address.port}`,
    childAuthToken,
    async close() {
      if (closed) return;
      closed = true;
      const closePromise = new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      server.closeAllConnections?.();
      for (const socket of sockets) socket.destroy();
      await closePromise;
    },
  };
}
