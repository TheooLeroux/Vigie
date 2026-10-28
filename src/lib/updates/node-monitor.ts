import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gt, valid } from "semver";
import { ApiError } from "../http";
import { githubRequest, githubUpdateToken } from "./github";
import { scanNodeSources, securityCheck } from "./security";
import { latestPackageVersion } from "./versions";
import { mapConcurrent, withPlanningSession } from "./planning";
import type { UpdateTarget } from "./types";

const locks = ["npm-shrinkwrap.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"];
export async function scanCurrentNode(target: UpdateTarget, commit: string | null, dependencies = { github: githubRequest, scan: scanNodeSources, latest: latestPackageVersion }) {
  if (target.mode !== "git" || !target.repository) throw new ApiError(target.unavailable?.startsWith("Image externe") ? "Image externe : l’analyse des dépendances npm ne couvre pas ce service. Un contrôle de l’image est nécessaire." : "Les sources de ce service ne sont pas reliées à un dépôt GitHub identifiable. L’analyse complète des dépendances est indisponible.");
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
  const filePrefix = path ? path + "/" : "";
  const entries = await dependencies.github(`${prefix}${path}?ref=${commit}`, token);
  if (!Array.isArray(entries)) throw new ApiError("Répertoire source non vérifiable.");
  const lock = locks.find(name => entries.some(entry => entry.name === name && entry.type === "file"));
  if (!lock || !entries.some(entry => entry.name === "package.json" && entry.type === "file")) throw new ApiError("Manifest ou verrou absent : analyse incomplète.");
  const folder = await mkdtemp(join(tmpdir(), "vigie-monitor-"));
  try {
    for (const name of ["package.json", lock]) {
      let file = await dependencies.github(`${prefix}${filePrefix}${name}?ref=${commit}`, token);
      // The Contents API omits content above 1 MB. Git blobs still provide a
      // bounded base64 response for larger locks, bound to the exact same SHA.
      if (file.type === "file" && file.encoding === "none" && /^[a-f0-9]{40}$/.test(file.sha || "") && Number.isInteger(file.size) && file.size <= 6_000_000) {
        const blob = await dependencies.github(`/repos/${repository}/git/blobs/${file.sha}`, token);
        if (blob.sha !== file.sha || blob.size !== file.size) throw new ApiError("Le verrou GitHub ne correspond pas au commit observé.");
        file = { ...blob, type: "file" };
      }
      if (file.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string" || !Number.isInteger(file.size) || file.size > 6_000_000) throw new ApiError("Sources trop volumineuses ou non vérifiables.");
      const bytes = Buffer.from(file.content, "base64");
      if (bytes.length !== file.size) throw new ApiError("Sources incomplètes.");
      await writeFile(join(folder, name), bytes);
    }
    const manifest = JSON.parse(await readFile(join(folder, "package.json"), "utf8"));
    let packages: { name: string; version?: string }[] = [];
    const findings = await dependencies.scan(folder, [""], ["package.json", lock], undefined, async (_names, inventory) => { packages = inventory || []; });
    const warnings = ["Analyse des dépendances verrouillées du commit déployé ; l’image système, les secrets et le code applicatif ne sont pas analysés."];
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
    return { checks: [securityCheck("OSV", "before", target.root || "racine", findings.map(finding => ({ ...finding, scope: target.root })))], updates: updates.flat(), warnings };
  } finally { await rm(folder, { recursive: true, force: true }); }
}
