#!/usr/bin/env node
// scripts/check.mjs — Zero-dependency production & release integrity checks

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const errors = [];

function fail(msg) {
  errors.push(msg);
  console.error(`✖ ${msg}`);
}

function ok(msg) {
  console.log(`✔ ${msg}`);
}

// 1. Validate manifest.json & package.json version alignment
let manifest;
let pkg;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (manifest.manifest_version !== 3) fail("manifest_version must be 3");
  if (manifest.version !== pkg.version) {
    fail(`Version mismatch: manifest.json (${manifest.version}) !== package.json (${pkg.version})`);
  } else {
    ok(`Manifest & package version aligned (${manifest.version})`);
  }
} catch (err) {
  fail(`Invalid manifest.json or package.json: ${err.message}`);
}

// 2. Verify all files referenced by manifest.json exist
if (manifest) {
  const referencedFiles = [
    manifest.side_panel?.default_path,
    manifest.background?.service_worker,
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {})
  ].filter(Boolean);

  for (const rel of new Set(referencedFiles)) {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) fail(`Missing file referenced in manifest.json: ${rel}`);
  }
  if (errors.length === 0) ok(`All ${new Set(referencedFiles).size} manifest asset paths exist`);
}

// 3. Verify popup.html version badge and DOM IDs match popup.js
try {
  const html = fs.readFileSync(path.join(root, "popup.html"), "utf8");
  const js = fs.readFileSync(path.join(root, "popup.js"), "utf8");
  const majorMinor = (manifest?.version || "").split(".").slice(0, 2).join(".");
  if (majorMinor && !html.includes(`v${majorMinor}`)) {
    fail(`popup.html version pill does not match v${majorMinor}`);
  }
  const ids = [...js.matchAll(/getElementById\(["']([^"']+)["']\)/g)].map((m) => m[1]);
  const missing = [...new Set(ids)].filter((id) => !html.includes(`id="${id}"`));
  if (missing.length) fail(`popup.js references missing HTML IDs: ${missing.join(", ")}`);
  else ok(`Verified ${new Set(ids).size} unique popup.js DOM IDs in popup.html`);
} catch (err) {
  fail(`Popup integrity check failed: ${err.message}`);
}

// 4. Syntax check every JS / MJS file
const jsFiles = [];
for (const dir of [".", "shared", "scripts", "tests"]) {
  const fullDir = path.join(root, dir);
  if (!fs.existsSync(fullDir)) continue;
  for (const entry of fs.readdirSync(fullDir)) {
    if (entry.endsWith(".js") || entry.endsWith(".mjs")) {
      jsFiles.push(path.join(dir, entry));
    }
  }
}
for (const rel of jsFiles) {
  try {
    execFileSync(process.execPath, ["--check", path.join(root, rel)], { stdio: "pipe" });
  } catch (err) {
    fail(`Syntax error in ${rel}: ${err.stderr?.toString() || err.message}`);
  }
}
ok(`Syntax-checked ${jsFiles.length} JavaScript modules`);

// 5. Secret / credential leak scan across tracked source files
const secretPatterns = [
  /AIzaSy[0-9A-Za-z_-]{20,}/,
  /sk-or-v1-[0-9a-fA-F]{20,}/,
  /gsk_[0-9A-Za-z]{20,}/,
  /nvapi-[0-9A-Za-z_-]{20,}/,
  /gh[po]_[0-9A-Za-z]{20,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
];
const scanFiles = [...jsFiles, "manifest.json", "popup.html", "popup.css"];
for (const rel of scanFiles) {
  const text = fs.readFileSync(path.join(root, rel), "utf8");
  for (const re of secretPatterns) {
    if (re.test(text)) fail(`Potential hardcoded secret detected in ${rel} (${re})`);
  }
}
ok("Zero hardcoded credentials detected");

if (errors.length > 0) {
  console.error(`\nCheck failed with ${errors.length} error(s).`);
  process.exit(1);
}
console.log("\nAll production checks passed.");
