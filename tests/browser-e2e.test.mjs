import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

import { buildFullStylesheet } from "../service-worker.js";
import { compilePresetOnlyCSS } from "../shared/layout-blueprints.js";

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium"
].filter(Boolean);
const CHROME_PATH = CHROME_CANDIDATES.find((p) => fs.existsSync(p)) || "";
const CONTENT_SCRIPT = fs.readFileSync(path.resolve("content-script.js"), "utf8");

class CDPClient {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener("message", (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}, timeoutMs = 10000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout on ${method}`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        }
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    }
    return res.result?.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function launchChromeCDP() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-chrome-test-"));
  const proc = spawn(
    CHROME_PATH,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "about:blank"
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  const wsUrl = await new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`Chrome startup timed out: ${stderr}`)), 15000);
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited early (${code}): ${stderr}`));
    });
  });

  const port = new URL(wsUrl).port;
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const pageTarget = targets.find((t) => t.type === "page");
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });

  const cdp = new CDPClient(ws);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false
  });

  return {
    cdp,
    async setPageHtml(html) {
      // Navigate to fresh about:blank so window/globals/MutationObservers reset cleanly
      await cdp.send("Page.navigate", { url: "about:blank" });
      await new Promise((r) => setTimeout(r, 80));
      const { frameTree } = await cdp.send("Page.getFrameTree");
      await cdp.send("Page.setDocumentContent", { frameId: frameTree.frame.id, html });
      // Mock chrome.runtime.onMessage harness and load real content-script.js
      await cdp.eval(`
        delete window.__redesigner_v3_loaded;
        window.__rdListeners = [];
        window.chrome = {
          runtime: {
            onMessage: { addListener: (fn) => window.__rdListeners.push(fn) },
            sendMessage: () => {}
          }
        };
        window.__rdDispatch = (msg) => new Promise((resolve, reject) => {
          if (!window.__rdListeners.length) return reject(new Error("No content-script listener registered"));
          for (const fn of window.__rdListeners) {
            fn(msg, {}, (resp) => resolve(resp));
          }
        });
        window.__rdInjectCss = (css) => {
          let s = document.getElementById("__rd_test_style");
          if (!s) {
            s = document.createElement("style");
            s.id = "__rd_test_style";
            document.head.appendChild(s);
          }
          s.textContent = css;
        };
      `);
      await cdp.eval(CONTENT_SCRIPT);
    },
    async cleanup() {
      cdp.close();
      try {
        proc.kill("SIGKILL");
      } catch {}
      await new Promise((resolve) => {
        if (proc.exitCode !== null || proc.killed) return setTimeout(resolve, 150);
        proc.once("exit", () => setTimeout(resolve, 100));
        setTimeout(resolve, 1000);
      });
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {}
    }
  };
}

const hasChrome = Boolean(CHROME_PATH);

