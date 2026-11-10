import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { controlInterval, controlSource } from "../src/lib/automatic-control-state";
import { writeAutomaticControl } from "../src/lib/automatic-control-storage";
import { createProject } from "../src/lib/db";
import { observedProjectDetail } from "../src/lib/project-observations";
import { filterSecurityWatch, rankSecurityWatch, type ProjectFinding, type PublicAdvisory } from "../src/lib/security-watch";
import { securityWatch } from "../src/lib/security-watch-data";
import { updateTargets } from "../src/lib/updates/targets";
import { createProjectSchema } from "../src/lib/validation";
import { applyVercelSnapshot, linkVercelProject, saveVercelConnection } from "../src/lib/vercel";
import type { VercelProject } from "../src/lib/vercel-types";
import "./auth-fixture";
import { healthCheck } from "./project-health-fixture";

test("Veille : regroupe les alias entre projets et sépare les avis publics des failles détectées", () => {
  const publicItem: PublicAdvisory = {
    id: "GHSA-AAAA-BBBB-CCCC", aliases: ["CVE-2026-1234"], title: "Avis GitHub",
    severity: "high", url: "https://github.com/advisories/GHSA-AAAA-BBBB-CCCC",
    publishedAt: "2026-11-04T00:00:00Z", packages: ["example (npm)"],
  };
  const newer = { ...publicItem, id: "GHSA-DDDD-EEEE-FFFF", aliases: [], publishedAt: "2026-11-05T00:00:00Z", severity: "critical" as const };
  const finding: ProjectFinding["finding"] = {
    key: "first", id: "CVE-2026-1234", aliases: ["OSV-2026-123"], targetId: "service", service: "Backend",
    package: "example", version: "1.0.0", severity: "high", usage: "runtime",
    kind: "vulnerability", checkedAt: "2026-11-06T00:00:00Z",
  };
  const project = { id: "one", name: "Premier projet" };
  const { detected, recent } = rankSecurityWatch([publicItem, newer], [
    { project, finding, searchLabels: ["Vercel", "Client Étoile"] },
    { project, historical: true, searchLabels: ["Railway"], finding: { ...finding, key: "duplicate", targetId: "other-service" } },
    { project: { id: "two", name: "Second projet" }, historical: true, searchLabels: ["Railway"], finding: { ...finding, key: "second", id: "osv-2026-123", aliases: [], severity: "critical", version: "2.0.0", package: "lib-beta" } },
    { project, finding: { ...finding, key: "third", id: "CVE-2026-4321", aliases: [], severity: "low" } },
  ]);
  assert.deepEqual(detected.map(item => item.id), ["CVE-2026-1234", "CVE-2026-4321"]);
  assert.deepEqual(detected[0].aliases, ["GHSA-AAAA-BBBB-CCCC", "OSV-2026-123"]);
  assert.deepEqual(detected[0].affected.map(item => [item.project.id, item.historical]), [["one", false], ["two", true]]);
  assert.equal(detected[0].severity, "critical");
  assert.equal(detected[0].title, "Avis GitHub");
  assert.deepEqual(recent.map(item => item.id), [newer.id]);
  const matches = (query: string) => filterSecurityWatch(detected, query).flatMap(item => item.affected.map(entry => [entry.project.id, entry.historical]));
  assert.deepEqual(matches("vercel client etoile"), [["one", false]]);
  assert.deepEqual(matches("railway lib-beta"), [["two", true]]);
  assert.deepEqual(matches("railway premier projet"), [["one", true]]);
  assert.deepEqual(matches("Avis GitHub CVE-2026-1234"), [["one", false], ["two", true]]);
  assert.deepEqual(matches("vercel lib-beta"), []);
  assert.equal(filterSecurityWatch(recent, "example npm").length, 1);
  assert.equal(filterSecurityWatch(recent, "railway").length, 0);
});

