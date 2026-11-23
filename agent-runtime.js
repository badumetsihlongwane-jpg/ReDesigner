// agent-runtime.js — Validated, Regression-Guarded, Testable Multi-Turn Workspace Agent

import {
  PROVIDERS,
  retiredGeminiModels,
  getGeminiFallbackChain,
  cloneContentsForDifferentGeminiModel
} from "./shared/providers.js";
import { buildLayoutSkillsPrompt } from "./shared/skills.js";
import { sanitizeAndValidateCSS } from "./shared/css-sanitizer.js";
import { validateMutations } from "./shared/mutation-validator.js";
import { parseLooseJson } from "./shared/json-utils.js";

function createDefaultChromeEnv() {
  return {
    sendTabMessage: (tabId, payload) => chrome.tabs.sendMessage(tabId, payload),
    captureTabScreenshot: async (tabId) => {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab || !tab.active) return null;
      return chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 45 });
    },
    getStorage: (keys) => chrome.storage.local.get(keys),
    keepAlivePing: () => chrome.runtime.getPlatformInfo?.(() => {}),
    fetch: (url, opts) => fetch(url, opts),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms))
  };
}

export class AgentRuntime {
  constructor({
    tabId,
    provider,
    model,
    apiKey,
    baseUrl,
    profileId,
    layoutPreset,
    isVision,
    pageOrigin = "",
    abortSignal,
    existingWorkspace,
    applyDesignFn,
    onStatus,
    onStep,
    onTodos,
    env
  }) {
    this.tabId = tabId;
    this.provider = provider;
    this.model = model;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.profileId = profileId || "obsidian";
    this.layoutPreset = layoutPreset || "auto";
    this.isVision = Boolean(isVision);
    this.pageOrigin = pageOrigin || "";
    this.abortSignal = abortSignal || null;
    this.refineMode = Boolean(existingWorkspace?.cssRules);
    this.applyDesignFn = applyDesignFn;
    this.onStatus = onStatus || (() => {});
    this.onStep = onStep || (() => {});
    this.onTodos = onTodos || (() => {});
    this.env = { ...createDefaultChromeEnv(), ...(env || {}) };

    this.workspace = {
      "todos.json": "[]",
      "design-spec.json": existingWorkspace?.designDirection
        ? JSON.stringify({ designDirection: existingWorkspace.designDirection }, null, 2)
        : "",
      "mutations.json": existingWorkspace?.domMutations
        ? JSON.stringify(existingWorkspace.domMutations, null, 2)
        : "[]",
      "styles.css": existingWorkspace?.cssRules || ""
    };

    this.todos = [];
    this.checkpoints = [];
    this.currentCheckpointId = 0;
    this.bestCheckpoint = null; // { checkpointId, score, criticalIssues, workspace }
    this.workspaceDirty = false;
    this.history = [];
    this.geminiContents = [];
    this.systemPrompt = "";
    this.lastAudit = null;
    this.currentTurn = 0;
    this.maxTurns = 10;
    this.finishRejections = 0;
    this.activeGeminiModel = model;
    this.lastGeminiModelUsed = null;
    this.cachedFetchedGeminiModels = null;
    this.visionDowngraded = false;
  }

