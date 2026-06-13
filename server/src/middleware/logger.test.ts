import { describe, expect, it } from "vitest";
import { isStaleModelIssueReference404 } from "./logger.js";

describe("isStaleModelIssueReference404", () => {
  it("detects stale model ids that old markdown clients mis-link as issues", () => {
    const req = {
      method: "GET",
      params: { id: "GEMINI-2" },
      route: { path: "/issues/:id" },
    };

    expect(isStaleModelIssueReference404(req, { statusCode: 404 })).toBe(true);
  });

  it("does not suppress normal issue route failures", () => {
    const req = {
      method: "GET",
      params: { id: "PAP-404" },
      route: { path: "/issues/:id" },
    };

    expect(isStaleModelIssueReference404(req, { statusCode: 404 })).toBe(false);
    expect(isStaleModelIssueReference404(req, { statusCode: 200 })).toBe(false);
  });
});
