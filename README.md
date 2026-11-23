<img width="1440" height="900" alt="Screenshot 2026-11-23 at 13 22 05" src="https://github.com/user-attachments/assets/8bdd708e-fc71-4e7d-b0ab-693f88ccd0b0" />
<img width="1440" height="900" alt="Screenshot 2026-11-23 at 11 32 58" src="https://github.com/user-attachments/assets/87f5582e-a5c4-494c-aed4-4ee1d464595a" />
# ReDesigner — Structural UI/UX Studio

<p align="center">
  <img src="icons/icon-128.png" alt="ReDesigner icon" width="84" height="84" />
</p>

**ReDesigner** is a zero-build Chrome Extension (Manifest V3, Side Panel) that lets you understand, restyle, and structurally redesign real websites while keeping their underlying interactive functionality intact.

Use it **100% offline** with instant visual profiles, layout presets, and ergonomic sliders—or connect your own AI provider (Google Gemini, OpenRouter, Groq, NVIDIA NIM, Ollama / OpenAI-compatible endpoints, or Chrome's built-in on-device Gemini Nano) to run a closed-loop visual + DOM QA redesign agent.

---

## Key Capabilities

- **Zero-AI Offline Mode (`⚡ Quick`)** — Apply structural layout presets (*Top Command Bar + Bento Grid*, *Zen Editorial Reader*, *Split App Workspace*, *Visual Card Grid*) and swap visual themes (*Obsidian*, *Editorial*, *Matcha*, *AAA Contrast*) with zero API calls.
- **Live Ergonomics** — Adjust content width (`ch`), non-compounding text scale (`rem`), border radius, card columns, and sidebar hiding (`inert`) in real time, with one-click reset.
- **Autonomous Workspace Agent & Fast 2-Pass AI Modes**:
  - **Workspace Agent (`react`)**: Multi-turn tool-using agent (`read_dom_tree`, `find_elements`, `inspect_styles`, `write_file`, `edit_file`, `apply_and_render`, `audit_rendered_page`, `take_screenshot`, `commit_checkpoint`, `undo_change`, `finish_task`) with automatic regression rollback to the highest-scoring checkpoint.
  - **Fast 2-Pass (`pipeline`)**: Single architect pass + visual/audit critic refinement pass with automatic rollback if critic edits degrade the QA score.
  - **`✨ Refine` Mode**: Iterate on an existing redesign without starting over.
- **Deep Page Analysis**:
  - Detects page archetype (`media-gallery`, `link-aggregator`, `article-reader`, `docs-dashboard`, `general`), landmarks, grids, layout tables, `:root` CSS custom properties, spatial bounding boxes, and SPA frameworks (`Next.js`, `React`, `Vue`, `Nuxt`, `Angular`, `Svelte`, `Astro`, `Gatsby`).
  - Preserves dropdowns, modals, tabs, and accordions (never locks hidden UI elements with `display: none !important`).
  - Debounced incremental `MutationObserver` adapts newly loaded SPA content without thrashing the DOM.
- **10-Point Live QA Auditor**:
  - Checks pairwise overlapping cards, `document.elementFromPoint` control occlusion, horizontal overflow offenders, baseline content loss, aspect-ratio image distortion, clashing surfaces in both dark and light themes, legacy unstyled links/borders, clipped text, collapsed controls, and WCAG AA contrast using true alpha-composited backgrounds (supporting `rgb`, `rgba`, `hex`, `hsl`, `color(srgb ...)`, `oklch`, `oklab`, and `color-mix`).
- **Safe, Reversible DOM Mutations & Site Persistence**:
  - Structural operations (`createSlot`, `reparent`, `wrapGroup`, `createHeroFromElement`, `setInert`, `unwrapLayoutTable`) use comment-anchor undo restoration so **Compare** and **Revert** cleanly restore the original DOM.
  - **Pin to Site** auto-applies your design on reload; **Code Inspector** edits `styles.css` & `mutations.json` live (`Cmd/Ctrl+S`); **Import / Export** shares portable `.json` recipes.

---

## Installation (Chrome 116+)

ReDesigner has **no build step and zero runtime dependencies**.

### Option A: From a Release Zip
1. Download `redesigner-v3.3.0.zip` from [GitHub Releases](https://github.com/badumetsihlongwane-jpg/ReDesigner/releases) and unzip it.
2. Open `chrome://extensions` in Google Chrome.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the unzipped folder.

### Option B: From Source
```bash
git clone https://github.com/badumetsihlongwane-jpg/ReDesigner.git
cd ReDesigner
```
Then open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the repository root folder.

Pin the ReDesigner icon to your toolbar and click it on any `http://` or `https://` website to open **ReDesigner Studio** in the Side Panel.

---

## Quick Start

1. **Try Instant Offline Redesign (No API Key Required)**
   - Pick a visual theme pill (**Obsidian**, **Editorial**, **Matcha**, or **AAA Contrast**).
   - Choose a **Layout Transformation** preset and click **⚡ Quick**.
   - Adjust the **Live Ergonomics** sliders or toggle **Compare** / **Revert**.

2. **Connect an AI Provider (Optional)**
   - Click **⚙ AI Setup** in the top-right corner of the Side Panel.
   - Choose a provider:
     - **Google Gemini** (`generativelanguage.googleapis.com`) — supports vision, tool calling, live model fetching, and cross-model fallback.
     - **OpenRouter** — supports Claude, GPT-4o, Gemini, Qwen VL, and free vision models.
     - **Groq** — Llama 4 Scout/Maverick vision & Llama 3.3 models.
     - **NVIDIA NIM** — Llama 3.2 Vision, Qwen Coder, DeepSeek.
     - **Custom OpenAI / Ollama** — connect local models (e.g., `http://localhost:11434/v1/chat/completions`) with `/v1/models` fetching.
     - **Chrome Built-in AI** — on-device Gemini Nano (`LanguageModel` API, no key needed when supported by your Chrome build).
   - Enter your API key (saved locally in `chrome.storage.local`), optionally click **↻ Fetch Models**, leave the prompt blank for an autonomous redesign or describe what you want, and press **✦ AI Redesign** (or `Cmd/Ctrl + Enter`).

3. **Iterate, Audit & Export**
   - Click the **QA score badge** in the cockpit header anytime to re-run the 10-point audit and inspect remaining recommendations.
   - Enter polish instructions and click **✨ Refine** to improve the active redesign incrementally.
   - Open **{ } Code** to inspect/edit `styles.css` and `mutations.json`, or **Export** / **Import** `.json` recipes.
   - Click **📌 Pin** (in the Side Panel or in-page Floating HUD) to automatically apply the design every time you visit that domain.

---

## Architecture

```text
├── manifest.json               # Chrome MV3 manifest (Side Panel + ES module Service Worker)
├── popup.html / popup.css      # Side Panel Studio UI
├── popup.js                    # Side Panel controller, live QA badge, recipe import/export
├── service-worker.js           # Per-tab serialized CSS manager, site pins, Fast 2-Pass pipeline
├── agent-runtime.js            # Multi-turn Workspace Agent, checkpointing, provider adapters
├── content-script.js           # Semantic/spatial scanner, safe DOM ops, color math, 10-point auditor, HUD
├── icons/                      # Vector source + 16/32/48/128 PNG extension icons
├── shared/
│   ├── personal-profiles.js    # Portable :root token profiles, slot baselines & healer CSS
│   ├── layout-blueprints.js    # Base floor, Quick presets & opt-in ergonomic tweak CSS
│   ├── css-sanitizer.js        # CSS security sanitizer, brace/comment checker & footgun linter
│   ├── mutation-validator.js   # Structural DOM mutation schema validator & normalizer
│   ├── providers.js            # Provider registry, vision detection & Gemini fallback logic
│   ├── skills.js               # Design architect system prompts, SPA guidance & injection guards
│   └── json-utils.js           # Resilient LLM JSON extraction & repair
├── scripts/
│   ├── check.mjs               # Production integrity checks (manifest, syntax, DOM IDs, secrets)
│   └── package.mjs             # Builds clean Chrome-ready dist/redesigner-v<version>.zip
└── tests/
    ├── core-modules.test.mjs   # Unit tests for sanitizers, validators, cascade & tab locking
    ├── agent-runtime.test.mjs  # Simulated multi-turn Gemini & OpenAI agent loop tests
    └── browser-e2e.test.mjs    # Real headless Chrome CDP end-to-end tests
```

### Stylesheet Cascade Order
Every active redesign is composed deterministically in [service-worker.js](service-worker.js):
1. `:root` visual profile tokens (`--rd-*`)
2. Structural slot baselines (hero spotlight, top command bar, bento shell, split workspace)
3. Low-specificity base floor
4. Layout preset rules (only when no custom adapter CSS is active)
5. Sanitized site adapter CSS (AI-generated or user-edited)
6. Opt-in user ergonomic tweaks (only for sliders moved away from default)
7. Contrast auto-healer markers & universal `:focus-visible` / `prefers-reduced-motion` guards

---

## Security, Privacy & Permissions

- **Zero Telemetry:** ReDesigner has no backend server, analytics, or tracking.
- **Local-Only Keys:** API keys are stored strictly in `chrome.storage.local` and sent directly from your browser to the provider endpoint you select.
- **Defense-in-Depth Sanitization:**
  - All AI/imported CSS passes through [shared/css-sanitizer.js](shared/css-sanitizer.js), blocking `@import`, external `url(...)` beacons, unsafe SVG `data:` scripts, legacy CSS script vectors, and catastrophic root-hiding rules (`html`/`body { display: none }`).
  - All DOM mutations pass through [shared/mutation-validator.js](shared/mutation-validator.js) with strict action allowlists and protected boundary checks.
  - Untrusted webpage DOM/text sent to AI models is wrapped in `<untrusted_page_data>` prompt-injection delimiters.
- **Chrome Permissions Used:**
  | Permission | Why it is needed |
  | --- | --- |
  | `storage` | Persist API keys, themes, tweaks, saved designs, and pinned site rules locally. |
  | `activeTab` | Capture clean visible screenshots for vision-capable AI models when you run a redesign. |
  | `scripting` | Inject and cleanly remove scoped CSS and `content-script.js` on the active/pinned tab. |
  | `tabs` | Sync Side Panel state with the active tab and re-apply pinned designs on navigation. |
  | `sidePanel` | Host ReDesigner Studio in Chrome's Side Panel. |
  | `<all_urls>` | Allow redesigning and pinning designs on any standard website you choose. |

See [SECURITY.md](SECURITY.md) for the full threat model and vulnerability reporting instructions.

---

## Development & Verification

Requires **Node.js 22+** (zero `npm install` required; uses Node's built-in test runner and native WebSocket/fetch).

```bash
# Run manifest, syntax, DOM ID, and secret-leak checks
npm run check

# Run unit tests + real headless Chrome E2E tests (auto-detects Chrome/Chromium)
npm test

# Build a clean Chrome-ready zip in dist/
npm run pack

# Run everything end-to-end
npm run verify
```

---

## Known Limitations

- **Restricted Browser Pages:** Chrome does not allow extensions to script `chrome://`, `chrome-extension://`, `about:`, or Chrome Web Store pages. Local `file://` pages require enabling *Allow access to file URLs* in `chrome://extensions`.
- **Cross-Origin Iframes & Closed Shadow DOM:** Scoped CSS and DOM scanning operate in the top-level document and cannot pierce cross-origin iframes or closed Shadow DOM trees.
- **Heavily Dynamic SPAs:** While ReDesigner detects React/Next.js/Vue/Angular/Svelte and steers the AI toward CSS-first transformations, aggressive manual `reparent` mutations on framework-managed DOM nodes can still conflict with client-side virtual DOM reconciliation.
- **Site Pinning Scope:** Pins currently match by `hostname` (all paths on a domain share the pinned design).
- **AI Provider Quotas & Output Quality:** AI redesign quality and latency depend on the selected provider/model; vision-capable models yield the strongest QA results.

---

## Contributing & License

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

Licensed under the **GNU General Public License v3.0** — see [LICENSE](LICENSE).