  getGeminiFunctionDeclarations(writePhaseOnly = false) {
    const all = [
      {
        name: "manage_todos",
        description: "Update your 4-step Todo plan.",
        parameters: {
          type: "OBJECT",
          properties: {
            todos: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  id: { type: "INTEGER" },
                  title: { type: "STRING" },
                  status: { type: "STRING", enum: ["pending", "in_progress", "completed"] },
                  detail: { type: "STRING" }
                },
                required: ["id", "title", "status", "detail"]
              }
            }
          },
          required: ["todos"]
        }
      },
      {
        name: "read_dom_tree",
        description: "Read annotated HTML skeleton from a specific CSS selector.",
        parameters: {
          type: "OBJECT",
          properties: {
            selector: { type: "STRING" },
            maxDepth: { type: "INTEGER" },
            maxChars: { type: "INTEGER" }
          },
          required: ["selector"]
        }
      },
      {
        name: "find_elements",
        description: "Find elements matching text, tag, or selector.",
        parameters: {
          type: "OBJECT",
          properties: {
            text: { type: "STRING" },
            tag: { type: "STRING" },
            selector: { type: "STRING" },
            limit: { type: "INTEGER" }
          }
        }
      },
      {
        name: "inspect_styles",
        description: "Inspect computed styles, effective background, contrast ratio, ancestorBackgrounds, and matchedSiteCssRules.",
        parameters: {
          type: "OBJECT",
          properties: { selector: { type: "STRING" } },
          required: ["selector"]
        }
      },
      {
        name: "read_file",
        description: "Read a workspace file with line numbers.",
        parameters: {
          type: "OBJECT",
          properties: {
            filename: { type: "STRING", enum: ["todos.json", "design-spec.json", "mutations.json", "styles.css"] }
          },
          required: ["filename"]
        }
      },
      {
        name: "write_file",
        description: "Write 'design-spec.json', 'mutations.json', or 'styles.css'. Validates CSS syntax/security and mutation schema immediately.",
        parameters: {
          type: "OBJECT",
          properties: {
            filename: { type: "STRING", enum: ["design-spec.json", "mutations.json", "styles.css"] },
            content: { type: "STRING" }
          },
          required: ["filename", "content"]
        }
      },
      {
        name: "edit_file",
        description: "Surgically replace exact old_text with new_text, or append_text, in 'styles.css', 'mutations.json', or 'design-spec.json'. Fails loudly if old_text is not found.",
        parameters: {
          type: "OBJECT",
          properties: {
            filename: { type: "STRING", enum: ["styles.css", "design-spec.json", "mutations.json"] },
            old_text: { type: "STRING" },
            new_text: { type: "STRING" },
            append_text: { type: "STRING" }
          },
          required: ["filename"]
        }
      },
      {
        name: "apply_and_render",
        description: "Render 'mutations.json' + 'styles.css' to the live page, return mutationReport + 10-point QA audit + live screenshot.",
        parameters: { type: "OBJECT", properties: {} }
      },
      {
        name: "audit_rendered_page",
        description: "Re-run the rendered DOM, card overlap, occlusion, overflow, image & WCAG contrast audit.",
        parameters: { type: "OBJECT", properties: {} }
      },
      {
        name: "take_screenshot",
        description: "Capture a fresh screenshot of the live tab. Optionally pass a CSS selector to scroll to that section before capturing.",
        parameters: {
          type: "OBJECT",
          properties: {
            selector: { type: "STRING" }
          }
        }
      },
      {
        name: "commit_checkpoint",
        description: "Save a workspace snapshot.",
        parameters: {
          type: "OBJECT",
          properties: { description: { type: "STRING" } },
          required: ["description"]
        }
      },
      {
        name: "undo_change",
        description: "Revert workspace and page to a checkpoint ID.",
        parameters: {
          type: "OBJECT",
          properties: { checkpointId: { type: "INTEGER" } },
          required: ["checkpointId"]
        }
      },
      {
        name: "finish_task",
        description: "Complete redesign after latest edits are rendered via apply_and_render and critical defects are resolved.",
        parameters: {
          type: "OBJECT",
          properties: { summary: { type: "STRING" } },
          required: ["summary"]
        }
      }
    ];

    if (writePhaseOnly) {
      return all.filter((f) => ["write_file", "edit_file", "apply_and_render"].includes(f.name));
    }
    return all;
  }

  getOpenAIToolsSchema(writePhaseOnly = false) {
    const toLower = (schema) => {
      if (!schema || typeof schema !== "object") return schema;
      const out = { ...schema };
      if (typeof out.type === "string") out.type = out.type.toLowerCase();
      if (out.properties) {
        out.properties = {};
        for (const [k, v] of Object.entries(schema.properties)) out.properties[k] = toLower(v);
      }
      if (out.items) out.items = toLower(schema.items);
      return out;
    };
    return this.getGeminiFunctionDeclarations(writePhaseOnly).map((fn) => ({
      type: "function",
      function: { name: fn.name, description: fn.description, parameters: toLower(fn.parameters) }
    }));
  }

  parseMutations() {
    try {
      const parsed = JSON.parse(this.workspace["mutations.json"] || "[]");
      const checked = validateMutations(parsed);
      return checked.mutations;
    } catch {
      return [];
    }
  }

  getSavedDirection() {
    try {
      const spec = JSON.parse(this.workspace["design-spec.json"] || "{}");
      if (spec.designDirection && typeof spec.designDirection === "string") return spec.designDirection;
      if (spec.theme && typeof spec.theme === "string") return spec.theme;
    } catch {}
    return "Structural Layout Redesign";
  }

  checkAborted() {
    if (this.abortSignal?.aborted) {
      throw new Error("Agent stopped by user.");
    }
  }

  createTurnFetchSignal(timeoutMs = 90000) {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    const onParentAbort = () => ctrl.abort();
    if (this.abortSignal) {
      if (this.abortSignal.aborted) onParentAbort();
      else this.abortSignal.addEventListener("abort", onParentAbort, { once: true });
    }
    return {
      signal: ctrl.signal,
      didTimeout: () => timedOut,
      cleanup: () => {
        clearTimeout(timer);
        if (this.abortSignal) this.abortSignal.removeEventListener("abort", onParentAbort);
      }
    };
  }

  validateWorkspaceFile(filename, content) {
    if (filename === "styles.css") {
      const check = sanitizeAndValidateCSS(content, { pageOrigin: this.pageOrigin });
      return {
        valid: check.valid,
        normalizedContent: check.sanitizedCss,
        errors: check.errors,
        warnings: check.warnings
      };
    }

    if (filename === "mutations.json") {
      let parsed;
      try {
        parsed = JSON.parse(content || "[]");
      } catch (err) {
        return {
          valid: false,
          normalizedContent: content,
          errors: [`Invalid JSON in mutations.json: ${err.message}`],
          warnings: []
        };
      }
      const check = validateMutations(parsed);
      return {
        valid: check.valid,
        normalizedContent: check.valid ? JSON.stringify(check.mutations, null, 2) : content,
        errors: check.errors,
        warnings: check.warnings
      };
    }

    if (filename === "design-spec.json") {
      try {
        JSON.parse(content || "{}");
        return { valid: true, normalizedContent: content, errors: [], warnings: [] };
      } catch (err) {
        return {
          valid: false,
          normalizedContent: content,
          errors: [`Invalid JSON in design-spec.json: ${err.message}`],
          warnings: []
        };
      }
    }

    return { valid: true, normalizedContent: content, errors: [], warnings: [] };
  }

  saveInternalCheckpoint(description) {
    const id = ++this.currentCheckpointId;
    this.checkpoints.push({
      id,
      description,
      workspace: { ...this.workspace }
    });
    return id;
  }

  async captureLiveScreenshot(selector = null) {
    if (!this.isVision || this.visionDowngraded) return null;
    await this.env.sendTabMessage(this.tabId, { action: "PREPARE_SCREENSHOT", selector }).catch(() => {});
    await this.env.sleep(60);
    let previewImage = null;
    try {
      previewImage = await this.env.captureTabScreenshot(this.tabId);
    } catch {}
    await this.env.sendTabMessage(this.tabId, { action: "RESTORE_HUD" }).catch(() => {});
    return previewImage;
  }

  async executeTool(name, args = {}) {
    this.checkAborted();
    switch (name) {
      case "manage_todos": {
        if (Array.isArray(args.todos) && args.todos.length > 0) {
          this.todos = args.todos.map((t, idx) => ({
            id: t.id || idx + 1,
            title: t.title || `Task ${idx + 1}`,
            status: t.status === "in_progress" ? "active" : t.status === "completed" ? "completed" : "pending",
            desc: t.detail || ""
          }));
          this.workspace["todos.json"] = JSON.stringify(this.todos, null, 2);
          this.onTodos(this.todos);
        }
        return { status: "todos_updated", total: this.todos.length };
      }

      case "read_dom_tree": {
        this.onStatus(`read_dom_tree("${args.selector || "body"}")`);
        const res = await this.env.sendTabMessage(this.tabId, {
          action: "READ_DOM_TREE",
          selector: args.selector || "body",
          maxDepth: args.maxDepth || 3,
          maxChars: args.maxChars || 3500
        });
        return res?.data || { error: "Could not read DOM tree" };
      }

      case "find_elements": {
        this.onStatus(`find_elements(${JSON.stringify(args)})`);
        const res = await this.env.sendTabMessage(this.tabId, { action: "FIND_ELEMENTS", ...args });
        return res?.data || { matches: [] };
      }

      case "inspect_styles": {
        this.onStatus(`inspect_styles("${args.selector}")`);
        const res = await this.env.sendTabMessage(this.tabId, { action: "INSPECT_STYLES", selector: args.selector });
        return res?.data || { error: "Element not found" };
      }

      case "read_file": {
        const raw = this.workspace[args.filename] || "";
        return raw ? raw.split("\n").map((l, i) => `${i + 1}\t${l}`).join("\n") : "[Empty]";
      }

      case "write_file": {
        const filename = args.filename;
        if (!["design-spec.json", "mutations.json", "styles.css"].includes(filename)) {
          return { status: "error", error: `Unsupported filename "${filename}"` };
        }
        const rawContent = typeof args.content === "string" ? args.content : JSON.stringify(args.content, null, 2);
        const validation = this.validateWorkspaceFile(filename, rawContent);

        if (!validation.valid && filename === "mutations.json") {
          this.onStatus(`write_file("${filename}") rejected: ${validation.errors[0]}`);
          return {
            status: "validation_error",
            filename,
            errors: validation.errors,
            warnings: validation.warnings,
            hint: "Fix the JSON/schema errors above and call write_file again."
          };
        }

        this.workspace[filename] = validation.normalizedContent;
        if (filename === "styles.css" || filename === "mutations.json") {
          this.workspaceDirty = true;
        }
        this.onStatus(`write_file("${filename}", ${validation.normalizedContent.length}B)`);

        return {
          status: validation.valid ? "written" : "written_with_errors",
          filename,
          bytes: validation.normalizedContent.length,
          errors: validation.errors.length ? validation.errors : undefined,
          warnings: validation.warnings.length ? validation.warnings : undefined
        };
      }

      case "edit_file": {
        const filename = args.filename || "styles.css";
        if (!["design-spec.json", "mutations.json", "styles.css"].includes(filename)) {
          return { status: "error", error: `Unsupported filename "${filename}"` };
        }
        let current = String(this.workspace[filename] || "");
        let modified = false;

        if (args.old_text) {
          if (current.includes(args.old_text)) {
            current = current.replace(args.old_text, args.new_text ?? "");
            modified = true;
          } else {
            return {
              status: "error",
              filename,
              error: "old_text was not found verbatim in file. Call read_file first to verify exact text before editing.",
              filePreview: current.slice(0, 600)
            };
          }
        } else if (args.new_text) {
          current = current ? `${current}\n${args.new_text}` : args.new_text;
          modified = true;
        }

        if (args.append_text) {
          current = current ? `${current}\n\n${args.append_text}` : args.append_text;
          modified = true;
        }

        if (!modified) {
          return {
            status: "error",
            filename,
            error: "No edit applied. Provide old_text + new_text, or append_text."
          };
        }

        const validation = this.validateWorkspaceFile(filename, current);
        if (!validation.valid && filename === "mutations.json") {
          return {
            status: "validation_error",
            filename,
            errors: validation.errors,
            hint: "Edit was NOT saved because it produced invalid mutations.json."
          };
        }

        this.workspace[filename] = validation.normalizedContent;
        if (filename === "styles.css" || filename === "mutations.json") {
          this.workspaceDirty = true;
        }
        this.onStatus(`edit_file("${filename}", total ${validation.normalizedContent.length}B)`);

        return {
          status: validation.valid ? "edited" : "edited_with_errors",
          filename,
          totalBytes: validation.normalizedContent.length,
          errors: validation.errors.length ? validation.errors : undefined,
          warnings: validation.warnings.length ? validation.warnings : undefined
        };
      }

      case "apply_and_render": {
        this.onStatus("Rendering layout + running 10-point QA audit...");
        const mutations = this.parseMutations();
        const designDirection = this.getSavedDirection();
        const cssCheck = sanitizeAndValidateCSS(this.workspace["styles.css"] || "", { pageOrigin: this.pageOrigin });
        const cleanCss = cssCheck.sanitizedCss;
        this.workspace["styles.css"] = cleanCss;

        const applied = await this.applyDesignFn({
          designDirection,
          cssRules: cleanCss,
          domMutations: mutations
        });
        this.workspaceDirty = false;
        await this.env.sleep(320);

        const auditRes = await this.env
          .sendTabMessage(this.tabId, { action: "AUDIT_RENDERED_PAGE" })
          .catch(() => null);
        this.lastAudit = auditRes?.data || { score: 100, criticalIssues: 0, minorIssues: 0, totalIssues: 0 };

        const checkpointId = this.saveInternalCheckpoint(`Turn ${this.currentTurn} (QA ${this.lastAudit.score})`);
        let regressionWarning = null;
        const score = typeof this.lastAudit.score === "number" ? this.lastAudit.score : 100;
        const critical = this.lastAudit.criticalIssues || 0;

        if (
          !this.bestCheckpoint ||
          score > this.bestCheckpoint.score ||
          (score === this.bestCheckpoint.score && critical < this.bestCheckpoint.criticalIssues)
        ) {
          this.bestCheckpoint = {
            checkpointId,
            score,
            criticalIssues: critical,
            workspace: { ...this.workspace }
          };
        } else if (score < this.bestCheckpoint.score - 12) {
          regressionWarning = `Score regressed from ${this.bestCheckpoint.score} (checkpoint #${this.bestCheckpoint.checkpointId}) down to ${score}. Fix the regression or call undo_change(${this.bestCheckpoint.checkpointId}).`;
        }

        const mutReport = applied?.mutationReport || { total: mutations.length, applied: mutations.length, skipped: 0, details: [] };
        this.onStatus(
          `QA ${score}/100 (${critical} critical, ${this.lastAudit.minorIssues || 0} minor | DOM ops ${mutReport.applied}/${mutReport.total})`
        );

        const previewImage = await this.captureLiveScreenshot(null);

        return {
          status: "rendered_and_audited",
          checkpointId,
          bestCheckpointId: this.bestCheckpoint?.checkpointId,
          cssBytes: cleanCss.length,
          cssWarnings: cssCheck.warnings.length ? cssCheck.warnings : undefined,
          cssErrors: cssCheck.errors.length ? cssCheck.errors : undefined,
          mutationReport: mutReport,
          healStats: applied?.healStats || {},
          audit: this.lastAudit,
          regressionWarning,
          previewImage
        };
      }

      case "audit_rendered_page": {
        const res = await this.env.sendTabMessage(this.tabId, { action: "AUDIT_RENDERED_PAGE" });
        this.lastAudit = res?.data || { score: 100, criticalIssues: 0, totalIssues: 0 };
        this.onStatus(`Audit Score: ${this.lastAudit.score}/100 (${this.lastAudit.totalIssues || 0} issues)`);
        return this.lastAudit;
      }

      case "take_screenshot": {
        this.onStatus(args.selector ? `Capturing screenshot at "${args.selector}"...` : "Capturing screenshot...");
        const previewImage = await this.captureLiveScreenshot(args.selector || null);
        return {
          status: previewImage ? "captured" : "capture_failed",
          scrolledTo: args.selector || null,
          previewImage
        };
      }

      case "commit_checkpoint": {
        const id = this.saveInternalCheckpoint(args.description || `#${this.currentCheckpointId + 1}`);
        return { status: "saved", checkpointId: id };
      }

      case "undo_change": {
        const target = this.checkpoints.find((c) => c.id === Number(args.checkpointId));
        if (!target) return { error: `Checkpoint #${args.checkpointId} not found` };
        this.workspace = { ...target.workspace };
        this.workspaceDirty = true;
        const renderResult = await this.executeTool("apply_and_render", {});
        return { status: "reverted", checkpointId: args.checkpointId, audit: renderResult.audit };
      }

      case "finish_task": {
        // Ensure latest edits were actually rendered & audited before allowing completion!
        if (this.workspaceDirty && (this.workspace["styles.css"] || "").trim().length > 0) {
          this.onStatus("Unrendered edits detected — rendering & auditing before finishing...");
          const renderRes = await this.executeTool("apply_and_render", {});
          if (
            (renderRes.audit?.criticalIssues > 0 || (renderRes.audit?.score ?? 100) < 80) &&
            this.currentTurn < this.maxTurns - 1 &&
            this.finishRejections < 2
          ) {
            this.finishRejections++;
            return {
              status: "rejected_needs_fix",
              message: "Auto-rendered your unapplied edits and found QA defects. Fix them and re-render before calling finish_task.",
              audit: renderRes.audit,
              previewImage: renderRes.previewImage
            };
          }
        }

        const hasCritical = (this.lastAudit?.criticalIssues || 0) > 0;
        const hasAnyIssues = (this.lastAudit?.totalIssues || 0) > 0;
        const maxRejections = hasCritical ? 2 : 1;

        if (
          this.lastAudit &&
          hasAnyIssues &&
          this.currentTurn < this.maxTurns - 1 &&
          this.finishRejections < maxRejections
        ) {
          this.finishRejections++;
          this.onStatus(`QA Pushback (${this.finishRejections}/${maxRejections}): fixing ${this.lastAudit.totalIssues} audit issues...`);
          return {
            status: "rejected_needs_fix",
            message:
              "Do NOT finish yet — audit detected layout/contrast/accessibility defects. Fix the topFixes via edit_file + apply_and_render, then call finish_task.",
            topFixes: this.lastAudit.topFixes || [],
            audit: this.lastAudit
          };
        }

        this.todos = this.todos.map((t) => ({ ...t, status: "completed" }));
        this.onTodos(this.todos);
        return { status: "complete", summary: args.summary || this.getSavedDirection() };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  }

  trimPreloadedContext(initialData) {
    const preload = initialData.preloadedExploration || {};
    const trimmedProbes = {};
    for (const [k, v] of Object.entries(preload.styleProbes || {})) {
      if (!v || typeof v !== "object") continue;
      trimmedProbes[k] = {
        selector: v.selector,
        inlineStyle: v.inlineStyle,
        effectiveBackground: v.effectiveBackground,
        contrastRatio: v.contrastRatio,
        computed: v.computed,
        ancestorBackgrounds: (v.ancestorBackgrounds || []).slice(0, 5),
        matchedSiteCssRules: (v.matchedSiteCssRules || []).slice(0, 4)
      };
    }
    return {
      domTree: (preload.domTree || "").slice(0, 2400),
      spatialMap: (preload.spatialMap || []).slice(0, 14),
      keyElements: (preload.keyElements || initialData.recognizedComponents || []).slice(0, 10),
      styleProbes: trimmedProbes
    };
  }

  /**
   * Prunes older intermediate screenshots in Gemini conversation history,
   * preserving the initial page screenshot (index 0) and the most recent screenshot.
   */
  pruneOldGeminiScreenshots() {
    let seenLatest = false;
    for (let i = this.geminiContents.length - 1; i >= 1; i--) {
      const turn = this.geminiContents[i];
      if (!Array.isArray(turn.parts)) continue;
      for (let j = turn.parts.length - 1; j >= 0; j--) {
        if (turn.parts[j]?.inlineData) {
          if (!seenLatest) {
            seenLatest = true;
          } else {
            turn.parts[j] = { text: "[Earlier intermediate screenshot omitted to save context]" };
          }
        }
      }
    }
  }

  /**
   * Atomic turn-aware compaction for OpenAI-compatible chat history.
   * NEVER slices between an assistant tool_calls message and its matching tool responses!
   */
  getCompactedOpenAIHistory(maxTailMessages = 10) {
    if (this.history.length <= maxTailMessages + 2) return this.history;

    const head = this.history.slice(0, 2); // [system, initial user prompt]
    const rest = this.history.slice(2);

    // Group remaining messages into atomic turns starting at assistant or standalone user messages
    const groups = [];
    for (let i = 0; i < rest.length; i++) {
      const msg = rest[i];
      if (msg.role === "assistant") {
        const group = [msg];
        // Attach all immediately following tool responses and attached screenshot user turns
        while (i + 1 < rest.length && (rest[i + 1].role === "tool" || rest[i + 1]._isScreenshotFollowup)) {
          i++;
          group.push(rest[i]);
        }
        groups.push(group);
      } else if (msg.role === "tool") {
        // Attach defensively to previous group if any
        if (groups.length > 0) groups[groups.length - 1].push(msg);
      } else {
        groups.push([msg]);
      }
    }

    const kept = [];
    let count = 0;
    for (let g = groups.length - 1; g >= 0; g--) {
      if (count > 0 && count + groups[g].length > maxTailMessages) break;
      kept.unshift(...groups[g]);
      count += groups[g].length;
    }

    // Strip older intermediate image_url screenshots in kept messages except the newest one
    let sawImage = false;
    const cleanedKept = kept.map((m) => ({ ...m }));
    for (let i = cleanedKept.length - 1; i >= 0; i--) {
      const msg = cleanedKept[i];
      if (Array.isArray(msg.content) && msg.content.some((p) => p.type === "image_url")) {
        if (!sawImage) {
          sawImage = true;
        } else {
          cleanedKept[i] = {
            role: msg.role,
            content: "[Earlier intermediate screenshot omitted to save context]"
          };
        }
      }
    }

    return [...head, ...cleanedKept];
  }

  async restoreBestCheckpointIfRegressed() {
    if (!this.bestCheckpoint || !this.lastAudit) return;
    const finalScore = typeof this.lastAudit.score === "number" ? this.lastAudit.score : 100;
    if (this.bestCheckpoint.score - finalScore >= 12) {
      this.onStatus(
        `Restoring best checkpoint #${this.bestCheckpoint.checkpointId} (QA ${this.bestCheckpoint.score} vs degraded ${finalScore})...`
      );
      this.workspace = { ...this.bestCheckpoint.workspace };
      this.workspaceDirty = true;
      await this.executeTool("apply_and_render", {});
    }
  }

  async run({ userPrompt, initialData, initialScreenshotUri }) {
    this.pageOrigin = this.pageOrigin || initialData?.origin || "";
    this.checkpoints.push({ id: 0, description: "Initial", workspace: { ...this.workspace } });

    this.todos = this.refineMode
      ? [
          { id: 1, title: "Inspect Current Redesign & Defects", status: "active", desc: "Reviewing live layout & audit" },
          { id: 2, title: "Patch CSS & DOM Mutations", status: "pending", desc: "Fixing overlaps, spacing & contrast" },
          { id: 3, title: "Re-Render & Verify QA", status: "pending", desc: "Checking screenshot & audit score" },
          { id: 4, title: "Finalize Polish", status: "pending", desc: "Completing refinement" }
        ]
      : [
          { id: 1, title: "Build Initial Design & Mutations", status: "active", desc: "Writing spec, mutations & CSS" },
          { id: 2, title: "Render & Inspect Screenshot/Audit", status: "pending", desc: "Checking grids, occlusion & contrast" },
          { id: 3, title: "Fix Visual/Layout Defects", status: "pending", desc: "Iterating with edit_file" },
          { id: 4, title: "Finalize Polish", status: "pending", desc: "Verifying clean render" }
        ];
    this.onTodos(this.todos);

    const skillBlock = buildLayoutSkillsPrompt({
      siteGraph: initialData,
      layoutPreset: this.layoutPreset,
      profileId: this.profileId,
      userPrompt
    });

    this.systemPrompt = `You are a Principal UI/UX Architect Agent inside ReDesigner Studio.
${
  this.refineMode
    ? "REFINE MODE: A redesign is ALREADY rendered (see current screenshot and existing styles.css / mutations.json). Keep what looks good, diagnose visual/overlap/contrast/occlusion flaws, and fix them via edit_file + apply_and_render!"
    : "1-SHOT SELF-HEAL MODE: Write concise, clean CSS (aim for 50-110 crisp lines, avoiding redundant rules) + mutations.json on Turn 1, call apply_and_render (which auto-audits & screenshots), then inspect & polish on Turns 2+!"
}

${skillBlock}

CRITICAL GRID & OVERLAP GUARDRAIL:
- NEVER let cards overlap! Whenever applying CSS Grid to \`[data-rd-role="card-grid"]\`, ALWAYS set \`width: 100%; min-width: 0; box-sizing: border-box; float: none;\` on \`[data-rd-role="card-item"]\`, use \`grid-template-columns: repeat(auto-fill, minmax(min(200px, 100%), 1fr))\`, and clear legacy floats or fixed pixel widths.`;

    const compactPreload = this.trimPreloadedContext(initialData);
    const refineContext = this.refineMode
      ? `\nCURRENT WORKSPACE styles.css:\n${this.workspace["styles.css"].slice(0, 5000)}\n\nCURRENT WORKSPACE mutations.json:\n${this.workspace["mutations.json"]}\n`
      : "";

    const userGoalText = `<untrusted_page_data>
Title: ${initialData.title}
URL: ${initialData.url}
Viewport: ${JSON.stringify(initialData.viewport || {})}
Profile: ${JSON.stringify(initialData.pageProfile)}
Spatial Map:
${JSON.stringify(compactPreload.spatialMap, null, 2)}
HTML TREE (compact):
${compactPreload.domTree}
KEY ELEMENTS:
${JSON.stringify(compactPreload.keyElements, null, 2)}
STYLE PROBE:
${JSON.stringify(compactPreload.styleProbes, null, 2)}
</untrusted_page_data>
${refineContext}
${
  this.refineMode
    ? "Examine the current screenshot & styles.css, and patch any overlapping cards, contrast, occlusion, or layout issues with edit_file + apply_and_render!"
    : "Write design-spec.json, mutations.json, and concise styles.css, then call apply_and_render right away!"
}`;

    const geminiParts = [{ text: userGoalText }];
    if (this.isVision && initialScreenshotUri?.includes(",")) {
      geminiParts.push({ inlineData: { mimeType: "image/jpeg", data: initialScreenshotUri.split(",")[1] } });
    }
    this.geminiContents = [{ role: "user", parts: geminiParts }];

    const openAIUserContent =
      this.isVision && initialScreenshotUri
        ? [
            { type: "text", text: userGoalText },
            { type: "image_url", image_url: { url: initialScreenshotUri } }
          ]
        : userGoalText;

    this.history = [
      { role: "system", content: this.systemPrompt },
      { role: "user", content: openAIUserContent }
    ];

    const keepAliveTimer = setInterval(() => {
      this.env.keepAlivePing?.();
    }, 20000);

    let hasApplied = false;

    try {
      for (let turn = 1; turn <= this.maxTurns; turn++) {
        this.currentTurn = turn;
        this.checkAborted();
        const hasCss = (this.workspace["styles.css"] || "").trim().length > 40;
        const forceWriteMode = !this.refineMode && turn >= 2 && !hasCss;

        this.onStatus(
          forceWriteMode
            ? `Turn ${turn}/${this.maxTurns}: Writing initial layout & CSS...`
            : `Turn ${turn}/${this.maxTurns}: ${hasApplied ? "Self-healing & polishing..." : "Architecting..."}`
        );

        const resp =
          this.provider === "gemini"
            ? await this.callGeminiTurn(forceWriteMode)
            : await this.callOpenAITurn(forceWriteMode);

        if (resp.thoughtText) {
          const snippet = resp.thoughtText.replace(/\s+/g, " ").trim().slice(0, 110);
          if (snippet) this.onStatus(`Agent: ${snippet}`);
        }

        const calls = resp.toolCalls || [];
        if (calls.length === 0) {
          if (hasCss) {
            if (!hasApplied || this.workspaceDirty) {
              await this.executeTool("apply_and_render", {});
              hasApplied = true;
            }
            await this.restoreBestCheckpointIfRegressed();
            const finalDir = this.getSavedDirection();
            await this.executeTool("finish_task", { summary: finalDir });
            return {
              success: true,
              summary: finalDir,
              cssRules: this.workspace["styles.css"],
              domMutations: this.parseMutations(),
              audit: this.lastAudit
            };
          }
          const nudge =
            'Call write_file("design-spec.json"), write_file("mutations.json"), write_file("styles.css"), and apply_and_render right now.';
          if (this.provider === "gemini") this.geminiContents.push({ role: "user", parts: [{ text: nudge }] });
          else this.history.push({ role: "user", content: nudge });
          continue;
        }

        const geminiRespParts = [];
        let finishSummary = null;

        for (const call of calls) {
          const result = await this.executeTool(call.name, call.arguments || {});
          if (call.name === "apply_and_render") hasApplied = true;
          if (call.name === "finish_task" && result?.status === "complete") {
            finishSummary = result.summary || this.getSavedDirection();
          }

          const cleanResult = { ...result };
          const capturedImg = cleanResult.previewImage;
          delete cleanResult.previewImage;

          if (this.provider === "gemini") {
            const fnResp = { name: call.name, response: { result: cleanResult } };
            if (call.id) fnResp.id = call.id;
            geminiRespParts.push({ functionResponse: fnResp });
            if (capturedImg?.includes(",")) {
              geminiRespParts.push({ inlineData: { mimeType: "image/jpeg", data: capturedImg.split(",")[1] } });
            }
          } else {
            const serialized = JSON.stringify(cleanResult);
            if (call.isNative) {
              this.history.push({ role: "tool", tool_call_id: call.id, content: serialized });
            } else {
              this.history.push({ role: "user", content: `Tool "${call.name}" result: ${serialized}` });
            }
            if (capturedImg && this.isVision && !this.visionDowngraded) {
              this.history.push({
                role: "user",
                _isScreenshotFollowup: true,
                content: [
                  { type: "text", text: "Live screenshot after rendering:" },
                  { type: "image_url", image_url: { url: capturedImg } }
                ]
              });
            }
          }
        }

        if (this.provider === "gemini" && geminiRespParts.length > 0) {
          if (turn >= 2 && !(this.workspace["styles.css"] || "").trim()) {
            geminiRespParts.push({
              text: "Write concise styles.css, mutations.json, design-spec.json, and call apply_and_render now."
            });
          } else if (turn === this.maxTurns - 1 && finishSummary === null) {
            geminiRespParts.push({
              text: "Final turn: apply any remaining fix via edit_file + apply_and_render, then call finish_task."
            });
          }
          this.geminiContents.push({ role: "user", parts: geminiRespParts });
          this.pruneOldGeminiScreenshots();
        } else if (turn === this.maxTurns - 1 && finishSummary === null) {
          this.history.push({ role: "user", content: "Final turn: apply any remaining fix and call finish_task." });
        }

        if (finishSummary !== null) {
          if ((!hasApplied || this.workspaceDirty) && (this.workspace["styles.css"] || "").trim().length > 0) {
            await this.executeTool("apply_and_render", {});
          }
          await this.restoreBestCheckpointIfRegressed();
          return {
            success: true,
            summary: finishSummary,
            cssRules: this.workspace["styles.css"] || "",
            domMutations: this.parseMutations(),
            audit: this.lastAudit
          };
        }
      }

      if ((!hasApplied || this.workspaceDirty) && (this.workspace["styles.css"] || "").trim().length > 0) {
        await this.executeTool("apply_and_render", {});
      }
      await this.restoreBestCheckpointIfRegressed();
      const finalDir = this.getSavedDirection();
      this.todos = this.todos.map((t) => ({ ...t, status: "completed" }));
      this.onTodos(this.todos);
      return {
        success: true,
        summary: finalDir,
        cssRules: this.workspace["styles.css"] || "",
        domMutations: this.parseMutations(),
        audit: this.lastAudit
      };
    } finally {
      clearInterval(keepAliveTimer);
    }
  }

  /**
   * Ultimate safety fallback if a Gemini model still rejects prior tool-call history
   * due to strict thought_signature rules: flattens prior tool calls/results into
   * a single clean user context message preserving initial prompt, screenshot, gathered
   * DOM/style findings, and current workspace files.
   */
  buildFlattenedGeminiHandoffContents() {
    const initialTurn = this.geminiContents[0];
    const handoffParts = Array.isArray(initialTurn?.parts) ? [...initialTurn.parts] : [];

    const gatheredNotes = [];
    for (let i = 1; i < this.geminiContents.length; i++) {
      const turn = this.geminiContents[i];
      if (!Array.isArray(turn?.parts)) continue;
      for (const p of turn.parts) {
        if (p?.functionResponse) {
          const fnName = p.functionResponse.name || "tool";
          const serialized = JSON.stringify(p.functionResponse.response?.result ?? p.functionResponse.response ?? {});
          gatheredNotes.push(`- ${fnName} result: ${serialized.slice(0, 1800)}`);
        }
      }
    }

    const wsSummary = [
      "MODEL HANDOFF CONTEXT (previous model hit quota/limits; continue directly from gathered findings and current workspace):",
      gatheredNotes.length ? `Gathered tool results so far:\n${gatheredNotes.slice(-6).join("\n")}` : "",
      this.workspace["styles.css"] ? `Current styles.css:\n${this.workspace["styles.css"].slice(0, 4500)}` : "",
      this.workspace["mutations.json"] && this.workspace["mutations.json"] !== "[]"
        ? `Current mutations.json:\n${this.workspace["mutations.json"]}`
        : "",
      "Proceed immediately: write/edit design-spec.json, mutations.json, styles.css and call apply_and_render."
    ]
      .filter(Boolean)
      .join("\n\n");

    handoffParts.push({ text: wsSummary });
    return [{ role: "user", parts: handoffParts }];
  }

  async callGeminiTurn(forceWriteMode = false) {
    if (!this.cachedFetchedGeminiModels) {
      const stored = await this.env.getStorage(["fetchedModels_gemini"]).catch(() => ({}));
      this.cachedFetchedGeminiModels = stored?.fetchedModels_gemini || [];
    }
    const baseChain = getGeminiFallbackChain(this.activeGeminiModel || this.model, this.cachedFetchedGeminiModels);
    const candidates = Array.from(new Set([this.activeGeminiModel, ...baseChain].filter((m) => m && !retiredGeminiModels.has(m))));

    const buildBody = (contentsPayload) => ({
      systemInstruction: { parts: [{ text: this.systemPrompt }] },
      contents: contentsPayload,
      tools: [{ functionDeclarations: this.getGeminiFunctionDeclarations(forceWriteMode) }],
      toolConfig: {
        functionCallingConfig: forceWriteMode
          ? { mode: "ANY", allowedFunctionNames: ["write_file", "edit_file", "apply_and_render"] }
          : { mode: "AUTO" }
      },
      generationConfig: { temperature: 0.45, maxOutputTokens: 4096 }
    });

    let lastErr = null;
    for (let i = 0; i < candidates.length; i++) {
      this.checkAborted();
      const m = candidates[i];
      const switchedModel = Boolean(this.lastGeminiModelUsed && this.lastGeminiModelUsed !== m);
      let contentsPayload = switchedModel
        ? cloneContentsForDifferentGeminiModel(this.geminiContents)
        : this.geminiContents;

      try {
        let res;
        try {
          res = await this.executeGeminiGenerate(m, buildBody(contentsPayload));
        } catch (sigErr) {
          // If Gemini still rejects thought_signature even with skip_thought_signature_validator,
          // flatten tool history into clean context and retry this SAME healthy model once!
          if (/thought_signature|thoughtSignature/i.test(sigErr.message) && this.geminiContents.length > 1) {
            this.onStatus(`Adapting tool history for ${m} handoff...`);
            contentsPayload = this.buildFlattenedGeminiHandoffContents();
            res = await this.executeGeminiGenerate(m, buildBody(contentsPayload));
          } else {
            throw sigErr;
          }
        }

        if (switchedModel || contentsPayload !== this.geminiContents) {
          this.geminiContents = contentsPayload;
        }
        this.geminiContents.push({ role: "model", parts: res.rawParts });
        this.activeGeminiModel = m;
        this.lastGeminiModelUsed = m;
        return { thoughtText: res.thoughtText, toolCalls: res.toolCalls };
      } catch (err) {
        if (this.abortSignal?.aborted) throw new Error("Agent stopped by user.");
        lastErr = err;
        if (/(api key not valid|invalid api key|permission_denied|unauthenticated|\(401\)|\(403\))/i.test(err.message)) {
          throw err;
        }
        if (/(is no longer available|not found|\(404\))/i.test(err.message)) {
          retiredGeminiModels.add(m);
        }
        const nextModel = candidates[i + 1];
        if (nextModel) {
          this.onStatus(`⟳ ${m} unavailable (${err.message.slice(0, 48)}) → switching to ${nextModel}...`);
          continue;
        }
      }
    }
    throw lastErr;
  }

  async executeGeminiGenerate(modelCandidate, requestBody) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelCandidate}:generateContent`;
    const { signal, didTimeout, cleanup } = this.createTurnFetchSignal(90000);

    try {
      const res = await this.env.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify(requestBody),
        signal
      });

      const json = await res.json().catch(() => null);
      if (!res.ok || json?.error) {
        const msg = json?.error?.message || `HTTP ${res.status}`;
        throw new Error(`${msg} (${res.status})`);
      }

      const parts = json?.candidates?.[0]?.content?.parts || [];
      if (parts.length === 0) {
        throw new Error("Empty response parts from model");
      }

      let thoughtText = "";
      const toolCalls = [];
      for (const part of parts) {
        if (typeof part.text === "string" && !part.functionCall && !part.thought) {
          thoughtText += part.text;
        }
        if (part.functionCall) {
          toolCalls.push({
            id: part.functionCall.id || null,
            name: part.functionCall.name,
            arguments: part.functionCall.args || {},
            isNative: true
          });
        }
      }
      return { thoughtText, toolCalls, rawParts: parts };
    } catch (err) {
      if (this.abortSignal?.aborted) throw new Error("Agent stopped by user.");
      if (didTimeout() || err.name === "AbortError") {
        throw new Error("Timed out after 90s");
      }
      throw err;
    } finally {
      cleanup();
    }
  }

  stripImagesFromOpenAIMessages(messages) {
    return messages.map((m) => {
      if (!Array.isArray(m.content)) return m;
      const textOnly = m.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");
      return { ...m, content: textOnly || "[Screenshot omitted in text-only mode]" };
    });
  }

  async callOpenAITurn(forceWriteMode = false) {
    const cfg = PROVIDERS[this.provider] || PROVIDERS.openrouter;
    const url = this.provider === "custom" ? this.baseUrl || cfg.defaultBaseUrl : cfg.baseUrl;

    const headers = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (this.provider === "openrouter") {
      headers["HTTP-Referer"] = "https://redesigner.local";
      headers["X-Title"] = "ReDesigner Studio";
    }

    const prepareMessages = (stripVision) => {
      const compacted = this.getCompactedOpenAIHistory(10).map((m) => {
        const { _isScreenshotFollowup: _ignored, ...clean } = m;
        return clean;
      });
      return stripVision ? this.stripImagesFromOpenAIMessages(compacted) : compacted;
    };

    const doFetch = async (messages, includeTools) => {
      const { signal, didTimeout, cleanup } = this.createTurnFetchSignal(90000);
      try {
        const body = { model: this.model, messages, max_tokens: 4096 };
        if (includeTools) {
          body.tools = this.getOpenAIToolsSchema(forceWriteMode);
          body.tool_choice = forceWriteMode ? "required" : "auto";
        }
        const res = await this.env.fetch(url, {
          method: "POST",
          headers,
          signal,
          body: JSON.stringify(body)
        });
        return { res, didTimeout };
      } catch (err) {
        if (this.abortSignal?.aborted) throw new Error("Agent stopped by user.");
        if (didTimeout() || err.name === "AbortError") throw new Error(`${this.model} timed out after 90s.`);
        throw err;
      } finally {
        cleanup();
      }
    };

    let messages = prepareMessages(this.visionDowngraded);
    let { res } = await doFetch(messages, true);

    // Transient 429 / 502 / 503 single retry with Retry-After support
    if (res.status === 429 || res.status === 502 || res.status === 503) {
      const retryAfterSec = parseInt(res.headers?.get?.("retry-after") || "0", 10);
      const waitMs = Math.min(8000, Math.max(1500, retryAfterSec > 0 ? retryAfterSec * 1000 : 2000));
      this.onStatus(`Rate limited (HTTP ${res.status}) — retrying in ${(waitMs / 1000).toFixed(1)}s...`);
      await this.env.sleep(waitMs);
      this.checkAborted();
      ({ res } = await doFetch(messages, true));
    }

    // Fallback 1: Vision rejected -> downgrade to semantic text mode
    if (!res.ok && !this.visionDowngraded && (res.status === 400 || res.status === 413 || res.status === 422)) {
      const errBody = await res.clone().text().catch(() => "");
      if (/vision|image|multimodal|media/i.test(errBody)) {
        this.visionDowngraded = true;
        this.onStatus("Model rejected image input — continuing in Semantic Text mode...");
        messages = prepareMessages(true);
        ({ res } = await doFetch(messages, true));
      } else if (/tool|function|choice/i.test(errBody)) {
        // Fallback 2: Provider does not support native tools
        const plainMessages = messages.map((m) =>
          m.role === "tool" ? { role: "user", content: `Tool result: ${m.content}` } : m
        );
        ({ res } = await doFetch(plainMessages, false));
      }
    }

    const json = await res.json().catch(() => null);
    if (!res.ok || json?.error) {
      throw new Error(json?.error?.message || json?.detail || `HTTP ${res.status}`);
    }

    const message = json?.choices?.[0]?.message;
    if (!message) throw new Error("Empty choice from AI provider.");
    this.history.push(message);

    let toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls.map((tc) => {
          let parsed = {};
          try {
            parsed =
              typeof tc.function.arguments === "string"
                ? JSON.parse(tc.function.arguments)
                : tc.function.arguments || {};
          } catch {}
          return { id: tc.id, name: tc.function.name, arguments: parsed, isNative: true };
        })
      : [];

    if (toolCalls.length === 0 && typeof message.content === "string" && message.content.trim()) {
      toolCalls = this.extractFallbackToolCalls(message.content);
    }

    return { thoughtText: typeof message.content === "string" ? message.content : "", toolCalls };
  }

  extractFallbackToolCalls(text) {
    try {
      const obj = parseLooseJson(text);
      if (obj?.cssRules && typeof obj.cssRules === "string") {
        const calls = [
          {
            id: `fb_css_${Date.now()}`,
            name: "write_file",
            arguments: { filename: "styles.css", content: obj.cssRules },
            isNative: false
          }
        ];
        if (Array.isArray(obj.domMutations)) {
          calls.push({
            id: `fb_mut_${Date.now()}`,
            name: "write_file",
            arguments: { filename: "mutations.json", content: JSON.stringify(obj.domMutations) },
            isNative: false
          });
        }
        calls.push({ id: `fb_apply_${Date.now()}`, name: "apply_and_render", arguments: {}, isNative: false });
        return calls;
      }
    } catch {}
    return [];
  }
}
