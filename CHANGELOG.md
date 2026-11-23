# Changelog

All notable changes to ReDesigner are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.3.0] - 2026-11-23

### Added
- **Zero-dependency production toolchain:** Added `package.json`, `scripts/check.mjs`, `scripts/package.mjs`, GitHub Actions CI, and 12 automated tests (unit + real headless Chrome CDP E2E tests).
- **Custom vector & PNG extension icons:** Added `icons/icon.svg` and native `16/32/48/128` PNG icons referenced in `manifest.json` and the Side Panel header.
- **Security & validation layers:**
  - `shared/css-sanitizer.js` blocking `@import`, external tracking `url(...)` (including quoted parenthesized URLs), unsafe SVG `data:` scripts, and root-hiding CSS while linting layout footguns and checking balanced braces/comments.
  - `shared/mutation-validator.js` enforcing action allowlists, protected boundaries, and selector normalization.
  - `<untrusted_page_data>` prompt-injection delimiters around scraped webpage content.
- **Deep page understanding:** SPA framework detection (`Next.js`, `React`, `Vue`, `Nuxt`, `Angular`, `Svelte`, `Astro`, `Gatsby`), `:root` CSS custom property extraction, spatial bounding-box map, and pre-redesign baseline content metrics.
- **10-point rendered QA auditor:** Pairwise card overlap detection, `document.elementFromPoint` control occlusion checks, horizontal overflow offending selectors, baseline content-loss alerts, aspect-ratio image distortion checks, bidirectional (dark + light) clashing surface detection, clipped text checks, and WCAG AA normal/large contrast checks.
- **Agent reliability & handoff:**
  - `workspaceDirty` guard ensuring edits are rendered before `finish_task`.
  - Best-checkpoint regression auto-restore if later turns degrade the QA score.
  - Scroll-to-selector `take_screenshot(selector)` for below-the-fold inspection.
  - Gemini cross-model `thoughtSignature` sentinel (`skip_thought_signature_validator`) + automatic flattened handoff retry and retired-model caching.
  - Atomic turn-safe OpenAI message compaction, 429/503 retry, and vision-to-text downgrade.
- **Side Panel Studio upgrades:** Clickable live QA score badge (Side Panel + Floating HUD), downloadable `.json` recipe Export + file Import, Reset Tweaks button, unsupported Chrome page notice banner, real-time Floating HUD ↔ Side Panel sync, auto-saved API settings, custom/Ollama `/v1/models` fetching, and `Cmd/Ctrl+Enter` / `Cmd/Ctrl+S` keyboard shortcuts.

### Fixed
- **Interactive UI preservation:** Removed the `[data-rd-originally-hidden="true"] { display: none !important }` lock that broke site dropdowns, modals, tabs, and accordions.
- **CSS injection leaks & cascade collisions:** Added per-tab serialization (`withTabLock`), fixed Quick Apply base-floor duplication, moved structural slot baselines ahead of adapter CSS, and fixed hardcoded `isEnforcedOnSite: true` on non-pinned tab reloads.
- **Semantic stamping & color math:** Prevented full-width page bands from being mis-stamped as `card-grid`, fixed duplicate `data-rd-id` collisions with monotonic IDs, added `#id` resolution for generated slots, implemented universal CSS color parsing (`oklch`/`oklab`/`color(srgb)`/`color-mix` via Canvas fallback) + true alpha compositing, added bidirectional dark/light contrast healing, and switched SPA observation to debounced incremental subtree updates.
- **Safe undo restoration:** Replaced fragile sibling-based `insertBefore` undo with comment-anchor restoration and non-generated child rescue.
- **Fast 2-Pass mode:** Added `refineMode` support and Critic score-regression rollback.
- **Ergonomic sliders:** Made Width slider apply visibly to `main`/`article`/`[data-rd-role="main-content"]` and fixed nested `font-size` compounding by switching from `1em` to `1rem`.
