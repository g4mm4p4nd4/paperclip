import { describe, expect, it } from "vitest";
import { sanitizeHttpLogUrl, serializeHttpRequestForLogs } from "../middleware/logger.js";
import {
  sanitizeHttpRequestBodyForLogs,
  sanitizeHttpErrorForLogs,
  sanitizeHttpFailureForLogs,
  sanitizeValue,
} from "../redaction.js";

describe("HTTP logger redaction boundary", () => {
  it("redacts authorization and cookies on successful requests", () => {
    const serialized = serializeHttpRequestForLogs({
      method: "GET",
      url: "/api/agents/me",
      headers: {
        authorization: "Bearer eyJheader.payload.signature",
        cookie: "session=credential-material",
        accept: "application/json",
      },
    });

    expect(serialized.headers).toEqual({
      authorization: "***REDACTED***",
      cookie: "***REDACTED***",
      accept: "application/json",
    });
  });

  it("drops query credentials from every logged URL surface", () => {
    const raw = "/api/x?access_token=must-not-log#fragment";
    expect(serializeHttpRequestForLogs({ method: "GET", url: raw }).url).toBe("/api/x");
    expect(sanitizeHttpLogUrl(raw)).toBe("/api/x");
  });

  it("recursively redacts nested claim nonces and bearer text on failures", () => {
    expect(sanitizeValue({
      body: { claim_nonce: "claim-secret", note: "Authorization: Bearer abcdefghijklmnop" },
      query: { access_token: "token-secret" },
      evidence: { executionEvidenceNonce: "db-only", server_observation_nonce: "db-only-too" },
    })).toEqual({
      body: { claim_nonce: "***REDACTED***", note: "Authorization: ***REDACTED***" },
      query: { access_token: "***REDACTED***" },
      evidence: { executionEvidenceNonce: "***REDACTED***", server_observation_nonce: "***REDACTED***" },
    });
  });

  it("redacts broker capabilities and bearer material from free-form messages and errors", () => {
    const capability = "paperclip-broker-abcdefghijklmnopqrstuvwxyz123456";
    expect(sanitizeValue(`failed with ${capability}`)).toBe("failed with ***REDACTED***");
    expect(sanitizeValue(new Error(`failed with ${capability}`))).toMatchObject({
      message: "failed with ***REDACTED***",
    });
  });

  it.each([
    ["/api/companies/company-1/secrets", { name: "HOSTINGER_API_KEY", provider: "local_encrypted", value: "unstructured-hostinger-token-1234567890" }],
    ["/api/secrets/secret-1/rotate", { value: "unstructured-hostinger-token-1234567890", externalRef: "provider-reference-1234567890" }],
  ])("redacts generic secret-write fields before failed request logging for %s", (url, body) => {
    const sanitized = sanitizeHttpRequestBodyForLogs("POST", url, body);
    const serialized = JSON.stringify(sanitized);

    expect(sanitized).toMatchObject({
      value: "***REDACTED***",
    });
    expect(serialized).not.toContain("unstructured-hostinger-token-1234567890");
    expect(serialized).not.toContain("provider-reference-1234567890");
  });

  it("does not globally redact ordinary non-secret value fields", () => {
    expect(sanitizeHttpRequestBodyForLogs(
      "POST",
      "/api/companies/company-1/settings",
      { value: "dark" },
    )).toEqual({ value: "dark" });
  });

  it.each([
    "/api/companies/company-1/secrets",
    "/api/secrets/secret-1/rotate",
  ])("redacts exact submitted values from secret-write failures for %s", (url) => {
    const secret = "synthetic-unstructured-secret-1234567890";
    const body = { value: secret };
    const error = new Error(`provider rejected ${secret}`);

    const context = sanitizeHttpFailureForLogs("POST", url, body, error);
    const rawError = sanitizeHttpErrorForLogs("POST", url, body, error);
    const serialized = JSON.stringify({
      context,
      message: rawError.message,
      stack: rawError.stack,
    });

    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("***REDACTED***");
  });
});
