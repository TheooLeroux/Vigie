import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { valid } from "semver";
import { ApiError } from "../http";
import { runCommand } from "./process";
import { createHash } from "node:crypto";
import type { SecurityFinding, UpdateCheck, UpdateResult } from "./types";

const identifier = z.string().min(1).max(200).regex(/^[a-z0-9@/_.:+~-]+$/i);
const findingSchema = z.object({ id: identifier, aliases: z.array(identifier).max(100).default([]), package: identifier, version: z.string().max(200), severity: z.enum(["critical", "high", "moderate", "low", "unknown"]), scope: z.string().max(4000).optional(), fixedVersions: z.array(z.string().regex(/^\d+\.\d+\.\d+$/)).max(200).optional() });
const vulnerability = z.object({ id: identifier, aliases: z.array(identifier).max(100).optional(), database_specific: z.object({ severity: z.string().optional() }).passthrough().optional() }).passthrough();
const osvSchema = z.object({ results: z.array(z.object({ source: z.object({ path: z.string() }), packages: z.array(z.object({ package: z.object({ name: identifier, version: z.string().max(200).optional(), ecosystem: z.string().optional() }), vulnerabilities: z.array(vulnerability).nullish(), groups: z.array(z.object({ ids: z.array(identifier), max_severity: z.string().optional() })).nullish() })) })) });
const trivySchema = z.object({ SchemaVersion: z.number(), Results: z.array(z.object({ Target: z.string(), Vulnerabilities: z.array(z.object({ VulnerabilityID: identifier, PkgName: identifier, InstalledVersion: z.string().max(200), Severity: z.string() })).nullish() })).default([]), Metadata: z.object({ OS: z.object({ Family: z.string(), Eosl: z.boolean().optional() }).passthrough().optional() }).passthrough() });

