import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
    async retain(working: string, findings: SecurityFinding[]) {
      let added = false;
      for (const finding of findings) {
        if (!finding.explanation || finding.kind === "supply-chain" || [finding.id, ...finding.aliases].some(id => id.startsWith("MAL-")) || !baseline.some(item => sameScopedFinding(item, finding))) continue;
        const signature = await exposure(working, finding);
        if (!signature || approvals.some(item => item.signature === signature && sameScopedFinding(item.finding, finding))) continue;
        approvals.push({ finding, signature });
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
        const approved = matches.find(item => item.signature === signature);
        if (approved) retained.push({ ...finding, explanation: approved.finding.explanation });
        else blockers.push(finding);
      }
      if (!retained.length) return check;
      return { ...check, status: blockers.length ? "blocked" : "warning", blockers: blockers.length ? blockers : undefined, npmRetained: retained, findings: [...blockers, ...retained],
        message: blockers.length ? `Publication arrêtée : ${blockers.length} alerte(s) restent bloquantes. ${retained.length} alerte(s) préexistantes sont documentées séparément.`
          : `${retained.length} alerte(s) npm déjà présentes restent à corriger. La proposition conserve ces alertes et passe les autres contrôles de sécurité OSV.` };
    },
  };
}
