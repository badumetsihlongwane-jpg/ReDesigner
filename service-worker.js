// service-worker.js — Serialized Zero-Leak CSS Manager, Hardened Multi-Provider Orchestrator & QA Pipeline

import { AgentRuntime } from "./agent-runtime.js";
import {
  PROVIDERS,
  retiredGeminiModels,
  isVisionCapable,
  getGeminiFallbackChain
} from "./shared/providers.js";
import {
  compileProfileTokensCSS,
  STRUCTURAL_SLOT_BASE_CSS,
  HEALER_AND_SAFETY_CSS
} from "./shared/personal-profiles.js";
import {
  DEFAULT_USER_TWEAKS,
  compileUserTweaksCSS,
  compileBaseFloorCSS,
  compilePresetOnlyCSS
} from "./shared/layout-blueprints.js";
import { buildLayoutSkillsPrompt } from "./shared/skills.js";
import { sanitizeAndValidateCSS } from "./shared/css-sanitizer.js";
import { validateMutations } from "./shared/mutation-validator.js";
import { parseLooseJson } from "./shared/json-utils.js";

let activeRunController = null;
let currentRunState = { isRunning: false, startedAt: 0, steps: {}, todos: [] };
const tabLocks = new Map();

/**
 * Serializes all CSS injection / removal / state updates per tabId so rapid
 * slider drags, theme swaps, or navigation events can NEVER orphan injected CSS.
 */
function withTabLock(tabId, fn) {
  const prev = tabLocks.get(tabId) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  const tracked = next.finally(() => {
    if (tabLocks.get(tabId) === tracked) {
      tabLocks.delete(tabId);
    }
  });
  tabLocks.set(tabId, tracked);
  return next;
}

function persistRunState(patch = {}) {
  currentRunState = { ...currentRunState, ...patch };
  chrome?.storage?.local?.set?.({ agentRunState: currentRunState });
}

function clearStaleRunFlag() {
  persistRunState({ isRunning: false, startedAt: 0, steps: {}, todos: [] });
}

if (typeof chrome !== "undefined" && chrome.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
    clearStaleRunFlag();
  });
  chrome.runtime.onStartup?.addListener(() => clearStaleRunFlag());
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

export function isSupportedTabUrl(url = "") {
  if (!url || typeof url !== "string") return false;
  if (!/^https?:\/\/|^file:\/\//i.test(url)) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host === "chromewebstore.google.com") return false;
    if (host === "chrome.google.com" && parsed.pathname.startsWith("/webstore")) return false;
    return true;
  } catch {
    return false;
  }
}

function notifyTabStateChanged(tabId) {
  chrome?.runtime?.sendMessage?.({ action: "TAB_STATE_CHANGED", tabId }, () => void chrome.runtime?.lastError);
}

function tabKey(tabId) {
  return `tabCss:${tabId}`;
}

async function getTabState(tabId) {
  const res = await chrome.storage.session.get([tabKey(tabId)]);
  return res[tabKey(tabId)] || null;
}

async function setTabState(tabId, state) {
  if (!state) {
    await chrome.storage.session.remove([tabKey(tabId)]);
  } else {
    await chrome.storage.session.set({ [tabKey(tabId)]: state });
  }
}

/**
 * Composes the complete stylesheet in deterministic cascade order:
 * 1. :root Profile Tokens
 * 2. Structural Slot Baselines (overridable by adapter CSS)
 * 3. Base Floor (low-specificity defaults)
 * 4. Optional Layout Preset (when no custom adapter CSS is present)
 * 5. Sanitized Site Adapter CSS (AI or user code)
 * 6. User Ergonomic Tweaks (opt-in overrides when moved from defaults)
 * 7. Contrast Auto-Healer & Accessibility Guards
 */
