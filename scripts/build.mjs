import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(projectRoot, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(resolve(dist, "content"), { recursive: true });
await mkdir(resolve(dist, "icons"), { recursive: true });
await mkdir(resolve(dist, "popup"), { recursive: true });
await mkdir(resolve(dist, "options"), { recursive: true });

const common = {
  bundle: true,
  minify: false,
  platform: "browser",
  target: "chrome120",
  sourcemap: true,
  logLevel: "info"
};

await build({
  ...common,
  entryPoints: [resolve(projectRoot, "src/background/service-worker.ts")],
  outfile: resolve(dist, "background.js")
});

await build({
  ...common,
  format: "iife",
  entryPoints: [resolve(projectRoot, "src/content/phase0-probe.ts")],
  outfile: resolve(dist, "content/phase0-probe.js")
});

await build({
  ...common,
  format: "iife",
  entryPoints: [resolve(projectRoot, "src/content/mtop-bridge-main.ts")],
  outfile: resolve(dist, "content/mtop-bridge-main.js")
});

await build({
  ...common,
  format: "iife",
  entryPoints: [resolve(projectRoot, "src/popup/main.ts")],
  outfile: resolve(dist, "popup/main.js")
});

await build({
  ...common,
  format: "iife",
  entryPoints: [resolve(projectRoot, "src/options/main.ts")],
  outfile: resolve(dist, "options/main.js")
});

await cp(resolve(projectRoot, "public/manifest.json"), resolve(dist, "manifest.json"));
await cp(resolve(projectRoot, "public/icons"), resolve(dist, "icons"), { recursive: true });
await cp(resolve(projectRoot, "src/content/coin-index-scrollbar.css"), resolve(dist, "content/coin-index-scrollbar.css"));
await cp(resolve(projectRoot, "src/popup/index.html"), resolve(dist, "popup/index.html"));
await cp(resolve(projectRoot, "src/popup/popup.css"), resolve(dist, "popup/popup.css"));
await cp(resolve(projectRoot, "src/options/index.html"), resolve(dist, "options/index.html"));
await cp(resolve(projectRoot, "src/options/options.css"), resolve(dist, "options/options.css"));
