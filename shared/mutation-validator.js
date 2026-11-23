// shared/mutation-validator.js — Structural DOM Mutation Schema Validator & Normalizer

export const ALLOWED_MUTATION_ACTIONS = new Set([
  "createSlot",
  "reparent",
  "wrapGroup",
  "createHeroFromElement",
  "setInert",
  "unwrapLayoutTable"
]);

export const ALLOWED_POSITIONS = new Set(["prepend", "append", "before", "after"]);
const PROTECTED_SELECTORS = new Set(["html", "body", "head", ":root", "*", "#redesigner-hud-host"]);
const SAFE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_MUTATIONS = 40;

function isProtectedSelector(sel) {
  if (typeof sel !== "string") return false;
  const normalized = sel.trim().toLowerCase();
  if (!normalized) return false;
  return normalized
    .split(",")
    .map((s) => s.trim())
    .some((part) => PROTECTED_SELECTORS.has(part));
}

function sanitizeId(raw) {
  if (!raw || typeof raw !== "string") return undefined;
  const cleaned = raw.trim().replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
  return SAFE_ID_RE.test(cleaned) ? cleaned : undefined;
}

/**
 * Validates and normalizes an array of DOM mutation operations.
 * Returns { valid, mutations, errors, warnings }.
 */
export function validateMutations(rawOps) {
  const errors = [];
  const warnings = [];
  const mutations = [];

  if (!Array.isArray(rawOps)) {
    return {
      valid: false,
      mutations: [],
      errors: ["mutations.json must be a JSON array of structural operations."],
      warnings
    };
  }

  let list = rawOps;
  if (list.length > MAX_MUTATIONS) {
    warnings.push(`Truncated mutations from ${list.length} to maximum ${MAX_MUTATIONS} operations.`);
    list = list.slice(0, MAX_MUTATIONS);
  }

  list.forEach((raw, idx) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`Mutation #${idx}: must be an object.`);
      return;
    }

    const action = typeof raw.action === "string" ? raw.action.trim() : "";
    if (!ALLOWED_MUTATION_ACTIONS.has(action)) {
      errors.push(
        `Mutation #${idx}: unsupported action "${action}". Allowed: ${Array.from(ALLOWED_MUTATION_ACTIONS).join(", ")}.`
      );
      return;
    }

    const position = raw.position && ALLOWED_POSITIONS.has(raw.position) ? raw.position : undefined;
    if (raw.position && !position) {
      warnings.push(`Mutation #${idx} (${action}): invalid position "${raw.position}", using default.`);
    }

    switch (action) {
      case "createSlot": {
        const slotRole =
          typeof raw.slotRole === "string" && raw.slotRole.trim()
            ? raw.slotRole.trim().slice(0, 48)
            : "bento-shell";
        const anchorSelector =
          typeof raw.anchorSelector === "string" && raw.anchorSelector.trim()
            ? raw.anchorSelector.trim()
            : "body";
        const op = {
          action,
          slotRole,
          anchorSelector,
          position: position || "prepend"
        };
        const safeId = sanitizeId(raw.id);
        if (safeId) op.id = safeId;
        mutations.push(op);
        break;
      }

      case "reparent": {
        const sourceSelector = (raw.sourceSelector || raw.sourceId || "").trim();
        const targetSelector = (raw.targetSelector || raw.targetId || "").trim();
        if (!sourceSelector || !targetSelector) {
          errors.push(`Mutation #${idx} (reparent): requires both sourceSelector and targetSelector.`);
          return;
        }
        if (isProtectedSelector(sourceSelector)) {
          errors.push(`Mutation #${idx} (reparent): cannot reparent protected boundary "${sourceSelector}".`);
          return;
        }
        mutations.push({
          action,
          sourceSelector,
          targetSelector,
          position: position || "append"
        });
        break;
      }

      case "wrapGroup": {
        const selectors = Array.isArray(raw.selectors)
          ? raw.selectors.map((s) => (typeof s === "string" ? s.trim() : "")).filter(Boolean)
          : [];
        if (selectors.length === 0) {
          errors.push(`Mutation #${idx} (wrapGroup): requires non-empty "selectors" array.`);
          return;
        }
        const safeSelectors = selectors.filter((sel) => {
          if (isProtectedSelector(sel)) {
            warnings.push(`Mutation #${idx} (wrapGroup): skipped protected selector "${sel}".`);
            return false;
          }
          return true;
        });
        if (safeSelectors.length === 0) {
          errors.push(`Mutation #${idx} (wrapGroup): no valid non-protected selectors remain.`);
          return;
        }
        const op = {
          action,
          selectors: safeSelectors,
          slotRole:
            typeof raw.slotRole === "string" && raw.slotRole.trim()
              ? raw.slotRole.trim().slice(0, 48)
              : "bento-shell",
          anchorSelector:
            typeof raw.anchorSelector === "string" && raw.anchorSelector.trim()
              ? raw.anchorSelector.trim()
              : "main",
          position: position || "prepend"
        };
        const safeId = sanitizeId(raw.id);
        if (safeId) op.id = safeId;
        mutations.push(op);
        break;
      }

      case "createHeroFromElement": {
        const sourceSelector = (raw.sourceSelector || "").trim();
        if (!sourceSelector) {
          errors.push(`Mutation #${idx} (createHeroFromElement): requires sourceSelector.`);
          return;
        }
        if (isProtectedSelector(sourceSelector)) {
          errors.push(`Mutation #${idx} (createHeroFromElement): cannot use protected "${sourceSelector}" as source.`);
          return;
        }
        const op = {
          action,
          sourceSelector,
          targetSelector:
            typeof raw.targetSelector === "string" && raw.targetSelector.trim()
              ? raw.targetSelector.trim()
              : "main",
          position: position || "prepend",
          id: sanitizeId(raw.id) || "rd-hero-spotlight",
          hideSource: raw.hideSource !== false
        };
        if (typeof raw.badgeText === "string" && raw.badgeText.trim()) {
          op.badgeText = raw.badgeText.trim().slice(0, 40);
        }
        if (typeof raw.ctaText === "string" && raw.ctaText.trim()) {
          op.ctaText = raw.ctaText.trim().slice(0, 40);
        }
        mutations.push(op);
        break;
      }

      case "setInert": {
        const selector = (raw.selector || "").trim();
        if (!selector) {
          errors.push(`Mutation #${idx} (setInert): requires selector.`);
          return;
        }
        if (isProtectedSelector(selector)) {
          errors.push(`Mutation #${idx} (setInert): cannot setInert on protected boundary "${selector}".`);
          return;
        }
        const op = {
          action,
          selector,
          hide: raw.hide !== false
        };
        if (typeof raw._source === "string") op._source = raw._source;
        mutations.push(op);
        break;
      }

      case "unwrapLayoutTable": {
        const selector = (raw.selector || "").trim();
        if (!selector) {
          errors.push(`Mutation #${idx} (unwrapLayoutTable): requires selector.`);
          return;
        }
        if (isProtectedSelector(selector)) {
          errors.push(`Mutation #${idx} (unwrapLayoutTable): cannot unwrap protected "${selector}".`);
          return;
        }
        mutations.push({ action, selector });
        break;
      }
    }
  });

  return {
    valid: errors.length === 0,
    mutations,
    errors,
    warnings
  };
}