export function buildFullStylesheet({ profileId, layoutPreset, adapterCss, tweaks, pageOrigin = "" }) {
  const tokenCss = compileProfileTokensCSS(profileId || "obsidian");
  const baseFloor = compileBaseFloorCSS();
  const hasAdapter = Boolean(adapterCss && adapterCss.trim().length > 0);
  const presetCss = hasAdapter ? "" : compilePresetOnlyCSS(layoutPreset || "auto");
  const safeAdapter = hasAdapter
    ? sanitizeAndValidateCSS(adapterCss, { pageOrigin }).sanitizedCss
    : "";
  const tweaksCss = compileUserTweaksCSS(tweaks || DEFAULT_USER_TWEAKS);

  return [
    tokenCss,
    STRUCTURAL_SLOT_BASE_CSS,
    baseFloor,
    presetCss,
    `/* === Site Structural Adapter CSS === */\n${safeAdapter}`,
    tweaksCss,
    HEALER_AND_SAFETY_CSS
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function applyDesignToTab(tabId, payload) {
  return withTabLock(tabId, async () => {
    const prev = await getTabState(tabId);
    if (prev?.fullCss) {
      await chrome.scripting.removeCSS({ target: { tabId }, css: prev.fullCss }).catch(() => {});
    }

    const tab = await chrome.tabs.get(tabId).catch(() => null);
    let pageOrigin = "";
    try {
      if (tab?.url) pageOrigin = new URL(tab.url).origin;
    } catch {}

    const storedPrefs = await chrome.storage.local.get(["userTweaks"]);
    const profileId = payload.profileId || prev?.profileId || "obsidian";
    const layoutPreset = payload.layoutPreset || prev?.layoutPreset || "auto";
    const rawAdapterCss =
      typeof payload.adapterCss === "string" ? payload.adapterCss : prev?.adapterCss || "";
    const cssCheck = sanitizeAndValidateCSS(rawAdapterCss, { pageOrigin });
    const adapterCss = cssCheck.sanitizedCss;

    const rawMutations = Array.isArray(payload.domMutations)
      ? payload.domMutations
      : prev?.domMutations || [];
    const domMutations = validateMutations(rawMutations).mutations;

    const tweaks = payload.tweaks || prev?.tweaks || storedPrefs.userTweaks || DEFAULT_USER_TWEAKS;
    const designDirection = payload.designDirection || prev?.designDirection || "Redesigned Layout";
    const designId = payload.designId || prev?.designId || null;

    const fullCss = buildFullStylesheet({ profileId, layoutPreset, adapterCss, tweaks, pageOrigin });

    await chrome.scripting.insertCSS({ target: { tabId }, css: fullCss });

    const nextState = {
      fullCss,
      adapterCss,
      profileId,
      layoutPreset,
      tweaks,
      domMutations,
      designDirection,
      designId,
      disabled: false,
      lastAudit: prev?.lastAudit || null
    };
    await setTabState(tabId, nextState);

    let healStats = { healedSurfaces: 0, healedTexts: 0 };
    let mutationReport = { total: domMutations.length, applied: 0, skipped: 0, details: [] };
    try {
      await ensureContentScript(tabId);
      const resp = await chrome.tabs.sendMessage(tabId, {
        action: "APPLY_DOM_AND_HEAL",
        patch: {
          designDirection,
          designId,
          profileId,
          domMutations,
          isEnforcedOnSite: Boolean(payload.isEnforcedOnSite)
        }
      });
      if (resp?.healStats) healStats = resp.healStats;
      if (resp?.mutationReport) mutationReport = resp.mutationReport;
    } catch {}

    return { ...nextState, healStats, mutationReport, cssWarnings: cssCheck.warnings };
  });
}

async function toggleTabPreview(tabId, forceDisabled) {
  return withTabLock(tabId, async () => {
    const state = await getTabState(tabId);
    if (!state?.fullCss) return { status: "NO_STYLES", isPreviewDisabled: false };

    const nextDisabled =
      typeof forceDisabled === "boolean" ? forceDisabled : !state.disabled;

    if (nextDisabled) {
      await chrome.scripting.removeCSS({ target: { tabId }, css: state.fullCss }).catch(() => {});
      await chrome.tabs
        .sendMessage(tabId, { action: "TEMPORARY_RESTORE_FOR_COMPARE", disabled: true })
        .catch(() => {});
    } else {
      await chrome.scripting.insertCSS({ target: { tabId }, css: state.fullCss }).catch(() => {});
      await chrome.tabs
        .sendMessage(tabId, {
          action: "TEMPORARY_RESTORE_FOR_COMPARE",
          disabled: false,
          domMutations: state.domMutations || []
        })
        .catch(() => {});
    }

    state.disabled = nextDisabled;
    await setTabState(tabId, state);
    return { status: "TOGGLED", isPreviewDisabled: nextDisabled };
  });
}

async function revertTab(tabId, clearSitePin = true) {
  return withTabLock(tabId, async () => {
    const state = await getTabState(tabId);
    if (state?.fullCss) {
      await chrome.scripting.removeCSS({ target: { tabId }, css: state.fullCss }).catch(() => {});
    }
    await setTabState(tabId, null);

    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (clearSitePin && tab?.url) {
      await updateSitePin(tab.url, false, null);
    }
    await chrome.tabs.sendMessage(tabId, { action: "REVERT_DOM_AND_HUD" }).catch(() => {});
    return { status: "REVERTED" };
  });
}

async function updateSitePin(tabUrl, enforced, designPayload) {
  let host = "";
  try {
    host = new URL(tabUrl).hostname;
  } catch {}
  if (!host) return false;

  const stored = await chrome.storage.local.get(["siteEnforcedDesigns"]);
  const map = stored.siteEnforcedDesigns || {};

  if (enforced && (designPayload?.cssRules || designPayload?.layoutPreset)) {
    map[host] = {
      ...designPayload,
      hostname: host,
      enabled: true,
      updatedAt: Date.now()
    };
  } else {
    delete map[host];
  }

  await chrome.storage.local.set({ siteEnforcedDesigns: map });
  return Boolean(map[host]);
}

async function isSitePinned(tabUrl) {
  try {
    const host = new URL(tabUrl).hostname;
    if (!host) return false;
    const stored = await chrome.storage.local.get(["siteEnforcedDesigns"]);
    const item = stored.siteEnforcedDesigns?.[host];
    return Boolean(item && item.enabled !== false && (item.cssRules || item.layoutPreset));
  } catch {
    return false;
  }
}

if (typeof chrome !== "undefined" && chrome.tabs?.onUpdated) {
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!isSupportedTabUrl(tab?.url || "") || !tab.url.startsWith("http")) return;
  let host = "";
  let pageOrigin = "";
  try {
    const u = new URL(tab.url);
    host = u.hostname;
    pageOrigin = u.origin;
  } catch {
    return;
  }

  if (changeInfo.status === "loading") {
    withTabLock(tabId, async () => {
      const prev = await getTabState(tabId);
      if (prev?.fullCss) {
        await chrome.scripting.removeCSS({ target: { tabId }, css: prev.fullCss }).catch(() => {});
      }
      await setTabState(tabId, null);

      const res = await chrome.storage.local.get(["siteEnforcedDesigns", "activeProfileId", "userTweaks"]);
      const enforced = res?.siteEnforcedDesigns?.[host];
      if (enforced && enforced.enabled !== false && (enforced.cssRules || enforced.layoutPreset)) {
        const profileId = enforced.profileId || res.activeProfileId || "obsidian";
        const layoutPreset = enforced.layoutPreset || "auto";
        const tweaks = enforced.tweaks || res.userTweaks || DEFAULT_USER_TWEAKS;
        const safeAdapter = sanitizeAndValidateCSS(enforced.cssRules || "", { pageOrigin }).sanitizedCss;
        const safeMutations = validateMutations(enforced.domMutations || []).mutations;
        const fullCss = buildFullStylesheet({
          profileId,
          layoutPreset,
          adapterCss: safeAdapter,
          tweaks,
          pageOrigin
        });

        await chrome.scripting.insertCSS({ target: { tabId }, css: fullCss }).catch(() => {});
        await setTabState(tabId, {
          fullCss,
          adapterCss: safeAdapter,
          profileId,
          layoutPreset,
          tweaks,
          domMutations: safeMutations,
          designDirection: enforced.designDirection || "Pinned Redesign",
          designId: enforced.id || null,
          disabled: false,
          pinnedInjection: true
        });
      }
    }).catch(() => {});
  } else if (changeInfo.status === "complete") {
    withTabLock(tabId, async () => {
      const state = await getTabState(tabId);
      if (state && !state.disabled) {
        const actuallyPinned = await isSitePinned(tab.url);
        await ensureContentScript(tabId).catch(() => {});
        await chrome.tabs
          .sendMessage(tabId, {
            action: "APPLY_DOM_AND_HEAL",
            patch: {
              designDirection: state.designDirection,
              designId: state.designId,
              profileId: state.profileId,
              domMutations: state.domMutations || [],
              isEnforcedOnSite: actuallyPinned
            }
          })
          .catch(() => {});
        notifyTabStateChanged(tabId);
      }
    }).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabLocks.delete(tabId);
  setTabState(tabId, null).catch(() => {});
});
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const handleAsync = async () => {
    switch (request.action) {
      case "CHECK_AGENT_STATUS":
        return { isRunning: Boolean(activeRunController) };

      case "ABORT_AGENT_PIPELINE":
        if (activeRunController) {
          activeRunController.abort();
          activeRunController = null;
        }
        clearStaleRunFlag();
        emitLog("Agent run aborted by user.", "cooldown");
        return { stopped: true };

      case "START_AGENT_PIPELINE":
        return { result: await executeAgentRuntime(request) };

      case "PREPARE_BUILTIN_AI": {
        const tabId = request.tabId || (await getActiveTabId());
        const tab = await ensureContentScript(tabId);
        const domRes = await chrome.tabs.sendMessage(tabId, { action: "EXTRACT_SEMANTICS" });
        return { tabId, url: tab.url, title: tab.title, siteGraph: domRes?.data };
      }

      case "APPLY_BUILTIN_AI_RESULT": {
        const { tabId, profileId, layoutPreset, designPlan, tabUrl } = request;
        const pinned = await isSitePinned(tabUrl);
        await applyDesignToTab(tabId, {
          adapterCss: designPlan.cssRules || "",
          domMutations: designPlan.domMutations || [],
          designDirection: designPlan.designDirection || "Local AI Layout",
          profileId,
          layoutPreset: layoutPreset || "auto",
          isEnforcedOnSite: pinned
        });
        await new Promise((r) => setTimeout(r, 250));
        const auditRes = await chrome.tabs.sendMessage(tabId, { action: "AUDIT_RENDERED_PAGE" }).catch(() => null);
        const audit = auditRes?.data || null;
        if (audit) await saveLastAuditToTabState(tabId, audit);

        const saved = await saveGeneratedDesignToLibrary({
          tabUrl,
          cssRules: designPlan.cssRules || "",
          domMutations: designPlan.domMutations || [],
          designDirection: designPlan.designDirection,
          profileId,
          layoutPreset: layoutPreset || "auto",
          pinSite: pinned
        });
        return { designId: saved?.id, audit, ...designPlan };
      }

      case "APPLY_QUICK_LAYOUT": {
        const tabId = request.tabId || (await getActiveTabId());
        const existingQuick = await getTabState(tabId);
        if (existingQuick) {
          await revertTab(tabId, false);
        }
        const tab = await ensureContentScript(tabId);
        const domRes = await chrome.tabs.sendMessage(tabId, { action: "EXTRACT_SEMANTICS" });
        const siteGraph = domRes?.data || {};
        const tweaks = request.tweaks || DEFAULT_USER_TWEAKS;
        const layoutPreset = request.layoutPreset || "bento-command";
        const autoMutations = [];

        if (layoutPreset === "editorial-focus" || layoutPreset === "bento-command" || tweaks.hideSidebars) {
          autoMutations.push({ action: "setInert", selector: "[data-rd-role='sidebar']", hide: true });
        }
        for (const tbl of siteGraph.pageProfile?.layoutTables || []) {
          autoMutations.push({ action: "unwrapLayoutTable", selector: tbl.selector });
        }

        // Only store preset-specific CSS in adapterCss (baseFloor is composed once by buildFullStylesheet!)
        const presetEditableCSS = compilePresetOnlyCSS(layoutPreset);
        const pinned = await isSitePinned(tab.url);
        await applyDesignToTab(tabId, {
          profileId: request.profileId || "obsidian",
          layoutPreset,
          adapterCss: presetEditableCSS,
          domMutations: autoMutations,
          tweaks,
          designDirection: `Quick ${layoutPreset}`,
          isEnforcedOnSite: pinned
        });

        await new Promise((r) => setTimeout(r, 200));
        const auditRes = await chrome.tabs.sendMessage(tabId, { action: "AUDIT_RENDERED_PAGE" }).catch(() => null);
        const audit = auditRes?.data || null;
        if (audit) await saveLastAuditToTabState(tabId, audit);

        return { applied: true, cssRules: presetEditableCSS, domMutations: autoMutations, audit };
      }

      case "RUN_PAGE_AUDIT": {
        const tabId = request.tabId || (await getActiveTabId());
        await ensureContentScript(tabId);
        const auditRes = await chrome.tabs.sendMessage(tabId, { action: "AUDIT_RENDERED_PAGE" });
        const audit = auditRes?.data || null;
        if (audit) await saveLastAuditToTabState(tabId, audit);
        return { audit };
      }

      case "UPDATE_USER_TWEAKS": {
        const tabId = request.tabId || (await getActiveTabId());
        await chrome.storage.local.set({ userTweaks: request.tweaks });
        const state = await getTabState(tabId);
        if (!state) return { skipped: true };

        const tab = await chrome.tabs.get(tabId);
        const pinned = await isSitePinned(tab.url);
        const nextMutations = [...(state.domMutations || [])].filter((m) => m._source !== "tweak-sidebar");
        if (request.tweaks?.hideSidebars) {
          nextMutations.push({
            action: "setInert",
            selector: "[data-rd-role='sidebar']",
            hide: true,
            _source: "tweak-sidebar"
          });
        }

        await applyDesignToTab(tabId, {
          ...state,
          tweaks: request.tweaks,
          domMutations: nextMutations,
          isEnforcedOnSite: pinned
        });
        return { updated: true };
      }

      case "SWITCH_PROFILE_ONLY": {
        const tabId = request.tabId || (await getActiveTabId());
        const state = await getTabState(tabId);
        if (!state) return { skipped: true };
        const tab = await chrome.tabs.get(tabId);
        const pinned = await isSitePinned(tab.url);
        await applyDesignToTab(tabId, {
          ...state,
          profileId: request.profileId,
          isEnforcedOnSite: pinned
        });
        return { switched: true, profileId: request.profileId };
      }

      case "APPLY_SAVED_DESIGN": {
        const tabId = request.tabId || (await getActiveTabId());
        const d = request.design;
        const tab = await chrome.tabs.get(tabId);
        const profileId = request.profileId || d.profileId || "obsidian";
        if (request.autoEnforce) {
          await updateSitePin(tab.url, true, { ...d, profileId });
        }
        const pinned = await isSitePinned(tab.url);
        await applyDesignToTab(tabId, {
          profileId,
          layoutPreset: d.layoutPreset || "auto",
          adapterCss: d.cssRules || "",
          domMutations: d.domMutations || [],
          tweaks: d.tweaks,
          designDirection: d.designDirection,
          designId: d.id,
          isEnforcedOnSite: pinned
        });
        await new Promise((r) => setTimeout(r, 200));
        const auditRes = await chrome.tabs.sendMessage(tabId, { action: "AUDIT_RENDERED_PAGE" }).catch(() => null);
        const audit = auditRes?.data || null;
        if (audit) await saveLastAuditToTabState(tabId, audit);
        return { applied: true, isEnforcedOnSite: pinned, audit };
      }

      case "IMPORT_RECIPE": {
        const tabId = request.tabId || (await getActiveTabId());
        const tab = await chrome.tabs.get(tabId);
        const recipe = request.recipe || {};
        const cssCheck = sanitizeAndValidateCSS(recipe.cssRules || "", {
          pageOrigin: tab?.url ? new URL(tab.url).origin : ""
        });
        const mutCheck = validateMutations(Array.isArray(recipe.domMutations) ? recipe.domMutations : []);
        if (!mutCheck.valid) {
          throw new Error(`Invalid recipe mutations: ${mutCheck.errors[0]}`);
        }
        const profileId = recipe.profileId || request.profileId || "obsidian";
        const layoutPreset = recipe.layoutPreset || "auto";
        const designDirection = (recipe.designDirection || "Imported Recipe").slice(0, 65);
        const pinned = await isSitePinned(tab.url);

        await applyDesignToTab(tabId, {
          profileId,
          layoutPreset,
          adapterCss: cssCheck.sanitizedCss,
          domMutations: mutCheck.mutations,
          tweaks: recipe.tweaks || DEFAULT_USER_TWEAKS,
          designDirection,
          isEnforcedOnSite: pinned
        });

        const saved = await saveGeneratedDesignToLibrary({
          tabUrl: tab.url,
          cssRules: cssCheck.sanitizedCss,
          domMutations: mutCheck.mutations,
          designDirection,
          profileId,
          layoutPreset,
          pinSite: pinned
        });

        await new Promise((r) => setTimeout(r, 200));
        const auditRes = await chrome.tabs.sendMessage(tabId, { action: "AUDIT_RENDERED_PAGE" }).catch(() => null);
        const audit = auditRes?.data || null;
        if (audit) await saveLastAuditToTabState(tabId, audit);

        return {
          imported: true,
          design: saved,
          cssRules: cssCheck.sanitizedCss,
          domMutations: mutCheck.mutations,
          designDirection,
          profileId,
          warnings: [...cssCheck.warnings, ...mutCheck.warnings],
          audit
        };
      }

      case "APPLY_CUSTOM_EDITS": {
        const tabId = request.tabId || (await getActiveTabId());
        const tab = await chrome.tabs.get(tabId);
        const pinned = await isSitePinned(tab.url);
        const applied = await applyDesignToTab(tabId, {
          profileId: request.profileId || "obsidian",
          adapterCss: request.cssRules || "",
          domMutations: request.domMutations || [],
          designDirection: request.designDirection || "Live Custom Edit",
          isEnforcedOnSite: pinned
        });
        await new Promise((r) => setTimeout(r, 200));
        const auditRes = await chrome.tabs.sendMessage(tabId, { action: "AUDIT_RENDERED_PAGE" }).catch(() => null);
        const audit = auditRes?.data || null;
        if (audit) await saveLastAuditToTabState(tabId, audit);
        return { applied: true, audit, cssWarnings: applied.cssWarnings };
      }

      case "TOGGLE_TAB_PREVIEW":
      case "HUD_TOGGLE_PREVIEW": {
        const tabId = request.tabId || sender.tab?.id || (await getActiveTabId());
        const out = await toggleTabPreview(tabId, request.disabled);
        if (request.action === "HUD_TOGGLE_PREVIEW") notifyTabStateChanged(tabId);
        return out;
      }

      case "REVERT_TAB":
      case "HUD_REVERT": {
        const tabId = request.tabId || sender.tab?.id || (await getActiveTabId());
        const out = await revertTab(tabId, true);
        if (request.action === "HUD_REVERT") notifyTabStateChanged(tabId);
        return out;
      }

      case "SET_SITE_PIN":
      case "HUD_SET_PIN": {
        const tabId = request.tabId || sender.tab?.id || (await getActiveTabId());
        const tab = await chrome.tabs.get(tabId);
        const state = await getTabState(tabId);
        if (!state && request.enforced) {
          throw new Error("Apply a layout design before pinning to this site.");
        }
        const pinned = await updateSitePin(tab.url, request.enforced, {
          id: state?.designId || `design_${Date.now()}`,
          designDirection: state?.designDirection || "Pinned Redesign",
          cssRules: state?.adapterCss || "",
          domMutations: state?.domMutations || [],
          profileId: state?.profileId || "obsidian",
          layoutPreset: state?.layoutPreset || "auto",
          tweaks: state?.tweaks || DEFAULT_USER_TWEAKS
        });
        await chrome.tabs
          .sendMessage(tabId, { action: "UPDATE_HUD_STATE", isEnforcedOnSite: pinned })
          .catch(() => {});
        if (request.action === "HUD_SET_PIN") notifyTabStateChanged(tabId);
        return { isEnforcedOnSite: pinned };
      }

      case "GET_TAB_STATE": {
        const tabId = request.tabId || (await getActiveTabId());
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        const state = await getTabState(tabId);
        const supported = isSupportedTabUrl(tab?.url || "");
        const pinned = tab?.url && supported ? await isSitePinned(tab.url) : false;
        let hostname = "";
        try {
          hostname = new URL(tab?.url || "").hostname;
        } catch {}
        return {
          tabId,
          hostname,
          isSupportedPage: supported,
          hasRedesign: Boolean(state),
          cssRules: state?.adapterCss || "",
          domMutations: state?.domMutations || [],
          designDirection: state?.designDirection || "",
          profileId: state?.profileId || null,
          layoutPreset: state?.layoutPreset || "auto",
          isPreviewDisabled: Boolean(state?.disabled),
          isEnforcedOnSite: pinned,
          lastAudit: state?.lastAudit || null
        };
      }

      default:
        return null;
    }
  };

  handleAsync()
    .then((data) => sendResponse({ success: true, ...(data || {}) }))
    .catch((err) => {
      emitLog(`Error: ${err.message}`, "error");
      sendResponse({ success: false, error: err.message });
    });
  return true;
});
}

