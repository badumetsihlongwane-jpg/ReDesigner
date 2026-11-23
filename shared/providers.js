// shared/providers.js — Single Source of Truth for AI Providers, Vision Detection & Smart Fallbacks

export const PROVIDERS = {
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    keyLabel: "Gemini API Key",
    keyPlaceholder: "AIzaSy...",
    requiresKey: true,
    modelsUrl: "https://generativelanguage.googleapis.com/v1beta/models",
    defaultModels: [
      { id: "gemini-flash-latest", label: "Gemini Flash Latest (Vision)", vision: true },
      { id: "gemini-flash-lite-latest", label: "Gemini Flash-Lite Latest", vision: true },
      { id: "gemini-pro-latest", label: "Gemini Pro Latest (Vision)", vision: true },
      { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", vision: true },
      { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite", vision: true }
    ]
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    keyLabel: "OpenRouter API Key",
    keyPlaceholder: "sk-or-v1-...",
    requiresKey: true,
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    modelsUrl: "https://openrouter.ai/api/v1/models",
    defaultModels: [
      { id: "google/gemini-2.5-flash", label: "Gemini Flash (Vision)", vision: true },
      { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4 (Vision)", vision: true },
      { id: "openai/gpt-4o-mini", label: "GPT-4o Mini (Vision)", vision: true },
      { id: "qwen/qwen-2.5-vl-72b-instruct:free", label: "Qwen 2.5 VL 72B (Free)", vision: true }
    ]
  },
  groq: {
    id: "groq",
    label: "Groq",
    keyLabel: "Groq API Key",
    keyPlaceholder: "gsk_...",
    requiresKey: true,
    baseUrl: "https://api.groq.com/openai/v1/chat/completions",
    modelsUrl: "https://api.groq.com/openai/v1/models",
    defaultModels: [
      { id: "meta-llama/llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout 17B (Vision)", vision: true },
      { id: "meta-llama/llama-4-maverick-17b-128e-instruct", label: "Llama 4 Maverick 17B (Vision)", vision: true },
      { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B Versatile", vision: false }
    ]
  },
  nvidia: {
    id: "nvidia",
    label: "NVIDIA NIM",
    keyLabel: "NVIDIA NIM API Key",
    keyPlaceholder: "nvapi-...",
    requiresKey: true,
    baseUrl: "https://integrate.api.nvidia.com/v1/chat/completions",
    modelsUrl: "https://integrate.api.nvidia.com/v1/models",
    defaultModels: [
      { id: "meta/llama-3.2-90b-vision-instruct", label: "Llama 3.2 90B Vision", vision: true },
      { id: "qwen/qwen2.5-coder-32b-instruct", label: "Qwen 2.5 Coder 32B", vision: false },
      { id: "deepseek-ai/deepseek-r1", label: "DeepSeek R1", vision: false }
    ]
  },
  custom: {
    id: "custom",
    label: "Custom OpenAI / Ollama",
    keyLabel: "API Key (optional for localhost)",
    keyPlaceholder: "sk-... or blank for Ollama",
    requiresKey: false,
    defaultBaseUrl: "http://localhost:11434/v1/chat/completions",
    defaultModels: [
      { id: "qwen2.5-coder:14b", label: "Ollama qwen2.5-coder:14b", vision: false },
      { id: "gpt-4o", label: "OpenAI gpt-4o (Vision)", vision: true }
    ]
  },
  "chrome-builtin": {
    id: "chrome-builtin",
    label: "Chrome Built-in AI (No Key)",
    keyLabel: "On-Device Gemini Nano (LanguageModel)",
    keyPlaceholder: "No key needed — runs locally in Chrome",
    requiresKey: false,
    defaultModels: [
      { id: "gemini-nano", label: "Chrome LanguageModel (Local)", vision: false }
    ]
  }
};

// Tracks models that returned 404 / "no longer available" during this session
export const retiredGeminiModels = new Set();

const NON_CODING_MODEL_RE =
  /(image|imagen|banana|live|tts|audio|speech|whisper|embed|veo|lyria|moderation|guard|robotics|computer-use|rerank|transcrib)/i;

export function isCodingEligibleModel(modelId = "") {
  return !NON_CODING_MODEL_RE.test(modelId);
}

export function isVisionCapable(modelId = "", provider = "") {
  if (provider === "chrome-builtin") return false;
  const known = PROVIDERS[provider]?.defaultModels?.find((m) => m.id === modelId);
  if (known) return Boolean(known.vision);
  const name = (modelId || "").toLowerCase();
  if (provider === "gemini") return isCodingEligibleModel(name) && !name.includes("gemma-2");
  return /(vision|-vl\b|vl-|flash|4v|4o|gpt-4\.1|gpt-5|o4-mini|pixtral|claude-3|claude-sonnet-4|claude-opus-4|claude-4|kimi|gemma-3|llama-4|maverick|scout|omni|llava|minicpm-v)/i.test(
    name
  );
}

export function deriveCustomModelsUrl(baseUrl = "") {
  const clean = (baseUrl || PROVIDERS.custom.defaultBaseUrl).trim();
  try {
    const u = new URL(clean);
    if (/\/chat\/completions\/?$/i.test(u.pathname)) {
      u.pathname = u.pathname.replace(/\/chat\/completions\/?$/i, "/models");
      return u.toString();
    }
    if (/\/v1\/?$/i.test(u.pathname)) {
      u.pathname = u.pathname.replace(/\/?$/, "/models");
      return u.toString();
    }
    u.pathname = "/v1/models";
    return u.toString();
  } catch {
    return "http://localhost:11434/v1/models";
  }
}

function parseGeminiVersionScore(id = "") {
  const m = id.match(/gemini-(\d+(?:\.\d+)?)/i);
  if (m) return parseFloat(m[1]);
  if (/latest/i.test(id)) return 3.9;
  return 2.0;
}

export function getGeminiFallbackChain(requestedModel, fetchedModels = [], extraSkipSet = null) {
  const skip = new Set([...retiredGeminiModels, ...(extraSkipSet ? Array.from(extraSkipSet) : [])]);
  const fetchedIds = Array.isArray(fetchedModels)
    ? fetchedModels
        .map((m) => (typeof m === "string" ? m : m?.id))
        .filter((id) => id && /^gemini/i.test(id) && isCodingEligibleModel(id) && !skip.has(id))
    : [];

  // Prefer newer capable Flash/Pro models before older or preview Flash-Lite models
  const sortedFetched = [...fetchedIds].sort((a, b) => {
    const tier = (id) => {
      if (/flash-latest/i.test(id) && !/lite/i.test(id)) return 0;
      if (/flash/i.test(id) && !/lite/i.test(id) && !/preview/i.test(id)) return 1;
      if (/flash/i.test(id) && !/lite/i.test(id)) return 2;
      if (/pro/i.test(id) && !/preview/i.test(id)) return 3;
      if (/flash-lite/i.test(id) && !/preview/i.test(id)) return 4;
      if (/flash-lite/i.test(id)) return 5;
      return 6;
    };
    const tDiff = tier(a) - tier(b);
    if (tDiff !== 0) return tDiff;
    return parseGeminiVersionScore(b) - parseGeminiVersionScore(a);
  });

  // Only pad with static defaults if fetchedModels didn't already give us plenty of live models
  const defaults =
    sortedFetched.length >= 4
      ? []
      : PROVIDERS.gemini.defaultModels.map((m) => m.id).filter((id) => !skip.has(id));

  return Array.from(
    new Set(
      [
        requestedModel && !skip.has(requestedModel) ? requestedModel : null,
        ...sortedFetched,
        ...defaults
      ].filter(Boolean)
    )
  ).slice(0, 8);
}

/**
 * Prepares Gemini conversation contents when switching mid-run to a DIFFERENT Gemini model:
 * - Removes `thought: true` internal reasoning text parts from the previous model.
 * - Replaces `thoughtSignature` on `functionCall` parts with Google's official cross-model
 *   sentinel `"skip_thought_signature_validator"` so Gemini 3+/4 models never reject
 *   with HTTP 400 "Function call is missing a thought_signature".
 */
export function cloneContentsForDifferentGeminiModel(contents = []) {
  return contents
    .map((turn) => {
      if (!Array.isArray(turn.parts)) return turn;
      const adaptedParts = [];
      for (const p of turn.parts) {
        if (!p || typeof p !== "object") continue;
        if (p.thought) continue;
        if (p.functionCall) {
          const { thoughtSignature: _oldSig, thought_signature: _oldSnake, ...rest } = p;
          adaptedParts.push({
            ...rest,
            thoughtSignature: "skip_thought_signature_validator"
          });
        } else {
          const { thoughtSignature: _oldSig, thought_signature: _oldSnake, ...rest } = p;
          adaptedParts.push(rest);
        }
      }
      return { ...turn, parts: adaptedParts };
    })
    .filter((turn) => !Array.isArray(turn.parts) || turn.parts.length > 0);
}
