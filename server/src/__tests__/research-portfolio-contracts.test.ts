import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

const PAPERCLIP_CONTRACT_ROOT = fileURLToPath(new URL("../../../contracts/profit-flywheel/", import.meta.url));
const POS_CONTRACT_ROOT = fileURLToPath(new URL("../../../../portfolio-os/contracts/", import.meta.url));

const CONTRACTS = {
  "pos.research_portfolio.v1.schema.json": "63d325a5f06881ef1aed4bb4d6bce2b514ede5fe0ba17fae883e9f0391947d38",
  "pos.research_portfolio_primary_dossier.v1.schema.json": "a0405fe77defe624d9321526c74eb4f980def3d415fd2893ffea95ebc85247a7",
  "pos.research_portfolio_corroboration.v1.schema.json": "f2c2cb7f40a83d3bd31a779f15000d3e092afddf70a618535abf16679acaf30d",
  "pos.research_portfolio_cross_review.v1.schema.json": "cbef6b87edd0f6c9e9fb76ebd42be85fbd6d597e81542a1be37ce412f23d5c4c",
  "pos.source_custody.v1.schema.json": "bfe16becce869330ec6b505cd0a7ed5e90dd00c52531dbe03d81adc45d8fdaa8",
  "paperclip.fleet_repair_scheduled_value_wave_accept.v2.schema.json": "5590b92f969eaf1534daae74561bfddc8e8bebaa84ecb21b607213975c1d30f2",
} as const;

describe("research portfolio contract closure", () => {
  it("keeps POS and Paperclip schemas byte-identical and resolves every JSON Schema reference", async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const schemaIds: string[] = [];

    for (const [basename, expectedSha256] of Object.entries(CONTRACTS)) {
      const [posBytes, paperclipBytes] = await Promise.all([
        readFile(path.join(POS_CONTRACT_ROOT, basename)),
        readFile(path.join(PAPERCLIP_CONTRACT_ROOT, basename)),
      ]);
      expect(paperclipBytes.equals(posBytes), basename).toBe(true);
      expect(createHash("sha256").update(posBytes).digest("hex"), basename).toBe(expectedSha256);
      const schema = JSON.parse(posBytes.toString("utf8")) as Record<string, unknown>;
      expect(typeof schema.$id, basename).toBe("string");
      schemaIds.push(schema.$id as string);
      ajv.addSchema(schema);
    }

    for (const schemaId of schemaIds) {
      expect(ajv.getSchema(schemaId), schemaId).toBeTypeOf("function");
    }
  });
});