async function saveLastAuditToTabState(tabId, audit) {
  const state = await getTabState(tabId);
  if (!state) return;
  state.lastAudit = {
    score: audit.score,
    criticalIssues: audit.criticalIssues || 0,
    minorIssues: audit.minorIssues || 0,
    totalIssues: audit.totalIssues || 0,
    topFixes: audit.topFixes || []
  };
  await setTabState(tabId, state);
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active browser tab found.");
  return tab.id;
}

async function ensureContentScript(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const url = tab?.url || "";
  if (!isSupportedTabUrl(url)) {
    throw new Error("Open a standard webpage (http/https) to redesign.");
  }
  try {
    await chrome.tabs.sendMessage(tabId, { action: "PING" });
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content-script.js"] });
    } catch (err) {
      if (url.startsWith("file://")) {
        throw new Error("Enable 'Allow access to file URLs' in chrome://extensions to redesign local files.");
      }
      throw err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return tab;
}

async function saveGeneratedDesignToLibrary({
  tabUrl,
  cssRules,
  domMutations = [],
  designDirection,
  profileId = "obsidian",
  layoutPreset = "auto",
  pinSite = false
}) {
  if (!cssRules || cssRules.trim().length < 15) return null;
  let hostname = "universal";
  try {
    hostname = new URL(tabUrl).hostname || "universal";
  } catch {}

  const entry = {
    id: `design_${Date.now()}`,
    hostname,
    designDirection: (designDirection || "Structural Redesign").slice(0, 65),
    cssRules,
    domMutations,
    profileId,
    layoutPreset,
    liked: false,
    enabled: true,
    createdAt: Date.now()
  };

  const stored = await chrome.storage.local.get(["savedDesignsLibrary"]);
  const library = Array.isArray(stored.savedDesignsLibrary) ? stored.savedDesignsLibrary : [];
  const filtered = library.filter(
    (d) => d.cssRules !== cssRules || JSON.stringify(d.domMutations) !== JSON.stringify(domMutations)
  );
  filtered.unshift(entry);

  await chrome.storage.local.set({
    savedDesignsLibrary: filtered.slice(0, 35),
    lastGeneratedCSS: cssRules,
    lastGeneratedMutations: domMutations,
    lastDesignDirection: entry.designDirection
  });

  if (pinSite && hostname !== "universal") {
    await updateSitePin(tabUrl, true, entry);
  }

  return entry;
}

async function captureCleanScreenshot(tabId, quality = 45) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !tab.active) return null;

  await chrome.tabs.sendMessage(tabId, { action: "PREPARE_SCREENSHOT" }).catch(() => {});
  await new Promise((r) => setTimeout(r, 55));
  let uri = null;
  try {
    uri = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality });
  } catch {
    uri = null;
  }
  await chrome.tabs.sendMessage(tabId, { action: "RESTORE_HUD" }).catch(() => {});
  return uri;
}

