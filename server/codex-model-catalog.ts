import type { RuntimeReasoningEffort } from "./runtimes/types.js";

export interface CodexModelOption {
  value: string;
  label: string;
  supportedReasoningEfforts: RuntimeReasoningEffort[];
  isDefault: boolean;
}

export interface CodexModelDescriptor {
  id?: unknown;
  model?: unknown;
  displayName?: unknown;
  hidden?: unknown;
  isDefault?: unknown;
  supportedReasoningEfforts?: readonly unknown[];
}

export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";

const GPT_56_REASONING: RuntimeReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const GPT_55_REASONING: RuntimeReasoningEffort[] = ["low", "medium", "high", "xhigh"];

export const FALLBACK_CODEX_MODELS: CodexModelOption[] = [
  {
    value: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    supportedReasoningEfforts: [...GPT_56_REASONING],
    isDefault: true,
  },
  {
    value: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    supportedReasoningEfforts: [...GPT_56_REASONING],
    isDefault: false,
  },
  {
    value: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    supportedReasoningEfforts: [...GPT_56_REASONING],
    isDefault: false,
  },
  {
    value: "gpt-5.5",
    label: "GPT-5.5",
    supportedReasoningEfforts: [...GPT_55_REASONING],
    isDefault: false,
  },
];

export const CODEX_MODEL_IDS = FALLBACK_CODEX_MODELS.map((model) => model.value);

const BOOP_REASONING_EFFORTS = new Set<RuntimeReasoningEffort>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function cloneOption(option: CodexModelOption): CodexModelOption {
  return {
    ...option,
    supportedReasoningEfforts: [...option.supportedReasoningEfforts],
  };
}

export function fallbackCodexModels(): CodexModelOption[] {
  return FALLBACK_CODEX_MODELS.map(cloneOption);
}

function descriptorId(descriptor: CodexModelDescriptor): string {
  const value =
    typeof descriptor.model === "string"
      ? descriptor.model
      : typeof descriptor.id === "string"
        ? descriptor.id
        : "";
  return value.trim().toLowerCase();
}

function descriptorEffort(entry: unknown): RuntimeReasoningEffort | null {
  const value =
    typeof entry === "string"
      ? entry
      : entry && typeof entry === "object"
        ? ((entry as { reasoningEffort?: unknown; effort?: unknown }).reasoningEffort ??
          (entry as { effort?: unknown }).effort)
        : null;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase() as RuntimeReasoningEffort;
  return BOOP_REASONING_EFFORTS.has(normalized) ? normalized : null;
}

export function reasoningEffortsForCodexModel(model: string): RuntimeReasoningEffort[] {
  const fallback = FALLBACK_CODEX_MODELS.find((option) => option.value === model);
  return fallback ? [...fallback.supportedReasoningEfforts] : ["medium"];
}

/**
 * Keep only the current Codex models Boop supports. Account metadata controls
 * availability and effort levels; the local definitions control stable order
 * and prevent deprecated/hidden models from resurfacing in the picker.
 */
export function normalizeCodexModelCatalog(
  descriptors: readonly CodexModelDescriptor[],
): CodexModelOption[] {
  const byId = new Map(
    descriptors
      .map((descriptor) => [descriptorId(descriptor), descriptor] as const)
      .filter(([id]) => Boolean(id)),
  );

  return FALLBACK_CODEX_MODELS.flatMap((fallback) => {
    const descriptor = byId.get(fallback.value);
    if (!descriptor || descriptor.hidden === true) return [];

    const advertised = new Set(
      (descriptor.supportedReasoningEfforts ?? [])
        .map(descriptorEffort)
        .filter((effort): effort is RuntimeReasoningEffort => Boolean(effort))
        .filter((effort) => fallback.supportedReasoningEfforts.includes(effort)),
    );
    const supported = fallback.supportedReasoningEfforts.filter((effort) =>
      advertised.has(effort),
    );

    return [
      {
        value: fallback.value,
        label: fallback.label,
        supportedReasoningEfforts:
          supported.length > 0 ? supported : [...fallback.supportedReasoningEfforts],
        isDefault:
          typeof descriptor.isDefault === "boolean"
            ? descriptor.isDefault
            : fallback.isDefault,
      },
    ];
  });
}
