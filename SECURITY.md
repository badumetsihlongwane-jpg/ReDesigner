# Security Policy

## Threat Model

ReDesigner operates in a high-trust browser extension context while inspecting and restyling **untrusted third-party websites** using **untrusted AI model outputs** and **imported user recipes**. Our primary security boundaries are:

1. **CSS Injection Hardening (`shared/css-sanitizer.js`):**
   - Blocks `@import` directives to prevent external stylesheet loading.
   - Blocks external `url(http://...)`, `url(https://...)`, and protocol-relative `url(//...)` references (allowing only relative paths, same-origin URLs, and safe `data:image/*` assets) to prevent CSS-based data exfiltration or tracking beacons.
   - Blocks unsafe `data:image/svg+xml` payloads containing `<script`, `javascript:`, or inline event handlers (`on*=`).
   - Blocks legacy script-in-CSS vectors (`expression(`, `behavior:`, `-moz-binding:`, `javascript:`).
   - Blocks catastrophic root-hiding declarations (`display: none`, `visibility: hidden`, `opacity: 0`) on bare `html`, `body`, `:root`, or `*`.
2. **DOM Mutation Hardening (`shared/mutation-validator.js` & `content-script.js`):**
   - Enforces a strict allowlist of 6 reversible structural actions (`createSlot`, `reparent`, `wrapGroup`, `createHeroFromElement`, `setInert`, `unwrapLayoutTable`).
   - Never injects arbitrary HTML from model outputs (`textContent` only for generated hero text; `isSafeUrl` rejects `javascript:`, `vbscript:`, `data:text/html`, and protocol-relative `//` URLs).
   - Protects critical document boundaries (`html`, `body`, `head`, `:root`, `#redesigner-hud-host`).
3. **Prompt-Injection Mitigations (`agent-runtime.js`, `service-worker.js`, `shared/skills.js`):**
   - Wraps scraped webpage titles, DOM trees, attributes, and style probes inside `<untrusted_page_data>` delimiters with explicit instructions not to obey webpage-embedded directives.
4. **Credential & Privacy Isolation:**
   - API keys are stored solely in Chrome's local extension storage (`chrome.storage.local`) and transmitted only to the user-selected AI provider endpoint.
   - ReDesigner contains zero telemetry, analytics, or third-party tracking scripts.

## Reporting a Vulnerability

If you discover a security vulnerability (such as a CSS sanitizer bypass, XSS vector, unsafe URL handling, or credential leak):

1. **Please do not open a public GitHub issue** with exploit details before a fix is ready.
2. Use GitHub's **Private Vulnerability Reporting** ("Security → Advisories → Report a vulnerability") on the repository, or contact the maintainer privately via their GitHub profile.
3. Include a minimal reproduction page/payload, affected file(s), and Chrome version.

We aim to acknowledge reports promptly and release fixes with clear advisory notes.
