# ReDesigner 🎬

> **Autonomous Semantic Website Redesigner** — A Chrome Extension (Manifest V3) that inspects live DOM, maps functional page semantics, and transforms messy web layouts into modern, premium streaming and media interfaces.

---

## Highlights & Capabilities

### 1. Website Understanding
- Inspects live DOM, CSS, HTML structure, and interactive components.
- Autonomous detection of:
  - **Navigation Bars** (`navbar`) — Menus, topbars, links, brand elements
  - **Search Functionality** (`search`) — Inputs, search icons, submit buttons
  - **Movie Cards & Grids** (`movie-card`, `movie-grid`) — Poster aspect ratios, titles, year, ratings, badges, and action triggers
  - **Video Players** (`video-player`) — HTML5 `<video>`, iframe embeds (YouTube, Vimeo, etc.), custom media containers
  - **Sidebars & Categories** (`sidebar`, `categories`) — Genre lists, complementary panels, filter drawers
  - **Buttons & CTAs** (`action-button`) — Watch, trailer, watchlist, and form triggers
  - **Clutter** (`clutter`) — Ads, promos, and banners (gracefully suppressed)

### 2. Website Mapping
- Builds a functional semantic graph representing what elements **DO**, not just what they look like:
  `Header → Search → Categories → Movie Grid → Movie Cards → Video Player → Sidebar`
- Distills pages into compact, token-efficient semantic skeletons suitable for instant analysis and AI prompts.

### 3. AI Design Engine
- **Instant Built-In Synthesizer** (Zero Latency & Offline):
  - **Cinematic (Netflix-inspired)**: Obsidian backdrop (`#141414`), red accents (`#e50914`), frosted glass navbar, 2:3 widescreen/portrait movie cards with hover zoom & glow, clean video player spotlight.
  - **Minimal (Clean & Simple)**: High whitespace, monochrome palette, subtle borders, distraction-free movie grid.
  - **Modern (Premium Web App)**: Glassmorphism (`backdrop-filter: blur(16px)`), modern pill radiuses, vibrant glow accents.
- **LLM API Provider** (Google Gemini & OpenAI):
  - Natural language custom prompt translation into scoped CSS rules targeting semantic roles.
  - Offline fallback with smart keyword understanding.

### 4. Visual Transformation
- **Non-Destructive Styling**: Injects clean scoped CSS targeting `[data-redesigner-role="..."]` and `[data-redesigner-sub="..."]` attributes.
- **Functional Integrity**: Video playback, form submissions, route transitions, and event listeners remain 100% intact.
- **Instant Undo / Hot-Reload**: Toggle on/off instantly without page reloads.

### 5. Continuous Adaptation
- **Dynamic MutationObserver**: Automatically catches newly loaded movie cards (e.g. infinite scroll or "Load More" buttons) and applies the redesign styling dynamically.
- **SPA Navigation Observer**: Intercepts `history.pushState` / `replaceState` / `popstate` to re-verify mapping across client-side route transitions.

---

## 3 Core Capabilities

- **A. Generic Intelligence**: Understands unfamiliar websites without developers manually writing site-specific rules.
- **B. Site-Specific Memory**: Uses **IndexedDB** (`ReDesignerDB`) to remember site structure, computed styles, selected presets, and user prompts per domain. When you return, the redesign loads immediately.
- **C. User-Directed Redesign**: Control via the Chrome Extension Popup, an in-page floating pill, or natural language prompts ("Make movie posters larger", "Netflix dark aesthetic", "Minimalist layout"). Includes a live **Visual Inspector** mode highlighting semantic bounding boxes.

---

## Getting Started

### Installation & Build

```bash
# Install dependencies
npm install

# Build extension for Chrome (Manifest V3)
npm run build
```

This compiles all assets into the `dist/` directory:
- `dist/manifest.json` (Chrome Manifest V3)
- `dist/service-worker.js` (Background worker)
- `dist/content-script.js` (DOM Scanner, Observer, Transformer)
- `dist/popup.html` & `dist/assets/` (React Extension Action UI)

---

### Loading into Google Chrome

1. Open Google Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select the `dist/` folder inside this project directory (`noble-bell/dist`).
5. Pin the **ReDesigner** extension icon to your toolbar!

---

### Live Interactive Showcase & Testbed

You can run the built-in testbed to preview ReDesigner immediately in any browser without needing to load the unpacked extension:

```bash
npm run demo
```

Then visit:
- **Showcase Demo**: [http://localhost:4173/](http://localhost:4173/)
  - Features the Retro Cinema 90s website side-by-side with the ReDesigner Extension Popup.
  - Test the **Cinematic (Netflix)**, **Minimal**, and **Modern** presets live.
  - Click **Inspect Roles** to see color-coded semantic bounding boxes.
  - Click **⚡ Load 4 More Titles** to test `MutationObserver` continuous adaptation!
