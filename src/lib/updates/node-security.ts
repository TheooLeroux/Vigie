import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { npmRiskReduction, sameNpmAdvisory } from "./npm-risk";
import { npmGraph } from "./remediation";
import { sameScopedFinding, securityCheck } from "./security";
import type { SecurityFinding, UpdateCheck } from "./types";

export async function npmResidualPolicy(folder: string, names: string[], baseline: SecurityFinding[]) {
  const locks = new Map<string, { name: string; original: string }>();
  for (const root of new Set(baseline.flatMap(finding => finding.scope === undefined ? [] : [finding.scope]))) {
    const prefix = root ? `${root}/` : "";
    const name = ["npm-shrinkwrap.json", "package-lock.json"].map(file => prefix + file).find(file => names.includes(file));
    if (name) locks.set(root, { name, original: await readFile(join(folder, name), "utf8") });
  }
  const approvals: { finding: SecurityFinding; signature: string }[] = [];
  const tradeoffs = new Map<string, { hash: string; findings: SecurityFinding[] }>();
  const hash = (lock: string) => createHash("sha256").update(lock).digest("hex");

  async function exposure(working: string, finding: SecurityFinding) {
    const lock = finding.scope !== undefined && locks.get(finding.scope);
    if (!lock) return;
    const original = npmGraph(lock.original), candidate = npmGraph(await readFile(join(working, lock.name), "utf8"));
    const paths = candidate.paths(finding.package, finding.version);
    const previous = new Set(original.paths(finding.package, finding.version).map(path => JSON.stringify(path)));
    const reached = new Set(paths.map(path => path.at(-1)));
    if (candidate.locations(finding.package, finding.version).some(path => !reached.has(path))) return;
    // Require the same vulnerable artifact and forbid new paths or wider usage.
    if (!paths.length || paths.some(path => {
      const location = path.at(-1)!;
      const before = original.nodes.get(location), after = candidate.nodes.get(location);
      return !previous.has(JSON.stringify(path)) || before?.integrity !== after?.integrity || before?.resolved !== after?.resolved
        || (before?.dev === true && after?.dev !== true);
    })) return;
    return JSON.stringify(paths.map(path => JSON.stringify(path.map(location => [location, candidate.nodes.get(location)?.version]))).sort());
  }

  return {
    async retain(working: string, findings: SecurityFinding[], scanned?: SecurityFinding[]) {
      let added = false;
      for (const finding of findings) {
        if (!finding.explanation || finding.kind === "supply-chain" || [finding.id, ...finding.aliases].some(id => id.startsWith("MAL-")) || !baseline.some(item => sameScopedFinding(item, finding))) continue;
        const signature = await exposure(working, finding);
        if (!signature || approvals.some(item => item.signature === signature && sameScopedFinding(item.finding, finding))) continue;
        approvals.push({ finding, signature });
        added = true;
      }
      if (scanned) for (const [root, lock] of locks) {
        const candidate = scanned.filter(finding => finding.scope === root);
        const introduced = candidate.filter(finding => !baseline.some(item => sameNpmAdvisory(item, finding)));
        if (!introduced.length || introduced.some(finding => !findings.some(item => item.explanation && sameScopedFinding(item, finding)))) continue;
        const content = await readFile(join(working, lock.name), "utf8");
        const signature = hash(content);
        if (tradeoffs.get(root)?.hash === signature) continue;
        const graph = npmGraph(content);
        const manifest = graph.nodes.get("")!;
        const runtime = new Set<string>();
        const pending = Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies })
          .flatMap(name => graph.resolve("", name) || []);
        while (pending.length) {
          const path = pending.pop()!;
          if (runtime.has(path)) continue;
          runtime.add(path);
          for (const edge of graph.edges(path, true)) if (!runtime.has(edge.target)) pending.push(edge.target);
        }
        const buildFindings = introduced.map(finding => {
          const locations = graph.locations(finding.package, finding.version);
          const buildOnly = locations.length > 0 && locations.every(location => graph.nodes.get(location)?.dev === true && !runtime.has(location));
          return { ...finding, usage: buildOnly ? "build" as const : "unknown" as const };
        });
        if (!npmRiskReduction(baseline, candidate, buildFindings)) continue;
        tradeoffs.set(root, { hash: signature, findings: buildFindings.map(finding => ({
          ...finding, explanation: findings.find(item => sameScopedFinding(item, finding))!.explanation,
        })) });
        added = true;
      }
      return added;
    },
    async check(working: string, scope: string, findings: SecurityFinding[]): Promise<UpdateCheck> {
      const check = securityCheck("OSV", "candidate", scope, findings);
      const retained: SecurityFinding[] = [], blockers: SecurityFinding[] = [];
      for (const finding of findings) {
        const matches = approvals.filter(item => sameScopedFinding(item.finding, finding));
        const signature = matches.length ? await exposure(working, finding) : undefined;
        const approved = finding.kind !== "supply-chain" && ![finding.id, ...finding.aliases].some(id => id.startsWith("MAL-")) &&
          matches.find(item => item.signature === signature);
        if (approved) retained.push({ ...finding, explanation: approved.finding.explanation });
        else blockers.push(finding);
      }
      const accepted: SecurityFinding[] = [];
      for (const root of new Set(blockers.map(finding => finding.scope))) {
        const lock = root !== undefined && locks.get(root);
        const approval = root !== undefined && tradeoffs.get(root);
        if (!lock || !approval || hash(await readFile(join(working, lock.name), "utf8")) !== approval.hash) continue;
        const candidate = findings.filter(finding => finding.scope === root);
        const introduced = candidate.flatMap(finding => {
          const original = approval.findings.find(item => sameScopedFinding(item, finding));
          return original ? [{ ...finding, usage: original.usage, explanation: original.explanation }] : [];
        });
        const fixed = npmRiskReduction(baseline, candidate, introduced);
        if (fixed) accepted.push(...introduced.map(finding => ({ ...finding,
          explanation: `Nouvelle alerte dans le verrou de développement. Le scan de ce service retire ${fixed} alerte(s) et en ajoute ${introduced.length}. ${finding.explanation}`,
        })));
      }
      const unresolved = blockers.filter(finding => !accepted.some(item => sameScopedFinding(item, finding)));
      const removed = npmRiskReduction(baseline, findings, accepted);
      if (!retained.length && !removed) return check;
      const tradeoff = removed ? { introduced: accepted, removed } : undefined;
      return { ...check, status: unresolved.length ? "blocked" : "warning", blockers: unresolved.length ? unresolved : undefined,
        npmRetained: retained, npmTradeoff: tradeoff, findings: [...unresolved, ...retained, ...accepted],
        message: unresolved.length ? `Publication arrêtée : ${unresolved.length} alerte(s) restent bloquantes.`
          : tradeoff ? `Bilan npm favorable : ${tradeoff.removed} alerte(s) supprimée(s), ${tradeoff.introduced.length} nouvelle(s) en développement. ${retained.length} alerte(s) préexistante(s) restent à corriger.`
          : `${retained.length} alerte(s) npm déjà présentes restent à corriger. La proposition conserve ces alertes et passe les autres contrôles de sécurité OSV.` };
    },
  };
}