test("Veille : flux indisponible puis rétabli et couverture calculée à partir des relevés", async t => {
  const current = {
    ghsa_id: "GHSA-aaaa-bbbb-cccc", cve_id: null, summary: "Avis en cours", severity: "medium",
    published_at: "2026-11-04T00:00:00Z", withdrawn_at: null, vulnerabilities: [],
  };
  const withdrawn = { ...current, ghsa_id: "GHSA-dddd-eeee-ffff", withdrawn_at: "2026-11-05T00:00:00Z" };
  let firstRequest = true;
  const transport = t.mock.method(globalThis, "fetch", async (input: string) => {
    assert.equal(new URL(input).hostname, "api.github.com");
    if (firstRequest) {
      firstRequest = false;
      return new Response(null, { status: 503 });
    }
    return Response.json([current, withdrawn]);
  });
  const read = () => securityWatch("live", new AbortController().signal);
  const partial = await read();
  assert.equal(partial.feedCheckedAt, null);
  assert.deepEqual(partial.coverage, { projects: 0, fullyCovered: 0 });

  const result = await read();
  assert.ok(result.feedCheckedAt);
  assert.deepEqual(result.recent.map(item => [item.id, item.severity]), [["GHSA-AAAA-BBBB-CCCC", "moderate"]]);

  process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  const project = await createProject("live", createProjectSchema.parse({ name: "Site de test", url: "https://watch.example.test", client: "Client Étoile" }));
  const connection = await saveVercelConnection({ name: "Veille QA", teamId: "team_watch", secret: "unit-test-only" });
  const at = new Date().toISOString();
  const production = { id: "deployed", state: "READY", target: "production", createdAt: at, url: project.url, framework: "nextjs", nodeBranch: "24.x", repository: "qa/observed", branch: "main", commit: "c".repeat(40), regions: [] };
  const remote: VercelProject = { id: "prj_watch", name: project.name, teamId: connection.teamId, teamSlug: "qa", teamName: "QA", framework: "nextjs", nodeBranch: "24.x", rootDirectory: null, repository: production.repository, productionBranch: "main", domains: [], excluded: false, clientSuggestion: null, latest: null, production };
  await applyVercelSnapshot(connection.id, [remote]);
  await linkVercelProject(connection.id, remote.id, project.id);
  const detail = await observedProjectDetail(project.id, "live");
  const [target] = await updateTargets(project.id);
  const check = healthCheck({ phase: "before", checkedAt: at, findings: [{ id: current.ghsa_id, aliases: [], package: "library", version: "1.0.0", severity: "high" }] });
  const report = { targetId: target.id, identity: controlSource(target, detail)!.identity, attemptedAt: at, checkedAt: at, checks: [check], updates: [], warnings: [] };
  await writeAutomaticControl(report);

  const matched = await read();
  assert.deepEqual(matched.coverage, { projects: 1, fullyCovered: 1 });
  assert.equal(matched.detected[0].affected[0].project.id, project.id);
  assert.equal(matched.detected[0].affected[0].historical, false);
  assert.deepEqual(matched.recent, []);
  assert.equal(filterSecurityWatch(matched.detected, "vercel client etoile next.js library").length, 1);

  await writeAutomaticControl({ ...report, error: "Dernier contrôle en erreur" });
  const failed = await read();
  assert.equal(failed.detected[0].affected.length, 1);
  assert.equal(failed.detected[0].affected[0].historical, true);

  const expired = new Date(Date.now() - controlInterval).toISOString();
  await writeAutomaticControl({ ...report, checkedAt: expired, checks: [{ ...check, checkedAt: expired }] });
  const stale = await read();
  assert.deepEqual(stale.coverage, { projects: 1, fullyCovered: 0 });
  assert.equal(stale.detected[0].affected[0].historical, true);
  assert.equal(stale.detected[0].latestCheckedAt, expired);
  assert.deepEqual(stale.recent, []);

  await writeAutomaticControl(report);
  await applyVercelSnapshot(connection.id, [{ ...remote, production: { ...production, id: "redeployed" } }]);
  const redeployed = await read();
  assert.equal(redeployed.detected[0].affected[0].historical, true);

  const redeployedDetail = await observedProjectDetail(project.id, "live");
  await writeAutomaticControl({ ...report, identity: controlSource(target, redeployedDetail)!.identity, checks: [{ ...check, findings: [] }] });
  const clean = await read();
  assert.deepEqual(clean.coverage, { projects: 1, fullyCovered: 1 });
  assert.deepEqual(clean.detected, []);
  assert.equal(clean.recent[0].id, "GHSA-AAAA-BBBB-CCCC");

  const other = { ...remote, id: "prj_watch_other", name: "Autre service" };
  await applyVercelSnapshot(connection.id, [{ ...remote, production: { ...production, id: "redeployed" } }, other]);
  await linkVercelProject(connection.id, other.id, project.id);
  const otherTarget = (await updateTargets(project.id)).find(item => item.remoteId === other.id)!;
  const mixedDetail = await observedProjectDetail(project.id, "live");
  await writeAutomaticControl({ ...report, targetId: otherTarget.id, identity: controlSource(otherTarget, mixedDetail)!.identity, checkedAt: expired, checks: [{ ...check, checkedAt: expired }] });
  const mixed = await read();
  assert.deepEqual(mixed.coverage, { projects: 1, fullyCovered: 0 });
  assert.equal(mixed.detected[0].affected.length, 1);
  assert.equal(mixed.detected[0].affected[0].historical, true);
  assert.equal(mixed.detected[0].affected[0].project.id, project.id);
  assert.equal(transport.mock.callCount(), 2);
});
