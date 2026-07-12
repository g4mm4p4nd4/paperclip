import { describe, expect, it } from "vitest";
import { sanitizeHttpLogUrl, serializeHttpRequestForLogs } from "../middleware/logger.js";
import { sanitizeValue } from "../redaction.js";

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
});
