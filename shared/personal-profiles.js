// shared/personal-profiles.js — User-Owned Design Tokens, Structural Slot Baselines & Safe Healer CSS

export const PERSONAL_PROFILES = {
  obsidian: {
    id: "obsidian",
    name: "Obsidian",
    swatches: ["#0b1017", "#121923", "#38bdf8"],
    colorScheme: "dark",
    tokens: {
      "--rd-bg-body": "#0b1017",
      "--rd-bg-surface": "#121923",
      "--rd-bg-muted": "#1a2332",
      "--rd-bg-track": "#243044",
      "--rd-overlay-hover": "rgba(226, 236, 248, 0.08)",
      "--rd-fg-primary": "#ecf1f8",
      "--rd-fg-muted": "#98a7bc",
      "--rd-accent": "#38bdf8",
      "--rd-accent-fg": "#071926",
      "--rd-border": "rgba(226, 236, 248, 0.12)",
      "--rd-font-body": "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
      "--rd-font-heading": "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
      "--rd-measure": "72ch",
      "--rd-radius": "10px",
      "--rd-gap": "16px"
    }
  },
  editorial: {
    id: "editorial",
    name: "Editorial",
    swatches: ["#f6f2ea", "#fdfbf7", "#9a3412"],
    colorScheme: "light",
    tokens: {
      "--rd-bg-body": "#f6f2ea",
      "--rd-bg-surface": "#fdfbf7",
      "--rd-bg-muted": "#ece6da",
      "--rd-bg-track": "#dfd7c8",
      "--rd-overlay-hover": "rgba(28, 25, 22, 0.05)",
      "--rd-fg-primary": "#1c1916",
      "--rd-fg-muted": "#5c554c",
      "--rd-accent": "#9a3412",
      "--rd-accent-fg": "#fffaf5",
      "--rd-border": "rgba(28, 25, 22, 0.13)",
      "--rd-font-body": "Georgia, 'Charter', 'Times New Roman', serif",
      "--rd-font-heading": "system-ui, -apple-system, sans-serif",
      "--rd-measure": "66ch",
      "--rd-radius": "6px",
      "--rd-gap": "20px"
    }
  },
  matcha: {
    id: "matcha",
    name: "Matcha",
    swatches: ["#152019", "#fafcf9", "#4ade80"],
    colorScheme: "light dark",
    tokens: {
      "--rd-bg-body": "light-dark(#f1f5ef, #0e1511)",
      "--rd-bg-surface": "light-dark(#fafcf9, #152019)",
      "--rd-bg-muted": "light-dark(#e3ebe0, #1e2d23)",
      "--rd-bg-track": "light-dark(#d4e0d0, #283a2e)",
      "--rd-overlay-hover": "light-dark(rgba(20, 33, 24, 0.05), rgba(232, 242, 235, 0.07))",
      "--rd-fg-primary": "light-dark(#142118, #e8f2eb)",
      "--rd-fg-muted": "light-dark(#495e50, #96ab9d)",
      "--rd-accent": "light-dark(#15803d, #4ade80)",
      "--rd-accent-fg": "light-dark(#f0fdf4, #052e16)",
      "--rd-border": "light-dark(rgba(20, 33, 24, 0.12), rgba(232, 242, 235, 0.13))",
      "--rd-font-body": "system-ui, -apple-system, sans-serif",
      "--rd-font-heading": "system-ui, -apple-system, sans-serif",
      "--rd-measure": "70ch",
      "--rd-radius": "10px",
      "--rd-gap": "16px"
    }
  },
  highContrast: {
    id: "highContrast",
    name: "AAA Contrast",
    swatches: ["#090b10", "#111520", "#facc15"],
    colorScheme: "dark",
    tokens: {
      "--rd-bg-body": "#090b10",
      "--rd-bg-surface": "#111520",
      "--rd-bg-muted": "#192030",
      "--rd-bg-track": "#273147",
      "--rd-overlay-hover": "rgba(255, 250, 220, 0.1)",
      "--rd-fg-primary": "#f7f8fb",
      "--rd-fg-muted": "#c6cedc",
      "--rd-accent": "#facc15",
      "--rd-accent-fg": "#090b10",
      "--rd-border": "rgba(247, 248, 251, 0.24)",
      "--rd-font-body": "system-ui, -apple-system, 'Segoe UI', sans-serif",
      "--rd-font-heading": "system-ui, -apple-system, 'Segoe UI', sans-serif",
      "--rd-measure": "65ch",
      "--rd-radius": "8px",
      "--rd-gap": "20px"
    }
  }
};

export function compileProfileTokensCSS(profileId = "obsidian") {
  const profile = PERSONAL_PROFILES[profileId] || PERSONAL_PROFILES.obsidian;
  const lines = Object.entries(profile.tokens).map(([k, v]) => `  ${k}: ${v};`);
  lines.push(
    `  --rd-bg: var(--rd-bg-body);`,
    `  --rd-surface: var(--rd-bg-surface);`,
    `  --rd-surface-elevated: var(--rd-bg-muted);`,
    `  --rd-text: var(--rd-fg-primary);`,
    `  --rd-text-muted: var(--rd-fg-muted);`
  );
  return `:root {\n  color-scheme: ${profile.colorScheme};\n${lines.join("\n")}\n}`;
}

