import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { valid } from "semver";
import { ApiError } from "../http";
import type { AutomaticControl } from "../automatic-control-state";
import type { SecurityFinding } from "./types";
import { browserDependencies, queryKnownPackages, type BrowserPackage } from "./browser-dependencies";
import { scanNodeSources, securityCheck } from "./security";
import { scanDependencyFiles } from "./source-monitor";
import { dependencyFiles } from "./source-files";
export { inspectableSource } from "./source-files";

export type SourceFile = { path: string; content: string };
const generic: Record<string, string> = { "bun.lock": "npm", "composer.lock": "Packagist", "uv.lock": "PyPI", "poetry.lock": "PyPI", "Pipfile.lock": "PyPI", "pdm.lock": "PyPI", "pylock.toml": "PyPI", "go.mod": "Go", "Cargo.lock": "crates.io", "Gemfile.lock": "RubyGems", "gems.locked": "RubyGems" };

// A snapshot is read-only evidence. No install, build or uploaded code is run.
export async function scanSourceSnapshot(files: SourceFile[], options: { source: "vercel" | "github" | "hosting"; deploymentId?: string; limitations?: string[] }, dependencies = { node: scanNodeSources, generic: scanDependencyFiles, query: queryKnownPackages }): Promise<Pick<AutomaticControl, "checks" | "updates" | "warnings" | "securityCoverage" | "coverage">> {
  if (!files.length || files.length > 500 || files.some(file => !file.path || file.path.startsWith("/") || /[\\\x00-\x1f]/.test(file.path) || file.path.split("/").some(part => part === ".." || part === ".")) || new Set(files.map(file => file.path)).size !== files.length) throw new ApiError("Inventaire de sources vide, ambigu ou trop volumineux.");
  const browser = browserDependencies(files.filter(file => /\.(?:html?|[cm]?jsx?|tsx?|css)$/i.test(file.path)));
  const limitations = [...options.limitations || [], ...browser.limitations];
  const inventory: BrowserPackage[] = [...browser.inventory], resolved: BrowserPackage[] = [];
  const findings: SecurityFinding[] = [];
  let packageCount = 0, analyzed = false;
  const deadline = Date.now() + 120_000;
  const budget = () => { if (Date.now() < deadline) return true; limitations.push("Budget d’analyse atteint ; certains composants doivent être contrôlés au prochain passage."); return false; };
  const folder = await mkdtemp(join(tmpdir(), "vigie-sources-"));
  try {
    for (const file of files.filter(file => dependencyFiles.includes(file.path.split("/").at(-1)!))) {
      await mkdir(dirname(join(folder, file.path)), { recursive: true }); await writeFile(join(folder, file.path), file.content);
    }
    const names = files.map(file => file.path);
    for (const file of files.filter(file => file.path === "package.json" || file.path.endsWith("/package.json"))) {
      if (!budget()) break;
      const root = file.path.slice(0, -"package.json".length);
      let manifest: Record<string, any>;
      try { manifest = JSON.parse(file.content); if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw Error(); }
      catch { limitations.push(`${file.path} : manifeste invalide ; les autres fichiers restent inspectés.`); continue; }
      const declared = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies });
      const lock = ["npm-shrinkwrap.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"].map(name => root + name).find(name => names.includes(name));
      const shared = !!manifest.workspaces || names.includes(root + "pnpm-workspace.yaml");
      if (lock) {
        const lockFile = files.find(file => file.path === lock)!;
        let npm;
        try { npm = /(?:package-lock|npm-shrinkwrap)\.json$/.test(lock) ? JSON.parse(lockFile.content) : null; }
        catch { limitations.push(`${lock} : verrou invalide ; les autres fichiers restent inspectés.`); continue; }
        const verifiedEmpty = npm && [2, 3].includes(npm.lockfileVersion) && npm.packages && !Array.isArray(npm.packages) && typeof npm.packages === "object" && Object.keys(npm.packages).every(path => path === "") && !declared.length && !Object.keys(npm.dependencies || {}).length && ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].every(section => !Object.keys(npm.packages[""]?.[section] || {}).length);
        try {
          if (!verifiedEmpty) findings.push(...(await dependencies.node(folder, [root.replace(/\/$/, "")], names, undefined, async (_names, packages) => { packageCount += packages?.length || 0; resolved.push(...(packages || []).filter(p => p.version).map(p => ({ name: p.name, version: p.version!, origin: lock }))); })).map(finding => ({ ...finding, ...(shared ? { kind: "unconfirmed" as const, explanation: "Verrou partagé ; applicabilité au service à confirmer." } : {}) })));
          analyzed = true;
          if (shared) limitations.push(`${root || "racine"} : verrou partagé entre plusieurs applications.`);
        } catch (error) { limitations.push(`${lock} : ${error instanceof ApiError ? error.message : "analyse du verrou indisponible."}`); }
      } else if (!names.includes(root + "bun.lock")) {
        if (declared.length) limitations.push(`${file.path} : versions transitives inconnues en l’absence de verrou.`);
        for (const [name, version] of declared) {
          if (typeof version === "string" && valid(version)) inventory.push({ name, version: valid(version)!, origin: file.path });
          else limitations.push(`${file.path} : version exacte non identifiée pour ${name}.`);
        }
        if (!declared.length) analyzed = true;
      }
    }
    for (const file of files.filter(file => generic[file.path.split("/").at(-1)!])) {
      if (!budget()) break;
      const name = file.path.split("/").at(-1)!;
      try { const result = await dependencies.generic([{ name, content: Buffer.from(file.content) }], generic[name]); packageCount += result.packages; findings.push(...result.findings.map(finding => ({ ...finding, scope: file.path }))); analyzed = true; }
      catch (error) { limitations.push(`${file.path} : ${error instanceof ApiError ? error.message : "analyse indisponible."}`); }
    }
    const unique = [...new Map(inventory.map(item => [`${item.name}@${item.version}`, item])).values()];
    if (unique.length && budget()) {
      try { findings.push(...await dependencies.query(unique)); packageCount += unique.length; analyzed = true; }
      catch { limitations.push("Le catalogue des vulnérabilités des bibliothèques identifiées est indisponible ; leur analyse sera réessayée."); }
    }
    const codeFiles = files.filter(file => /\.(?:html?|[cm]?jsx?|tsx?|css)$/i.test(file.path));
    if (codeFiles.length) {
      if (!unique.length && !limitations.length) analyzed = true;
      limitations.push("Les fichiers HTML/JavaScript/CSS sont inventoriés et leurs références de bibliothèques analysées. Le code personnalisé, les bibliothèques intégrées et les chargements construits dynamiquement demandent une analyse complémentaire.");
    }
    for (const file of files.filter(file => /(?:requirements\.txt|pyproject\.toml|composer\.json|Cargo\.toml)$/.test(file.path))) {
      const root = file.path.slice(0, file.path.lastIndexOf("/") + 1);
      if (!files.some(f => f.path.startsWith(root) && generic[f.path.slice(root.length)])) limitations.push(`${file.path} : aucun verrou résolu exploitable pour cette technologie.`);
    }
    if (!analyzed && !limitations.length) limitations.push("Sources récupérées, aucun inventaire de composants exploitable pour cette technologie.");
    const fullInventory = [...new Map([...unique, ...resolved].map(item => [`${item.name}@${item.version}`, item])).values()];
    if (fullInventory.length > 2000) limitations.push("L’affichage de l’inventaire est limité à 2000 composants ; les alertes sont conservées intégralement.");
    return { checks: analyzed ? [securityCheck("OSV", "before", options.deploymentId || options.source, findings)] : [], ...(!analyzed ? { coverage: "partial" as const } : {}), updates: [], warnings: [...new Set(limitations)], securityCoverage: { scope: "sources", source: options.source, deploymentId: options.deploymentId, files: files.length, filesRead: files.map(file => file.path), packages: packageCount, inventory: fullInventory.slice(0, 2000), observations: [`${files.length} fichier(s) de sources ou de dépendances lu(s).`, `${packageCount} entrée(s) de composants analysée(s).`], limitations: [...new Set(limitations)] } };
  } finally { await rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
}