async function executeAgentRuntime({
  userPrompt,
  layoutPreset = "auto",
  profileId = "obsidian",
  apiKey,
  baseUrl,
  model,
  provider,
  agentMode = "react",
  refineMode = false
}) {
  if (activeRunController) {
    activeRunController.abort();
  }
  const runController = new AbortController();
  activeRunController = runController;

  const tabId = await getActiveTabId();
  let tab = await ensureContentScript(tabId);
  let pageOrigin = "";
  try {
    pageOrigin = new URL(tab.url).origin;
  } catch {}

  let existingWorkspace = null;
  const existingState = await getTabState(tabId);
  if (refineMode && existingState?.adapterCss) {
    existingWorkspace = {
      cssRules: existingState.adapterCss,
      domMutations: existingState.domMutations || [],
      designDirection: existingState.designDirection
    };
  } else if (!refineMode && existingState) {
    await revertTab(tabId, false);
    tab = await ensureContentScript(tabId);
    await new Promise((r) => setTimeout(r, 120));
  }

  persistRunState({ isRunning: true, startedAt: Date.now(), steps: {}, todos: [] });

  let currentStep = 1;

  try {
    emitStep(
      1,
      "active",
      existingWorkspace ? "Capturing current redesign to refine..." : "Scanning original HTML tree, tokens & layout..."
    );
    emitLog(
      existingWorkspace
        ? "Loading existing design workspace for refinement..."
        : "Extracting clean original HTML tree, CSS variables, spatial map & frameworks..."
    );

    const initialScreenshotUri = await captureCleanScreenshot(tabId, 45);
    const domResponse = await chrome.tabs.sendMessage(tabId, { action: "EXTRACT_SEMANTICS" });
    if (!domResponse?.data) throw new Error("Failed to extract page semantics.");
    const siteGraph = domResponse.data;

    const fwTag = siteGraph.pageProfile?.frameworks?.length
      ? ` | SPA: ${siteGraph.pageProfile.frameworks.join("+")}`
      : "";
    const tokCount = Object.keys(siteGraph.pageProfile?.siteCssVariables || {}).length;
    emitLog(
      `Archetype: ${siteGraph.pageProfile?.archetype || "general"} | ${siteGraph.recognizedComponents.length} landmarks | ${siteGraph.totalStampedGrids || 0} grids${fwTag}${tokCount ? ` | ${tokCount} CSS vars` : ""}.`
    );
    emitStep(
      1,
      "completed",
      `Mapped ${siteGraph.pageProfile?.archetype || "page"} (${siteGraph.totalStampedAffordances || 0} controls).`
    );

    const visionEnabled = isVisionCapable(model, provider) && Boolean(initialScreenshotUri);
    const alreadyPinned = await isSitePinned(tab.url);

    if (agentMode === "react") {
      currentStep = 2;
      emitLog(`Launching ${existingWorkspace ? "Refine" : "1-Shot Self-Heal"} Agent (${model})...`, "system");

      const runtime = new AgentRuntime({
        tabId,
        provider,
        model,
        apiKey,
        baseUrl,
        profileId,
        layoutPreset,
        isVision: visionEnabled,
        pageOrigin,
        abortSignal: runController.signal,
        existingWorkspace,
        applyDesignFn: (workspacePayload) =>
          applyDesignToTab(tabId, {
            profileId,
            layoutPreset,
            adapterCss: workspacePayload.cssRules,
            domMutations: workspacePayload.domMutations,
            designDirection: workspacePayload.designDirection,
            isEnforcedOnSite: alreadyPinned
          }),
        onStatus: (text) => emitLog(text, "action"),
        onStep: (step, status, desc) => {
          currentStep = step;
          emitStep(step, status, desc);
        },
        onTodos: (todos) => emitTodos(todos)
      });

      const reactResult = await runtime.run({
        userPrompt,
        initialData: siteGraph,
        initialScreenshotUri
      });

      if (reactResult.audit) {
        await saveLastAuditToTabState(tabId, reactResult.audit);
      }

      const savedEntry = await saveGeneratedDesignToLibrary({
        tabUrl: tab.url,
        cssRules: reactResult.cssRules || "",
        domMutations: reactResult.domMutations || [],
        designDirection: reactResult.summary || "Structural Workspace Redesign",
        profileId,
        layoutPreset,
        pinSite: alreadyPinned
      });

      emitLog(
        `✓ ${reactResult.summary}${reactResult.audit ? ` (QA ${reactResult.audit.score}/100)` : ""}`,
        "success"
      );
      return {
        success: true,
        designId: savedEntry?.id,
        cssRules: reactResult.cssRules || "",
        domMutations: reactResult.domMutations || [],
        designDirection: reactResult.summary,
        isEnforcedOnSite: alreadyPinned,
        audit: reactResult.audit || null
      };
    }

    // === Fast 2-Pass Pipeline Mode (supports BOTH fresh redesign AND Refine mode!) ===
    currentStep = 2;
    emitStep(2, "active", `${existingWorkspace ? "Refining" : "Architecting"} layout (${model})...`);
    const designPlan = await callModelDispatcher({
      provider,
      apiKey,
      baseUrl,
      model,
      role: "designer",
      layoutPreset,
      profileId,
      userPrompt,
      screenshotUri: initialScreenshotUri,
      siteGraph,
      existingWorkspace,
      isVision: visionEnabled,
      abortSignal: runController.signal
    });

    const cssRules = sanitizeAndValidateCSS(designPlan.cssRules || "", { pageOrigin }).sanitizedCss;
    const domMutations = validateMutations(Array.isArray(designPlan.domMutations) ? designPlan.domMutations : []).mutations;
    const designDirection = designPlan.designDirection || existingWorkspace?.designDirection || "Modernized Structural Layout";

    emitLog(`Architect: "${designDirection}" (${domMutations.length} DOM ops, ${cssRules.length}B CSS)`);
    emitStep(2, "completed", `${domMutations.length} layout ops + ${cssRules.length}B CSS`);

    currentStep = 3;
    emitStep(3, "active", "Applying structural ops & scoped stylesheet...");
    const applied = await applyDesignToTab(tabId, {
      profileId,
      layoutPreset,
      adapterCss: cssRules,
      domMutations,
      designDirection,
      isEnforcedOnSite: alreadyPinned
    });
    await new Promise((r) => setTimeout(r, 320));

    const valRes = await chrome.tabs.sendMessage(tabId, { action: "AUDIT_RENDERED_PAGE" });
    let validationReport = valRes?.data || { score: 100, criticalIssues: 0, totalIssues: 0 };
    emitLog(
      `Rendered! QA ${validationReport.score}/100 (${validationReport.criticalIssues || 0} critical, ${applied.healStats?.healedTexts || 0} contrast auto-heals).`
    );
    emitStep(3, "completed", `Rendered (QA ${validationReport.score}/100)`);

    currentStep = 4;
    let finalCSS = cssRules;
    let finalMutations = domMutations;

    if (visionEnabled || validationReport.totalIssues > 0) {
      emitStep(4, "active", "Critic auditing overlaps, occlusion & contrast...");
      const postScreenshot = visionEnabled ? await captureCleanScreenshot(tabId, 45) : null;
      try {
        const critic = await callModelDispatcher({
          provider,
          apiKey,
          baseUrl,
          model,
          role: "critic",
          layoutPreset,
          profileId,
          userPrompt,
          screenshotUri: postScreenshot,
          designPlan: { designDirection, cssRules, domMutations },
          siteGraph,
          validationReport,
          isVision: visionEnabled && Boolean(postScreenshot),
          abortSignal: runController.signal
        });

        const refinement = (critic?.refinementCSS || critic?.cssRules || "").trim();
        const criticMutations = Array.isArray(critic?.domMutations)
          ? validateMutations(critic.domMutations).mutations
          : null;

        if (refinement.length > 10 || criticMutations) {
          const candidateCSS = refinement.length > 10
            ? sanitizeAndValidateCSS(`${cssRules}\n\n/* === QA Critic Refinement === */\n${refinement}`, { pageOrigin }).sanitizedCss
            : cssRules;
          const candidateMutations = criticMutations || domMutations;

          await applyDesignToTab(tabId, {
            profileId,
            layoutPreset,
            adapterCss: candidateCSS,
            domMutations: candidateMutations,
            designDirection,
            isEnforcedOnSite: alreadyPinned
          });
          await new Promise((r) => setTimeout(r, 280));
          const postAuditRes = await chrome.tabs.sendMessage(tabId, { action: "AUDIT_RENDERED_PAGE" }).catch(() => null);
          const postAudit = postAuditRes?.data;

          if (postAudit && postAudit.score < validationReport.score - 8) {
            emitLog(
              `Critic patch regressed QA (${validationReport.score} → ${postAudit.score}); keeping cleaner initial build.`,
              "cooldown"
            );
            await applyDesignToTab(tabId, {
              profileId,
              layoutPreset,
              adapterCss: cssRules,
              domMutations,
              designDirection,
              isEnforcedOnSite: alreadyPinned
            });
          } else {
            finalCSS = candidateCSS;
            finalMutations = candidateMutations;
            if (postAudit) validationReport = postAudit;
            emitLog(`Critic polish verified (QA ${validationReport.score}/100).`);
          }
        }
        emitStep(4, "completed", `Verified (QA ${validationReport.score}/100).`);
      } catch (e) {
        emitLog(`Critic skipped (${e.message}).`, "cooldown");
        emitStep(4, "completed", "Initial layout preserved.");
      }
    } else {
      emitStep(4, "completed", "Verified (QA 100/100).");
    }

    await saveLastAuditToTabState(tabId, validationReport);

    const savedEntry = await saveGeneratedDesignToLibrary({
      tabUrl: tab.url,
      cssRules: finalCSS,
      domMutations: finalMutations,
      designDirection,
      profileId,
      layoutPreset,
      pinSite: alreadyPinned
    });

    return {
      success: true,
      designId: savedEntry?.id,
      cssRules: finalCSS,
      domMutations: finalMutations,
      designDirection,
      isEnforcedOnSite: alreadyPinned,
      audit: validationReport
    };
  } catch (err) {
    emitStep(currentStep, "error", err.message.slice(0, 75));
    throw err;
  } finally {
    if (activeRunController === runController) {
      activeRunController = null;
    }
    persistRunState({ isRunning: false });
  }
}

