#!/usr/bin/env node
// Bundles terminal_bridge.ts into a self-executing IIFE for injection into ttyd.

import { buildSync } from "esbuild";
import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const entryPoint = resolve(__dirname, "terminal_bridge.ts");
const outFile = resolve(__dirname, "terminal_bridge.built.js");

const result = buildSync({
  entryPoints: [entryPoint],
  bundle: true,
  format: "iife",
  target: "es2020",
  minify: false, // keep readable for debugging; flip for prod
  write: false,
  logLevel: "error",
});

const code = result.outputFiles[0].text;
writeFileSync(outFile, code);
console.log(`bridge built → ${outFile} (${code.length} bytes)`);
