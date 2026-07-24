import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const CONTRACT_ROOT = fileURLToPath(new URL("../../../contracts/profit-flywheel/", import.meta.url));

const FROZEN_POS_MIRRORS = {
  "paperclip.factory_runtime_manifest.v1.schema.json": "bc7720d24eadcea8d29272be78127ac3dc4d1bfd5d5e8bd4ea20e582793a1f57",
  "pos.managed_runtime_package.v1.schema.json": "d4b7fe14fce9c6914c7e104887eedb0b80daf082e8a12d0fa4209b7109da19ba",
  "pos.paperclip_provider_policy_authority.v1.schema.json": "bd800da956bfb3b2966c5b38326fe4b2e0e8049a1153d51c33394cb862c68541",
  "pos.paperclip_consumer_envelope.v1.schema.json": "81e9aee6b0cfa58149871693d0dc7f32ea3368aae83acee1f0fc94bb80dfb315",
  "pos.paperclip_consumer_crash_journal.v1.schema.json": "c70797386c78eeeca4b2fd369b1b77c24d377f5ff7f8ea7b70b5c91305ac80bd",
  "consumer-protocol-golden-vectors.v1.json": "787fc292445cd2a919bab7196e60111112023f86279d4533e4d2f844b8fb2702",
  "pos.next_research_authorization.v2.schema.json": "0948aa17cb883023270e0ca822f1ed3629e10fceb9ddb794c604122e7cd50082",
  "paperclip.research_continuation.v1.schema.json": "73c7e399aa220197aaa7dbadee6e4a2ba9766cbc7cabc682836194b9a2ef3124",
  "paperclip.research_plan.v3.schema.json": "92f05772cb4ff3917bb42e0b589e14dbdddc43ef6aae48cc657ce04312ffe0cc",
  "research-continuation-golden-vectors.v1.json": "e2964eaefd5b42d7e69b55909ff65362ec2664fe76d53bc47c41a652af7285cb",
  "pos.learning_receipt.v3.schema.json": "e2274a9726ef90c40ab386090b473a0f9a4424c5ff338f3b8af072227243a3ed",
} as const;

describe("frozen Portfolio OS consumer contract mirrors", () => {
  it.each(Object.entries(FROZEN_POS_MIRRORS))("pins %s byte-for-byte", async (file, expectedSha256) => {
    const bytes = await readFile(path.join(CONTRACT_ROOT, file));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(expectedSha256);
  });
});