function buildPrompts(args) {
  if (args.role === "designer") {
    const skillBlock = buildLayoutSkillsPrompt({
      siteGraph: args.siteGraph,
      layoutPreset: args.layoutPreset,
      profileId: args.profileId,
      userPrompt: args.userPrompt
    });

    const preload = args.siteGraph.preloadedExploration || {};
    const refineNote = args.existingWorkspace
      ? `\nREFINE MODE: Improve the existing redesign below instead of starting from scratch!\nExisting CSS:\n${(args.existingWorkspace.cssRules || "").slice(0, 4000)}\nExisting Mutations:\n${JSON.stringify(args.existingWorkspace.domMutations || [])}\n`
      : "";

    const systemInstructions = `You are an elite Principal UI/UX Architect who structurally redesigns webpages.

${skillBlock}

Return ONLY valid JSON:
{
  "designDirection": "4-7 word architectural summary",
  "domMutations": [
    { "action": "createSlot|reparent|setInert|unwrapLayoutTable|wrapGroup|createHeroFromElement", ... }
  ],
  "cssRules": "/* Concise, clean structural & component CSS */"
}`;

    const userText = `<untrusted_page_data>
Title: ${args.siteGraph.title}
URL: ${args.siteGraph.url}
Page Profile: ${JSON.stringify(args.siteGraph.pageProfile)}
Spatial Map:
${JSON.stringify((preload.spatialMap || []).slice(0, 12), null, 2)}
HTML Tree:
${(preload.domTree || "").slice(0, 2400)}
Key Elements:
${JSON.stringify((preload.keyElements || args.siteGraph.recognizedComponents).slice(0, 8), null, 2)}
Sample Body Style:
${JSON.stringify(preload.styleProbes?.body?.ancestorBackgrounds || [], null, 2)}
</untrusted_page_data>${refineNote}`;

    return { systemInstructions, userText };
  }

  return {
    systemInstructions: `You are a Principal Visual & Accessibility Critic. Fix any overlapping cards, occluded controls, horizontal overflow, clashing boxes, buried/distorted images, or low contrast.
Return ONLY valid JSON:
{
  "criticAssessment": "Brief QA summary",
  "refinementCSS": "/* Corrective CSS rules */"
}`,
    userText: `Applied Direction: "${args.designPlan?.designDirection}"
Audit Report (QA ${args.validationReport?.score ?? 100}/100):
${JSON.stringify(args.validationReport || {}, null, 2)}
Existing CSS Snippet:
${(args.designPlan?.cssRules || "").slice(0, 2800)}`
  };
}