/**
 * Injected BEFORE adapter CSS so AI/user adapter rules can freely override
 * spacing, radius, backdrop, or layout dimensions of generated structural slots.
 */
export const STRUCTURAL_SLOT_BASE_CSS = `
/* === ReDesigner Structural Slot Baselines & Stacking Context Isolation === */
[data-rd-role="card-item"],
[data-rd-role="list-item"],
[data-rd-role="hero-spotlight"] {
  isolation: isolate;
}

[data-rd-layout-table="true"],
[data-rd-layout-table="true"] > tbody,
[data-rd-layout-table="true"] > tbody > tr,
[data-rd-layout-table="true"] > tbody > tr > td {
  display: block !important;
  width: 100% !important;
  max-width: 100% !important;
  box-sizing: border-box !important;
}

[data-rd-generated="true"][data-rd-role="hero-spotlight"] {
  position: relative;
  min-height: 290px;
  border-radius: var(--rd-radius, 18px);
  overflow: hidden;
  display: flex;
  align-items: flex-end;
  padding: 26px;
  border: 1px solid var(--rd-border);
  margin-bottom: 20px;
  background: var(--rd-bg-surface);
}

[data-rd-generated="true"][data-rd-role="hero-spotlight"]::after {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 1;
  background: linear-gradient(90deg, rgba(10, 14, 20, 0.88) 0%, rgba(10, 14, 20, 0.5) 55%, rgba(10, 14, 20, 0.15) 100%);
  pointer-events: none;
}

[data-rd-slot="hero-backdrop"] {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  z-index: 0;
}

[data-rd-slot="hero-content"] {
  position: relative;
  z-index: 2;
  max-width: 580px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  color: #f8fafc;
}

[data-rd-slot="hero-badge"] {
  align-self: flex-start;
  padding: 4px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  background: rgba(255, 255, 255, 0.18);
  backdrop-filter: blur(10px);
  color: #ffffff;
}

[data-rd-slot="hero-title"] {
  margin: 0;
  font-size: clamp(1.5rem, 2.4vw, 2.2rem);
  line-height: 1.15;
  font-weight: 750;
  color: #ffffff;
}

[data-rd-slot="hero-desc"] {
  margin: 0;
  font-size: 0.95rem;
  line-height: 1.45;
  color: rgba(248, 250, 252, 0.85);
}

[data-rd-slot="hero-cta"] {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px;
  border-radius: 999px;
  background: #ffffff;
  color: #0f172a;
  font-weight: 700;
  font-size: 13.5px;
  text-decoration: none;
}

[data-rd-generated="true"][data-rd-role="top-command-bar"] {
  position: sticky;
  top: 0;
  z-index: 999;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 20px;
  background: var(--rd-bg-surface);
  border-bottom: 1px solid var(--rd-border);
}

[data-rd-generated="true"][data-rd-role="bento-shell"] {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: var(--rd-gap, 16px);
  width: min(1320px, 94vw);
  margin: 20px auto;
  align-items: start;
}

[data-rd-generated="true"][data-rd-role="split-workspace"] {
  display: grid;
  grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
  gap: var(--rd-gap, 20px);
  width: min(1400px, 96vw);
  margin: 16px auto;
  align-items: start;
}

@media (max-width: 860px) {
  [data-rd-generated="true"][data-rd-role="split-workspace"] {
    grid-template-columns: 1fr;
  }
}
`;

/**
 * Injected AFTER adapter CSS and user tweaks: only targets elements explicitly
 * marked by the contrast auto-healer + universal accessibility focus/motion guards.
 * Deliberately does NOT lock originally-hidden elements with display:none!important
 * so site dropdowns, modals, tabs, and accordions keep working interactively.
 */
export const HEALER_AND_SAFETY_CSS = `
/* === ReDesigner Contrast Healer & Accessibility Guards === */
:where(a, button, input, select, textarea, [tabindex]):focus-visible {
  outline: 2px solid var(--rd-accent) !important;
  outline-offset: 2px !important;
}

[data-rd-healed-bg="surface"] {
  background-color: var(--rd-bg-surface) !important;
  color: var(--rd-fg-primary) !important;
  border-color: var(--rd-border) !important;
}

[data-rd-healed-bg="elevated"] {
  background-color: var(--rd-bg-muted) !important;
  color: var(--rd-fg-primary) !important;
  border-color: var(--rd-border) !important;
}

[data-rd-healed-bg="transparent"] {
  background-color: transparent !important;
}

[data-rd-healed-text="fg"] {
  color: var(--rd-fg-primary) !important;
}

[data-rd-healed-text="link"],
[data-rd-healed-text="link"]:visited {
  color: var(--rd-accent) !important;
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
  }
}
`;

// Backwards-compatible combined export
export const BASE_HEALER_AND_LAYOUT_CSS = `${STRUCTURAL_SLOT_BASE_CSS}\n${HEALER_AND_SAFETY_CSS}`;
