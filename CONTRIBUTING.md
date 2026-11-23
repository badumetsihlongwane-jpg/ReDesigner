# Contributing to ReDesigner

Thank you for helping improve ReDesigner! We aim to keep ReDesigner fast, trustworthy, approachable, and zero-dependency.

## Core Design Principles

1. **Zero Build, Zero Runtime Dependencies:** ReDesigner loads directly in Chrome via *Load unpacked* using native ES modules (`manifest.json` `"type": "module"`) and a standalone classic `content-script.js`. Do not introduce bundlers or npm dependencies unless there is an overwhelming, discussed reason.
2. **Respect Underlying Website Functionality:** Never break interactive menus, dropdowns, modals, forms, media players, or keyboard focus. Every DOM mutation must be cleanly reversible via **Compare** and **Revert**.
3. **Defense in Depth:** Untrusted webpages and LLM outputs are adversarial inputs. All CSS and DOM mutations must pass through `shared/css-sanitizer.js` and `shared/mutation-validator.js`.
4. **Verify Behavior, Not Just Syntax:** Changes to DOM scanning, color math, mutation undo, or QA auditing should include real Chrome E2E assertions in `tests/browser-e2e.test.mjs`.

## Local Setup

1. Fork and clone the repository.
2. Load the repo root in `chrome://extensions` with **Developer mode → Load unpacked**.
3. After editing files, click the **Reload** icon on ReDesigner in `chrome://extensions` (and refresh any open test tab if you edited `content-script.js`).

## Running Checks & Tests

Requires Node.js 22+ (and Google Chrome or Chromium for E2E tests):

```bash
npm run check   # Validates manifest.json, syntax, popup DOM IDs, and secret-free sources
npm test        # Runs unit tests + headless Chrome CDP E2E tests
npm run pack    # Produces dist/redesigner-v<version>.zip
```

## Submitting a Pull Request

- Keep PRs focused on a single bug fix or cohesive improvement.
- Run `npm run verify` and confirm all checks and tests pass locally before opening a PR.
- Update `README.md` or `CHANGELOG.md` if your change alters user-facing behavior, permissions, or supported providers.
- Never commit API keys, `.DS_Store`, `dist/`, or private configuration.