async function callModelDispatcher(args) {
  if (args.provider === "gemini") {
    return callGeminiWithFallback(args);
  }
  const providerCfg = PROVIDERS[args.provider] || PROVIDERS.openrouter;
  const url =
    args.provider === "custom"
      ? args.baseUrl || providerCfg.defaultBaseUrl
      : providerCfg.baseUrl;

  const headers = {};
  if (args.apiKey) headers.Authorization = `Bearer ${args.apiKey}`;
  if (args.provider === "openrouter") {
    headers["HTTP-Referer"] = "https://redesigner.local";
    headers["X-Title"] = "ReDesigner Studio";
  }

  return callOpenAICompatible({
    providerName: providerCfg.label,
    url,
    headers,
    ...args
  });
}

async function callOpenAICompatible(args) {
  const { systemInstructions, userText } = buildPrompts(args);
  const sendRequest = async (useVision) => {
    const userContent =
      useVision && args.screenshotUri
        ? [
            { type: "text", text: userText },
            { type: "image_url", image_url: { url: args.screenshotUri } }
          ]
        : userText;

    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 90000);
    const onAbort = () => controller.abort();
    args.abortSignal?.addEventListener("abort", onAbort, { once: true });

    try {
      const res = await fetch(args.url, {
        method: "POST",
        headers: { ...args.headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: args.model,
          messages: [
            { role: "system", content: systemInstructions },
            { role: "user", content: userContent }
          ],
          temperature: 0.45,
          max_tokens: 4096
        }),
        signal: controller.signal
      });

      if (!res.ok) {
        const errText = await res.text();
        let parsed;
        try {
          parsed = JSON.parse(errText);
        } catch {}
        const err = new Error(
          `${args.providerName}: ${parsed?.error?.message || parsed?.detail || `HTTP ${res.status}`}`
        );
        err.status = res.status;
        throw err;
      }

      const json = await res.json();
      const raw = json.choices?.[0]?.message?.content;
      if (!raw) throw new Error(`Empty response from ${args.providerName}.`);
      return parseLooseJson(raw);
    } catch (err) {
      if (args.abortSignal?.aborted) throw new Error("Agent stopped by user.");
      if (timedOut || err.name === "AbortError") throw new Error(`${args.model} timed out after 90s.`);
      throw err;
    } finally {
      clearTimeout(timeoutId);
      args.abortSignal?.removeEventListener("abort", onAbort);
    }
  };

  try {
    return await sendRequest(args.isVision);
  } catch (err) {
    if (
      args.isVision &&
      (err.status === 400 || err.status === 413 || err.status === 422 || /vision|image|multimodal/i.test(err.message))
    ) {
      emitLog(`Retrying ${args.providerName} in Semantic Text mode...`, "cooldown");
      return await sendRequest(false);
    }
    throw err;
  }
}

