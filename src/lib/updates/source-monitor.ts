import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError } from "../http";
import type { AutomaticControl } from "../automatic-control-state";
import { githubRequest, githubUpdateToken } from "./github";
import { scanCurrentNode } from "./node-monitor";
import { SourceQualificationError } from "./capabilities";
import type { SourceQualification } from "./capabilities";
import type { UpdateTarget } from "./types";
import { parseOsv, securityCheck } from "./security";
import { runCommand } from "./process";

const formats: Partial<Record<SourceQualification["family"], { files: string[]; ecosystem: string }>> = {
  php: { files: ["composer.lock"], ecosystem: "Packagist" },
  python: { files: ["uv.lock", "poetry.lock", "Pipfile.lock", "pdm.lock", "pylock.toml"], ecosystem: "PyPI" },
  go: { files: ["go.mod"], ecosystem: "Go" },
  rust: { files: ["Cargo.lock"], ecosystem: "crates.io" },
  ruby: { files: ["Gemfile.lock", "gems.locked"], ecosystem: "RubyGems" },
  bun: { files: ["bun.lock"], ecosystem: "npm" },
};
type Observation = Pick<AutomaticControl, "checks" | "updates" | "warnings" | "sourceQualification" | "securityCoverage">;

// Scan only exact dependency files. No package manager, install hook, project
// script or branch-head fallback is allowed in read-only surveillance.
export async function scanDependencyFiles(files: { name: string; content: Uint8Array }[], ecosystem: string, execute = runCommand) {
  const allowed = new Set(Object.values(formats).flatMap(format => format.files));
  if (!files.length || files.some(file => !allowed.has(file.name)) || new Set(files.map(file => file.name)).size !== files.length) throw new ApiError("Fichiers de dépendances non autorisés.");
  const folder = await mkdtemp(join(tmpdir(), "vigie-dependencies-"));
  try {
    for (const file of files) await writeFile(join(folder, file.name), file.content);
    const output = await execute("osv-scanner", ["scan", "source", "--format=json", "--all-packages", ...files.map(file => `--lockfile=${join(folder, file.name)}`)], {
      cwd: folder, env: { NODE_ENV: "production", PATH: process.env.PATH, HOME: folder, TMPDIR: folder }, timeout: 180_000, acceptedExitCodes: [1],
    });
    let report;
    try { report = parseOsv(output); } catch { throw new ApiError("OSV n’a pas fourni un rapport de sécurité exploitable.", 502); }
    const normalize = (path: string) => process.platform === "win32" ? path.replaceAll("\\", "/").toLowerCase() : path.replaceAll("\\", "/");
    const paths = new Set(files.map(file => normalize(join(folder, file.name))));
    if (report.sources.some(source => !paths.has(normalize(source))) || files.some(file => !report.coverage.some(source => normalize(source.path) === normalize(join(folder, file.name)) && source.packages > 0))) throw new ApiError("OSV n’a pas confirmé l’analyse de chaque verrou avec ses dépendances.", 502);
    if (report.packages.some(item => item.ecosystem !== ecosystem || !item.version || /^(?:unknown|unspecified)$/i.test(item.version))) throw new ApiError("Certaines dépendances n’ont pas de version résolue identifiable.", 502);
    return { findings: report.findings, packages: new Set(report.packages.map(item => `${item.ecosystem}:${item.name}:${item.version}`)).size };
  } finally { await rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
}

export async function scanCurrentDependencies(target: UpdateTarget, commit: string | null, dependencies = { node: scanCurrentNode, github: githubRequest, scan: scanDependencyFiles }): Promise<Observation> {
  try { return await dependencies.node(target, commit); }
  catch (error) {
    if (!(error instanceof SourceQualificationError)) throw error;
    if (!formats[error.sourceQualification.family]) {
      const { scanGitHubSources } = await import("./github-source-monitor");
      return { ...await scanGitHubSources(target, commit, { github: dependencies.github, scan: (await import("./source-snapshot")).scanSourceSnapshot }), sourceQualification: error.sourceQualification };
    }
    const sourceQualification = error.sourceQualification;
    if (!target.repository || !commit || !/^[a-f0-9]{40}$/.test(commit) || sourceQualification.repository !== target.repository || sourceQualification.commit !== commit || sourceQualification.root !== target.root) throw new ApiError("La qualification ne correspond pas au déploiement actuel.");
    const format = formats[sourceQualification.family]!;
    const token = githubUpdateToken(target.repository);
    if (!token) throw new ApiError("L’accès GitHub en lecture aux sources de ce service est indisponible.");
    const root = target.root ? target.root.split("/").map(encodeURIComponent).join("/") + "/" : "";
    const directory = `/repos/${target.repository}/contents/${root.replace(/\/$/, "")}`;
    const entries = await dependencies.github(`${directory}?ref=${commit}`, token);
    if (!Array.isArray(entries)) throw new ApiError("Répertoire source non vérifiable.");
    const selected = format.files.filter(name => entries.some(entry => entry.type === "file" && entry.name === name));
    if (!selected.length) throw new SourceQualificationError(`Sources ${sourceQualification.family} : fournir un verrou résolu (${format.files.join(", ")}) lié au commit déployé.`, sourceQualification);
    const files: { name: string; content: Uint8Array }[] = [];
    for (const name of selected) {
      let file = await dependencies.github(`/repos/${target.repository}/contents/${root}${name}?ref=${commit}`, token);
      if (file.type === "file" && file.encoding === "none" && /^[a-f0-9]{40}$/.test(file.sha || "") && Number.isInteger(file.size) && file.size <= 6_000_000) {
        const blob = await dependencies.github(`/repos/${target.repository}/git/blobs/${file.sha}`, token);
        if (blob.sha !== file.sha || blob.size !== file.size) throw new ApiError("Le verrou ne correspond pas au commit observé.");
        file = { ...blob, type: "file" };
      }
      if (file.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string" || !Number.isInteger(file.size) || file.size < 0 || file.size > 6_000_000) throw new ApiError("Verrou trop volumineux ou non vérifiable.");
      const content = Buffer.from(file.content, "base64");
      if (content.length !== file.size) throw new ApiError("Sources incomplètes.");
      files.push({ name, content });
    }
    const report = await dependencies.scan(files, format.ecosystem);
    sourceQualification.lock = selected[0];
    // Multiple alternative environments and workspace membership need separate
    // qualification. Keep their findings, without asserting service applicability.
    const shared = selected.length > 1 || sourceQualification.sharedLock || files.some(file => /\[workspace\]|\[\[tool\.poetry\.group\.|\[manifest\][\s\S]*members\s*=/.test(Buffer.from(file.content).toString("utf8")));
    const limitations = shared ? ["Plusieurs environnements ou un espace de travail partagé sont présents ; l’applicabilité au service doit être confirmée."] : [];
    const findings = report.findings.map(finding => ({ ...finding, scope: target.root, usage: "unknown" as const, ...(shared ? { kind: "unconfirmed" as const, explanation: limitations[0] } : {}) }));
    return { sourceQualification, checks: [securityCheck("OSV", "before", `${sourceQualification.family} · ${target.root || "racine"}`, findings)], updates: [], warnings: ["Analyse des dépendances identifiées au commit déployé. Le code métier et le système d’exploitation restent hors de ce périmètre.", ...limitations], securityCoverage: { scope: "dependencies", packages: report.packages, limitations } };
  }
}
