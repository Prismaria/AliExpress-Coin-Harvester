import { access, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(projectRoot, "dist");
const manifestPath = resolve(dist, "manifest.json");

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.manifest_version !== 3 || !manifest.background?.service_worker || !manifest.action?.default_popup || !manifest.options_ui?.page) {
  throw new Error("Generated manifest is missing the required MV3 entry points.");
}

const references = new Set([
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
  manifest.options_ui?.page,
  ...(manifest.content_scripts ?? []).flatMap((script) => script.js ?? []),
  ...(manifest.content_scripts ?? []).flatMap((script) => script.css ?? [])
].filter((reference) => typeof reference === "string"));

for (const htmlPath of [manifest.action?.default_popup, manifest.options_ui?.page].filter(Boolean)) {
  const htmlFilePath = resolve(dist, htmlPath);
  const html = await readFile(htmlFilePath, "utf8");
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/gu)) {
    const reference = match[1];
    if (/^(?:[a-z][a-z\d+.-]*:|#|\/)/iu.test(reference)) continue;
    references.add(relative(dist, resolve(dirname(htmlFilePath), reference)));
  }
}

for (const reference of references) {
  const resolved = resolve(dist, reference);
  const relativePath = relative(dist, resolved);
  if (relativePath.startsWith("..") || relativePath.includes(":")) {
    throw new Error(`Generated package references a path outside dist: ${reference}`);
  }
  await access(resolved);
}

console.log(`Validated ${references.size} generated extension assets.`);