test("Real Chrome E2E: interactive dropdowns stay clickable, accurate grid stamping, safe undo & 10-point auditor", { skip: !hasChrome }, async () => {
  const browser = await launchChromeCDP();
  try {
    // 1. Test Interactive Dropdown + Media Catalog + Non-Grid Page Bands + Safe Undo
    const svgImg = `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='300'><rect width='200' height='300' fill='%232563eb'/></svg>`;
    await browser.setPageHtml(`<!DOCTYPE html>
    <html>
      <head>
        <style>
          :root { --site-bg: #ffffff; --site-fg: #111111; }
          body { margin: 0; background: var(--site-bg); color: var(--site-fg); font-family: sans-serif; }
          header { height: 60px; display: flex; align-items: center; justify-content: space-between; padding: 0 20px; background: #fff; }
          #dropdown-menu { display: none; padding: 10px; background: #eee; }
          #dropdown-menu.open { display: block; }
          .band { width: 1200px; height: 380px; margin: 10px auto; }
          .catalog { display: flex; flex-wrap: wrap; gap: 12px; width: 900px; }
          .movie { width: 200px; height: 300px; border: 2px solid rgb(0, 0, 238); padding: 8px; }
          .movie img { width: 180px; height: 220px; }
          .movie a { color: rgb(0, 0, 238); }
          aside { width: 220px; height: 400px; background: #ffffff; }
        </style>
      </head>
      <body>
        <div id="__next">
          <header>
            <a href="/" id="brand">CinePortal</a>
            <form id="search-form"><input type="search" placeholder="Search titles..." /></form>
            <button id="menu-toggle" onclick="document.getElementById('dropdown-menu').classList.toggle('open')">Menu</button>
          </header>
          <div id="dropdown-menu"><a href="/settings">Settings</a></div>
          <div class="page-bands">
            <section class="band"><h2>Band 1</h2><p>Full-width hero intro band content.</p></section>
            <section class="band"><h2>Band 2</h2><p>Second full-width section.</p></section>
            <section class="band"><h2>Band 3</h2><p>Third full-width section.</p></section>
          </div>
          <main id="main">
            <div class="catalog" id="catalog">
              <div class="movie" id="m1"><img src="${svgImg}" /><a href="/m1">Dune Part Two</a><p>Epic sci-fi</p></div>
              <div class="movie" id="m2"><img src="${svgImg}" /><a href="/m2">Arrival</a><p>Linguistics</p></div>
              <div class="movie" id="m3"><img src="${svgImg}" /><a href="/m3">Interstellar</a><p>Space travel</p></div>
              <div class="movie" id="m4"><img src="${svgImg}" /><a href="/m4">Blade Runner</a><p>Neo-noir</p></div>
            </div>
          </main>
          <aside id="sidebar">Sponsored sidebar widget</aside>
        </div>
      </body>
    </html>`);

    const semantics = await browser.cdp.eval(`window.__rdDispatch({ action: "EXTRACT_SEMANTICS" })`);
    assert.equal(semantics.status, "SUCCESS");
    const graph = semantics.data;

    // Verifies Next.js/React SPA detection & :root CSS variable extraction
    assert.equal(graph.pageProfile.isSpaFramework, true);
    assert.ok(graph.pageProfile.frameworks.includes("Next.js"));
    assert.equal(graph.pageProfile.siteCssVariables["--site-bg"], "#ffffff");
    assert.ok(graph.preloadedExploration.spatialMap.length >= 3);

    // Verifies full-width 380px bands were NOT mis-stamped as card-grid, while .catalog WAS stamped as media card-grid!
    const stampingCheck = await browser.cdp.eval(`({
      bandsRole: document.querySelector(".page-bands").dataset.rdRole || null,
      catalogRole: document.getElementById("catalog").dataset.rdRole || null,
      catalogKind: document.getElementById("catalog").dataset.rdGridKind || null
    })`);
    assert.equal(stampingCheck.bandsRole, null, "Full-page section bands must NOT be mis-stamped as card-grid!");
    assert.equal(stampingCheck.catalogRole, "card-grid");
    assert.equal(stampingCheck.catalogKind, "media");

    // Apply Obsidian Quick Layout + createHeroFromElement + reparent + bad selector to test observable mutationReport
    const css = buildFullStylesheet({
      profileId: "obsidian",
      layoutPreset: "bento-command",
      adapterCss: compilePresetOnlyCSS("bento-command")
    });
    await browser.cdp.eval(`window.__rdInjectCss(${JSON.stringify(css)})`);

    const applied = await browser.cdp.eval(`window.__rdDispatch({
      action: "APPLY_DOM_AND_HEAL",
      patch: {
        designDirection: "Obsidian Cinema",
        profileId: "obsidian",
        domMutations: [
          { action: "createHeroFromElement", sourceSelector: "#m1", targetSelector: "#main", position: "prepend", badgeText: "Featured", ctaText: "Watch" },
          { action: "createSlot", slotRole: "top-command-bar", anchorSelector: "body", position: "prepend", id: "rd-cmd" },
          { action: "reparent", sourceSelector: "#search-form", targetSelector: "rd-cmd", position: "append" },
          { action: "setInert", selector: "#nonexistent-el" }
        ]
      }
    })`);

    assert.equal(applied.status, "APPLIED");
    assert.equal(applied.mutationReport.applied, 3);
    assert.equal(applied.mutationReport.skipped, 1);

    // CRITICAL FUNCTIONALITY TEST: Clicking Menu MUST open #dropdown-menu (not permanently locked by display:none!important!)
    const dropdownDisplayAfterClick = await browser.cdp.eval(`(() => {
      document.getElementById("menu-toggle").click();
      return getComputedStyle(document.getElementById("dropdown-menu")).display;
    })()`);
    assert.equal(dropdownDisplayAfterClick, "block", "Interactive dropdown MUST remain openable after redesign!");

    // SAFE UNDO TEST: Even if a sibling right after #search-form's original spot is removed, REVERT must rescue #search-form back into <header>!
    const revertCheck = await browser.cdp.eval(`(async () => {
      document.getElementById("menu-toggle").remove();
      await window.__rdDispatch({ action: "REVERT_DOM_AND_HUD" });
      return {
        searchParentTag: document.getElementById("search-form")?.parentElement?.tagName,
        heroExists: Boolean(document.querySelector('[data-rd-role="hero-spotlight"]')),
        m1Hidden: document.getElementById("m1").hidden
      };
    })()`);
    assert.equal(revertCheck.searchParentTag, "HEADER");
    assert.equal(revertCheck.heroExists, false);
    assert.equal(revertCheck.m1Hidden, false);

    // 2. Test 10-Point Auditor: Overlapping Cards, Occluded Control (elementFromPoint), Horizontal Overflow, Aspect Ratio Distortion & Content Loss
    await browser.setPageHtml(`<!DOCTYPE html>
    <html>
      <head>
        <style>
          body { margin: 0; background: #0b1017; color: #f8fafc; font-family: sans-serif; }
          #blocker { position: fixed; top: 0; left: 0; width: 400px; height: 90px; z-index: 500; background: rgba(20, 20, 30, 0.95); }
          #primary-btn { position: absolute; top: 20px; left: 40px; width: 120px; height: 40px; z-index: 1; }
          .grid { display: grid; grid-template-columns: repeat(3, 100px); width: 300px; margin-top: 120px; }
          .card { width: 220px; height: 140px; background: #121923; }
          .card img { width: 200px; height: 50px; object-fit: fill; }
          #overflow-box { width: 1900px; height: 40px; background: #121923; }
          #white-panel { width: 500px; height: 80px; background: #ffffff; color: #111111; }
          #glass-card { background: rgba(255, 255, 255, 0.12); padding: 12px; width: 300px; }
          #glass-text { color: oklch(0.95 0.01 250); }
        </style>
      </head>
      <body>
        <div id="blocker">Sticky Cover</div>
        <button id="primary-btn">Click Me</button>
        <main>
          <div class="grid">
            <div class="card"><img src="${svgImg}" /><a href="/1">Card 1</a></div>
            <div class="card"><img src="${svgImg}" /><a href="/2">Card 2</a></div>
            <div class="card"><img src="${svgImg}" /><a href="/3">Card 3</a></div>
          </div>
          <div id="overflow-box">Wide overflowing element</div>
          <div id="white-panel">Clashing bright white box</div>
          <div id="glass-card"><p id="glass-text">Readable white-ish oklch text on translucent dark glass</p></div>
        </main>
      </body>
    </html>`);

    await browser.cdp.eval(`window.__rdDispatch({ action: "EXTRACT_SEMANTICS" })`);
    const auditRes = await browser.cdp.eval(`window.__rdDispatch({ action: "AUDIT_RENDERED_PAGE" })`);
    const audit = auditRes.data;

    assert.ok(audit.overlappingCards.length >= 1, "Auditor must catch overlapping cards!");
    assert.ok(audit.occludedControls.length >= 1, "Auditor must catch occluded #primary-btn via elementFromPoint!");
    assert.equal(audit.occludedControls[0].occludedBy, "#blocker");
    assert.equal(audit.horizontalOverflow, true);
    assert.ok(audit.horizontalOverflowOffenders.some((o) => o.selector === "#overflow-box"));
    assert.ok(audit.whiteOrClashingBoxes.some((b) => b.selector === "#white-panel"));
    assert.ok(audit.buriedOrBrokenImages.some((i) => /Distorted aspect ratio/i.test(i.issue)));

    // Verify true alpha-compositing + oklch() parsing on #glass-text:
    // rgba(255,255,255,0.12) over #0b1017 is ~rgb(40,44,50), so bright oklch(0.95) text has >10:1 contrast!
    const glassProbe = await browser.cdp.eval(`window.__rdDispatch({ action: "INSPECT_STYLES", selector: "#glass-text" })`);
    assert.ok(glassProbe.data.contrastRatio > 8, `Expected high contrast on dark glass, got ${glassProbe.data.contrastRatio}`);

    // 3. Test Bidirectional Auto-Healer: Light Theme (Editorial) on a pitch-black dark website!
    await browser.setPageHtml(`<!DOCTYPE html>
    <html>
      <head>
        <style>
          body { margin: 0; background: #000000; color: #eeeeee; font-family: sans-serif; }
          .dark-card { width: 500px; height: 100px; background: #050505; color: #f8f8f8; padding: 16px; }
        </style>
      </head>
      <body>
        <main><div class="dark-card" id="dc"><p id="dp">Originally dark mode panel</p></div></main>
      </body>
    </html>`);

    const editorialCss = buildFullStylesheet({
      profileId: "editorial",
      layoutPreset: "editorial-focus",
      adapterCss: "html, body { background: var(--rd-bg-body) !important; color: var(--rd-fg-primary) !important; }"
    });
    await browser.cdp.eval(`window.__rdInjectCss(${JSON.stringify(editorialCss)})`);
    const healLight = await browser.cdp.eval(`window.__rdDispatch({
      action: "APPLY_DOM_AND_HEAL",
      patch: { designDirection: "Editorial Light", profileId: "editorial", domMutations: [] }
    })`);
    assert.ok(healLight.healStats.healedSurfaces >= 1, "Light theme healer must heal leftover pitch-black panels!");
    const healedAttr = await browser.cdp.eval(`document.getElementById("dc").dataset.rdHealedBg`);
    assert.equal(healedAttr, "surface");

    // 4. Test Generated Slot #id Selector Support + Compare Toggle + SPA Incremental MutationObserver + Content Loss Audit + Scroll-to-Selector Screenshot
    await browser.setPageHtml(`<!DOCTYPE html>
    <html>
      <head>
        <style>
          body { margin: 0; background: #0b1017; color: #f8fafc; font-family: sans-serif; min-height: 2200px; }
          .feed { display: flex; flex-direction: column; gap: 12px; }
          .item { padding: 12px; background: #121923; border: 1px solid #334155; }
          #footer-target { margin-top: 1600px; height: 120px; background: #121923; }
        </style>
      </head>
      <body>
        <header id="hdr"><a href="/">Home</a></header>
        <main id="article-main">
          <h1>Long Technical Article</h1>
          <p>${"ReDesigner structural layout architecture preserves user agency and interactive functionality across modern websites. ".repeat(12)}</p>
          <div class="feed" id="feed">
            <div class="item"><a href="/a">Alpha Story</a></div>
            <div class="item"><a href="/b">Beta Story</a></div>
            <div class="item"><a href="/c">Gamma Story</a></div>
          </div>
          <div id="footer-target">Below-the-fold target</div>
        </main>
      </body>
    </html>`);

    await browser.cdp.eval(`window.__rdDispatch({ action: "EXTRACT_SEMANTICS" })`);
    const slotApplied = await browser.cdp.eval(`window.__rdDispatch({
      action: "APPLY_DOM_AND_HEAL",
      patch: {
        designDirection: "Slot + SPA Test",
        profileId: "obsidian",
        domMutations: [
          { action: "createSlot", slotRole: "top-command-bar", anchorSelector: "body", position: "prepend", id: "rd-top-bar" },
          { action: "reparent", sourceSelector: "#hdr", targetSelector: "#rd-top-bar", position: "append" }
        ]
      }
    })`);
    assert.equal(slotApplied.mutationReport.applied, 2, "Generated slot must be resolvable via #rd-top-bar selector!");

    // Compare toggle disables mutations then re-enables them cleanly
    const cmpOff = await browser.cdp.eval(`window.__rdDispatch({ action: "TEMPORARY_RESTORE_FOR_COMPARE", disabled: true })`);
    assert.equal(cmpOff.isPreviewDisabled, true);
    const hdrParentOriginal = await browser.cdp.eval(`document.getElementById("hdr").parentElement.tagName`);
    assert.equal(hdrParentOriginal, "BODY");

    const cmpOn = await browser.cdp.eval(`window.__rdDispatch({ action: "TEMPORARY_RESTORE_FOR_COMPARE", disabled: false })`);
    assert.equal(cmpOn.isPreviewDisabled, false);
    const hdrParentRestored = await browser.cdp.eval(`document.getElementById("hdr").parentElement.id`);
    assert.equal(hdrParentRestored, "rd-top-bar");

    // Dynamically append a bright white SPA node and verify debounced incremental MutationObserver heals it without duplicate data-rd-id!
    const spaDynamic = await browser.cdp.eval(`(async () => {
      const card = document.createElement("div");
      card.id = "dynamic-white-card";
      card.style.cssText = "width:320px;height:60px;background:#ffffff;color:#000000;padding:8px;";
      card.innerHTML = "<a href='/dyn'>Dynamic SPA Item</a>";
      document.getElementById("feed").appendChild(card);
      await new Promise((r) => setTimeout(r, 320));
      const allIds = Array.from(document.querySelectorAll("[data-rd-id]")).map((el) => el.dataset.rdId);
      return {
        healedBg: card.dataset.rdHealedBg || null,
        totalIds: allIds.length,
        uniqueIds: new Set(allIds).size
      };
    })()`);
    assert.equal(spaDynamic.healedBg, "surface", "Incremental SPA observer must auto-heal dynamically added white cards!");
    assert.equal(spaDynamic.totalIds, spaDynamic.uniqueIds, "Monotonic IDs must NEVER collide on SPA mutations!");

    // Scroll-to-selector PREPARE_SCREENSHOT scrolls down and RESTORE_HUD restores scrollY
    const scrollCheck = await browser.cdp.eval(`(async () => {
      window.scrollTo(0, 0);
      const prep = await window.__rdDispatch({ action: "PREPARE_SCREENSHOT", selector: "#footer-target" });
      const midY = window.scrollY;
      await window.__rdDispatch({ action: "RESTORE_HUD" });
      const endY = window.scrollY;
      return { scrolledTo: prep.scrolledTo, midY, endY };
    })()`);
    assert.equal(scrollCheck.scrolledTo, "#footer-target");
    assert.ok(scrollCheck.midY > 500, "PREPARE_SCREENSHOT must scroll target into viewport");
    assert.equal(scrollCheck.endY, 0, "RESTORE_HUD must restore original scroll position");

    // Content loss detection: hiding main triggers contentLoss audit alert!
    const contentLossAudit = await browser.cdp.eval(`(async () => {
      document.getElementById("article-main").style.display = "none";
      const res = await window.__rdDispatch({ action: "AUDIT_RENDERED_PAGE" });
      return res.data;
    })()`);
    assert.ok(contentLossAudit.contentLoss, "Auditor must detect accidental main content disappearance!");
    assert.ok(contentLossAudit.criticalIssues >= 1);
  } finally {
    await browser.cleanup();
  }
});
