// shared/layout-blueprints.js — Unconstrained Base Floor, Presets & Opt-In Ergonomic Overrides

export const DEFAULT_USER_TWEAKS = {
  measureCh: 74,
  fontScale: 1.0,
  radiusPx: 10,
  cardCols: 0, // 0 = Auto responsive
  hideSidebars: false
};

export function compileUserTweaksCSS(tweaks = {}) {
  const t = { ...DEFAULT_USER_TWEAKS, ...tweaks };
  const rules = [];

  // Only override AI/Profile CSS variables when the user explicitly moved a slider away from default
  const rootOverrides = [];
  const measureMoved = Number(t.measureCh) && Number(t.measureCh) !== DEFAULT_USER_TWEAKS.measureCh;
  const radiusMoved = t.radiusPx !== undefined && Number(t.radiusPx) !== DEFAULT_USER_TWEAKS.radiusPx;
  const fontMoved = Number(t.fontScale) && Number(t.fontScale) !== DEFAULT_USER_TWEAKS.fontScale;

  if (measureMoved) {
    rootOverrides.push(`  --rd-measure: ${Number(t.measureCh)}ch;`);
  }
  if (radiusMoved) {
    rootOverrides.push(`  --rd-radius: ${Number(t.radiusPx)}px;`);
  }
  if (fontMoved) {
    rootOverrides.push(`  --rd-font-scale: ${Number(t.fontScale)};`);
  }
  if (rootOverrides.length > 0) {
    rules.push(`:root {\n${rootOverrides.join("\n")}\n}`);
  }

  if (measureMoved) {
    rules.push(`
[data-rd-role="main-content"],
main,
article {
  max-width: min(var(--rd-measure), 95vw) !important;
  margin-inline: auto !important;
}`);
  }

  if (radiusMoved) {
    rules.push(`
[data-rd-role="card-item"],
[data-rd-role="list-item"],
[data-rd-role="hero-spotlight"],
[data-rd-affordance="search-input"],
[data-rd-affordance="action-cta"] {
  border-radius: var(--rd-radius) !important;
}`);
  }

  if (fontMoved) {
    // Use 1rem (not 1em) so nested elements never compound scale exponentially
    rules.push(`
@scope (body) to (header, nav, pre, code, svg, #redesigner-hud-host) {
  p, td, th, dd, dt, figcaption, blockquote, label, li:not(:has(p, ul, ol)) {
    font-size: max(12px, calc(1rem * var(--rd-font-scale, 1)));
  }
}`);
  }

  if (t.hideSidebars) {
    rules.push(`
[data-rd-role="sidebar"] {
  display: none !important;
}`);
  }

  if (Number(t.cardCols) > 0) {
    const cols = Number(t.cardCols);
    rules.push(`
[data-rd-role="card-grid"]:not([data-rd-role="nav-list"]),
[data-rd-role="link-list"]:not([data-rd-role="nav-list"]) {
  display: grid !important;
  grid-template-columns: ${cols === 1 ? "1fr" : `repeat(${cols}, minmax(0, 1fr))`} !important;
  gap: var(--rd-gap, 16px) !important;
}
[data-rd-role="card-grid"] > [data-rd-role="card-item"],
[data-rd-role="link-list"] > [data-rd-role="list-item"] {
  width: 100% !important;
  min-width: 0 !important;
  box-sizing: border-box !important;
}`);
  }

  return rules.join("\n");
}

