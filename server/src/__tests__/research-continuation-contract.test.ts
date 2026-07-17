import { readFile } from "node:fs/promises";
import path from "node:path";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

describe("research continuation cross-repo contract", () => {
  it("accepts exact shared valid vectors, rejects mode confusion, and rejects secret-bearing authorization bindings", async () => {
    const root = path.resolve(process.cwd(), "contracts/profit-flywheel");
    const [schema, vectors] = await Promise.all([
      readFile(path.join(root, "paperclip.research_continuation.v1.schema.json"), "utf8").then(JSON.parse),
      readFile(path.join(root, "research-continuation-golden-vectors.v1.json"), "utf8").then(JSON.parse),
    ]);
    const ajv = new Ajv({ strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    for (const value of Object.values(vectors.valid)) {
      expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    }
    for (const value of Object.values(vectors.invalid)) {
      expect(validate(value)).toBe(false);
    }
    const valid = vectors.valid.fixture_iteration_two as Record<string, unknown>;
    for (const authorization of vectors.invalid_authorization_bindings as Array<Record<string, unknown>>) {
      expect(validate({ ...valid, authorization })).toBe(false);
    }
  });
});
