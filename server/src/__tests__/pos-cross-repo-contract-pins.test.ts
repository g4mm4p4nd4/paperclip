import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const CONTRACT_ROOT = fileURLToPath(new URL("../../../contracts/profit-flywheel/", import.meta.url));

const FROZEN_POS_MIRRORS = {
  "paperclip.factory_runtime_manifest.v1.schema.json": "dc0ea3a2c69103f7c889fc0b93f93bef6c4b28fd7d13cc44cd891953c429ddce",
  "paperclip.factory_runtime_manifest.v2.schema.json": "719d2c9eded06069f1a15dd6669c6eb2e2398f6e080c92d4f93f2596498b986c",
  "pos.managed_runtime_package.v1.schema.json": "9d448c3105aaca60adc5c51772fdef0bbd343be06449d71c0d6910fc3baf6628",
  "pos.managed_runtime_package.v2.schema.json": "2c37b0969c67585ee5bd02a509182aac54baf8eb3915bbbf500cceedaf930dce",
  "pos.managed_runtime_pointer_set.v2.schema.json": "a392e05a6c5763a7fa4fb80484bc3133899a4dd0a316d33ac889219218158239",
  "pos.managed_runtime_rollback.v2.schema.json": "6b196a156fbe9d6ab220b24510db7dc2a4c5be528b1856bcace4e2c58e41765e",
  "pos.managed_runtime_selector.v2.schema.json": "7b226593b98f1560db26450bad857680b83af552d4f8cb56d54cdc95fde17c6f",
  "pos.managed_runtime_transition.v2.schema.json": "8b1d951047907585dd897886c810c09713c2bd34948bbf1e3d545a341929129b",
  "pos.paperclip_provider_policy_authority.v1.schema.json": "bd800da956bfb3b2966c5b38326fe4b2e0e8049a1153d51c33394cb862c68541",
  "pos.paperclip_consumer_envelope.v1.schema.json": "6574b139a90815e386ac0195373090c8e59afb1cd90730c87980711d33490c08",
  "pos.paperclip_consumer_crash_journal.v1.schema.json": "16a6dfcdabff47a436d37de582e82f647016d560e78ebf57c2cbf4db80a0a027",
  "consumer-protocol-golden-vectors.v1.json": "8081700692a7a70a4b10d9e2b20f97533fe386bc779e7e49100f71e8a9bce784",
  "pos.next_research_authorization.v2.schema.json": "0948aa17cb883023270e0ca822f1ed3629e10fceb9ddb794c604122e7cd50082",
  "paperclip.research_continuation.v1.schema.json": "73c7e399aa220197aaa7dbadee6e4a2ba9766cbc7cabc682836194b9a2ef3124",
  "paperclip.research_plan.v3.schema.json": "92f05772cb4ff3917bb42e0b589e14dbdddc43ef6aae48cc657ce04312ffe0cc",
  "research-continuation-golden-vectors.v1.json": "e2964eaefd5b42d7e69b55909ff65362ec2664fe76d53bc47c41a652af7285cb",
  "pos.learning_receipt.v3.schema.json": "e2274a9726ef90c40ab386090b473a0f9a4424c5ff338f3b8af072227243a3ed",
  "pos.research_portfolio.v1.schema.json": "63d325a5f06881ef1aed4bb4d6bce2b514ede5fe0ba17fae883e9f0391947d38",
  "pos.research_portfolio_primary_dossier.v1.schema.json": "a0405fe77defe624d9321526c74eb4f980def3d415fd2893ffea95ebc85247a7",
  "pos.research_portfolio_corroboration.v1.schema.json": "f2c2cb7f40a83d3bd31a779f15000d3e092afddf70a618535abf16679acaf30d",
  "pos.research_portfolio_cross_review.v1.schema.json": "cbef6b87edd0f6c9e9fb76ebd42be85fbd6d597e81542a1be37ce412f23d5c4c",
  "pos.source_custody.v1.schema.json": "bfe16becce869330ec6b505cd0a7ed5e90dd00c52531dbe03d81adc45d8fdaa8",
  "paperclip.fleet_repair_scheduled_value_wave_accept.v2.schema.json": "5590b92f969eaf1534daae74561bfddc8e8bebaa84ecb21b607213975c1d30f2",
} as const;

describe("frozen Portfolio OS consumer contract mirrors", () => {
  it.each(Object.entries(FROZEN_POS_MIRRORS))("pins %s byte-for-byte", async (file, expectedSha256) => {
    const bytes = await readFile(path.join(CONTRACT_ROOT, file));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(expectedSha256);
  });
});