async function callGeminiWithFallback(args) {
  const stored = await chrome.storage.local.get(["fetchedModels_gemini"]);
  const fetchedModels = stored?.fetchedModels_gemini || [];
  const candidates = getGeminiFallbackChain(args.model, fetchedModels);
  let lastError = null;

  for (let i = 0; i < candidates.length; i++) {
    if (args.abortSignal?.aborted) throw new Error("Agent stopped by user.");
    const modelCandidate = candidates[i];
    try {
      return await executeGeminiRequest({ ...args, model: modelCandidate });
    } catch (err) {
      if (args.abortSignal?.aborted) throw new Error("Agent stopped by user.");
      lastError = err;
      if (/(api key not valid|invalid api key|permission_denied|unauthenticated|\(401\)|\(403\))/i.test(err.message)) {
        throw err;
      }
      if (/(is no longer available|not found|\(404\))/i.test(err.message)) {
        retiredGeminiModels.add(modelCandidate);
      }
      const next = candidates[i + 1];
      if (next) {
        emitLog(`⟳ ${modelCandidate} unavailable (${err.message.slice(0, 48)}) → switching to ${next}...`, "cooldown");
        continue;
      }
    }
  }
  throw lastError;
}

async function executeGeminiRequest({ apiKey, model, screenshotUri, role, abortSignal, ...rest }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const { systemInstructions, userText } = buildPrompts({ role, ...rest });

  const schema =
    role === "designer"
      ? {
          type: "OBJECT",
          properties: {
            designDirection: { type: "STRING" },
            domMutations: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  action: {
                    type: "STRING",
                    enum: ["createSlot", "reparent", "setInert", "unwrapLayoutTable", "wrapGroup", "createHeroFromElement"]
                  },
                  id: { type: "STRING" },
                  slotRole: { type: "STRING" },
                  anchorSelector: { type: "STRING" },
                  sourceSelector: { type: "STRING" },
                  targetSelector: { type: "STRING" },
                  selector: { type: "STRING" },
                  selectors: { type: "ARRAY", items: { type: "STRING" } },
                  position: { type: "STRING", enum: ["append", "prepend", "before", "after"] },
                  badgeText: { type: "STRING" },
                  ctaText: { type: "STRING" },
                  hide: { type: "BOOLEAN" }
                },
                required: ["action"]
              }
            },
            cssRules: { type: "STRING" }
          },
          required: ["designDirection", "domMutations", "cssRules"]
        }
      : {
          type: "OBJECT",
          properties: {
            criticAssessment: { type: "STRING" },
            refinementCSS: { type: "STRING" }
          },
          required: ["criticAssessment", "refinementCSS"]
        };

  const parts = [{ text: userText }];
  if (screenshotUri?.includes(",")) {
    parts.push({ inlineData: { mimeType: "image/jpeg", data: screenshotUri.split(",")[1] } });
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 90000);
  const onAbort = () => controller.abort();
  abortSignal?.addEventListener("abort", onAbort, { once: true });

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstructions }] },
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json", responseSchema: schema, maxOutputTokens: 4096 }
      })
    });
    const json = await res.json();
    if (!res.ok || json.error) throw new Error(`${json?.error?.message || `HTTP ${res.status}`} (${res.status})`);
    return parseLooseJson(json.candidates?.[0]?.content?.parts?.[0]?.text);
  } catch (err) {
    if (abortSignal?.aborted) throw new Error("Agent stopped by user.");
    if (timedOut || err.name === "AbortError") throw new Error("Timed out after 90s");
    throw err;
  } finally {
    clearTimeout(timeoutId);
    abortSignal?.removeEventListener("abort", onAbort);
  }
}

function emitStep(step, status, desc) {
  persistRunState({
    steps: { ...(currentRunState.steps || {}), [step]: { status, desc } }
  });
  chrome.runtime.sendMessage({ action: "AGENT_STEP_UPDATE", step, status, desc }, () => chrome.runtime.lastError);
}

function emitTodos(todos) {
  persistRunState({ todos });
  chrome.runtime.sendMessage({ action: "AGENT_TODOS_UPDATE", todos }, () => chrome.runtime.lastError);
}

function emitLog(text, logType = "action") {
  chrome.runtime.sendMessage({ action: "AGENT_LOG", text, logType }, () => chrome.runtime.lastError);
}
