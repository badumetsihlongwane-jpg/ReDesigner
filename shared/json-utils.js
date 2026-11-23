// shared/json-utils.js — Resilient JSON Extraction & Parsing for LLM Outputs

/**
 * Strips thinking blocks and markdown code fences, extracts the outermost JSON
 * object or array, repairs common trailing-comma issues, and parses safely.
 */
export function parseLooseJson(raw, { expectArray = false } = {}) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("Empty response from AI model.");
  }

  const cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json|javascript|js)?/gi, "")
    .replace(/```/g, "")
    .trim();

  if (!cleaned) {
    throw new Error("Empty response after stripping wrappers.");
  }

  // Direct fast path
  try {
    return JSON.parse(cleaned);
  } catch {}

  const openChar = expectArray ? "[" : "{";
  const closeChar = expectArray ? "]" : "}";
  const first = cleaned.indexOf(openChar);
  const last = cleaned.lastIndexOf(closeChar);

  if (first !== -1 && last > first) {
    const candidate = cleaned.slice(first, last + 1);
    try {
      return JSON.parse(candidate);
    } catch {}

    // Repair trailing commas before } or ]
    const noTrailingCommas = candidate.replace(/,\s*([}\]])/g, "$1");
    try {
      return JSON.parse(noTrailingCommas);
    } catch {}

    // Repair unescaped raw newlines inside JSON string literals
    const escapedNewlines = escapeRawNewlinesInStrings(noTrailingCommas);
    try {
      return JSON.parse(escapedNewlines);
    } catch {}

    // Last-resort partial recovery for designer payload when truncated mid-JSON
    if (!expectArray) {
      const recovered = recoverPartialDesignPayload(candidate);
      if (recovered) return recovered;
    }
  }

  throw new Error("Could not parse valid JSON from model response.");
}

function escapeRawNewlinesInStrings(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString && ch === "\n") {
      out += "\\n";
    } else if (inString && ch === "\r") {
      out += "\\r";
    } else if (inString && ch === "\t") {
      out += "\\t";
    } else {
      out += ch;
    }
  }
  return out;
}

function recoverPartialDesignPayload(candidate) {
  const dirMatch = candidate.match(/"designDirection"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const cssMatch = candidate.match(/"cssRules"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const refMatch = candidate.match(/"refinementCSS"\s*:\s*"((?:[^"\\]|\\.)*)"/);

  if (cssMatch) {
    return {
      designDirection: dirMatch ? unescapeJsonString(dirMatch[1]) : "Structural Layout Redesign",
      cssRules: unescapeJsonString(cssMatch[1]),
      domMutations: []
    };
  }
  if (refMatch) {
    return {
      criticAssessment: "Recovered partial refinement CSS",
      refinementCSS: unescapeJsonString(refMatch[1])
    };
  }
  return null;
}

function unescapeJsonString(str) {
  try {
    return JSON.parse(`"${str}"`);
  } catch {
    return str.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
}
