import { describe, expect, it } from "vitest";
import {
  OPENCODE_GO_MODEL_IDS,
  OPENCODE_GO_MODEL_CONTEXT_LIMITS,
  OPENCODE_GO_MODELS,
  OPENCODE_GO_ROLE_ROUTING,
  OPENCODE_ZEN_FREE_MODEL_CONTEXT_LIMITS,
  OPENCODE_ZEN_FREE_MODEL_IDS,
  OPENCODE_ZEN_FREE_MODELS,
  collectOpenCodeGoRoutingModelIds,
  isOpenCodeGoModelId,
  isOpenCodeZenFreeModelId,
  resolveOpenCodeGoRoutingForRole,
} from "./opencode-go-routing.js";

const requestedModelIds = [
  "minimax-m2.7",
  "minimax-m2.5",
  "kimi-k2.6",
  "kimi-k2.5",
  "glm-5.1",
  "glm-5",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "qwen3.7-max",
  "qwen3.6-plus",
  "qwen3.5-plus",
  "mimo-v2-pro",
  "mimo-v2-omni",
  "mimo-v2.5-pro",
  "mimo-v2.5",
  "hy3-preview",
] as const;

const freeModelIds = [
  "deepseek-v4-flash-free",
  "mimo-v2.5-free",
  "nemotron-3-super-free",
  "big-pickle",
] as const;

describe("OpenCode Go role routing", () => {
  it("represents every requested OpenCode Go model id", () => {
    expect(OPENCODE_GO_MODEL_IDS).toEqual(requestedModelIds);
    expect(new Set(OPENCODE_GO_MODEL_IDS).size).toBe(16);
  });

  it("publishes prefixed OpenCode model ids for opencode_local", () => {
    expect(OPENCODE_GO_MODELS).toHaveLength(16);
    expect(OPENCODE_GO_MODELS.every((model) => model.id.startsWith("opencode-go/"))).toBe(true);
    expect(OPENCODE_GO_MODELS.map((model) => model.id)).toContain("opencode-go/deepseek-v4-flash");
  });

  it("publishes explicit OpenCode Zen free emergency models", () => {
    expect(OPENCODE_ZEN_FREE_MODEL_IDS).toEqual(freeModelIds);
    expect(OPENCODE_ZEN_FREE_MODELS).toHaveLength(4);
    expect(OPENCODE_ZEN_FREE_MODELS.every((model) => model.id.startsWith("opencode-zen/"))).toBe(true);
    expect(OPENCODE_ZEN_FREE_MODELS.map((model) => model.id)).toContain("opencode-zen/deepseek-v4-flash-free");
    expect(isOpenCodeZenFreeModelId("opencode-zen/mimo-v2.5-free")).toBe(true);
  });

  it("tracks context tiers for context-aware routing decisions", () => {
    expect(OPENCODE_GO_MODEL_CONTEXT_LIMITS["deepseek-v4-pro"]).toBe(1_000_000);
    expect(OPENCODE_GO_MODEL_CONTEXT_LIMITS["deepseek-v4-flash"]).toBe(1_000_000);
    expect(OPENCODE_GO_MODEL_CONTEXT_LIMITS["qwen3.7-max"]).toBe(1_000_000);
    expect(OPENCODE_GO_MODEL_CONTEXT_LIMITS["mimo-v2.5"]).toBe(1_000_000);
    expect(OPENCODE_GO_MODEL_CONTEXT_LIMITS["qwen3.5-plus"]).toBe(262_144);
    expect(OPENCODE_ZEN_FREE_MODEL_CONTEXT_LIMITS["deepseek-v4-flash-free"]).toBe(1_000_000);
    expect(OPENCODE_ZEN_FREE_MODEL_CONTEXT_LIMITS["mimo-v2.5-free"]).toBe(1_000_000);
  });

  it("routes Paperclip roles to the expected primary model and variant", () => {
    expect(resolveOpenCodeGoRoutingForRole("engineer")).toMatchObject({
      model: "opencode-go/deepseek-v4-flash",
      variant: "high",
    });
    expect(resolveOpenCodeGoRoutingForRole("cto")).toMatchObject({
      model: "opencode-go/deepseek-v4-pro",
      variant: "high",
    });
    expect(resolveOpenCodeGoRoutingForRole("pm")).toMatchObject({
      model: "opencode-go/kimi-k2.6",
      variant: "high",
    });
    expect(resolveOpenCodeGoRoutingForRole("skill_curator")).toMatchObject({
      model: "opencode-go/qwen3.5-plus",
      variant: "medium",
    });
    expect(resolveOpenCodeGoRoutingForRole("unknown")).toEqual(OPENCODE_GO_ROLE_ROUTING.default);
  });

  it("keeps every recommended primary and fallback model in the catalog", () => {
    for (const model of collectOpenCodeGoRoutingModelIds()) {
      expect(model.startsWith("opencode-go/")).toBe(true);
      expect(isOpenCodeGoModelId(model)).toBe(true);
    }
  });
});
