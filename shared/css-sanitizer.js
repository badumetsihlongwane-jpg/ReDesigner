// shared/css-sanitizer.js — CSS Security Sanitizer, Syntax Checker & Safety Linter

const SAFE_DATA_IMAGE_RE = /^data:image\/(png|jpeg|jpg|webp|gif|avif|svg\+xml)[;,]/i;
const DANGEROUS_SVG_DATA_RE = /(<script|javascript:|on\w+\s*=)/i;
const RELATIVE_URL_RE = /^(\/(?!\/)|\.\/|\.\.\/|#)/;

/**
 * Validates and sanitizes AI- or user-authored CSS before injection into a live page.
 * Returns { valid, sanitizedCss, errors, warnings }.
 */
export function sanitizeAndValidateCSS(rawCss = "", { pageOrigin = "" } = {}) {
  const errors = [];
  const warnings = [];
  if (typeof rawCss !== "string") {
    return { valid: false, sanitizedCss: "", errors: ["CSS must be a string."], warnings };
  }

  let css = rawCss.replace(/\0/g, "");

  // 1. Check balanced comments and braces on raw CSS
  const balance = checkCssBalance(css);
  if (balance.unclosedComment) {
    errors.push("Unclosed CSS comment (/* ... */).");
    css += " */";
  }
  if (balance.braceDepth > 0) {
    errors.push(`Unclosed CSS block: missing ${balance.braceDepth} closing "}" brace(s).`);
  } else if (balance.braceDepth < 0) {
    errors.push(`Extra closing "}" brace(s) detected (${Math.abs(balance.braceDepth)} unmatched).`);
  }

  // 2. Strip @import directives (prevents external stylesheet loading / exfiltration)
  const importRe = /@import\s+(?:url\([^)]*\)|"[^"]*"|'[^']*')[^;]*;?/gi;
  if (css.search(importRe) !== -1) {
    warnings.push("Removed @import rule (external stylesheet imports are blocked for security).");
    css = css.replace(importRe, "/* blocked-import */");
  }

  // 3. Block legacy script-in-CSS vectors
  const legacyVectorRe = /\b(expression\s*\(|-moz-binding\s*:|behavior\s*:|javascript\s*:)/gi;
  if (css.search(legacyVectorRe) !== -1) {
    warnings.push("Removed unsafe legacy CSS expression/binding directive.");
    css = css.replace(legacyVectorRe, "/* blocked-vector */");
  }

  // 4. Filter url(...) references (handles quoted URLs containing parentheses!): allow relative, safe data:image, or same-origin only
  css = css.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]+))\s*\)/gi, (full, dQuoted, sQuoted, unquoted) => {
    const rawUrl = dQuoted ?? sQuoted ?? unquoted ?? "";
    const target = rawUrl.trim();
    if (!target) return full;

    if (SAFE_DATA_IMAGE_RE.test(target)) {
      let decoded = target;
      try {
        decoded = decodeURIComponent(target);
      } catch {}
      if (DANGEROUS_SVG_DATA_RE.test(decoded)) {
        warnings.push("Blocked unsafe SVG data: URL containing script/handler.");
        return "none";
      }
      return full;
    }

    if (RELATIVE_URL_RE.test(target)) {
      return full;
    }

    if (pageOrigin && /^https?:\/\//i.test(target)) {
      try {
        if (new URL(target).origin === pageOrigin) {
          return full;
        }
      } catch {}
    }

    warnings.push(`Blocked external CSS url("${target.slice(0, 60)}") for privacy/security.`);
    return "none";
  });

  // 5. Block catastrophic root hiding rules on bare html / body / *
  css = guardCatastrophicRules(css, errors, warnings);

  // 6. Lint common layout footguns (advisory warnings for AI self-correction)
  if (/(?:^|[,}\s])(?:header|nav|aside|ul|div)\s*\{[^}]*display\s*:\s*(?:flex|grid|block)\s*!important/i.test(css)) {
    warnings.push(
      'Broad selector (header/nav/aside/ul/div) uses "display: ... !important" which may accidentally unhide collapsed dropdowns or hidden mobile navbars. Scope to specific [data-rd-id="..."] or add :not([hidden]).'
    );
  }

  if (/\bz-index\s*:\s*-\d+/i.test(css) && !/isolation\s*:\s*isolate/i.test(css)) {
    warnings.push(
      'Negative z-index detected without "isolation: isolate". Images with z-index: -1 can vanish behind the page background; use z-index: 0 on images, 1 on scrim, 2 on text.'
    );
  }

  return {
    valid: errors.length === 0,
    sanitizedCss: css,
    errors,
    warnings
  };
}

function checkCssBalance(css) {
  let inComment = false;
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let braceDepth = 0;

  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    const next = css[i + 1];

    if (inComment) {
      if (ch === "*" && next === "/") {
        inComment = false;
        i++;
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if ((inSingle || inDouble) && ch === "\\") {
      escaped = true;
      continue;
    }
    if (!inDouble && ch === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble) {
      if (ch === "/" && next === "*") {
        inComment = true;
        i++;
        continue;
      }
      if (ch === "{") braceDepth++;
      else if (ch === "}") braceDepth--;
    }
  }

  return { unclosedComment: inComment, braceDepth };
}

function guardCatastrophicRules(css, errors, warnings) {
  // Match simple rule blocks (not @-rules) and check if bare html, body, or * hides the page
  return css.replace(/([^{}@/][^{}@]*?)\{([^{}]*)\}/g, (match, rawSelectors, body) => {
    const selectors = rawSelectors
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    const targetsRootBare = selectors.some(
      (sel) => sel === "html" || sel === "body" || sel === "*" || sel === ":root"
    );
    if (!targetsRootBare) return match;

    let nextBody = body;
    let stripped = false;
    const dangerDeclRe =
      /\b(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0+)?(?=\s*(?:!important)?\s*(?:;|}|$)))\s*(?:!important)?\s*;?/gi;
    if (nextBody.search(dangerDeclRe) !== -1) {
      stripped = true;
      nextBody = nextBody.replace(dangerDeclRe, "/* blocked root-hiding declaration */");
    }

    if (stripped) {
      const msg = `Blocked catastrophic page-hiding rule on "${selectors.join(", ")}".`;
      errors.push(msg);
      warnings.push(msg);
      return `${rawSelectors}{${nextBody}}`;
    }
    return match;
  });
}
