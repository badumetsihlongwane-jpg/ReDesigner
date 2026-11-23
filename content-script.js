// content-script.js — Deep Semantic/Spatial Explorer, Safe Structural Engine, True-Color Healer & 10-Point QA Auditor

(() => {
  if (window.__redesigner_v3_loaded) return;
  window.__redesigner_v3_loaded = true;

  const undoOps = [];
  const usedRdIds = new Set();
  const originallyHiddenElements = new Set();
  let baselineMetrics = null;
  let lastAppliedMutations = [];
  let currentDesignDirection = "";
  let currentDesignId = null;
  let currentProfileId = "obsidian";
  let lastAuditScore = null;
  let isPreviewDisabled = false;
  let isEnforcedOnSite = false;
  let hudHost = null;
  let hudDismissedByUser = false;
  let savedScrollPos = null;
  let spaObserver = null;
  let spaDebounceTimer = null;
  let pendingAddedNodes = new Set();
  let isInternalDomChange = false;
  let lastObservedHref = location.href;
  let monotonicSeq = 0;

  // Color parser cache + 1x1 offscreen canvas fallback for oklch/oklab/color-mix/hsl/named colors
  const colorCache = new Map();
  let colorCtx = null;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      switch (message.action) {
        case "PING":
          sendResponse({ status: "PONG" });
          return true;

        case "EXTRACT_SEMANTICS":
          snapshotPageBaselineIfNeeded();
          sendResponse({ status: "SUCCESS", data: analyzeAndStampPage(true) });
          return true;

        case "READ_DOM_TREE":
          sendResponse({
            status: "SUCCESS",
            data: readDomTree(message.selector || "body", message.maxDepth || 4, message.maxChars || 5500)
          });
          return true;

        case "FIND_ELEMENTS":
          sendResponse({ status: "SUCCESS", data: findElementsTool(message) });
          return true;

        case "INSPECT_STYLES":
          sendResponse({ status: "SUCCESS", data: inspectStylesTool(message.selector) });
          return true;

        case "AUDIT_RENDERED_PAGE":
        case "VALIDATE_AFFORDANCES": {
          const report = auditRenderedPage();
          lastAuditScore = report.score;
          updateHudState();
          sendResponse({ data: report });
          return true;
        }

        case "APPLY_DOM_AND_HEAL": {
          const patch = message.patch || {};
          if (patch.designDirection) currentDesignDirection = patch.designDirection;
          if (patch.designId) currentDesignId = patch.designId;
          if (patch.profileId) currentProfileId = patch.profileId;
          if (typeof patch.isEnforcedOnSite === "boolean") isEnforcedOnSite = patch.isEnforcedOnSite;

          isPreviewDisabled = false;
          hudDismissedByUser = false;

          let mutationReport = { total: 0, applied: 0, skipped: 0, details: [] };
          let healStats = { healedSurfaces: 0, healedTexts: 0 };

          withInternalMutationGuard(() => {
            snapshotPageBaselineIfNeeded();
            undoStructuralOps();
            analyzeAndStampPage(false);
            if (Array.isArray(patch.domMutations) && patch.domMutations.length > 0) {
              lastAppliedMutations = patch.domMutations;
              mutationReport = executeStructuralOps(patch.domMutations);
            } else {
              lastAppliedMutations = [];
            }
            healStats = autoHealPageContrast(document);
          });

          startSpaObserver();
          mountOrUpdateFloatingHud();
          sendResponse({ status: "APPLIED", healStats, mutationReport });
          return true;
        }

        case "TEMPORARY_RESTORE_FOR_COMPARE": {
          isPreviewDisabled = Boolean(message.disabled);
          withInternalMutationGuard(() => {
            if (isPreviewDisabled) {
              stopSpaObserver();
              undoStructuralOps();
              clearHealMarkers();
            } else {
              analyzeAndStampPage(false);
              const ops = Array.isArray(message.domMutations) ? message.domMutations : lastAppliedMutations;
              if (ops.length > 0) executeStructuralOps(ops);
              autoHealPageContrast(document);
              startSpaObserver();
            }
          });
          updateHudState();
          sendResponse({ status: "TOGGLED", isPreviewDisabled });
          return true;
        }

        case "UPDATE_HUD_STATE": {
          if (typeof message.isEnforcedOnSite === "boolean") isEnforcedOnSite = message.isEnforcedOnSite;
          if (message.profileId) currentProfileId = message.profileId;
          if (message.designDirection) currentDesignDirection = message.designDirection;
          if (typeof message.auditScore === "number") lastAuditScore = message.auditScore;
          updateHudState();
          sendResponse({ status: "UPDATED" });
          return true;
        }

        case "PREPARE_SCREENSHOT": {
          if (hudHost) hudHost.style.display = "none";
          let scrolledTo = null;
          if (message.selector) {
            const target = resolveElement(message.selector);
            if (target) {
              savedScrollPos = { x: window.scrollX, y: window.scrollY };
              try {
                target.scrollIntoView({ behavior: "instant", block: "center" });
                scrolledTo = message.selector;
              } catch {}
            }
          }
          sendResponse({ status: "READY", scrolledTo });
          return true;
        }

        case "RESTORE_HUD": {
          if (savedScrollPos) {
            try {
              window.scrollTo({ left: savedScrollPos.x, top: savedScrollPos.y, behavior: "instant" });
            } catch {}
            savedScrollPos = null;
          }
          if (hudHost && !hudDismissedByUser) hudHost.style.display = "block";
          sendResponse({ status: "RESTORED" });
          return true;
        }

        case "REVERT_DOM_AND_HUD":
          revertDomAndHud();
          sendResponse({ status: "REVERTED" });
          return true;

        default:
          return false;
      }
    } catch (err) {
      sendResponse({ status: "ERROR", error: err?.message || String(err) });
      return true;
    }
  });

  function withInternalMutationGuard(fn) {
    isInternalDomChange = true;
    try {
      return fn();
    } finally {
      isInternalDomChange = false;
    }
  }

  function allocateRdId(el, prefix) {
    if (el.dataset.rdId) {
      usedRdIds.add(el.dataset.rdId);
      return el.dataset.rdId;
    }
    let candidate;
    do {
      candidate = `${prefix}-${++monotonicSeq}`;
    } while (usedRdIds.has(candidate));
    usedRdIds.add(candidate);
    el.dataset.rdId = candidate;
    return candidate;
  }

  function isProtectedBoundary(el) {
    return (
      !el ||
      el === document.documentElement ||
      el === document.body ||
      el === document.head ||
      el.id === "redesigner-hud-host"
    );
  }

  function resolveElement(ref) {
    if (!ref || typeof ref !== "string") return null;
    const trimmed = ref.trim();
    if (!trimmed) return null;
    try {
      // Exact data-rd-id lookup if ref looks like a bare ID
      if (/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
        const byRd = document.querySelector(`[data-rd-id="${CSS.escape(trimmed)}"]`);
        if (byRd) return byRd;
      }
      const direct = document.querySelector(trimmed);
      if (direct) return direct;
      if (trimmed.startsWith("#") && /^#[a-zA-Z0-9_-]+$/.test(trimmed)) {
        return document.querySelector(`[data-rd-id="${CSS.escape(trimmed.slice(1))}"]`);
      }
      return null;
    } catch {
      return null;
    }
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element) || el.id === "redesigner-hud-host") return false;
    if (el.closest("#redesigner-hud-host")) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity || "1") <= 0.05) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 4 && rect.height > 4;
  }

  function isSafeUrl(url, allowDataImage = false) {
    if (!url || typeof url !== "string") return false;
    const trimmed = url.trim();
    if (!trimmed || trimmed.startsWith("//")) return false;
    if (allowDataImage && /^data:image\/(png|jpeg|jpg|webp|gif|avif);/i.test(trimmed)) return true;
    return /^(https?:\/\/|\/(?!\/)|\.\/|\.\.\/|#)/i.test(trimmed);
  }

  function isElementInsideIntentionallyHiddenContainer(el) {
    let curr = el;
    while (curr && curr instanceof Element) {
      if (curr.inert || curr.hidden || curr.dataset.rdRole === "sidebar") {
        const comp = window.getComputedStyle(curr);
        if (curr.inert || curr.hidden || comp.display === "none") return true;
      }
      curr = curr.parentElement;
    }
    return false;
  }

  /**
   * Snapshots originally hidden elements (strictly for QA audit diagnostics —
   * NEVER locked with display:none!important so interactive dropdowns/modals stay functional!)
   * and captures pre-redesign content metrics to detect accidental content loss.
   */
  function snapshotPageBaselineIfNeeded() {
    if (!document.body || baselineMetrics) return;

    originallyHiddenElements.clear();
    document.querySelectorAll("header, nav, aside, ul, div, section, dialog").forEach((el) => {
      if (el.id === "redesigner-hud-host") return;
      const comp = window.getComputedStyle(el);
      if (comp.display === "none" || el.hidden) {
        originallyHiddenElements.add(el);
      }
    });

    baselineMetrics = measurePageContentMetrics();
  }

  function measurePageContentMetrics() {
    if (!document.body) {
      return { wordCount: 0, imageCount: 0, linkCount: 0, controlCount: 0 };
    }
    const rawText = (document.body.innerText || "").trim();
    const wordCount = rawText ? rawText.split(/\s+/).filter(Boolean).length : 0;

    let imageCount = 0;
    document.querySelectorAll("img").forEach((img) => {
      if (img.closest("#redesigner-hud-host, [inert], [hidden]")) return;
      const r = img.getBoundingClientRect();
      const c = window.getComputedStyle(img);
      if (c.display !== "none" && c.visibility !== "hidden" && r.width >= 32 && r.height >= 32) {
        imageCount++;
      }
    });

    let linkCount = 0;
    document.querySelectorAll("a[href]").forEach((a) => {
      if (isVisible(a) && !a.closest("[inert]")) linkCount++;
    });

    let controlCount = 0;
    document.querySelectorAll("button, input:not([type='hidden']), select, textarea, [role='button']").forEach((el) => {
      if (isVisible(el) && !el.closest("[inert]")) controlCount++;
    });

    return { wordCount, imageCount, linkCount, controlCount };
  }

  function detectFrameworks() {
    const frameworks = [];
    if (
      document.getElementById("__next") ||
      document.getElementById("__NEXT_DATA__") ||
      document.querySelector('script[src*="/_next/"]')
    ) {
      frameworks.push("Next.js");
    }
    if (
      document.querySelector("[data-reactroot], [data-reactid]") ||
      document.getElementById("root")?._reactRootContainer ||
      frameworks.includes("Next.js")
    ) {
      if (!frameworks.includes("React")) frameworks.push("React");
    }
    if (document.getElementById("__nuxt")) frameworks.push("Nuxt");
    if (
      document.querySelector("[data-v-app]") ||
      Array.from(document.querySelectorAll("body *"))
        .slice(0, 60)
        .some((el) => Array.from(el.attributes).some((a) => a.name.startsWith("data-v-")))
    ) {
      frameworks.push("Vue");
    }
    if (document.querySelector("[ng-version], app-root")) frameworks.push("Angular");
    if (document.querySelector('[class*="svelte-"], #svelte')) frameworks.push("Svelte");
    if (document.querySelector("astro-island")) frameworks.push("Astro");
    if (document.getElementById("___gatsby")) frameworks.push("Gatsby");

    return {
      isSpaFramework: frameworks.length > 0,
      frameworks
    };
  }

  function extractSiteCssVariables(limit = 24) {
    const vars = {};
    const rootStyle = window.getComputedStyle(document.documentElement);
    const interestingRe =
      /(bg|background|surface|canvas|color|text|fg|ink|accent|primary|secondary|border|divider|muted|font|radius|shadow|link)/i;

    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules || [])) {
          if (!rule.selectorText || !rule.style) continue;
          const sel = rule.selectorText.trim();
          if (!/^(:root|html|body)(\[[^\]]+\]|\.[a-zA-Z0-9_-]+)?$/.test(sel)) continue;
          for (let i = 0; i < rule.style.length; i++) {
            const prop = rule.style[i];
            if (!prop.startsWith("--") || prop.startsWith("--rd-")) continue;
            if (!interestingRe.test(prop)) continue;
            if (prop in vars) continue;
            const resolved = rootStyle.getPropertyValue(prop).trim();
            if (resolved && resolved.length <= 80) {
              vars[prop] = resolved;
              if (Object.keys(vars).length >= limit) return vars;
            }
          }
        }
      } catch {}
    }
    return vars;
  }

  function buildSpatialMap() {
    const map = [];
    const roles = ["navbar", "hero", "hero-spotlight", "sidebar", "main-content", "card-grid", "link-list", "footer"];
    for (const role of roles) {
      document.querySelectorAll(`[data-rd-role="${role}"]`).forEach((el) => {
        if (!isVisible(el) || map.length >= 16) return;
        const r = el.getBoundingClientRect();
        map.push({
          role,
          selector: el.dataset.rdId ? `[data-rd-id="${el.dataset.rdId}"]` : buildQuickSelector(el),
          x: Math.round(r.left + window.scrollX),
          y: Math.round(r.top + window.scrollY),
          w: Math.round(r.width),
          h: Math.round(r.height)
        });
      });
    }
    return map;
  }

  function readDomTree(rootSelector = "body", maxDepth = 4, maxChars = 5500) {
    const root = resolveElement(rootSelector) || document.body;
    if (!root) return { error: "Root element not found" };

    const lines = [];
    let totalLen = 0;

    function walk(el, depth) {
      if (totalLen >= maxChars || depth > maxDepth || !el || el.id === "redesigner-hud-host") return;
      const tag = el.tagName.toLowerCase();
      if (["script", "style", "noscript", "svg", "path", "link", "meta"].includes(tag)) return;

      const comp = window.getComputedStyle(el);
      const hiddenFlag = comp.display === "none" || el.hidden || originallyHiddenElements.has(el);

      const attrs = [];
      if (el.id) attrs.push(`id="${el.id}"`);
      if (typeof el.className === "string" && el.className.trim()) {
        attrs.push(`class="${el.className.trim().split(/\s+/).slice(0, 4).join(" ")}"`);
      }
      if (el.dataset.rdId) attrs.push(`data-rd-id="${el.dataset.rdId}"`);
      if (el.dataset.rdRole) attrs.push(`data-rd-role="${el.dataset.rdRole}"`);
      if (el.dataset.rdGridKind) attrs.push(`data-rd-grid-kind="${el.dataset.rdGridKind}"`);
      if (el.getAttribute("style")) attrs.push(`style="${el.getAttribute("style").slice(0, 60)}"`);
      if (tag === "img" && el.getAttribute("src")) attrs.push(`src="${el.getAttribute("src").slice(0, 50)}"`);
      if (tag === "a" && el.getAttribute("href")) attrs.push(`href="${el.getAttribute("href").slice(0, 40)}"`);
      if (hiddenFlag) attrs.push("[HIDDEN]");

      const directText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent.trim())
        .filter(Boolean)
        .join(" ")
        .slice(0, 45);

      const indent = "  ".repeat(depth);
      const attrStr = attrs.length ? " " + attrs.join(" ") : "";
      const textStr = directText ? ` "${directText}"` : "";
      const line = `${indent}<${tag}${attrStr}>${textStr}`;
      lines.push(line);
      totalLen += line.length + 1;

      if (hiddenFlag && depth > 0) return;
      for (const child of Array.from(el.children)) {
        if (totalLen >= maxChars) break;
        walk(child, depth + 1);
      }
    }

    walk(root, 0);
    return { rootSelector, truncated: totalLen >= maxChars, tree: lines.join("\n") };
  }

  function findElementsTool({ text, tag, selector, limit = 10 } = {}) {
    let candidates = [];
    try {
      const baseQuery =
        selector ||
        (tag
          ? tag
          : "header, nav, form, input, section, aside, main, ul, div, table, marquee, h1, h2, h3, a, button");
      candidates = Array.from(document.querySelectorAll(baseQuery));
    } catch {
      return { error: "Invalid selector" };
    }

    const needle = (text || "").trim().toLowerCase();
    const matches = [];

    for (const el of candidates) {
      if (el.id === "redesigner-hud-host" || el.closest("#redesigner-hud-host")) continue;
      if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) continue;
      const elText = (el.innerText || el.value || el.placeholder || "").trim().replace(/\s+/g, " ");
      if (needle && !elText.toLowerCase().includes(needle)) continue;

      const comp = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const rdSelector = el.dataset.rdId
        ? `[data-rd-id="${el.dataset.rdId}"]`
        : el.id
        ? `#${CSS.escape(el.id)}`
        : buildQuickSelector(el);

      matches.push({
        selector: rdSelector,
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        classes: typeof el.className === "string" ? el.className.trim().slice(0, 80) : "",
        rdRole: el.dataset.rdRole || null,
        visible: comp.display !== "none" && rect.width > 0 && rect.height > 0,
        originallyHidden: originallyHiddenElements.has(el),
        bounds: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        text: elText.slice(0, 80)
      });
      if (matches.length >= limit) break;
    }

    return { count: matches.length, matches };
  }

  function buildQuickSelector(el) {
    if (!el || !(el instanceof Element)) return "";
    if (el === document.documentElement) return "html";
    if (el === document.body) return "body";
    if (el.dataset?.rdId) return `[data-rd-id="${el.dataset.rdId}"]`;
    if (el.id) return `#${CSS.escape(el.id)}`;
    const tag = el.tagName.toLowerCase();
    const cls =
      typeof el.className === "string" && el.className.trim()
        ? "." +
          el.className
            .trim()
            .split(/\s+/)
            .slice(0, 2)
            .map((c) => CSS.escape(c))
            .join(".")
        : "";
    return `${tag}${cls}`;
  }

  function inspectStylesTool(selector) {
    const el = resolveElement(selector);
    if (!el) return { error: `Element "${selector}" not found` };

    const comp = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();

    const ancestorBackgrounds = [];
    let curr = el;
    while (curr && curr instanceof Element) {
      const c = window.getComputedStyle(curr);
      const rgba = parseColor(c.backgroundColor);
      if ((rgba && rgba.a > 0.05) || (c.backgroundImage && c.backgroundImage !== "none")) {
        ancestorBackgrounds.push({
          selector: buildQuickSelector(curr),
          backgroundColor: c.backgroundColor,
          backgroundImage: c.backgroundImage !== "none" ? c.backgroundImage.slice(0, 80) : "none"
        });
      }
      curr = curr.parentElement;
    }

    const matchedRules = [];
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules || [])) {
          if (rule.selectorText && el.matches(rule.selectorText)) {
            matchedRules.push(`${rule.selectorText} { ${rule.style.cssText.slice(0, 140)} }`);
            if (matchedRules.length >= 10) break;
          }
        }
      } catch {}
      if (matchedRules.length >= 10) break;
    }

    const effectiveBg = getEffectiveBackgroundColor(el);
    const contrastRatio = Number(computeContrastRatio(comp.color, effectiveBg).toFixed(2));

    return {
      selector,
      tag: el.tagName.toLowerCase(),
      inlineStyle: el.getAttribute("style") || "",
      bounds: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      effectiveBackground: effectiveBg,
      contrastRatio,
      computed: {
        display: comp.display,
        position: comp.position,
        zIndex: comp.zIndex,
        opacity: comp.opacity,
        backgroundColor: comp.backgroundColor,
        backgroundImage: comp.backgroundImage !== "none" ? comp.backgroundImage.slice(0, 90) : "none",
        color: comp.color,
        border: comp.border,
        borderRadius: comp.borderRadius,
        padding: comp.padding,
        margin: comp.margin,
        width: comp.width,
        maxWidth: comp.maxWidth,
        fontSize: comp.fontSize,
        gridTemplateColumns: comp.gridTemplateColumns
      },
      ancestorBackgrounds,
      matchedSiteCssRules: matchedRules
    };
  }

  /**
   * Executes structural DOM mutations safely with comment-anchor undo restoration
   * and returns an observable report of every applied/skipped operation.
   */
  function executeStructuralOps(ops = []) {
    const report = { total: ops.length, applied: 0, skipped: 0, details: [] };

    ops.forEach((op, index) => {
      if (!op || !op.action) {
        report.skipped++;
        report.details.push({ index, action: "unknown", status: "skipped", reason: "Missing action" });
        return;
      }

      try {
        if (op.action === "createSlot") {
          const anchorSel = op.anchorSelector || "body";
          const anchor = resolveElement(anchorSel) || document.body;
          if (!anchor) {
            report.skipped++;
            report.details.push({ index, action: op.action, status: "skipped", reason: `Anchor "${anchorSel}" not found` });
            return;
          }
          const slot = document.createElement("div");
          slot.dataset.rdGenerated = "true";
          slot.dataset.rdRole = op.slotRole || "bento-shell";
          if (op.id) {
            slot.dataset.rdId = op.id;
            if (!document.getElementById(op.id)) slot.id = op.id;
            usedRdIds.add(op.id);
          }

          insertAtPosition(anchor, slot, op.position || "prepend");
          undoOps.push(() => {
            rescueNonGeneratedChildren(slot, anchor);
            slot.remove();
          });
          report.applied++;
          report.details.push({ index, action: op.action, status: "applied", id: op.id || null, anchorSelector: anchorSel });
        } else if (op.action === "reparent") {
          const srcSel = op.sourceSelector || op.sourceId;
          const targetSel = op.targetSelector || op.targetId;
          const src = resolveElement(srcSel);
          const target = resolveElement(targetSel);

          if (!src) {
            report.skipped++;
            report.details.push({ index, action: op.action, status: "skipped", reason: `Source "${srcSel}" not found` });
            return;
          }
          if (!target) {
            report.skipped++;
            report.details.push({ index, action: op.action, status: "skipped", reason: `Target "${targetSel}" not found` });
            return;
          }
          if (isProtectedBoundary(src) || src === target || src.contains(target)) {
            report.skipped++;
            report.details.push({ index, action: op.action, status: "skipped", reason: "Protected boundary or circular hierarchy" });
            return;
          }

          const prevParent = src.parentNode;
          const anchorComment = document.createComment("rd-anchor");
          if (prevParent) prevParent.insertBefore(anchorComment, src);

          insertAtPosition(target, src, op.position || "append");
          undoOps.push(() => {
            restoreToAnchor(src, anchorComment, prevParent);
          });
          report.applied++;
          report.details.push({ index, action: op.action, status: "applied", sourceSelector: srcSel, targetSelector: targetSel });
        } else if (op.action === "wrapGroup" && Array.isArray(op.selectors)) {
          const anchorSel = op.anchorSelector || "main";
          const anchor = resolveElement(anchorSel) || document.body;
          if (!anchor) {
            report.skipped++;
            report.details.push({ index, action: op.action, status: "skipped", reason: `Anchor "${anchorSel}" not found` });
            return;
          }

          const resolvedTargets = [];
          const seenTargets = new Set();
          for (const sel of op.selectors) {
            const el = resolveElement(sel);
            if (!el || isProtectedBoundary(el) || seenTargets.has(el)) continue;
            seenTargets.add(el);
            resolvedTargets.push(el);
          }

          if (resolvedTargets.length === 0) {
            report.skipped++;
            report.details.push({ index, action: op.action, status: "skipped", reason: "None of the selectors matched valid elements" });
            return;
          }

          const slot = document.createElement("div");
          slot.dataset.rdGenerated = "true";
          slot.dataset.rdRole = op.slotRole || "bento-shell";
          if (op.id) {
            slot.dataset.rdId = op.id;
            if (!document.getElementById(op.id)) slot.id = op.id;
            usedRdIds.add(op.id);
          }
          insertAtPosition(anchor, slot, op.position || "prepend");

          const restored = [];
          for (const el of resolvedTargets) {
            if (el.contains(slot)) continue;
            const prevParent = el.parentNode;
            const anchorComment = document.createComment("rd-anchor");
            if (prevParent) prevParent.insertBefore(anchorComment, el);
            restored.push({ el, anchorComment, prevParent });
            slot.appendChild(el);
          }

          if (restored.length === 0) {
            slot.remove();
            report.skipped++;
            report.details.push({ index, action: op.action, status: "skipped", reason: "All targets were ancestors of the slot" });
            return;
          }

          undoOps.push(() => {
            for (const r of restored.reverse()) {
              restoreToAnchor(r.el, r.anchorComment, r.prevParent);
            }
            rescueNonGeneratedChildren(slot, anchor);
            slot.remove();
          });
          report.applied++;
          report.details.push({ index, action: op.action, status: "applied", wrappedCount: restored.length, id: op.id || null });
        } else if (op.action === "createHeroFromElement") {
          const src = resolveElement(op.sourceSelector);
          const target = resolveElement(op.targetSelector || "main") || document.body;
          if (!src || !target || isProtectedBoundary(src)) {
            report.skipped++;
            report.details.push({
              index,
              action: op.action,
              status: "skipped",
              reason: !src ? `Source "${op.sourceSelector}" not found` : "Target missing or source protected"
            });
            return;
          }

          const imgEl = src.querySelector("img");
          const linkEl = src.querySelector("a[href]") || (src.tagName === "A" ? src : null);
          const titleNode = src.querySelector("h1, h2, h3, h4, [data-rd-slot='title']") || linkEl;
          const descNode = src.querySelector("p, [data-rd-slot='description']");

          const hero = document.createElement("section");
          hero.dataset.rdGenerated = "true";
          hero.dataset.rdRole = "hero-spotlight";
          const heroId = op.id || "rd-hero-spotlight";
          hero.dataset.rdId = heroId;
          if (!document.getElementById(heroId)) hero.id = heroId;
          usedRdIds.add(heroId);

          const imgSrc = imgEl?.currentSrc || imgEl?.getAttribute("src") || "";
          if (isSafeUrl(imgSrc, true)) {
            const bgImg = document.createElement("img");
            bgImg.src = imgSrc;
            bgImg.alt = imgEl?.alt || "";
            bgImg.dataset.rdSlot = "hero-backdrop";
            hero.appendChild(bgImg);
          }

          const content = document.createElement("div");
          content.dataset.rdSlot = "hero-content";

          if (op.badgeText) {
            const badge = document.createElement("span");
            badge.dataset.rdSlot = "hero-badge";
            badge.textContent = String(op.badgeText);
            content.appendChild(badge);
          }

          const heading = document.createElement("h2");
          heading.dataset.rdSlot = "hero-title";
          heading.textContent = (titleNode?.innerText || src.innerText || "Featured").trim().slice(0, 90);
          content.appendChild(heading);

          if (descNode?.innerText?.trim()) {
            const p = document.createElement("p");
            p.dataset.rdSlot = "hero-desc";
            p.textContent = descNode.innerText.trim().slice(0, 180);
            content.appendChild(p);
          }

          const href = linkEl?.getAttribute("href") || "";
          if (isSafeUrl(href, false)) {
            const cta = document.createElement("a");
            cta.href = href;
            cta.dataset.rdSlot = "hero-cta";
            cta.dataset.rdAffordance = "action-cta";
            cta.textContent = op.ctaText ? String(op.ctaText) : "Open Featured";
            content.appendChild(cta);
          }

          hero.appendChild(content);
          insertAtPosition(target, hero, op.position || "prepend");

          const hideSource = op.hideSource !== false;
          const prevInert = src.inert;
          const prevHidden = src.hidden;
          if (hideSource) {
            src.inert = true;
            src.hidden = true;
          }

          undoOps.push(() => {
            if (hideSource) {
              src.inert = prevInert;
              src.hidden = prevHidden;
            }
            hero.remove();
          });
          report.applied++;
          report.details.push({ index, action: op.action, status: "applied", id: heroId, hasImage: Boolean(imgSrc) });
        } else if (op.action === "setInert") {
          const targets = resolveAllSafe(op.selector);
          let matched = 0;
          for (const target of targets) {
            if (isProtectedBoundary(target)) continue;
            const prevInert = target.inert;
            const prevHidden = target.hidden;
            target.inert = true;
            if (op.hide !== false) target.hidden = true;
            undoOps.push(() => {
              target.inert = prevInert;
              target.hidden = prevHidden;
            });
            matched++;
          }
          if (matched > 0) {
            report.applied++;
            report.details.push({ index, action: op.action, status: "applied", selector: op.selector, matchedCount: matched });
          } else {
            report.skipped++;
            report.details.push({ index, action: op.action, status: "skipped", reason: `Selector "${op.selector}" matched 0 elements` });
          }
        } else if (op.action === "unwrapLayoutTable") {
          const tables = resolveAllSafe(op.selector).filter((el) => el.tagName === "TABLE");
          if (tables.length === 0) {
            report.skipped++;
            report.details.push({ index, action: op.action, status: "skipped", reason: `No <table> matched "${op.selector}"` });
            return;
          }
          for (const tbl of tables) {
            tbl.dataset.rdLayoutTable = "true";
            undoOps.push(() => {
              delete tbl.dataset.rdLayoutTable;
            });
          }
          report.applied++;
          report.details.push({ index, action: op.action, status: "applied", selector: op.selector, matchedCount: tables.length });
        } else {
          report.skipped++;
          report.details.push({ index, action: op.action, status: "skipped", reason: `Unknown action "${op.action}"` });
        }
      } catch (err) {
        report.skipped++;
        report.details.push({ index, action: op.action, status: "skipped", reason: err?.message || "Execution error" });
      }
    });

    return report;
  }

  function resolveAllSafe(selector) {
    if (!selector || typeof selector !== "string") return [];
    try {
      if (/^[a-zA-Z0-9_-]+$/.test(selector.trim())) {
        const byRd = document.querySelector(`[data-rd-id="${CSS.escape(selector.trim())}"]`);
        return byRd ? [byRd] : [];
      }
      return Array.from(document.querySelectorAll(selector));
    } catch {
      return [];
    }
  }

  function restoreToAnchor(el, anchorComment, prevParent) {
    try {
      if (anchorComment && anchorComment.parentNode) {
        anchorComment.parentNode.insertBefore(el, anchorComment);
        anchorComment.remove();
        return;
      }
      if (prevParent && prevParent.isConnected) {
        prevParent.appendChild(el);
      }
    } catch {
      try {
        if (prevParent && prevParent.isConnected) prevParent.appendChild(el);
      } catch {}
    } finally {
      try {
        anchorComment?.remove();
      } catch {}
    }
  }

  function rescueNonGeneratedChildren(slot, fallbackParent) {
    const dest = fallbackParent && fallbackParent.isConnected ? fallbackParent : document.body;
    if (!dest) return;
    Array.from(slot.children).forEach((child) => {
      if (!child.dataset?.rdGenerated) {
        try {
          dest.appendChild(child);
        } catch {}
      }
    });
  }

  function insertAtPosition(anchor, node, position) {
    if (position === "prepend") anchor.insertBefore(node, anchor.firstChild);
    else if (position === "before" && anchor.parentNode) anchor.parentNode.insertBefore(node, anchor);
    else if (position === "after" && anchor.parentNode) anchor.parentNode.insertBefore(node, anchor.nextSibling);
    else anchor.appendChild(node);
  }

  function undoStructuralOps() {
    while (undoOps.length > 0) {
      const fn = undoOps.pop();
      try {
        fn();
      } catch {}
    }
  }

  function isLikelyCardOrListGrid(parent, visibleChildren) {
    if (visibleChildren.length < 3) return null;
    if (
      parent === document.body ||
      parent.tagName === "MAIN" ||
      parent.getAttribute("role") === "main" ||
      /^(app|root|__next|__nuxt)$/i.test(parent.id || "")
    ) {
      return null;
    }
    if (parent.closest("[data-rd-role='card-item'], [data-rd-role='list-item']")) {
      return null;
    }

    // Reject page-shell wrappers whose direct children are top-level page landmarks
    const hasLandmarkChild = visibleChildren.some((c) => {
      const t = c.tagName;
      return t === "HEADER" || t === "MAIN" || t === "FOOTER" || t === "NAV" || t === "ASIDE";
    });
    if (hasLandmarkChild) return null;

    const sample = visibleChildren.slice(0, 6);
    const first = sample[0].getBoundingClientRect();
    if (first.width < 60 || first.height < 16) return null;

    // Reject full-width huge layout bands (e.g., 3-5 full-page marketing sections)
    if (first.width > window.innerWidth * 0.85 && first.height > 320 && visibleChildren.length < 6) {
      return null;
    }

    // Require tag homogeneity (>= 70% same tag as first child)
    const firstTag = sample[0].tagName;
    const sameTagCount = sample.filter((c) => c.tagName === firstTag).length;
    if (sameTagCount / sample.length < 0.7) return null;

    // Relative dimension consistency
    const widthTol = Math.max(70, first.width * 0.35);
    const heightTol = Math.max(130, first.height * 0.85);
    const homogeneous = sample.slice(1).every((c) => {
      const r = c.getBoundingClientRect();
      return Math.abs(r.width - first.width) < widthTol && Math.abs(r.height - first.height) < heightTol;
    });
    if (!homogeneous) return null;

    // Require genuine media presence across at least half of sampled children (not 1 tiny icon)
    const mediaChildren = sample.filter((c) => {
      const media = c.querySelector("img, picture, video");
      if (!media) return false;
      const r = media.getBoundingClientRect();
      return (r.width >= 40 && r.height >= 40) || (media.tagName === "IMG" && media.naturalWidth >= 48);
    }).length;
    const hasMedia = mediaChildren >= Math.ceil(sample.length / 2);

    const isList = !hasMedia && first.height < 64 && parent.matches("ul, ol, div, tbody");
    return { hasMedia, isList };
  }

  function analyzeAndStampPage(includePreload = false, scopeRoot = document) {
    const components = [];
    const affordances = [];
    const seen = new Set();

    const landmarks = [
      { role: "navbar", selector: "header, [role='banner'], body > nav:first-of-type, .navbar, #header, #topban, .global-header" },
      { role: "sidebar", selector: "aside, [role='complementary'], .sidebar, #sidebar, .side-nav, #leftbar, #rightbar" },
      { role: "hero", selector: ".hero, .jumbotron, .banner, main > section:first-of-type" },
      { role: "main-content", selector: "main, [role='main'], article, #content, .content, #main, #center" },
      { role: "section", selector: "main section, article section, .section, .col, .widget, .panel, .box" },
      { role: "footer", selector: "footer, [role='contentinfo'], .footer, #footer" }
    ];

    landmarks.forEach(({ role, selector }) => {
      scopeRoot.querySelectorAll(selector).forEach((el) => {
        if (!isVisible(el) || seen.has(el) || el.dataset.rdGenerated) return;
        if (role === "navbar" && el.closest("aside, footer, [data-rd-role='sidebar'], [data-rd-role='footer']")) return;
        seen.add(el);
        const id = allocateRdId(el, `rd-${role}`);
        el.dataset.rdRole = el.dataset.rdRole || role;

        if (components.length < 16) {
          const rect = el.getBoundingClientRect();
          const comp = window.getComputedStyle(el);
          components.push({
            id,
            role: el.dataset.rdRole,
            tag: el.tagName.toLowerCase(),
            selector: `[data-rd-id="${id}"]`,
            display: comp.display,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            childCount: el.children.length,
            snippet: (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 50)
          });
        }
      });
    });

    scopeRoot.querySelectorAll("header ul, nav ul, [data-rd-role='navbar'] ul, [role='navigation'] ul").forEach((navUl) => {
      if (!isVisible(navUl) || navUl.closest("[data-rd-role='sidebar'], [data-rd-role='footer']")) return;
      allocateRdId(navUl, "rd-nav-list");
      navUl.dataset.rdRole = "nav-list";
      Array.from(navUl.children).forEach((li) => {
        if (!isVisible(li)) return;
        allocateRdId(li, "rd-nav-item");
        li.dataset.rdRole = "nav-item";
      });
    });

    let gridCount = 0;
    scopeRoot.querySelectorAll("ul, ol, div, section, tbody").forEach((parent) => {
      if (!isVisible(parent) || parent.dataset.rdGenerated) return;
      if (
        parent.closest(
          "header, nav, footer, [role='banner'], [role='navigation'], [role='contentinfo'], [data-rd-role='navbar'], [data-rd-role='footer']"
        )
      ) {
        return;
      }

      const children = Array.from(parent.children).filter(isVisible);
      const gridMatch = isLikelyCardOrListGrid(parent, children);
      if (!gridMatch) return;

      gridCount++;
      const { hasMedia, isList } = gridMatch;
      const gridRole = isList ? "link-list" : "card-grid";
      const itemRole = isList ? "list-item" : "card-item";
      const id = allocateRdId(parent, `rd-${gridRole}`);
      if (!parent.dataset.rdRole || parent.dataset.rdRole === "section") {
        parent.dataset.rdRole = gridRole;
      }
      if (hasMedia) parent.dataset.rdGridKind = "media";

      children.forEach((item) => {
        allocateRdId(item, `${id}-item`);
        if (!item.dataset.rdRole) item.dataset.rdRole = itemRole;
        stampInnerCardSlots(item);
      });

      if (components.length < 22) {
        components.push({
          id,
          role: parent.dataset.rdRole,
          gridKind: hasMedia ? "media-posters" : "text-items",
          tag: parent.tagName.toLowerCase(),
          selector: `[data-rd-id="${id}"]`,
          itemSelector: `[data-rd-role="${itemRole}"]`,
          itemCount: children.length
        });
      }
    });

    const layoutTables = [];
    scopeRoot.querySelectorAll("table").forEach((tbl) => {
      if (!isVisible(tbl)) return;
      const hasThead = Boolean(tbl.querySelector(":scope > thead"));
      const hasTh = tbl.querySelectorAll(":scope > tbody > tr:first-child > th").length >= 2;
      const hasNestedTable = Boolean(tbl.querySelector("table"));
      const wideAttr = tbl.getAttribute("width") || tbl.getAttribute("cellpadding") !== null;
      if (!hasThead && !hasTh && (hasNestedTable || wideAttr || tbl.getBoundingClientRect().width > window.innerWidth * 0.65)) {
        const id = allocateRdId(tbl, "rd-layout-table");
        layoutTables.push({ selector: `[data-rd-id="${id}"]`, width: Math.round(tbl.getBoundingClientRect().width) });
      }
    });

    scopeRoot.querySelectorAll("h1, h2, h3, h4, .ban, caption, th").forEach((el) => {
      if (!isVisible(el)) return;
      allocateRdId(el, "rd-heading");
      if (!el.dataset.rdRole) el.dataset.rdRole = "section-header";
    });

    let affCount = 0;
    scopeRoot.querySelectorAll("button, a[href], input:not([type='hidden']), select, textarea, [role='button'], form").forEach((el) => {
      if (!isVisible(el)) return;
      const tag = el.tagName.toLowerCase();
      let role = "interactive";
      if (tag === "input" && (el.type === "search" || /search|query|\bq\b/i.test(`${el.name} ${el.id} ${el.placeholder}`))) {
        role = "search-input";
      } else if (tag === "form") {
        role = "form-container";
      } else if (tag === "button" || el.getAttribute("role") === "button" || el.type === "submit") {
        role = "action-cta";
      } else if (tag === "a") {
        role = "navigation-link";
      } else {
        role = "form-control";
      }

      const id = allocateRdId(el, "rd-aff");
      el.dataset.rdAffordance = role;
      affCount++;
      if (affordances.length < 30) {
        affordances.push({
          id,
          role,
          selector: `[data-rd-id="${id}"]`,
          label: (el.innerText || el.placeholder || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 35)
        });
      }
    });

    if (scopeRoot !== document) {
      return null;
    }

    const imgCount = document.querySelectorAll("main img, article img, [data-rd-role='card-item'] img").length;
    const pWords = Array.from(document.querySelectorAll("article p, main p"))
      .slice(0, 10)
      .reduce((sum, p) => sum + (p.innerText || "").split(/\s+/).length, 0);
    let archetype = "general";
    if (imgCount > 8) archetype = "media-gallery";
    else if (layoutTables.length > 0 || document.querySelectorAll("[data-rd-role='list-item']").length > 12) {
      archetype = "link-aggregator";
    } else if (pWords > 240) {
      archetype = "article-reader";
    } else if (document.querySelector("aside, [role='complementary']") && document.querySelector("pre, code, table")) {
      archetype = "docs-dashboard";
    }

    const frameworkInfo = detectFrameworks();
    const siteCssVariables = includePreload ? extractSiteCssVariables(24) : {};
    const spatialMap = includePreload ? buildSpatialMap() : [];

    let preloadedExploration = null;
    if (includePreload) {
      const styleProbes = { body: inspectStylesTool("body") };
      const firstCard = document.querySelector("[data-rd-role='card-item']");
      if (firstCard?.dataset?.rdId) styleProbes.sampleCard = inspectStylesTool(`[data-rd-id="${firstCard.dataset.rdId}"]`);
      const firstCardLink = document.querySelector("[data-rd-role='card-item'] a");
      if (firstCardLink?.dataset?.rdId) {
        styleProbes.sampleCardLink = inspectStylesTool(`[data-rd-id="${firstCardLink.dataset.rdId}"]`);
      }
      const firstNav = document.querySelector("[data-rd-role='navbar']");
      if (firstNav?.dataset?.rdId) styleProbes.navbar = inspectStylesTool(`[data-rd-id="${firstNav.dataset.rdId}"]`);

      preloadedExploration = {
        domTree: readDomTree("body", 4, 4200).tree,
        spatialMap,
        keyElements: findElementsTool({
          selector: "header, nav, form, marquee, aside, [data-rd-role='navbar'], [data-rd-role='sidebar'], [data-rd-role='section-header']",
          limit: 14
        }).matches,
        styleProbes
      };
    }

    const bodyStyle = document.body ? window.getComputedStyle(document.body) : {};
    return {
      title: document.title || "",
      url: location.hostname + location.pathname,
      origin: location.origin,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      totalStampedGrids: gridCount,
      totalStampedAffordances: affCount,
      pageProfile: {
        archetype,
        layoutTables,
        hasSidebar: Boolean(document.querySelector("[data-rd-role='sidebar']")),
        isDarkPage: isDarkColor(getEffectiveBackgroundColor(document.body)),
        bodyWidth: document.body ? Math.round(document.body.getBoundingClientRect().width) : 0,
        bodyFont: bodyStyle.fontFamily || "",
        isSpaFramework: frameworkInfo.isSpaFramework,
        frameworks: frameworkInfo.frameworks,
        siteCssVariables
      },
      recognizedComponents: components,
      protectedAffordances: affordances,
      preloadedExploration
    };
  }

  function stampInnerCardSlots(item) {
    if (item.dataset.rdSlotsStamped) return;
    item.dataset.rdSlotsStamped = "true";

    const media = item.querySelector("img, picture, video");
    if (media && !media.closest("[data-rd-slot]")) {
      const container = media.closest("a, figure, div");
      (container && container !== item ? container : media).dataset.rdSlot = "media";
    }

    const title = item.querySelector("h1, h2, h3, h4, .title a, a.title, strong a, a:last-of-type");
    if (title && !title.dataset.rdSlot) title.dataset.rdSlot = "title";

    const desc = item.querySelector("p, .excerpt, .summary, .description");
    if (desc && !desc.dataset.rdSlot) desc.dataset.rdSlot = "description";

    const meta = item.querySelector("time, .meta, .subtext, .author, .tags, small, span");
    if (meta && !meta.dataset.rdSlot) meta.dataset.rdSlot = "meta";

    const btn = item.querySelector("button, [role='button']");
    if (btn && !btn.dataset.rdSlot) btn.dataset.rdSlot = "actions";
  }

  function startSpaObserver() {
    stopSpaObserver();
    if (!document.body) return;
    lastObservedHref = location.href;
    pendingAddedNodes.clear();

    spaObserver = new MutationObserver((records) => {
      if (isInternalDomChange || isPreviewDisabled) return;

      for (const rec of records) {
        if (rec.type === "childList" && rec.addedNodes.length > 0) {
          for (const node of rec.addedNodes) {
            if (node instanceof Element && node.id !== "redesigner-hud-host" && !node.dataset?.rdGenerated) {
              pendingAddedNodes.add(node);
            }
          }
        }
      }

      if (pendingAddedNodes.size === 0 && location.href === lastObservedHref) return;
      if (spaDebounceTimer) clearTimeout(spaDebounceTimer);

      spaDebounceTimer = setTimeout(() => {
        spaDebounceTimer = null;
        if (isPreviewDisabled || isInternalDomChange) return;

        const added = Array.from(pendingAddedNodes);
        pendingAddedNodes.clear();

        withInternalMutationGuard(() => {
          if (location.href !== lastObservedHref) {
            lastObservedHref = location.href;
            undoStructuralOps();
            analyzeAndStampPage(false, document);
            if (lastAppliedMutations.length > 0) executeStructuralOps(lastAppliedMutations);
            autoHealPageContrast(document);
          } else {
            // Incremental stamping & healing on newly inserted subtrees only (zero full-DOM thrash!)
            for (const root of added) {
              if (!root.isConnected) continue;
              analyzeAndStampPage(false, root);
              autoHealPageContrast(root, false);
            }
          }
        });
      }, 180);
    });

    spaObserver.observe(document.body, { childList: true, subtree: true });
  }

  function stopSpaObserver() {
    if (spaObserver) {
      spaObserver.disconnect();
      spaObserver = null;
    }
    if (spaDebounceTimer) {
      clearTimeout(spaDebounceTimer);
      spaDebounceTimer = null;
    }
    pendingAddedNodes.clear();
  }

  function clearHealMarkers(scope = document) {
    scope.querySelectorAll("[data-rd-healed-bg], [data-rd-healed-text]").forEach((el) => {
      delete el.dataset.rdHealedBg;
      delete el.dataset.rdHealedText;
    });
  }

  function hasOverlaySurfaceBackdrop(el) {
    let curr = el;
    while (curr && curr instanceof Element && curr !== document.body && curr !== document.documentElement) {
      const comp = window.getComputedStyle(curr);
      if (comp.backdropFilter && comp.backdropFilter !== "none") return true;
      if (comp.backgroundImage && comp.backgroundImage !== "none") return true;
      curr = curr.parentElement;
    }
    return false;
  }

  function estimateGradientLuminance(bgImageStr) {
    if (!bgImageStr || bgImageStr === "none" || !/gradient\(/i.test(bgImageStr)) return null;
    const tokens = bgImageStr.match(/(rgba?\([^)]+\)|hsla?\([^)]+\)|#[0-9a-fA-F]{3,8}|color\([^)]+\)|oklch\([^)]+\))/gi);
    if (!tokens || tokens.length === 0) return null;
    let sum = 0;
    let count = 0;
    for (const tok of tokens.slice(0, 6)) {
      const c = parseColor(tok);
      if (c && c.a > 0.2) {
        sum += relativeLuminance(c);
        count++;
      }
    }
    return count > 0 ? sum / count : null;
  }

  /**
   * Determines whether the current rendered page theme is dark using the ACTUAL
   * rendered body/html background (including gradients) first, then --rd-bg-body.
   */
  function isThemeDark() {
    if (document.body) {
      const bodyComp = window.getComputedStyle(document.body);
      const gradLum = estimateGradientLuminance(bodyComp.backgroundImage);
      if (gradLum !== null) return gradLum < 0.35;

      const bodyBg = parseColor(bodyComp.backgroundColor);
      if (bodyBg && bodyBg.a > 0.5) return relativeLuminance(bodyBg) < 0.35;
    }

    const htmlComp = window.getComputedStyle(document.documentElement);
    const htmlGradLum = estimateGradientLuminance(htmlComp.backgroundImage);
    if (htmlGradLum !== null) return htmlGradLum < 0.35;
    const htmlBg = parseColor(htmlComp.backgroundColor);
    if (htmlBg && htmlBg.a > 0.5) return relativeLuminance(htmlBg) < 0.35;

    const bgToken = htmlComp.getPropertyValue("--rd-bg-body").trim();
    if (bgToken) {
      if (bgToken.includes("light-dark(")) {
        return window.matchMedia("(prefers-color-scheme: dark)").matches;
      }
      const tokenRgb = parseColor(bgToken);
      if (tokenRgb) return relativeLuminance(tokenRgb) < 0.35;
    }

    return isDarkColor(getEffectiveBackgroundColor(document.body || document.documentElement));
  }

  function isLegacyBlueTint(colorStr) {
    const rgba = parseColor(colorStr);
    if (!rgba || rgba.a < 0.2) return false;
    return rgba.b > rgba.r + 65 && rgba.r < 75 && rgba.g < 140;
  }

  function isLargeText(comp) {
    const sizePx = parseFloat(comp.fontSize || "16");
    const weight = parseInt(comp.fontWeight, 10) || (comp.fontWeight === "bold" ? 700 : 400);
    return sizePx >= 24 || (sizePx >= 18.66 && weight >= 700);
  }

  /**
   * Bidirectional contrast auto-healer (handles BOTH dark and light themes)
   * without touching interactive buttons, badges, media, or already-accessible surfaces.
   */
  function autoHealPageContrast(scope = document, shouldClearFirst = true) {
    if (shouldClearFirst) clearHealMarkers(scope);
    if (!document.body) return { healedSurfaces: 0, healedTexts: 0 };

    const darkTheme = isThemeDark();
    let healedSurfaces = 0;
    let healedTexts = 0;

    const containerNodes = [];
    if (scope instanceof Element && scope.matches("div, section, article, aside, header, footer, nav, ul, ol, li, table, td, th")) {
      containerNodes.push(scope);
    }
    scope.querySelectorAll("div, section, article, aside, header, footer, nav, ul, ol, li, table, td, th").forEach((el) => {
      containerNodes.push(el);
    });

    for (const el of containerNodes) {
      if (
        el.closest(
          "#redesigner-hud-host, pre, code, video, canvas, svg, [data-rd-role='nav-list'], [data-rd-role='nav-item'], [data-rd-generated='true'], [data-rd-no-heal]"
        )
      ) {
        continue;
      }
      const comp = window.getComputedStyle(el);
      if (comp.display === "none" || comp.visibility === "hidden") continue;
      if (comp.backgroundImage && comp.backgroundImage !== "none") continue;
      const rgba = parseColor(comp.backgroundColor);
      if (!rgba || rgba.a < 0.45) continue;

      const rect = el.getBoundingClientRect();
      // Skip tiny pills/dots/badges/avatars so status colors stay intact
      if (rect.width < 90 || rect.height < 28) continue;

      const lum = relativeLuminance(rgba);
      if (darkTheme && lum > 0.65) {
        const isHeader = el.matches("h1, h2, h3, h4, th, [data-rd-role='section-header']");
        el.dataset.rdHealedBg = isHeader ? "elevated" : "surface";
        healedSurfaces++;
      } else if (!darkTheme && lum < 0.14 && rect.width > 180 && rect.height > 44) {
        // Light theme active on a dark-mode website: heal leftover pitch-black panels
        const isHeader = el.matches("h1, h2, h3, h4, th, [data-rd-role='section-header']");
        el.dataset.rdHealedBg = isHeader ? "elevated" : "surface";
        healedSurfaces++;
      }
    }

    const textNodes = [];
    if (scope instanceof Element && scope.matches("a, p, span, li, td, th, h1, h2, h3, h4, label, small, strong")) {
      textNodes.push(scope);
    }
    scope.querySelectorAll("a, p, span, li, td, th, h1, h2, h3, h4, label, small, strong").forEach((el) => {
      textNodes.push(el);
    });

    for (const el of textNodes) {
      if (el.closest("#redesigner-hud-host, pre, code, svg, button, [role='button'], [data-rd-generated='true'], [data-rd-no-heal]")) {
        continue;
      }
      if (!isVisible(el)) continue;
      const comp = window.getComputedStyle(el);
      const fgRgb = parseColor(comp.color);
      const fgLum = fgRgb ? relativeLuminance(fgRgb) : 0;

      if (darkTheme && (el.tagName === "A" || el.closest("a")) && isLegacyBlueTint(comp.color)) {
        el.dataset.rdHealedText = "link";
        healedTexts++;
        continue;
      }

      // Skip already-readable text on overlays/gradients
      if (hasOverlaySurfaceBackdrop(el)) {
        if (darkTheme && fgLum >= 0.35) continue;
        if (!darkTheme && fgLum <= 0.45) continue;
      }

      const hasDirectText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
      if (!hasDirectText && el.tagName !== "A") continue;

      const bg = getEffectiveBackgroundColor(el);
      const minRatio = isLargeText(comp) ? 3.0 : 4.5;
      if (computeContrastRatio(comp.color, bg) < minRatio) {
        el.dataset.rdHealedText = el.tagName === "A" || el.closest("a") ? "link" : "fg";
        healedTexts++;
      }
    }

    return { healedSurfaces, healedTexts };
  }

  /**
   * Comprehensive 10-Dimension Rendered-Page QA Auditor.
   * Produces actionable selectors, exact pixel metrics, critical vs minor classification, and topFixes.
   */
  function auditRenderedPage() {
    const overlappingCards = [];
    const accidentallyUnhidden = [];
    const clashingSurfaces = [];
    const buriedOrBrokenImages = [];
    const unwantedLegacyBordersOrLinks = [];
    const lowContrastElements = [];
    const occludedControls = [];
    const violations = [];
    const layoutSmells = [];
    const horizontalOverflowOffenders = [];
    let contentLoss = null;
    const darkTheme = isThemeDark();

    // 1. Pairwise overlapping cards inside grids/lists (catches horizontal AND vertical row collisions!)
    document.querySelectorAll("[data-rd-role='card-grid'], [data-rd-role='link-list']").forEach((grid) => {
      if (!isVisible(grid) || overlappingCards.length >= 4) return;
      const items = Array.from(grid.children).filter(isVisible).slice(0, 16);
      const rects = items.map((el) => el.getBoundingClientRect());
      let overlapsInGrid = 0;
      let sampleCardW = 0;

      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i];
          const b = rects[j];
          const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (overlapX > 12 && overlapY > 12) {
            overlapsInGrid++;
            sampleCardW = Math.round(a.width);
            break;
          }
        }
      }

      if (overlapsInGrid > 0) {
        overlappingCards.push({
          gridSelector: buildQuickSelector(grid),
          gridWidth: Math.round(grid.getBoundingClientRect().width),
          sampleCardWidth: sampleCardW,
          overlapsDetected: overlapsInGrid,
          fix: "Set width: 100%; min-width: 0; box-sizing: border-box; float: none; on cards, and use repeat(auto-fill, minmax(min(200px, 100%), 1fr)) on the grid."
        });
      }
    });

    // 2. Originally hidden elements accidentally unhidden by overly broad CSS
    originallyHiddenElements.forEach((el) => {
      if (!el.isConnected || el.hidden || el.inert || accidentallyUnhidden.length >= 5) return;
      const comp = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (comp.display !== "none" && comp.visibility !== "hidden" && rect.height > 12 && rect.width > 12) {
        accidentallyUnhidden.push({
          selector: buildQuickSelector(el),
          tag: el.tagName.toLowerCase(),
          text: (el.innerText || "").trim().slice(0, 40)
        });
      }
    });

    // 3. Clashing surface wrappers (bright white on dark theme, OR pitch-black on light theme)
    const surfaceCandidates = new Set([
      document.documentElement,
      document.body,
      ...Array.from(document.querySelectorAll("body > div, main, main div, header, section, article, aside, [data-rd-role='card-item']"))
    ]);
    for (const el of surfaceCandidates) {
      if (!el || el.id === "redesigner-hud-host" || clashingSurfaces.length >= 6) continue;
      if (el.dataset?.rdGenerated || isElementInsideIntentionallyHiddenContainer(el)) continue;
      const comp = window.getComputedStyle(el);
      if (comp.display === "none" || (comp.backgroundImage && comp.backgroundImage !== "none")) continue;
      const rgba = parseColor(comp.backgroundColor);
      const rect = el.getBoundingClientRect();
      if (!rgba || rgba.a <= 0.5 || rect.width <= 200 || rect.height <= 36) continue;

      const lum = relativeLuminance(rgba);
      if (darkTheme && lum > 0.72) {
        clashingSurfaces.push({
          selector: buildQuickSelector(el),
          issue: "Bright white surface on dark theme",
          backgroundColor: comp.backgroundColor,
          bounds: `${Math.round(rect.width)}x${Math.round(rect.height)}`
        });
      } else if (!darkTheme && lum < 0.12) {
        clashingSurfaces.push({
          selector: buildQuickSelector(el),
          issue: "Dark black surface on light theme",
          backgroundColor: comp.backgroundColor,
          bounds: `${Math.round(rect.width)}x${Math.round(rect.height)}`
        });
      }
    }

    // 4. Buried, collapsed, or aspect-ratio-distorted images
    document
      .querySelectorAll("[data-rd-role='card-item'] img, [data-rd-role='hero-spotlight'] img, [data-rd-role='main-content'] img, main img")
      .forEach((img) => {
        if (buriedOrBrokenImages.length >= 6) return;
        if (isElementInsideIntentionallyHiddenContainer(img) || originallyHiddenElements.has(img)) return;
        const comp = window.getComputedStyle(img);
        const rect = img.getBoundingClientRect();
        const z = parseInt(comp.zIndex, 10);
        const card = img.closest("[data-rd-role='card-item'], [data-rd-role='hero-spotlight']");
        const cardIso = card ? window.getComputedStyle(card).isolation : "auto";

        if (comp.display === "none" || comp.visibility === "hidden" || parseFloat(comp.opacity || "1") < 0.15) {
          buriedOrBrokenImages.push({ selector: buildQuickSelector(img), issue: "Image hidden" });
        } else if (rect.width < 16 || rect.height < 16) {
          if (!img.complete || img.naturalWidth > 16) {
            buriedOrBrokenImages.push({
              selector: buildQuickSelector(img),
              issue: `Image collapsed (${Math.round(rect.width)}x${Math.round(rect.height)})`
            });
          }
        } else if (!Number.isNaN(z) && z < 0 && cardIso !== "isolate") {
          buriedOrBrokenImages.push({ selector: buildQuickSelector(img), issue: "z-index: -1 without isolation: isolate" });
        } else if (
          img.complete &&
          img.naturalWidth >= 60 &&
          img.naturalHeight >= 60 &&
          comp.objectFit === "fill"
        ) {
          const natRatio = img.naturalWidth / img.naturalHeight;
          const renRatio = rect.width / rect.height;
          const distortion = Math.max(natRatio / renRatio, renRatio / natRatio);
          if (distortion > 2.1) {
            buriedOrBrokenImages.push({
              selector: buildQuickSelector(img),
              issue: `Distorted aspect ratio (${distortion.toFixed(1)}x) — add object-fit: cover`
            });
          }
        }
      });

    // 5. Legacy blue borders / dark-blue links on dark theme
    if (darkTheme) {
      document.querySelectorAll("[data-rd-role='card-item'], [data-rd-role='card-item'] *").forEach((el) => {
        if (isElementInsideIntentionallyHiddenContainer(el) || unwantedLegacyBordersOrLinks.length >= 6) return;
        const comp = window.getComputedStyle(el);
        if (parseFloat(comp.borderTopWidth) > 0 && isLegacyBlueTint(comp.borderTopColor)) {
          unwantedLegacyBordersOrLinks.push({
            selector: buildQuickSelector(el),
            issue: `Legacy blue border (${comp.borderTopColor})`
          });
        }
        if ((el.tagName === "A" || el.matches("[data-rd-slot='title']")) && isLegacyBlueTint(comp.color)) {
          unwantedLegacyBordersOrLinks.push({
            selector: buildQuickSelector(el),
            issue: `Dark blue link (${comp.color})`
          });
        }
      });
    }

    // 6. Affordances integrity, WCAG AA contrast (affordances + headings/paragraphs), AND elementFromPoint occlusion!
    let hitTestChecks = 0;
    document.querySelectorAll("[data-rd-affordance]").forEach((el) => {
      if (isElementInsideIntentionallyHiddenContainer(el)) return;
      const comp = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4 || comp.display === "none" || comp.visibility === "hidden") {
        if (violations.length < 6) {
          violations.push({
            selector: buildQuickSelector(el),
            role: el.dataset.rdAffordance,
            issue: "Collapsed interactive control"
          });
        }
        return;
      }

      // Hit-test primary interactive controls currently inside the viewport
      if (
        hitTestChecks < 18 &&
        occludedControls.length < 4 &&
        ["search-input", "action-cta", "navigation-link", "form-control"].includes(el.dataset.rdAffordance) &&
        rect.width >= 16 &&
        rect.height >= 16 &&
        rect.top >= 2 &&
        rect.bottom <= window.innerHeight - 2 &&
        rect.left >= 2 &&
        rect.right <= window.innerWidth - 2
      ) {
        hitTestChecks++;
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const topEl = document.elementFromPoint(cx, cy);
        if (
          topEl &&
          topEl !== el &&
          !el.contains(topEl) &&
          !topEl.contains(el) &&
          topEl.id !== "redesigner-hud-host" &&
          !topEl.closest("#redesigner-hud-host") &&
          !(topEl.tagName === "LABEL" && el.id && topEl.getAttribute("for") === el.id)
        ) {
          occludedControls.push({
            selector: buildQuickSelector(el),
            role: el.dataset.rdAffordance,
            label: (el.innerText || el.placeholder || el.value || "").trim().slice(0, 30),
            occludedBy: buildQuickSelector(topEl)
          });
        }
      }

      if ((el.innerText || "").trim() && lowContrastElements.length < 8) {
        const fgRgb = parseColor(comp.color);
        const fgLum = fgRgb ? relativeLuminance(fgRgb) : 0;
        if (hasOverlaySurfaceBackdrop(el) && ((darkTheme && fgLum >= 0.35) || (!darkTheme && fgLum <= 0.45))) return;
        const bg = getEffectiveBackgroundColor(el);
        const ratio = computeContrastRatio(comp.color, bg);
        const minRatio = isLargeText(comp) ? 3.0 : 4.5;
        if (ratio < minRatio) {
          lowContrastElements.push({
            selector: buildQuickSelector(el),
            text: (el.innerText || "").trim().slice(0, 30),
            color: comp.color,
            bg,
            ratio: Number(ratio.toFixed(2)),
            required: minRatio
          });
        }
      }
    });

    // Also audit primary headings & body paragraphs for contrast and clipped text
    const checkedTextEls = Array.from(document.querySelectorAll("main h1, main h2, main h3, main p, article h1, article p, [data-rd-role='card-item'] [data-rd-slot='title']")).slice(0, 35);
    for (const el of checkedTextEls) {
      if (!isVisible(el) || isElementInsideIntentionallyHiddenContainer(el)) continue;
      const comp = window.getComputedStyle(el);
      const txt = (el.innerText || "").trim();
      if (!txt) continue;

      if (lowContrastElements.length < 8) {
        const fgRgb = parseColor(comp.color);
        const fgLum = fgRgb ? relativeLuminance(fgRgb) : 0;
        const skipOverlay = hasOverlaySurfaceBackdrop(el) && ((darkTheme && fgLum >= 0.35) || (!darkTheme && fgLum <= 0.45));
        if (!skipOverlay) {
          const bg = getEffectiveBackgroundColor(el);
          const ratio = computeContrastRatio(comp.color, bg);
          const minRatio = isLargeText(comp) ? 3.0 : 4.5;
          if (ratio < minRatio) {
            lowContrastElements.push({
              selector: buildQuickSelector(el),
              text: txt.slice(0, 30),
              color: comp.color,
              bg,
              ratio: Number(ratio.toFixed(2)),
              required: minRatio
            });
          }
        }
      }

      // Clipped text smell detection
      if (
        layoutSmells.length < 4 &&
        (comp.overflowX === "hidden" || comp.overflow === "hidden") &&
        comp.textOverflow !== "ellipsis" &&
        el.scrollWidth > el.clientWidth + 24 &&
        el.clientWidth > 30
      ) {
        layoutSmells.push({
          selector: buildQuickSelector(el),
          issue: `Clipped text (${el.scrollWidth}px content inside ${el.clientWidth}px box)`
        });
      }
    }

    // 7. Horizontal overflow + exact offending elements
    const overflowDelta = document.documentElement.scrollWidth - window.innerWidth;
    const horizontalOverflow = overflowDelta > 8;
    if (horizontalOverflow) {
      const candidates = document.querySelectorAll("div, section, main, article, header, nav, ul, table, img, pre, form, aside");
      for (const el of candidates) {
        if (horizontalOverflowOffenders.length >= 5) break;
        if (!isVisible(el) || el.id === "redesigner-hud-host") continue;
        const rect = el.getBoundingClientRect();
        if (rect.right <= window.innerWidth + 8) continue;
        // Skip elements inside an intentionally scrollable horizontal container
        let inScrollable = false;
        let p = el.parentElement;
        while (p && p !== document.body) {
          const pc = window.getComputedStyle(p);
          if (pc.overflowX === "auto" || pc.overflowX === "scroll") {
            inScrollable = true;
            break;
          }
          p = p.parentElement;
        }
        if (inScrollable) continue;
        horizontalOverflowOffenders.push({
          selector: buildQuickSelector(el),
          overflowPx: Math.round(rect.right - window.innerWidth),
          width: Math.round(rect.width)
        });
      }
    }

    // 8. Baseline content retention check (detect accidental main-content disappearance!)
    if (baselineMetrics && baselineMetrics.wordCount >= 40) {
      const current = measurePageContentMetrics();
      const wordRatio = current.wordCount / baselineMetrics.wordCount;
      const imgRatio = baselineMetrics.imageCount >= 4 ? current.imageCount / baselineMetrics.imageCount : 1;
      if (wordRatio < 0.45 || imgRatio < 0.4) {
        contentLoss = {
          baselineWords: baselineMetrics.wordCount,
          currentWords: current.wordCount,
          baselineImages: baselineMetrics.imageCount,
          currentImages: current.imageCount,
          issue:
            wordRatio < 0.45
              ? `Lost ${Math.round((1 - wordRatio) * 100)}% of visible page text!`
              : `Lost ${Math.round((1 - imgRatio) * 100)}% of visible images!`
        };
      }
    }

    const criticalIssues =
      overlappingCards.length +
      occludedControls.length +
      buriedOrBrokenImages.length +
      accidentallyUnhidden.length +
      violations.length +
      (contentLoss ? 1 : 0);

    const minorIssues =
      clashingSurfaces.length +
      unwantedLegacyBordersOrLinks.length +
      lowContrastElements.length +
      layoutSmells.length +
      (horizontalOverflow ? 1 : 0);

    const totalIssues = criticalIssues + minorIssues;

    const score = Math.max(
      0,
      Math.round(
        100 -
          overlappingCards.length * 20 -
          occludedControls.length * 16 -
          accidentallyUnhidden.length * 14 -
          buriedOrBrokenImages.length * 14 -
          violations.length * 10 -
          (contentLoss ? 30 : 0) -
          clashingSurfaces.length * 10 -
          unwantedLegacyBordersOrLinks.length * 5 -
          lowContrastElements.length * 4 -
          layoutSmells.length * 4 -
          (horizontalOverflow ? 8 : 0)
      )
    );

    const topFixes = [];
    if (contentLoss) topFixes.push(`CRITICAL: ${contentLoss.issue} Check if a rule hid main content.`);
    if (overlappingCards.length) topFixes.push(`Fix ${overlappingCards.length} overlapping card grid(s): ${overlappingCards[0].gridSelector}`);
    if (occludedControls.length) topFixes.push(`Unblock ${occludedControls.length} occluded control(s): ${occludedControls[0].selector} covered by ${occludedControls[0].occludedBy}`);
    if (buriedOrBrokenImages.length) topFixes.push(`Fix ${buriedOrBrokenImages.length} broken/buried image(s): ${buriedOrBrokenImages[0].issue}`);
    if (accidentallyUnhidden.length) topFixes.push(`Stop unhiding hidden element(s): ${accidentallyUnhidden[0].selector}`);
    if (horizontalOverflow) {
      topFixes.push(
        `Eliminate ${Math.round(overflowDelta)}px horizontal overflow${
          horizontalOverflowOffenders[0] ? ` caused by ${horizontalOverflowOffenders[0].selector}` : ""
        }`
      );
    }
    if (clashingSurfaces.length) topFixes.push(`Fix ${clashingSurfaces.length} clashing surface(s): ${clashingSurfaces[0].selector}`);
    if (lowContrastElements.length) {
      topFixes.push(
        `Raise contrast on ${lowContrastElements.length} element(s), e.g. ${lowContrastElements[0].selector} (${lowContrastElements[0].ratio}:1 < ${lowContrastElements[0].required}:1)`
      );
    }

    return {
      intact: totalIssues === 0,
      score,
      criticalIssues,
      minorIssues,
      totalIssues,
      themeDetected: darkTheme ? "dark" : "light",
      topFixes,
      contentLoss,
      overlappingCards,
      occludedControls,
      accidentallyUnhidden,
      whiteOrClashingBoxes: clashingSurfaces,
      buriedOrBrokenImages,
      unwantedLegacyBordersOrLinks,
      lowContrastElements,
      violations,
      layoutSmells,
      horizontalOverflow,
      horizontalOverflowPx: horizontalOverflow ? Math.round(overflowDelta) : 0,
      horizontalOverflowOffenders
    };
  }

  function mountOrUpdateFloatingHud() {
    if (!document.body) return;
    if (!hudHost) {
      hudHost = document.createElement("div");
      hudHost.id = "redesigner-hud-host";
      hudHost.style.cssText =
        "position:fixed;bottom:18px;right:18px;z-index:2147483647;font-family:system-ui,-apple-system,sans-serif;";
      const shadow = hudHost.attachShadow({ mode: "open" });

      shadow.innerHTML = `
        <style>
          .pill { display:flex; align-items:center; gap:6px; background:rgba(12,18,22,0.92); backdrop-filter:blur(12px); border:1px solid rgba(74,222,128,0.38); border-radius:999px; padding:6px 10px; color:#f1f5f9; font-size:11.5px; box-shadow:0 10px 28px rgba(0,0,0,0.45); }
          .dot { width:8px; height:8px; border-radius:50%; background:#4ade80; flex-shrink:0; }
          .dot.paused { background:#fbbf24; }
          .dot.warn { background:#f87171; }
          .title { max-width:140px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
          .qa { font-size:10px; font-weight:700; padding:2px 6px; border-radius:999px; background:rgba(74,222,128,0.16); color:#86efac; }
          .qa.mid { background:rgba(251,191,36,0.18); color:#fde68a; }
          .qa.low { background:rgba(248,113,113,0.2); color:#fecaca; }
          .qa.hidden { display:none; }
          button { background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.14); color:#f8fafc; border-radius:999px; padding:4px 8px; font-size:10.5px; font-weight:600; cursor:pointer; }
          button:hover { border-color:#4ade80; background:rgba(74,222,128,0.2); }
          button.pinned { border-color:#4ade80; color:#86efac; background:rgba(74,222,128,0.18); }
        </style>
        <div class="pill">
          <span class="dot" id="hud-dot"></span>
          <span class="title" id="hud-title">Redesigned</span>
          <span class="qa hidden" id="hud-qa"></span>
          <button type="button" id="hud-pin">Pin</button>
          <button type="button" id="hud-compare">Compare</button>
          <button type="button" id="hud-revert">Revert</button>
          <button type="button" id="hud-close" title="Hide">✕</button>
        </div>
      `;

      const sendHudAction = (payload) => {
        try {
          chrome.runtime.sendMessage(payload, () => void chrome.runtime?.lastError);
        } catch {}
      };
      shadow.getElementById("hud-pin").addEventListener("click", () => {
        sendHudAction({ action: "HUD_SET_PIN", enforced: !isEnforcedOnSite });
      });
      shadow.getElementById("hud-compare").addEventListener("click", () => {
        sendHudAction({ action: "HUD_TOGGLE_PREVIEW" });
      });
      shadow.getElementById("hud-revert").addEventListener("click", () => {
        sendHudAction({ action: "HUD_REVERT" });
      });
      shadow.getElementById("hud-close").addEventListener("click", () => {
        hudDismissedByUser = true;
        hudHost.style.display = "none";
      });

      document.body.appendChild(hudHost);
    }
    if (!hudDismissedByUser) hudHost.style.display = "block";
    updateHudState();
  }

  function updateHudState() {
    if (!hudHost?.shadowRoot) return;
    const dot = hudHost.shadowRoot.getElementById("hud-dot");
    const title = hudHost.shadowRoot.getElementById("hud-title");
    const qa = hudHost.shadowRoot.getElementById("hud-qa");
    const pin = hudHost.shadowRoot.getElementById("hud-pin");
    const cmp = hudHost.shadowRoot.getElementById("hud-compare");

    if (dot) {
      dot.classList.toggle("paused", isPreviewDisabled);
      dot.classList.toggle("warn", !isPreviewDisabled && typeof lastAuditScore === "number" && lastAuditScore < 70);
    }
    if (title) title.textContent = isPreviewDisabled ? "Original View" : currentDesignDirection || "Redesigned";
    if (qa) {
      if (typeof lastAuditScore === "number" && !isPreviewDisabled) {
        qa.textContent = `QA ${lastAuditScore}`;
        qa.className = `qa ${lastAuditScore >= 85 ? "" : lastAuditScore >= 65 ? "mid" : "low"}`.trim();
      } else {
        qa.className = "qa hidden";
      }
    }
    if (pin) {
      pin.classList.toggle("pinned", isEnforcedOnSite);
      pin.textContent = isEnforcedOnSite ? "📌 Pinned" : "Pin";
    }
    if (cmp) cmp.textContent = isPreviewDisabled ? "Show New" : "Compare";
  }

  function revertDomAndHud() {
    withInternalMutationGuard(() => {
      stopSpaObserver();
      undoStructuralOps();
      clearHealMarkers(document);
      isPreviewDisabled = false;
      isEnforcedOnSite = false;
      hudDismissedByUser = false;
      lastAppliedMutations = [];
      lastAuditScore = null;
      baselineMetrics = null;
      originallyHiddenElements.clear();
      usedRdIds.clear();
      monotonicSeq = 0;
      hudHost?.remove();
      hudHost = null;
      document
        .querySelectorAll("[data-rd-id], [data-rd-role], [data-rd-affordance], [data-rd-slot], [data-rd-slots-stamped], [data-rd-grid-kind], [data-rd-layout-table]")
        .forEach((el) => {
          delete el.dataset.rdId;
          delete el.dataset.rdRole;
          delete el.dataset.rdAffordance;
          delete el.dataset.rdSlot;
          delete el.dataset.rdSlotsStamped;
          delete el.dataset.rdGridKind;
          delete el.dataset.rdLayoutTable;
        });
    });
  }

  // === Universal CSS Color Parsing + True Alpha Compositing + WCAG Luminance ===

  function parseColor(str) {
    if (!str || typeof str !== "string") return null;
    const key = str.trim();
    if (!key || key === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
    if (colorCache.has(key)) return colorCache.get(key);

    let result = null;

    // 1. rgb() / rgba() (comma or space/slash CSS Color 4 syntax, ints or floats)
    const rgbMatch = key.match(
      /^rgba?\(\s*([\d.]+)(%?)[,\s]+([\d.]+)(%?)[,\s]+([\d.]+)(%?)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/i
    );
    if (rgbMatch) {
      const r = rgbMatch[2] ? (parseFloat(rgbMatch[1]) / 100) * 255 : parseFloat(rgbMatch[1]);
      const g = rgbMatch[4] ? (parseFloat(rgbMatch[3]) / 100) * 255 : parseFloat(rgbMatch[3]);
      const b = rgbMatch[6] ? (parseFloat(rgbMatch[5]) / 100) * 255 : parseFloat(rgbMatch[5]);
      let a = 1;
      if (rgbMatch[7] !== undefined) {
        a = rgbMatch[8] ? parseFloat(rgbMatch[7]) / 100 : parseFloat(rgbMatch[7]);
      }
      result = { r: clamp255(r), g: clamp255(g), b: clamp255(b), a: clamp01(a) };
    }

    // 2. color(srgb r g b / a)
    if (!result) {
      const srgbMatch = key.match(
        /^color\(\s*srgb\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)(?:\s*\/\s*([\d.eE+-]+)(%?))?\s*\)$/i
      );
      if (srgbMatch) {
        const r = parseFloat(srgbMatch[1]) * 255;
        const g = parseFloat(srgbMatch[2]) * 255;
        const b = parseFloat(srgbMatch[3]) * 255;
        let a = 1;
        if (srgbMatch[4] !== undefined) {
          a = srgbMatch[5] ? parseFloat(srgbMatch[4]) / 100 : parseFloat(srgbMatch[4]);
        }
        result = { r: clamp255(r), g: clamp255(g), b: clamp255(b), a: clamp01(a) };
      }
    }

    // 3. Hex (#rgb, #rgba, #rrggbb, #rrggbbaa)
    if (!result && key.startsWith("#")) {
      const clean = key.slice(1);
      if (clean.length === 3 || clean.length === 4) {
        result = {
          r: parseInt(clean[0] + clean[0], 16),
          g: parseInt(clean[1] + clean[1], 16),
          b: parseInt(clean[2] + clean[2], 16),
          a: clean.length === 4 ? parseInt(clean[3] + clean[3], 16) / 255 : 1
        };
      } else if (clean.length === 6 || clean.length === 8) {
        result = {
          r: parseInt(clean.slice(0, 2), 16),
          g: parseInt(clean.slice(2, 4), 16),
          b: parseInt(clean.slice(4, 6), 16),
          a: clean.length === 8 ? parseInt(clean.slice(6, 8), 16) / 255 : 1
        };
      }
      if (result && Number.isNaN(result.r)) result = null;
    }

    // 4. Universal Canvas 2D fallback for oklch(), oklab(), lab(), hsl(), color-mix(), named colors
    if (!result) {
      result = resolveColorViaCanvas(key);
    }

    if (colorCache.size > 500) colorCache.clear();
    colorCache.set(key, result);
    return result;
  }

  function resolveColorViaCanvas(colorStr) {
    try {
      if (!colorCtx) {
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        colorCtx = canvas.getContext("2d", { willReadFrequently: true });
      }
      if (!colorCtx) return null;
      colorCtx.clearRect(0, 0, 1, 1);
      colorCtx.fillStyle = "rgba(0, 0, 0, 0)";
      colorCtx.fillStyle = colorStr;
      colorCtx.fillRect(0, 0, 1, 1);
      const [r, g, b, aByte] = colorCtx.getImageData(0, 0, 1, 1).data;
      return { r, g, b, a: aByte / 255 };
    } catch {
      return null;
    }
  }

  function clamp255(n) {
    return Math.max(0, Math.min(255, Math.round(Number.isFinite(n) ? n : 0)));
  }

  function clamp01(n) {
    return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 1));
  }

  function alphaComposite(fg, bg) {
    const a = clamp01(fg.a);
    const inv = 1 - a;
    return {
      r: fg.r * a + bg.r * inv,
      g: fg.g * a + bg.g * inv,
      b: fg.b * a + bg.b * inv,
      a: 1
    };
  }

  /**
   * Computes the true alpha-composited effective background color behind `el`
   * by stacking translucent ancestor backgrounds from bottom (canvas) to top (el).
   */
  function getEffectiveBackgroundColor(el) {
    const layers = [];
    let curr = el;
    while (curr && curr instanceof Element) {
      const rgba = parseColor(window.getComputedStyle(curr).backgroundColor);
      if (rgba && rgba.a > 0.01) {
        layers.push(rgba);
        if (rgba.a >= 0.995) break;
      }
      curr = curr.parentElement;
    }

    // Default browser canvas backdrop (respects color-scheme: dark)
    const rootScheme = window.getComputedStyle(document.documentElement).colorScheme || "";
    const prefersDarkCanvas =
      rootScheme === "dark" ||
      (rootScheme.includes("dark") && window.matchMedia?.("(prefers-color-scheme: dark)")?.matches);
    let composite = prefersDarkCanvas ? { r: 18, g: 18, b: 18, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };

    for (let i = layers.length - 1; i >= 0; i--) {
      composite = alphaComposite(layers[i], composite);
    }

    return `rgb(${clamp255(composite.r)}, ${clamp255(composite.g)}, ${clamp255(composite.b)})`;
  }

  function relativeLuminance({ r, g, b }) {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.722 * f(b);
  }

  function computeContrastRatio(fgStr, bgStr) {
    const fgRaw = parseColor(fgStr) || { r: 0, g: 0, b: 0, a: 1 };
    const bg = parseColor(bgStr) || { r: 255, g: 255, b: 255, a: 1 };
    const fg = fgRaw.a < 0.995 ? alphaComposite(fgRaw, bg) : fgRaw;
    const l1 = relativeLuminance(fg);
    const l2 = relativeLuminance(bg);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }

  function isDarkColor(str) {
    const rgb = parseColor(str);
    return rgb ? relativeLuminance(rgb) < 0.28 : false;
  }
})();
