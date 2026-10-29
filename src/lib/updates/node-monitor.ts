import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gt, valid } from "semver";
import { ApiError } from "../http";
import { githubRequest, githubUpdateToken } from "./github";
import { scanNodeSources, securityCheck } from "./security";
import { latestPackageVersion } from "./versions";
import { mapConcurrent, withPlanningSession } from "./planning";
import type { UpdateTarget } from "./types";
import { workspaceLockCovers } from "./workspace-monitor";
import { qualifySources, SourceQualificationError, CoverageLimit } from "./capabilities";

const locks = ["npm-shrinkwrap.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"];
export async function scanCurrentNode(target: UpdateTarget, commit: string | null, dependencies = { github: githubRequest, scan: scanNodeSources, latest: latestPackageVersion }) {
  if (target.mode !== "git" || !target.repository) throw new CoverageLimit(target.unavailable?.startsWith("Image externe") ? "Image externe : l’analyse des dépendances npm ne couvre pas ce service. Un contrôle de l’image est nécessaire." : "Les sources de ce service ne sont pas reliées à un dépôt GitHub identifiable. L’analyse complète des dépendances est indisponible.");
  // Provider-bound read-only monitoring is independent of permission to publish
  // updates. The token's existing repository read rights still apply.
  if (!/^[\w.-]+\/[\w.-]+$/.test(target.repository) || !githubUpdateToken(target.repository)) throw new ApiError("L’accès GitHub en lecture aux sources de ce service est indisponible.");
  if (!commit || !/^[a-f0-9]{40}$/.test(commit)) throw new ApiError("Le commit réellement déployé doit être identifié avant l’analyse.");
  if (target.root && (target.root.split("/").some(part => !part || part === "." || part === "..") || /[\\\x00-\x1f]/.test(target.root))) throw new ApiError("Répertoire source invalide.");
  const repository = target.repository, token = githubUpdateToken(repository);
  const prefix = `/repos/${repository}/contents/`;
  // GitHub redirects directory paths ending in '/'. Keep the exact commit query
  // and avoid that redirect instead of relaxing the no-redirect credential policy.
  const path = target.root ? target.root.split("/").map(encodeURIComponent).join("/") : "";
  async function sourceFile(directory: string, name: string) {
    const encoded = directory ? directory.split("/").map(encodeURIComponent).join("/") + "/" : "";
    let file = await dependencies.github(`${prefix}${encoded}${name}?ref=${commit}`, token);
    if (file.type === "file" && file.encoding === "none" && /^[a-f0-9]{40}$/.test(file.sha || "") && Number.isInteger(file.size) && file.size <= 6_000_000) {
      const blob = await dependencies.github(`/repos/${repository}/git/blobs/${file.sha}`, token);
      if (blob.sha !== file.sha || blob.size !== file.size) throw new ApiError("Le verrou GitHub ne correspond pas au commit observé.");
      file = { ...blob, type: "file" };
    }
    if (file.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string" || !Number.isInteger(file.size) || file.size > 6_000_000) throw new ApiError("Sources trop volumineuses ou non vérifiables.");
    const bytes = Buffer.from(file.content, "base64");
    if (bytes.length !== file.size) throw new ApiError("Sources incomplètes.");
    return bytes;
  }
  const entries = await dependencies.github(`${prefix}${path}?ref=${commit}`, token);
  if (!Array.isArray(entries)) throw new ApiError("Répertoire source non vérifiable.");
  const namesInRoot = entries.filter(entry => ["file", "dir"].includes(entry.type)).map(entry => entry.name);
  const hasManifest = entries.some(entry => entry.name === "package.json" && entry.type === "file");
  const manifestBytes = hasManifest ? await sourceFile(target.root, "package.json") : null;
  const manifest = manifestBytes ? JSON.parse(manifestBytes.toString("utf8")) : undefined;
  const sourceQualification = qualifySources(target, commit, namesInRoot, manifest);
  if (sourceQualification.family !== "node") throw new SourceQualificationError(`Technologie ${sourceQualification.family} identifiée au commit déployé ; analyse Node non applicable. Un parcours dédié est nécessaire.`, sourceQualification);
  let lock = locks.find(name => entries.some(entry => entry.name === name && entry.type === "file"));
  if (!entries.some(entry => entry.name === "package.json" && entry.type === "file")) {
    const known = ["package.json", ...locks, "requirements.txt", "pyproject.toml", "uv.lock", "Pipfile.lock", "composer.json", "composer.lock", "go.mod", "go.sum", "Cargo.toml", "Cargo.lock"];
    const detected = entries.filter(entry => entry.type === "file" && known.includes(entry.name)).map(entry => entry.name);
    throw new ApiError(`Manifest ou verrou absent : analyse incomplète. Répertoire : ${target.root || "racine"}. Fichiers de dépendances détectés : ${detected.join(", ") || "aucun"}.`);
  }
  let lockBytes = lock ? await sourceFile(target.root, lock) : undefined;
  let shared = false;
  if (!lock) {
    let parent = target.root;
    for (let depth = 0; parent && depth < 20; depth++) {
      parent = parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/")) : "";
      const directory = parent.split("/").map(encodeURIComponent).join("/");
      const files = await dependencies.github(`${prefix}${directory}?ref=${commit}`, token);
      if (!Array.isArray(files)) throw new ApiError("Répertoire de workspace non vérifiable.");
      const candidate = locks.find(name => files.some(file => file.type === "file" && file.name === name));
      if (!candidate || !files.some(file => file.type === "file" && file.name === "package.json")) continue;
      const bytes = await sourceFile(parent, candidate);
      const relative = parent ? target.root.slice(parent.length + 1) : target.root;
      const parentManifest = candidate === "yarn.lock" ? JSON.parse((await sourceFile(parent, "package.json")).toString("utf8")) : undefined;
      if (!workspaceLockCovers(candidate, bytes.toString("utf8"), relative, manifest, parentManifest)) continue;
      lock = candidate; lockBytes = bytes; shared = true; break;
    }
  }
  if (!lock || !lockBytes) throw new SourceQualificationError("Aucun verrou de dépendances ne couvre ce service, y compris dans les workspaces parents. Analyse incomplète.", sourceQualification);
  sourceQualification.lock = lock;
  sourceQualification.sharedLock ||= shared;
  const folder = await mkdtemp(join(tmpdir(), "vigie-monitor-"));
  try {
    await writeFile(join(folder, "package.json"), manifestBytes!);
    await writeFile(join(folder, lock), lockBytes);
    let packages: { name: string; version?: string }[] = [];
    const findings = await dependencies.scan(folder, [""], ["package.json", lock], undefined, async (_names, inventory) => { packages = inventory || []; });
    const warnings = ["Analyse des dépendances verrouillées du commit déployé ; l’image système, les secrets et le code applicatif ne sont pas analysés."];
    if (shared) {
      warnings.push("Analyse du verrou partagé du dépôt, qui référence ce workspace. Les alertes couvrent aussi d’autres services ; leur applicabilité à ce service doit être confirmée. Les versions disponibles de ses dépendances ne sont pas isolées par ce contrôle.");
      return { sourceQualification, checks: [securityCheck("OSV", "before", "Verrou partagé du dépôt · " + target.root, findings.map(finding => ({ ...finding, scope: target.root, kind: "unconfirmed" as const, explanation: "Signalement dans le verrou partagé du dépôt ; applicabilité à ce service à confirmer." })))], updates: [], warnings };
    }
    const names = [...new Set(["dependencies", "devDependencies", "optionalDependencies"].flatMap(section => Object.keys(manifest[section] || {})))];
    if (names.length > 250) throw new ApiError("Trop de dépendances directes pour ce contrôle.");
    const deadline = AbortSignal.timeout(60_000);
    const transport: typeof fetch = (input, options) => fetch(input, { ...options, signal: AbortSignal.any([deadline, ...(options?.signal ? [options.signal] : [])]) });
    const updates = await withPlanningSession(() => mapConcurrent(names, 6, async name => {
      const installed = [...new Set(packages.filter(item => item.name === name && valid(item.version)).map(item => item.version!))];
      if (!installed.length) { warnings.push(`${name} : version installée non identifiée.`); return []; }
      try {
        const latest = await dependencies.latest(name, transport);
        return installed.filter(version => gt(latest, version)).map(version => `${target.name} · ${name} ${version} → ${latest} : version stable disponible, compatibilité à valider.`);
      } catch { warnings.push(`${name} : catalogue des mises à jour indisponible.`); return []; }
    }));
    return { sourceQualification, checks: [securityCheck("OSV", "before", target.root || "racine", findings.map(finding => ({ ...finding, scope: target.root })))], updates: updates.flat(), warnings };
  } finally { await rm(folder, { recursive: true, force: true }); }
}
