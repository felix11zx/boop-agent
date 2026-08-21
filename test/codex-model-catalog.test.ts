import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODEX_MODEL,
  fallbackCodexModels,
  normalizeCodexModelCatalog,
  reasoningEffortsForCodexModel,
} from "../server/codex-model-catalog.js";
import {
  FAST_CODEX_MODEL,
  KNOWN_CODEX_MODELS,
  fastCodexRuntimeConfig,
  resolveModelInput,
  resolveReasoningEffortInput,
} from "../server/runtime-config.js";
import { estimateOpenAiCostUsd } from "../server/usage.js";

describe("Codex model catalog", () => {
  it("keeps only visible GPT-5.6 and GPT-5.5 account models in picker order", () => {
    const models = normalizeCodexModelCatalog([
      {
        model: "gpt-5.5",
        hidden: false,
        supportedReasoningEfforts: [
          { reasoningEffort: "max" },
          { reasoningEffort: "xhigh" },
          { reasoningEffort: "medium" },
        ],
      },
      {
        model: "gpt-5.4",
        hidden: false,
        supportedReasoningEfforts: ["medium"],
      },
      {
        model: "gpt-5.6-luna",
        hidden: true,
        supportedReasoningEfforts: ["low", "medium"],
      },
      {
        model: "gpt-5.6-terra",
        hidden: false,
        supportedReasoningEfforts: ["ultra", "max", "high", "minimal"],
      },
      {
        model: "gpt-5.6-sol",
        hidden: false,
        isDefault: true,
        supportedReasoningEfforts: ["ultra", "max", "xhigh", "medium", "low"],
      },
    ]);

    expect(models.map((model) => model.value)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.5",
    ]);
    expect(models[0]).toMatchObject({
      label: "GPT-5.6 Sol",
      isDefault: true,
      supportedReasoningEfforts: ["low", "medium", "xhigh", "max"],
    });
    expect(models[1].supportedReasoningEfforts).toEqual(["high", "max"]);
    expect(models[2].supportedReasoningEfforts).toEqual(["medium", "xhigh"]);
  });

  it("provides a safe four-model fallback and returns independent copies", () => {
    const first = fallbackCodexModels();
    const second = fallbackCodexModels();

    expect(DEFAULT_CODEX_MODEL).toBe("gpt-5.6-sol");
    expect(first.map((model) => model.value)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]);

    first[0].supportedReasoningEfforts.pop();
    expect(second[0].supportedReasoningEfforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("uses model-specific fallback reasoning levels", () => {
    expect(reasoningEffortsForCodexModel("gpt-5.6-luna")).toContain("max");
    expect(reasoningEffortsForCodexModel("gpt-5.5")).not.toContain("max");
    expect(reasoningEffortsForCodexModel("unknown")).toEqual(["medium"]);
  });

  it("accepts current aliases and rejects removed Codex models", () => {
    expect([...KNOWN_CODEX_MODELS]).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]);
    expect(resolveModelInput("GPT 5.6", "codex")).toBe("gpt-5.6-sol");
    expect(resolveModelInput("terra", "codex")).toBe("gpt-5.6-terra");
    expect(resolveModelInput("mini", "codex")).toBe("gpt-5.6-luna");
    expect(resolveModelInput("gpt-5.4", "codex")).toBeNull();
    expect(resolveModelInput("gpt-5.4-mini", "codex")).toBeNull();
    expect(resolveReasoningEffortInput("max")).toBe("max");
  });

  it("uses Luna/low for lightweight Codex work without mutating execution config", () => {
    const executionConfig = {
      runtime: "codex" as const,
      model: "gpt-5.6-sol",
      reasoningEffort: "medium" as const,
      billingMode: "codex-subscription" as const,
    };

    const fastConfig = fastCodexRuntimeConfig(executionConfig);

    expect(FAST_CODEX_MODEL).toBe("gpt-5.6-luna");
    expect(fastConfig).toEqual({
      ...executionConfig,
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
    });
    expect(executionConfig).toMatchObject({
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
    });
  });

  it("leaves Claude configs unchanged", () => {
    const config = {
      runtime: "claude" as const,
      model: "claude-sonnet-4-6",
      billingMode: "api" as const,
    };

    expect(fastCodexRuntimeConfig(config)).toBe(config);
  });

  it.each([
    ["gpt-5.6-sol", 35],
    ["gpt-5.6-terra", 14],
    ["gpt-5.6-luna", 1.4],
    ["gpt-5.5", 35],
  ])("estimates current %s usage with its own price", (model, expected) => {
    expect(
      estimateOpenAiCostUsd({
        model,
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    ).toBeCloseTo(expected);
  });
});