export function severity(value: unknown): SecurityFinding["severity"] {
  const label = typeof value === "string" ? value.toLowerCase() : "";
  if (["critical", "high", "low"].includes(label)) return label as SecurityFinding["severity"];
  if (["moderate", "medium"].includes(label)) return "moderate";
  const score = typeof value === "number" ? value : typeof value === "string" && /^\d+(\.\d+)?$/.test(value) ? Number(value) : NaN;
  return score >= 9 && score <= 10 ? "critical" : score >= 7 && score < 9 ? "high" : score >= 4 && score < 7 ? "moderate" : score >= 0 && score < 4 ? "low" : "unknown";
}
export function parseOsv(raw: string) {
  const report = osvSchema.parse(JSON.parse(raw));
  const findings: SecurityFinding[] = [];
  for (const source of report.results) for (const item of source.packages) for (const entry of item.vulnerabilities || []) {
    const group = item.groups?.find(group => group.ids.includes(entry.id));
    const affected = z.array(z.object({ package: z.object({ name: z.string(), ecosystem: z.string() }), ranges: z.array(z.object({ events: z.array(z.object({ fixed: z.string().optional() })) })).optional() })).safeParse(entry.affected);
    const fixedVersions = affected.success ? [...new Set(affected.data.filter(affected => affected.package.name === item.package.name && affected.package.ecosystem === "npm").flatMap(affected => affected.ranges?.flatMap(range => range.events.flatMap(event => event.fixed && /^\d+\.\d+\.\d+$/.test(event.fixed) ? [event.fixed] : [])) || []))] : [];
    findings.push(findingSchema.parse({ id: entry.id, aliases: entry.aliases || [], package: item.package.name, version: item.package.version || "unknown", scope: source.source.path.replaceAll("\\", "/"), fixedVersions, severity: severity(group?.max_severity || entry.database_specific?.severity) }));
  }
  return { findings, sources: report.results.map(result => result.source.path.replaceAll("\\", "/")), coverage: report.results.map(result => ({ path: result.source.path.replaceAll("\\", "/"), packages: result.packages.length })), packages: report.results.flatMap(result => result.packages.map(item => item.package)) };
}
export function parseTrivy(raw: string, baseline = false) {
  const report = trivySchema.parse(JSON.parse(raw));
  if (!report.Metadata.OS?.Family || !report.Results.length) throw new ApiError("Trivy n’a pas identifié le système de l’image. Analyse incomplète.", 502);
  if (report.Metadata.OS.Eosl && !baseline) throw new ApiError("L’image utilise une distribution système en fin de support. Publication annulée.");
  const findings: SecurityFinding[] = report.Results.flatMap(result => (result.Vulnerabilities || []).map(entry => findingSchema.parse({ id: entry.VulnerabilityID, aliases: [], package: entry.PkgName, version: entry.InstalledVersion, severity: severity(entry.Severity) })));
  if (report.Metadata.OS.Eosl) findings.push({ id: "EOL-OS", aliases: [], package: "base-image", version: "unsupported", severity: "critical" });
  return findings;
}
export function securityCheck(tool: UpdateCheck["tool"], phase: UpdateCheck["phase"], scope: string, findings: SecurityFinding[], _before: SecurityFinding[] = []): UpdateCheck {
  // The baseline describes what must be repaired; it is never an allowlist.
  // Every reported vulnerability, including low/unknown and unpatched issues,
  // excludes a candidate. Neither old versions nor missing fixes waive this gate.
  const blockers = phase === "before" ? [] : findings;
  return { tool, phase, scope, checkedAt: new Date().toISOString(), status: blockers.length ? "blocked" : findings.length ? "warning" : "passed", message: blockers.length ? `Publication arrêtée : ${blockers.length} vulnérabilité(s) connue(s) non résolue(s). Recherche d’une autre combinaison sans faille signalée ; aucune exception pour les alertes préexistantes.` : findings.length ? `${findings.length} vulnérabilité(s) à corriger ; cet état initial n’autorise pas la publication.` : "Aucune vulnérabilité connue signalée dans le périmètre analysé.", findings, ...(blockers.length ? { blockers } : {}) };
}
export class SecurityPolicyError extends ApiError {
  constructor(readonly check: UpdateCheck) { super(`${check.tool} : ${check.message}`, 422); }
}
export function requireSecurityPass(check: UpdateCheck) {
  if (check.status === "blocked") throw new SecurityPolicyError(check);
}
export function requireZeroFinalFindings(results: UpdateResult[]) {
  let unresolved: UpdateCheck | undefined;
  for (const result of results) {
    const latest = new Map<UpdateCheck["tool"], UpdateCheck>();
    for (const check of result.checks || []) {
      if (!["OSV", "Trivy", "WPScan", "WPVulnerability"].includes(check.tool)) continue;
      const previous = latest.get(check.tool);
      if (!previous || check.phase !== "before" || previous.phase === "before") latest.set(check.tool, check);
    }
    for (const check of latest.values()) if (check.findings.length || check.status === "blocked") {
      const failure = check.findings.length ? securityCheck(check.tool, "after", check.scope, check.findings) : check;
      result.stage = result.commit || result.deploymentId || result.backup ? "attention" : "failed";
      result.message = failure.message;
      unresolved ||= failure;
    }
  }
  if (unresolved) throw new SecurityPolicyError(unresolved);
}
function scannerEnvironment(temporary: string): NodeJS.ProcessEnv {
  return { NODE_ENV: "production", PATH: process.env.PATH, HOME: temporary, TMPDIR: temporary, ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}) };
}
export async function scanNodeSources(folder: string, roots: string[], names: string[], execute = runCommand, inventory?: (names: string[]) => Promise<void>) {
  const temporary = await mkdtemp(join(tmpdir(), "vigie-osv-"));
  try {
    const locks: string[] = [];
    const nonempty = new Set<string>();
    for (const root of [...new Set(roots)]) {
      const prefix = root ? root + "/" : "";
      const lock = ["npm-shrinkwrap.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"].find(name => names.includes(prefix + name));
      if (!lock) throw new ApiError("L’analyse de sécurité exige un fichier de verrouillage pour chaque service.");
      for (const name of [prefix + lock, prefix + "package.json"]) {
        if (name.split("/").some(part => !part || part === "." || part === "..") || /[\\\x00-\x1f]/.test(name)) throw new ApiError("Chemin d’analyse non autorisé.");
        await mkdir(dirname(join(temporary, name)), { recursive: true });
        await writeFile(join(temporary, name), await readFile(join(folder, name)));
      }
      locks.push(prefix + lock);
      const manifest = JSON.parse(await readFile(join(folder, prefix + "package.json"), "utf8"));
      if (["dependencies", "devDependencies", "optionalDependencies"].some(section => Object.keys(manifest[section] || {}).length)) nonempty.add(prefix + lock);
    }
    const output = await execute("osv-scanner", ["scan", "source", "--format=json", "--all-packages", ...locks.map(lock => `--lockfile=${join(temporary, lock)}`)], { cwd: temporary, env: scannerEnvironment(temporary), timeout: 180_000, acceptedExitCodes: [1] });
    let report;
    try { report = parseOsv(output); } catch { throw new ApiError("OSV n’a pas fourni un rapport de sécurité exploitable. Aucune publication autorisée.", 502); }
    const normalize = (path: string) => process.platform === "win32" ? path.replaceAll("\\", "/").toLowerCase() : path.replaceAll("\\", "/");
    const scannedLock = (path: string) => locks.find(lock => normalize(path) === normalize(join(temporary, lock)));
    if (locks.some(lock => !report.sources.some(source => scannedLock(source) === lock))) throw new ApiError("OSV n’a pas confirmé l’analyse de tous les fichiers de verrouillage.", 502);
    if ([...nonempty].some(lock => !report.coverage.some(source => scannedLock(source.path) === lock && source.packages > 0))) throw new ApiError("OSV n’a identifié aucune dépendance dans un verrou non vide. Analyse incomplète.", 502);
    if (report.packages.some(item => item.ecosystem !== "npm" || !item.version || !valid(item.version))) throw new ApiError("OSV ne peut pas identifier précisément certaines dépendances. Une validation dédiée est nécessaire.", 502);
    await inventory?.([...new Set(report.packages.map(item => item.name))]);
    return report.findings.map(finding => {
      const lock = finding.scope && scannedLock(finding.scope);
      if (!lock) throw new ApiError("OSV a renvoyé une alerte hors du périmètre analysé.", 502);
      return { ...finding, scope: lock.includes("/") ? lock.slice(0, lock.lastIndexOf("/")) : "" };
    });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
// Job-local, short-lived results only. Each changed manifest/lock is rescanned;
// callers force a complete fresh scan immediately before publication.
export function createNodeScanCache(folder: string, roots: string[], scan = scanNodeSources, clock = Date.now) {
  const cache = new Map<string, { key: string; findings: SecurityFinding[]; at: number }>();
  return async (names: string[], fresh = false) => {
    const selected = [...new Set(roots)], pending: { root: string; key: string }[] = [], reused: string[] = [];
    for (const root of selected) {
      const prefix = root ? root + "/" : "";
      const lock = ["npm-shrinkwrap.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"].find(name => names.includes(prefix + name));
      if (!lock || /[\\\x00-\x1f]/.test(prefix) || prefix.split("/").some(part => part === "." || part === "..") || prefix.startsWith("/")) throw new ApiError("Périmètre de cache de sécurité invalide.");
      const key = createHash("sha256").update(prefix + lock).update(await readFile(join(folder, prefix + "package.json"))).update(await readFile(join(folder, prefix + lock))).digest("hex");
      const previous = cache.get(root);
      if (!fresh && previous?.key === key && clock() - previous.at >= 0 && clock() - previous.at < 300_000) reused.push(root);
      else pending.push({ root, key });
    }
    if (pending.length) {
      const findings = await scan(folder, pending.map(entry => entry.root), names);
      if (findings.some(entry => !pending.some(item => item.root === entry.scope))) throw new ApiError("Alerte de sécurité hors du périmètre analysé.", 502);
      const at = clock();
      for (const entry of pending) cache.set(entry.root, { key: entry.key, at, findings: structuredClone(findings.filter(finding => finding.scope === entry.root)) });
    }
    return { findings: selected.flatMap(root => structuredClone(cache.get(root)!.findings)), checkedAt: new Date(Math.min(...selected.map(root => cache.get(root)!.at))).toISOString(), scanned: pending.map(entry => entry.root), reused };
  };
}

export async function scanDockerImage(image: string, execute = runCommand, baseline = false, cacheDirectory?: string) {
  if (!/^(?:node:[a-z0-9.-]+|vigie-validation:[a-f0-9-]{36})$/.test(image)) throw new ApiError("Image non autorisée pour l’analyse de sécurité.");
  const temporary = await mkdtemp(join(tmpdir(), "vigie-trivy-"));
  try {
    const output = await execute("trivy", ["image", "--scanners=vuln", "--format=json", "--quiet", "--exit-code=0", "--cache-dir", cacheDirectory || temporary, "--timeout=5m", image], { cwd: temporary, env: scannerEnvironment(temporary), timeout: 360_000 });
    try { return parseTrivy(output, baseline); } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError("Trivy n’a pas fourni un rapport d’image exploitable. Aucune publication autorisée.", 502);
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