export function compileBaseFloorCSS() {
  return `
html, body {
  background: var(--rd-bg-body);
  color: var(--rd-fg-primary);
  font-family: var(--rd-font-body);
}

[data-rd-role="navbar"]:not([hidden]) {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 20px;
}

[data-rd-role="nav-list"]:not([hidden]) {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 14px;
  list-style: none;
  margin: 0;
  padding: 0;
}

[data-rd-role="nav-item"]:not([hidden]) {
  display: inline-flex;
  align-items: center;
  width: auto;
  padding: 6px 10px;
  border-radius: 8px;
}

@scope (body) to (dialog, [popover], iframe, video, pre, code, canvas, svg, #redesigner-hud-host) {
  a { color: var(--rd-accent); text-underline-offset: 3px; }
  h1, h2, h3, h4 { font-family: var(--rd-font-heading); color: var(--rd-fg-primary); line-height: 1.25; }

  [data-rd-role="card-item"],
  [data-rd-role="list-item"] {
    background: var(--rd-bg-surface);
    border: 1px solid var(--rd-border);
    border-radius: var(--rd-radius);
    padding: 12px;
    box-sizing: border-box;
    min-width: 0;
  }

  [data-rd-grid-kind="media"] {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(185px, 1fr));
    gap: var(--rd-gap, 16px);
  }

  [data-rd-grid-kind="media"] [data-rd-slot="media"] img {
    width: 100%;
    height: auto;
    aspect-ratio: 2 / 3;
    object-fit: cover;
    border-radius: calc(var(--rd-radius) * 0.75);
  }

  [data-rd-slot="title"] { font-weight: 650; color: var(--rd-fg-primary); }
  [data-rd-slot="description"] { color: var(--rd-fg-muted); margin-top: 6px; line-height: 1.5; }
  [data-rd-slot="meta"] { color: var(--rd-fg-muted); font-size: 0.85em; margin-top: 6px; display: inline-flex; gap: 6px; flex-wrap: wrap; }

  [data-rd-affordance="search-input"],
  [data-rd-affordance="form-control"] {
    background: var(--rd-bg-muted);
    color: var(--rd-fg-primary);
    border: 1px solid var(--rd-border);
    border-radius: calc(var(--rd-radius) * 0.85);
    padding: 8px 12px;
  }

  [data-rd-affordance="action-cta"] {
    background: var(--rd-accent);
    color: var(--rd-accent-fg);
    border: 1px solid transparent;
    border-radius: calc(var(--rd-radius) * 0.85);
    padding: 8px 14px;
    font-weight: 600;
    cursor: pointer;
  }
}`.trim();
}

export function compilePresetOnlyCSS(layoutPreset = "auto") {
  const presets = {
    "bento-command": `
/* Quick Preset: Top Command Bar + Bento Grid */
[data-rd-role="sidebar"] { display: none !important; }
[data-rd-role="navbar"]:not([hidden]) {
  position: sticky;
  top: 0;
  z-index: 50;
  background: color-mix(in oklab, var(--rd-bg-surface) 92%, transparent);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--rd-border);
  padding: 12px 24px;
}
[data-rd-role="main-content"] {
  width: min(1320px, 95vw) !important;
  max-width: none !important;
  margin-inline: auto !important;
  padding: 20px 0 !important;
}
[data-rd-role="card-grid"]:not([data-rd-grid-kind="media"]),
[data-rd-role="link-list"] {
  display: grid !important;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)) !important;
  gap: var(--rd-gap, 16px) !important;
}
[data-rd-role="card-grid"] > [data-rd-role="card-item"],
[data-rd-role="link-list"] > [data-rd-role="list-item"] {
  width: 100% !important;
  min-width: 0 !important;
  float: none !important;
}`,

    "editorial-focus": `
/* Quick Preset: Zen Editorial Reader */
[data-rd-role="sidebar"] { display: none !important; }
[data-rd-role="main-content"],
main, article {
  width: min(var(--rd-measure, 68ch), 92vw) !important;
  max-width: var(--rd-measure, 68ch) !important;
  margin-inline: auto !important;
  float: none !important;
  line-height: 1.75 !important;
  padding-block: 28px !important;
}
[data-rd-role="main-content"] p,
article p {
  margin-block: 1em;
}`,

    "app-workspace": `
/* Quick Preset: Split App Workspace */
[data-rd-role="main-content"] {
  max-width: 1400px !important;
  margin-inline: auto !important;
  padding: 18px 24px !important;
}
[data-rd-role="sidebar"] {
  position: sticky !important;
  top: 64px !important;
  max-height: calc(100dvh - 84px);
  overflow-y: auto;
  background: var(--rd-bg-surface) !important;
  border: 1px solid var(--rd-border) !important;
  border-radius: var(--rd-radius) !important;
  padding: 14px !important;
}`,

    "media-cards": `
/* Quick Preset: Visual Card Grid */
[data-rd-role="main-content"] {
  width: min(1380px, 95vw) !important;
  max-width: none !important;
  margin-inline: auto !important;
}
[data-rd-role="card-grid"]:not([data-rd-grid-kind="media"]) {
  display: grid !important;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)) !important;
  gap: var(--rd-gap, 16px) !important;
}
[data-rd-role="card-item"] {
  display: flex !important;
  flex-direction: column !important;
  justify-content: space-between;
  gap: 8px;
  width: 100% !important;
  min-width: 0 !important;
  float: none !important;
}`
  };

  return (presets[layoutPreset] || "").trim();
}

export function compileLayoutBlueprintCSS(layoutPreset = "auto") {
  const base = compileBaseFloorCSS();
  const preset = compilePresetOnlyCSS(layoutPreset);
  return preset ? `${base}\n\n${preset}` : base;
}
