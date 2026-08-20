import {
  fallbackCodexModels,
  normalizeCodexModelCatalog,
  type CodexModelOption,
} from "./codex-model-catalog.js";
import { queryCodexAppServerModels } from "./runtimes/codex-app-server.js";
import { formatError } from "./error-format.js";

export interface CodexModelCatalog {
  models: CodexModelOption[];
  source: "codex-account" | "fallback";
}

const ACCOUNT_CACHE_TTL_MS = 5 * 60 * 1000;
const FALLBACK_CACHE_TTL_MS = 30 * 1000;

let cached: { expiresAt: number; value: CodexModelCatalog } | null = null;
let inFlight: Promise<CodexModelCatalog> | null = null;

async function loadCodexModelCatalog(): Promise<CodexModelCatalog> {
  try {
    const models = normalizeCodexModelCatalog(await queryCodexAppServerModels());
    if (models.length === 0) {
      throw new Error("Codex returned no supported GPT-5.6/5.5 models");
    }
    return { models, source: "codex-account" };
  } catch (err) {
    console.warn(`[codex-models] account catalog unavailable; using fallback: ${formatError(err)}`);
    return { models: fallbackCodexModels(), source: "fallback" };
  }
}

export async function getCodexModelCatalog(): Promise<CodexModelCatalog> {
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (inFlight) return inFlight;

  inFlight = loadCodexModelCatalog().then((value) => {
    cached = {
      value,
      expiresAt:
        Date.now() +
        (value.source === "codex-account" ? ACCOUNT_CACHE_TTL_MS : FALLBACK_CACHE_TTL_MS),
    };
    return value;
  });

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}
