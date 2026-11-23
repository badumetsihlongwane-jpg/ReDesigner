#!/usr/bin/env node
// scripts/package.mjs — Builds a clean Chrome Web Store / GitHub Release zip bundle in dist/

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const version = manifest.version;
const distDir = path.join(root, "dist");
const outZip = path.join(distDir, `redesigner-v${version}.zip`);

const RUNTIME_ENTRIES = [
  "manifest.json",
  "popup.html",
  "popup.css",
  "popup.js",
  "service-worker.js",
  "content-script.js",
  "agent-runtime.js",
  "shared",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png",
  "LICENSE"
];

for (const entry of RUNTIME_ENTRIES) {
  if (!fs.existsSync(path.join(root, entry))) {
    console.error(`✖ Missing required runtime entry: ${entry}`);
    process.exit(1);
  }
}

fs.mkdirSync(distDir, { recursive: true });
if (fs.existsSync(outZip)) fs.unlinkSync(outZip);

execFileSync("zip", ["-r", "-q", outZip, ...RUNTIME_ENTRIES, "-x", "*.DS_Store"], {
  cwd: root,
  stdio: "inherit"
});

const sizeKb = (fs.statSync(outZip).size / 1024).toFixed(1);
console.log(`✔ Packaged ${path.relative(root, outZip)} (${sizeKb} KB)`);
