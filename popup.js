// popup.js — Side Panel Studio Controller with Live QA Telemetry, Recipe Import/Export & Tab-Safe State Sync

import { PROVIDERS, isCodingEligibleModel, deriveCustomModelsUrl } from "./shared/providers.js";
import { PERSONAL_PROFILES } from "./shared/personal-profiles.js";
import { buildLayoutSkillsPrompt } from "./shared/skills.js";
import { DEFAULT_USER_TWEAKS } from "./shared/layout-blueprints.js";
import { parseLooseJson } from "./shared/json-utils.js";

let timerInterval = null;
let secondsElapsed = 0;

function initUI() {
  const settingsDrawer = document.getElementById("settings-drawer");
  const unsupportedBanner = document.getElementById("unsupported-banner");
  const btnToggleSettings = document.getElementById("btn-toggle-settings");
  const providerSelect = document.getElementById("provider-select");
  const agentModeSelect = document.getElementById("agent-mode-select");
  const customUrlField = document.getElementById("custom-url-field");
  const customBaseUrlInput = document.getElementById("custom-base-url");
  const apiKeyField = document.getElementById("api-key-field");
  const apiKeyLabel = document.getElementById("api-key-label");
  const apiKeyInput = document.getElementById("api-key");
  const modelSelect = document.getElementById("model-select");
  const customModelInput = document.getElementById("custom-model-input");
  const btnFetchModels = document.getElementById("btn-fetch-models");
  const profilePillsEl = document.getElementById("profile-pills");
  const layoutPresetSelect = document.getElementById("layout-preset-select");
  const promptInput = document.getElementById("user-prompt");
  const btnRun = document.getElementById("btn-run");
  const btnRefine = document.getElementById("btn-refine");
  const btnStop = document.getElementById("btn-stop");
  const btnQuickApply = document.getElementById("btn-quick-apply");
  const btnCompare = document.getElementById("btn-compare");
  const btnRevert = document.getElementById("btn-revert");
  const btnClearLogs = document.getElementById("btn-clear-logs");
  const btnToggleDesigns = document.getElementById("btn-toggle-designs");
  const designsCountEl = document.getElementById("designs-count");
  const designsDrawer = document.getElementById("designs-drawer");
  const savedDesignsList = document.getElementById("saved-designs-list");
  const drawerTabs = document.querySelectorAll(".designs-drawer .drawer-tab");
  const btnPinSite = document.getElementById("btn-pin-site");
  const btnLikeCurrent = document.getElementById("btn-like-current");
  const btnToggleCss = document.getElementById("btn-toggle-css");
  const cssInspector = document.getElementById("css-inspector");
  const cssEditor = document.getElementById("css-editor");
  const mutationsEditor = document.getElementById("mutations-editor");
  const tabCodeCss = document.getElementById("tab-code-css");
  const tabCodeMutations = document.getElementById("tab-code-mutations");
  const cssDirectionLabel = document.getElementById("css-direction-label");
  const btnApplyCss = document.getElementById("btn-apply-css");
  const btnImportRecipe = document.getElementById("btn-import-recipe");
  const recipeFileInput = document.getElementById("recipe-file-input");
  const btnExportRecipe = document.getElementById("btn-export-recipe");
  const btnCopyCss = document.getElementById("btn-copy-css");
  const terminalLogs = document.getElementById("terminal-logs");
  const checklistEl = document.getElementById("checklist");
  const timerDisplay = document.getElementById("cockpit-timer");
  const qaPill = document.getElementById("cockpit-qa-pill");
  const defaultChecklistHTML = checklistEl.innerHTML;

  const tweakMeasure = document.getElementById("tweak-measure");
  const tweakMeasureVal = document.getElementById("tweak-measure-val");
  const tweakFontScale = document.getElementById("tweak-font-scale");
  const tweakFontVal = document.getElementById("tweak-font-val");
  const tweakRadius = document.getElementById("tweak-radius");
  const tweakRadiusVal = document.getElementById("tweak-radius-val");
  const tweakCardCols = document.getElementById("tweak-card-cols");
  const tweakHideSidebars = document.getElementById("tweak-hide-sidebars");
  const btnResetTweaks = document.getElementById("btn-reset-tweaks");

  let activeProfileId = "obsidian";
  let activeTabId = null;
  let activeTabHostname = "";
  let currentTabSupported = true;
  let currentTabEnforced = false;
  let currentTabHasRedesign = false;
  let isAgentRunning = false;
  let currentDesignFilter = "all";
  let userTweaks = { ...DEFAULT_USER_TWEAKS };
  let tweakDebounce = null;
  let localAbortCtrl = null;

  Object.values(PROVIDERS).forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.label;
    providerSelect.appendChild(opt);
  });

  function updateQaBadge(audit) {
    if (!audit || typeof audit.score !== "number") {
      qaPill.classList.add("hidden");
      return;
    }
    const crit = audit.criticalIssues || 0;
    qaPill.textContent = `QA ${audit.score}${crit > 0 ? ` · ${crit}!` : ""}`;
    qaPill.className = `qa-pill ${audit.score >= 85 ? "" : audit.score >= 65 ? "mid" : "low"}`.trim();
  }

  function syncLikeButtonState() {
    const css = cssEditor.value.trim();
    if (!css) {
      btnLikeCurrent.textContent = "♡ Like";
      return;
    }
    chrome.storage.local.get(["savedDesignsLibrary"], (res) => {
      const list = Array.isArray(res.savedDesignsLibrary) ? res.savedDesignsLibrary : [];
      const found = list.find((d) => d.cssRules === css);
      btnLikeCurrent.textContent = found?.liked ? "♥ Liked" : "♡ Like";
    });
  }

  function renderProfilePills() {
    profilePillsEl.textContent = "";
    Object.values(PERSONAL_PROFILES).forEach((profile) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `profile-pill${profile.id === activeProfileId ? " active" : ""}`;
      const dots = document.createElement("span");
      dots.className = "swatch-dots";
      profile.swatches.forEach((hex) => {
        const dot = document.createElement("span");
        dot.className = "swatch-dot";
        if (CSS.supports("color", hex)) dot.style.background = hex;
        dots.appendChild(dot);
      });
      const label = document.createElement("span");
      label.textContent = profile.name;
      btn.appendChild(dots);
      btn.appendChild(label);
      btn.addEventListener("click", async () => {
        activeProfileId = profile.id;
        chrome.storage.local.set({ activeProfileId });
        renderProfilePills();
        const res = await sendToSW({ action: "SWITCH_PROFILE_ONLY", profileId: activeProfileId });
        if (res?.switched) {
          appendLog(`✦ Swapped theme to "${profile.name}" (0 AI calls).`, "success");
        } else {
          appendLog(`Theme set to "${profile.name}" — click ⚡ Quick or ✦ AI Redesign to apply.`, "system");
        }
      });
      profilePillsEl.appendChild(btn);
    });
  }

  function syncTweakControlsUI() {
    tweakMeasure.value = userTweaks.measureCh;
    tweakMeasureVal.textContent = `${userTweaks.measureCh}ch`;
    tweakFontScale.value = userTweaks.fontScale;
    tweakFontVal.textContent = `${Number(userTweaks.fontScale).toFixed(2)}×`;
    tweakRadius.value = userTweaks.radiusPx;
    tweakRadiusVal.textContent = `${userTweaks.radiusPx}px`;
    tweakCardCols.value = String(userTweaks.cardCols || 0);
    tweakHideSidebars.checked = Boolean(userTweaks.hideSidebars);
  }

  function scheduleTweaksPush() {
    syncTweakControlsUI();
    clearTimeout(tweakDebounce);
    tweakDebounce = setTimeout(() => {
      sendToSW({ action: "UPDATE_USER_TWEAKS", tweaks: userTweaks });
    }, 60);
  }

  tweakMeasure.addEventListener("input", () => { userTweaks.measureCh = Number(tweakMeasure.value); scheduleTweaksPush(); });
  tweakFontScale.addEventListener("input", () => { userTweaks.fontScale = Number(tweakFontScale.value); scheduleTweaksPush(); });
  tweakRadius.addEventListener("input", () => { userTweaks.radiusPx = Number(tweakRadius.value); scheduleTweaksPush(); });
  tweakCardCols.addEventListener("change", () => { userTweaks.cardCols = Number(tweakCardCols.value); scheduleTweaksPush(); });
  tweakHideSidebars.addEventListener("change", () => { userTweaks.hideSidebars = tweakHideSidebars.checked; scheduleTweaksPush(); });

  btnResetTweaks.addEventListener("click", () => {
    userTweaks = { ...DEFAULT_USER_TWEAKS };
    scheduleTweaksPush();
    appendLog("Reset ergonomic sliders to defaults.", "system");
  });

  qaPill.addEventListener("click", async () => {
    const res = await sendToSW({ action: "RUN_PAGE_AUDIT" });
    if (res?.audit) {
      updateQaBadge(res.audit);
      appendLog(
        `QA Audit: ${res.audit.score}/100 (${res.audit.criticalIssues || 0} critical, ${res.audit.minorIssues || 0} minor).`,
        res.audit.score >= 85 ? "success" : "cooldown"
      );
      (res.audit.topFixes || []).slice(0, 3).forEach((fix) => appendLog(`  • ${fix}`, "cooldown"));
    }
  });

  function populateModelList(models, savedModel) {
    modelSelect.textContent = "";
    models.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label || m.id;
      if (savedModel && savedModel === m.id) opt.selected = true;
      modelSelect.appendChild(opt);
    });
  }

  function updateProviderUI(providerKey, savedModel) {
    const cfg = PROVIDERS[providerKey] || PROVIDERS.gemini;
    apiKeyLabel.textContent = cfg.keyLabel;
    apiKeyInput.placeholder = cfg.keyPlaceholder;
    customUrlField.classList.toggle("hidden", providerKey !== "custom");
    apiKeyField.classList.toggle("hidden", providerKey === "chrome-builtin");
    btnFetchModels.classList.toggle("hidden", providerKey === "chrome-builtin");

    chrome.storage.local.get([`apiKey_${providerKey}`, `fetchedModels_${providerKey}`, "customBaseUrl"], (res) => {
      apiKeyInput.value = res[`apiKey_${providerKey}`] || "";
      if (res.customBaseUrl) customBaseUrlInput.value = res.customBaseUrl;
      const cached = res[`fetchedModels_${providerKey}`];
      if (Array.isArray(cached) && cached.length > 0) {
        const seen = new Set(cfg.defaultModels.map((m) => m.id));
        populateModelList([...cfg.defaultModels, ...cached.filter((m) => !seen.has(m.id))], savedModel);
      } else {
        populateModelList(cfg.defaultModels, savedModel);
      }
      if (cfg.requiresKey && !apiKeyInput.value) {
        settingsDrawer.classList.remove("hidden");
      }
    });
  }

  btnToggleSettings.addEventListener("click", () => settingsDrawer.classList.toggle("hidden"));

  chrome.storage.local.get(
    [
      "selectedProvider",
      "selectedAgentMode",
      "selectedModel",
      "customModel",
      "activeProfileId",
      "selectedLayoutPreset",
      "userTweaks",
      "lastPrompt",
      "agentRunState"
    ],
    async (res) => {
      activeProfileId = res.activeProfileId || "obsidian";
      userTweaks = { ...DEFAULT_USER_TWEAKS, ...(res.userTweaks || {}) };
      renderProfilePills();
      syncTweakControlsUI();

      if (res.selectedLayoutPreset) layoutPresetSelect.value = res.selectedLayoutPreset;
      const provider = res.selectedProvider || "gemini";
      providerSelect.value = provider;
      agentModeSelect.value = res.selectedAgentMode || "react";
      updateProviderUI(provider, res.selectedModel);
      if (res.customModel) customModelInput.value = res.customModel;
      if (res.lastPrompt) promptInput.value = res.lastPrompt;

      if (res.agentRunState?.isRunning) {
        const status = await sendToSW({ action: "CHECK_AGENT_STATUS" });
        if (status?.isRunning) {
          setRunningState(true);
          if (Array.isArray(res.agentRunState.todos) && res.agentRunState.todos.length > 0) {
            renderDynamicTodos(res.agentRunState.todos);
          } else if (res.agentRunState.steps) {
            for (const [step, info] of Object.entries(res.agentRunState.steps)) {
              updateStepUI(step, info.status, info.desc);
            }
          }
          startTimer(Math.max(0, Math.floor((Date.now() - res.agentRunState.startedAt) / 1000)));
        } else {
          chrome.storage.local.set({ agentRunState: { isRunning: false, steps: {}, todos: [] } });
          setRunningState(false);
        }
      }
    }
  );

  async function syncActiveTabState() {
    const state = await sendToSW({ action: "GET_TAB_STATE" });
    if (state?.tabId) activeTabId = state.tabId;
    activeTabHostname = state?.hostname || "";
    currentTabSupported = state?.isSupportedPage !== false;
    currentTabHasRedesign = Boolean(state?.hasRedesign);

    unsupportedBanner.classList.toggle("hidden", currentTabSupported);
    btnRefine.classList.toggle("hidden", !currentTabHasRedesign || !currentTabSupported);
    if (!isAgentRunning) {
      btnRun.disabled = !currentTabSupported;
      btnQuickApply.disabled = !currentTabSupported;
      btnRefine.disabled = !currentTabSupported;
    }

    if (state?.hasRedesign) {
      cssEditor.value = state.cssRules || "";
      mutationsEditor.value = JSON.stringify(state.domMutations || [], null, 2);
      cssDirectionLabel.textContent = state.designDirection || "Active Redesign";
      if (state.profileId && PERSONAL_PROFILES[state.profileId]) {
        activeProfileId = state.profileId;
        renderProfilePills();
      }
      updateCompareButtonUI(state.isPreviewDisabled);
      updateQaBadge(state.lastAudit);
    } else {
      cssEditor.value = "";
      mutationsEditor.value = "[]";
      cssDirectionLabel.textContent = "Adapter Code";
      updateCompareButtonUI(false);
      updateQaBadge(null);
    }

    syncLikeButtonState();
    updatePinButtonUI(Boolean(state?.isEnforcedOnSite));
    refreshSavedDesignsGallery();
  }

  syncActiveTabState();
  chrome.tabs.onActivated?.addListener(({ tabId }) => {
    activeTabId = tabId;
    syncActiveTabState();
  });
  chrome.tabs.onUpdated?.addListener((tabId, info) => {
    if (info.status === "complete" && (!activeTabId || tabId === activeTabId)) {
      syncActiveTabState();
    }
  });

  providerSelect.addEventListener("change", () => {
    updateProviderUI(providerSelect.value);
    chrome.storage.local.set({ selectedProvider: providerSelect.value });
  });

  modelSelect.addEventListener("change", () => {
    chrome.storage.local.set({ selectedModel: modelSelect.value });
  });

  agentModeSelect.addEventListener("change", () => {
    chrome.storage.local.set({ selectedAgentMode: agentModeSelect.value });
  });

  // Auto-persist settings & inputs immediately so users never lose keys/URLs when closing the side panel
  apiKeyInput.addEventListener("change", () => {
    chrome.storage.local.set({ [`apiKey_${providerSelect.value}`]: apiKeyInput.value.trim() });
  });
  customBaseUrlInput.addEventListener("change", () => {
    chrome.storage.local.set({ customBaseUrl: customBaseUrlInput.value.trim() });
  });
  customModelInput.addEventListener("change", () => {
    chrome.storage.local.set({ customModel: customModelInput.value.trim() });
  });
  layoutPresetSelect.addEventListener("change", () => {
    chrome.storage.local.set({ selectedLayoutPreset: layoutPresetSelect.value });
  });
  promptInput.addEventListener("change", () => {
    chrome.storage.local.set({ lastPrompt: promptInput.value.trim() });
  });

  // Keyboard ergonomics: Cmd/Ctrl+Enter in prompt triggers AI Redesign (or Refine when active + non-empty)
  promptInput.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !isAgentRunning && currentTabSupported) {
      e.preventDefault();
      startPipeline({ refineMode: currentTabHasRedesign && Boolean(promptInput.value.trim()) });
    }
  });

  // Cmd/Ctrl+S in Code Inspector applies live CSS + mutations edits
  const onCodeSaveKey = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      btnApplyCss.click();
    }
  };
  cssEditor.addEventListener("keydown", onCodeSaveKey);
  mutationsEditor.addEventListener("keydown", onCodeSaveKey);

  btnStop.addEventListener("click", async () => {
    localAbortCtrl?.abort();
    await sendToSW({ action: "ABORT_AGENT_PIPELINE" });
    stopTimer();
    setRunningState(false);
    appendLog("■ Stopped by user.", "cooldown");
  });

  btnQuickApply.addEventListener("click", async () => {
    const layoutPreset = layoutPresetSelect.value === "auto" ? "bento-command" : layoutPresetSelect.value;
    const res = await sendToSW({
      action: "APPLY_QUICK_LAYOUT",
      layoutPreset,
      profileId: activeProfileId,
      tweaks: userTweaks
    });
    if (res?.applied) {
      currentTabHasRedesign = true;
      btnRefine.classList.remove("hidden");
      cssEditor.value = res.cssRules || "";
      mutationsEditor.value = JSON.stringify(res.domMutations || [], null, 2);
      cssDirectionLabel.textContent = `Quick ${layoutPreset}`;
      updateCompareButtonUI(false);
      updateQaBadge(res.audit);
      syncLikeButtonState();
      appendLog(
        `⚡ Quick Layout "${layoutPreset}" applied${res.audit ? ` (QA ${res.audit.score}/100)` : ""}!`,
        "success"
      );
    } else {
      appendLog(res?.error || "Could not apply quick layout.", "error");
    }
  });

  btnFetchModels.addEventListener("click", async () => {
    const provider = providerSelect.value;
    const cfg = PROVIDERS[provider];
    const key = apiKeyInput.value.trim();
    const modelsUrl =
      provider === "custom" ? deriveCustomModelsUrl(customBaseUrlInput.value) : cfg?.modelsUrl;
    if (!modelsUrl) return;
    if (cfg.requiresKey && !key && provider !== "openrouter") {
      appendLog(`Enter ${cfg.keyLabel} first.`, "error");
      return;
    }

    const prevSelected = modelSelect.value;
    btnFetchModels.textContent = "Loading...";
    try {
      const headers = {};
      if (provider === "gemini") headers["x-goog-api-key"] = key;
      else if (key) headers.Authorization = `Bearer ${key}`;
      const res = await fetch(modelsUrl, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      let list =
        provider === "gemini"
          ? (json.models || [])
              .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
              .map((m) => ({ id: m.name.replace(/^models\//, ""), label: m.displayName || m.name }))
          : (json.data || json.models || []).map((m) => ({ id: m.id || m.name, label: m.id || m.name }));
      list = list.filter((m) => m.id && isCodingEligibleModel(m.id));
      populateModelList(list, prevSelected);
      chrome.storage.local.set({
        [`apiKey_${provider}`]: key,
        [`fetchedModels_${provider}`]: list,
        selectedModel: modelSelect.value
      });
      appendLog(`✓ Loaded ${list.length} coding/vision models.`, "success");
    } catch (err) {
      appendLog(`Fetch failed: ${err.message}`, "error");
    } finally {
      btnFetchModels.textContent = "↻ Fetch Models";
    }
  });

  async function startPipeline({ refineMode = false }) {
    const provider = providerSelect.value;
    const cfg = PROVIDERS[provider];
    const apiKey = apiKeyInput.value.trim();
    const baseUrl = customBaseUrlInput.value.trim();
    const model = customModelInput.value.trim() || modelSelect.value;
    const layoutPreset = layoutPresetSelect.value;
    const userPrompt = promptInput.value.trim();
    const agentMode = agentModeSelect.value;

    if (cfg.requiresKey && !apiKey) {
      settingsDrawer.classList.remove("hidden");
      apiKeyInput.focus();
      appendLog(`Missing ${cfg.keyLabel}.`, "error");
      return;
    }

    chrome.storage.local.set({
      [`apiKey_${provider}`]: apiKey,
      customBaseUrl: baseUrl,
      selectedProvider: provider,
      selectedAgentMode: agentMode,
      selectedModel: modelSelect.value,
      customModel: customModelInput.value.trim(),
      selectedLayoutPreset: layoutPreset,
      activeProfileId,
      userTweaks,
      lastPrompt: userPrompt
    });

    resetChecklist();
    startTimer(0);
    setRunningState(true);
    updateCompareButtonUI(false);

    try {
      if (provider === "chrome-builtin") {
        await runChromeBuiltInAI({ layoutPreset, userPrompt });
        return;
      }

      const response = await sendToSW({
        action: "START_AGENT_PIPELINE",
        userPrompt,
        layoutPreset,
        profileId: activeProfileId,
        apiKey,
        baseUrl,
        model,
        provider,
        agentMode,
        refineMode
      });

      if (!response?.success) {
        appendLog(`Pipeline error: ${response?.error || "Unknown error"}`, "error");
      } else {
        currentTabHasRedesign = true;
        btnRefine.classList.remove("hidden");
        cssEditor.value = response.result?.cssRules || "";
        mutationsEditor.value = JSON.stringify(response.result?.domMutations || [], null, 2);
        cssDirectionLabel.textContent = response.result?.designDirection || "Layout Redesign";
        updatePinButtonUI(Boolean(response.result?.isEnforcedOnSite));
        updateQaBadge(response.result?.audit);
        syncLikeButtonState();
        refreshSavedDesignsGallery();
        appendLog(
          `✓ Complete in ${secondsElapsed}s${response.result?.audit ? ` (QA ${response.result.audit.score}/100)` : ""}!`,
          "success"
        );
      }
    } finally {
      stopTimer();
      setRunningState(false);
    }
  }

  btnRun.addEventListener("click", () => startPipeline({ refineMode: false }));
  btnRefine.addEventListener("click", () => startPipeline({ refineMode: true }));

  async function runChromeBuiltInAI({ layoutPreset, userPrompt }) {
    if (typeof LanguageModel === "undefined") {
      appendLog("Chrome Built-in LanguageModel API is unavailable in this Chrome build.", "error");
      return;
    }

    const modelOpts = {
      expectedInputs: [{ type: "text", languages: ["en"] }],
      expectedOutputs: [{ type: "text", languages: ["en"] }]
    };

    const avail = await LanguageModel.availability(modelOpts);
    if (avail === "unavailable") {
      appendLog("On-device Gemini Nano is unavailable on this device.", "error");
      return;
    }

    updateStepUI(1, "active", "Scanning layout & card slots...");
    const prep = await sendToSW({ action: "PREPARE_BUILTIN_AI" });
    if (!prep?.siteGraph) throw new Error("Failed to scan page.");
    updateStepUI(1, "completed", `Mapped ${prep.siteGraph.pageProfile?.archetype || "page"}`);

    updateStepUI(2, "active", avail === "available" ? "Running local Gemini Nano..." : "Downloading on-device model...");
    const skills = buildLayoutSkillsPrompt({
      siteGraph: prep.siteGraph,
      layoutPreset,
      profileId: activeProfileId,
      userPrompt
    });

    localAbortCtrl = new AbortController();
    let session = null;

    try {
      session = await LanguageModel.create({
        ...modelOpts,
        signal: localAbortCtrl.signal,
        initialPrompts: [{ role: "system", content: `You are a Principal UI/UX Layout Architect.\n${skills}` }],
        monitor(m) {
          m.addEventListener("downloadprogress", (e) => {
            if (typeof e.loaded === "number") {
              const pct = Math.round((e.total ? e.loaded / e.total : e.loaded) * 100);
              updateStepUI(2, "active", `Downloading model: ${pct}%`);
            }
          });
        }
      });

      const schema = {
        type: "object",
        properties: {
          designDirection: { type: "string" },
          domMutations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                action: { type: "string" },
                id: { type: "string" },
                slotRole: { type: "string" },
                anchorSelector: { type: "string" },
                sourceSelector: { type: "string" },
                targetSelector: { type: "string" },
                selector: { type: "string" },
                position: { type: "string" },
                hide: { type: "boolean" }
              },
              required: ["action"]
            }
          },
          cssRules: { type: "string" }
        },
        required: ["designDirection", "domMutations", "cssRules"]
      };

      const raw = await session.prompt(
        `<untrusted_page_data>\nPage: ${prep.title}\nProfile: ${JSON.stringify(prep.siteGraph.pageProfile)}\nTree:\n${
          prep.siteGraph.preloadedExploration?.domTree?.slice(0, 2200) || ""
        }\n</untrusted_page_data>`,
        { responseConstraint: schema, signal: localAbortCtrl.signal }
      );

      const designPlan = parseLooseJson(raw);
      updateStepUI(2, "completed", designPlan.designDirection || "Local Layout Ready");
      updateStepUI(3, "active", "Injecting stylesheet & DOM ops...");

      const applied = await sendToSW({
        action: "APPLY_BUILTIN_AI_RESULT",
        tabId: prep.tabId,
        tabUrl: prep.url,
        profileId: activeProfileId,
        layoutPreset,
        designPlan
      });

      currentTabHasRedesign = true;
      btnRefine.classList.remove("hidden");
      cssEditor.value = designPlan.cssRules || "";
      mutationsEditor.value = JSON.stringify(designPlan.domMutations || [], null, 2);
      cssDirectionLabel.textContent = designPlan.designDirection || "Local Redesign";
      updateQaBadge(applied?.audit);
      syncLikeButtonState();
      updateStepUI(3, "completed", "Rendered");
      updateStepUI(4, "completed", "Local AI Complete");
      refreshSavedDesignsGallery();
      appendLog(`✓ Local AI finished: ${applied?.designDirection || "Done"}`, "success");
    } catch (err) {
      updateStepUI(2, "error", err.message.slice(0, 60));
      appendLog(`Local AI error: ${err.message}`, "error");
    } finally {
      session?.destroy();
      localAbortCtrl = null;
    }
  }

  tabCodeCss.addEventListener("click", () => {
    tabCodeCss.classList.add("active");
    tabCodeMutations.classList.remove("active");
    cssEditor.classList.remove("hidden");
    mutationsEditor.classList.add("hidden");
  });

  tabCodeMutations.addEventListener("click", () => {
    tabCodeMutations.classList.add("active");
    tabCodeCss.classList.remove("active");
    mutationsEditor.classList.remove("hidden");
    cssEditor.classList.add("hidden");
  });

  btnCompare.addEventListener("click", async () => {
    const res = await sendToSW({ action: "TOGGLE_TAB_PREVIEW" });
    if (res?.status === "NO_STYLES") {
      appendLog("No active redesign to compare yet.", "system");
      return;
    }
    updateCompareButtonUI(res.isPreviewDisabled);
  });

  btnRevert.addEventListener("click", async () => {
    await sendToSW({ action: "REVERT_TAB" });
    currentTabHasRedesign = false;
    btnRefine.classList.add("hidden");
    resetChecklist();
    updateCompareButtonUI(false);
    updatePinButtonUI(false);
    updateQaBadge(null);
    appendLog("Restored original layout & cleared site pin.", "system");
  });

  btnPinSite.addEventListener("click", async () => {
    const res = await sendToSW({ action: "SET_SITE_PIN", enforced: !currentTabEnforced });
    if (res?.success === false) {
      appendLog(res.error || "Apply a design first.", "cooldown");
      return;
    }
    updatePinButtonUI(Boolean(res?.isEnforcedOnSite));
    appendLog(res?.isEnforcedOnSite ? `📌 Pinned to ${activeTabHostname}` : "Site pin removed.", "system");
  });

  btnApplyCss.addEventListener("click", async () => {
    let parsedMutations = [];
    try {
      const txt = mutationsEditor.value.trim();
      parsedMutations = txt ? JSON.parse(txt) : [];
      if (!Array.isArray(parsedMutations)) throw new Error("mutations.json must be a JSON array.");
    } catch (err) {
      appendLog(`Invalid mutations.json: ${err.message}`, "error");
      return;
    }

    const res = await sendToSW({
      action: "APPLY_CUSTOM_EDITS",
      cssRules: cssEditor.value,
      domMutations: parsedMutations,
      profileId: activeProfileId,
      designDirection: cssDirectionLabel.textContent || "Live Custom Edit"
    });
    if (res?.applied) {
      currentTabHasRedesign = true;
      btnRefine.classList.remove("hidden");
      updateCompareButtonUI(false);
      updateQaBadge(res.audit);
      syncLikeButtonState();
      appendLog(
        `✓ Applied live edits${res.audit ? ` (QA ${res.audit.score}/100)` : ""}.`,
        "success"
      );
      (res.cssWarnings || []).forEach((w) => appendLog(`⚠ ${w}`, "cooldown"));
    } else {
      appendLog(res?.error || "Failed to apply custom edits.", "error");
    }
  });

  btnImportRecipe.addEventListener("click", () => {
    recipeFileInput.value = "";
    recipeFileInput.click();
  });

  recipeFileInput.addEventListener("change", async () => {
    const file = recipeFileInput.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const recipe = parseLooseJson(text);
      if (!recipe || typeof recipe !== "object" || (!recipe.cssRules && !Array.isArray(recipe.domMutations))) {
        throw new Error("File does not look like a valid ReDesigner recipe JSON.");
      }
      const res = await sendToSW({
        action: "IMPORT_RECIPE",
        recipe,
        profileId: recipe.profileId || activeProfileId
      });
      if (!res?.imported) throw new Error(res?.error || "Import failed");
      currentTabHasRedesign = true;
      btnRefine.classList.remove("hidden");
      cssEditor.value = res.cssRules || "";
      mutationsEditor.value = JSON.stringify(res.domMutations || [], null, 2);
      cssDirectionLabel.textContent = res.designDirection || "Imported Recipe";
      if (res.profileId && PERSONAL_PROFILES[res.profileId]) {
        activeProfileId = res.profileId;
        renderProfilePills();
      }
      updateCompareButtonUI(false);
      updateQaBadge(res.audit);
      syncLikeButtonState();
      refreshSavedDesignsGallery();
      appendLog(`✓ Imported recipe "${res.designDirection}"!`, "success");
      (res.warnings || []).forEach((w) => appendLog(`⚠ ${w}`, "cooldown"));
    } catch (err) {
      appendLog(`Import error: ${err.message}`, "error");
    }
  });

  btnExportRecipe.addEventListener("click", async () => {
    let parsedMutations = [];
    try {
      parsedMutations = JSON.parse(mutationsEditor.value || "[]");
    } catch {}
    const recipe = {
      schema: "redesigner-recipe/v3.3",
      hostname: activeTabHostname || "universal",
      designDirection: cssDirectionLabel.textContent || "Custom Recipe",
      profileId: activeProfileId,
      layoutPreset: layoutPresetSelect.value,
      tweaks: userTweaks,
      domMutations: parsedMutations,
      cssRules: cssEditor.value
    };
    const jsonText = JSON.stringify(recipe, null, 2);

    // Download portable .json recipe file (matches Import file workflow)
    try {
      const slug = (activeTabHostname || "universal").replace(/[^a-z0-9.-]/gi, "-");
      const blob = new Blob([jsonText], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${slug}-redesigner-recipe.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {}

    // Also copy to clipboard when focused
    try {
      await navigator.clipboard.writeText(jsonText);
      appendLog("✓ Exported recipe .json and copied to clipboard!", "success");
    } catch {
      appendLog("✓ Exported recipe .json file!", "success");
    }
  });

  btnCopyCss.addEventListener("click", async () => {
    const activeText = cssEditor.classList.contains("hidden") ? mutationsEditor.value : cssEditor.value;
    if (!activeText.trim()) return;
    try {
      await navigator.clipboard.writeText(activeText);
      btnCopyCss.textContent = "Copied!";
      setTimeout(() => (btnCopyCss.textContent = "Copy"), 1200);
    } catch {
      appendLog("Clipboard write failed.", "error");
    }
  });

  btnLikeCurrent.addEventListener("click", () => {
    const css = cssEditor.value.trim();
    if (!css) return;
    let parsedMutations = [];
    try {
      parsedMutations = JSON.parse(mutationsEditor.value || "[]");
    } catch {}

    chrome.storage.local.get(["savedDesignsLibrary"], (res) => {
      const list = Array.isArray(res.savedDesignsLibrary) ? res.savedDesignsLibrary : [];
      let found = list.find((d) => d.cssRules === css);
      if (found) found.liked = !found.liked;
      else {
        found = {
          id: `design_${Date.now()}`,
          hostname: activeTabHostname || "custom",
          designDirection: cssDirectionLabel.textContent || "Liked Design",
          cssRules: css,
          domMutations: parsedMutations,
          profileId: activeProfileId,
          liked: true,
          createdAt: Date.now()
        };
        list.unshift(found);
      }
      chrome.storage.local.set({ savedDesignsLibrary: list.slice(0, 35) }, () => {
        btnLikeCurrent.textContent = found.liked ? "♥ Liked" : "♡ Like";
        refreshSavedDesignsGallery();
      });
    });
  });

  btnToggleDesigns.addEventListener("click", () => {
    designsDrawer.classList.toggle("hidden");
    refreshSavedDesignsGallery();
  });

  btnToggleCss.addEventListener("click", () => cssInspector.classList.toggle("hidden"));

  btnClearLogs.addEventListener("click", () => {
    terminalLogs.textContent = "";
    appendLog("Cleared.", "system");
    chrome.storage.local.set({ agentRunState: { isRunning: false, steps: {}, todos: [] } });
    resetChecklist();
    setRunningState(false);
  });

  drawerTabs.forEach((tabBtn) => {
    tabBtn.addEventListener("click", () => {
      drawerTabs.forEach((b) => b.classList.remove("active"));
      tabBtn.classList.add("active");
      currentDesignFilter = tabBtn.dataset.tab || "all";
      refreshSavedDesignsGallery();
    });
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "AGENT_TODOS_UPDATE") renderDynamicTodos(msg.todos);
    else if (msg.action === "AGENT_STEP_UPDATE") updateStepUI(msg.step, msg.status, msg.desc);
    else if (msg.action === "AGENT_LOG") appendLog(msg.text, msg.logType || "action");
    else if (msg.action === "TAB_STATE_CHANGED" && (!msg.tabId || !activeTabId || msg.tabId === activeTabId)) {
      syncActiveTabState();
    }
  });

  function refreshSavedDesignsGallery() {
    chrome.storage.local.get(["savedDesignsLibrary"], (res) => {
      const all = Array.isArray(res.savedDesignsLibrary) ? res.savedDesignsLibrary : [];
      designsCountEl.textContent = String(all.length);

      let filtered = all;
      if (currentDesignFilter === "liked") filtered = all.filter((d) => d.liked);
      else if (currentDesignFilter === "site" && activeTabHostname) {
        filtered = all.filter((d) => d.hostname === activeTabHostname);
      }

      savedDesignsList.textContent = "";
      if (filtered.length === 0) {
        const empty = document.createElement("div");
        empty.className = "design-sub";
        empty.style.textAlign = "center";
        empty.style.padding = "10px";
        empty.textContent = "No saved layouts here yet.";
        savedDesignsList.appendChild(empty);
        return;
      }

      filtered.forEach((d) => {
        const item = document.createElement("div");
        item.className = "saved-design-item";

        const meta = document.createElement("div");
        meta.className = "design-meta";
        const title = document.createElement("div");
        title.className = "design-title";
        title.textContent = d.designDirection || "Saved Layout";
        const sub = document.createElement("div");
        sub.className = "design-sub";
        sub.textContent = `${d.hostname || "universal"} · ${PERSONAL_PROFILES[d.profileId]?.name || "Obsidian"}`;
        meta.appendChild(title);
        meta.appendChild(sub);

        const likeBtn = document.createElement("button");
        likeBtn.type = "button";
        likeBtn.className = `icon-btn${d.liked ? " liked" : ""}`;
        likeBtn.textContent = d.liked ? "♥" : "♡";
        likeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          d.liked = !d.liked;
          chrome.storage.local.set({ savedDesignsLibrary: all }, () => {
            syncLikeButtonState();
            refreshSavedDesignsGallery();
          });
        });

        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "icon-btn";
        delBtn.textContent = "✕";
        delBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          chrome.storage.local.set(
            { savedDesignsLibrary: all.filter((x) => x.id !== d.id) },
            () => {
              syncLikeButtonState();
              refreshSavedDesignsGallery();
            }
          );
        });

        item.appendChild(meta);
        item.appendChild(likeBtn);
        item.appendChild(delBtn);

        item.addEventListener("click", async () => {
          cssEditor.value = d.cssRules || "";
          mutationsEditor.value = JSON.stringify(d.domMutations || [], null, 2);
          cssDirectionLabel.textContent = d.designDirection || "Saved Layout";
          const res = await sendToSW({
            action: "APPLY_SAVED_DESIGN",
            design: d,
            profileId: activeProfileId,
            autoEnforce: false
          });
          currentTabHasRedesign = true;
          btnRefine.classList.remove("hidden");
          updateCompareButtonUI(false);
          updatePinButtonUI(Boolean(res?.isEnforcedOnSite));
          updateQaBadge(res?.audit);
          syncLikeButtonState();
          appendLog(`✦ Applied "${d.designDirection}"`, "success");
        });

        savedDesignsList.appendChild(item);
      });
    });
  }

  function updatePinButtonUI(pinned) {
    currentTabEnforced = Boolean(pinned);
    btnPinSite.classList.toggle("enforced", currentTabEnforced);
    btnPinSite.textContent = currentTabEnforced ? "📌 Pinned: ON" : "📌 Pin: OFF";
  }

  function updateCompareButtonUI(disabled) {
    btnCompare.classList.toggle("active-compare", Boolean(disabled));
    btnCompare.textContent = disabled ? "Show New" : "Compare";
  }

  function updateStepUI(step, status, desc) {
    let el = document.getElementById(`step-${step}`);
    if (!el) el = checklistEl.querySelector(".check-item.active") || checklistEl.lastElementChild;
    if (!el) return;
    el.className = `check-item ${status}`;
    const descEl = el.querySelector(".check-desc");
    if (desc && descEl) descEl.textContent = desc;
  }

  function renderDynamicTodos(todos) {
    if (!Array.isArray(todos) || !todos.length) return;
    checklistEl.textContent = "";
    todos.forEach((t, i) => {
      const id = t.id || i + 1;
      const item = document.createElement("div");
      item.id = `step-${id}`;
      item.className = `check-item ${t.status || "pending"}`;
      const icon = document.createElement("div");
      icon.className = "check-icon";
      icon.textContent = String(id);
      const c = document.createElement("div");
      const ttl = document.createElement("div");
      ttl.className = "check-title";
      ttl.textContent = t.title || "";
      const d = document.createElement("div");
      d.className = "check-desc";
      d.textContent = t.desc || "";
      c.appendChild(ttl);
      c.appendChild(d);
      item.appendChild(icon);
      item.appendChild(c);
      checklistEl.appendChild(item);
    });
  }

  function resetChecklist() {
    checklistEl.innerHTML = defaultChecklistHTML;
  }

  function appendLog(text, type = "action") {
    const div = document.createElement("div");
    div.className = `log-entry ${type}`;
    div.textContent = `[${new Date().toLocaleTimeString([], { hour12: false })}] ${text}`;
    terminalLogs.appendChild(div);
    terminalLogs.scrollTop = terminalLogs.scrollHeight;
  }

  function startTimer(startAt = 0) {
    clearInterval(timerInterval);
    secondsElapsed = startAt;
    const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    timerDisplay.textContent = fmt(secondsElapsed);
    timerInterval = setInterval(() => {
      secondsElapsed++;
      timerDisplay.textContent = fmt(secondsElapsed);
    }, 1000);
  }

  function stopTimer() {
    clearInterval(timerInterval);
  }

  function setRunningState(running) {
    isAgentRunning = Boolean(running);
    btnRun.classList.toggle("hidden", running);
    btnStop.classList.toggle("hidden", !running);
    btnRun.disabled = running || !currentTabSupported;
    btnRefine.disabled = running || !currentTabSupported;
    btnQuickApply.disabled = running || !currentTabSupported;
  }

  function sendToSW(payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(payload, (res) => {
        if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message });
        else resolve(res);
      });
    });
  }
}

document.addEventListener("DOMContentLoaded", initUI);
