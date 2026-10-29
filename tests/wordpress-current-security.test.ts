import "./auth-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import { currentWordPressSecurity } from "../src/lib/updates/wordpress-current-security";
import { healthFixture } from "./project-health-fixture";
import type { HostingInstallationView } from "../src/lib/types";
import type { UpdateTarget } from "../src/lib/updates/types";

test("Contrôle WordPress en lecture seule : cache lié aux versions, aucun ordre d’agent et échec explicite", async () => {
  const target: UpdateTarget = { id: "wordpress:readonly", remoteId: "readonly", name: "Fixture", projectId: "project", connectionId: "hosting", root: "/home/fixture/site", provider: "o2switch", mode: "wordpress", url: "https://example.test", environmentId: null, repository: null, branch: null, configured: true, unavailable: null };
  const now = new Date().toISOString();
  const site = { id: "readonly", project: healthFixture().project, connectionId: "hosting", documentRoot: target.root, inventory: { source: "wordpress-observer", observedAt: now, wordpress: { version: "7.1.3" }, php: { version: "8.2.35" }, plugins: [{ slug: "example", version: "1" }], themes: [], error: null } } as unknown as HostingInstallationView;
  let calls = 0;
  const dependencies = { site: async () => site, transport: (async (input, options) => {
    assert.equal(options?.method || "GET", "GET");
    const url = new URL(String(input)); assert.equal(url.hostname, "www.wpvulnerability.net"); calls++;
    return Response.json({ error: 0, updated: "1792736835", data: url.pathname.startsWith("/core/") ? { core: "7.1.3", vulnerability: [] } : { plugin: "example", name: "Example", link: "https://wordpress.org/plugins/example/", vulnerability: [{ uuid: "fixture-1", operator: { max_version: "2", max_operator: "lt" } }] } });
  }) as typeof fetch };
  const first = await currentWordPressSecurity(target, dependencies);
  assert.equal(first.check?.findings.length, 1);
  assert.equal(first.securityCoverage?.packages, 2);
  assert.deepEqual(first.securityCoverage?.limitations, []);
  assert.equal(calls, 2);
  assert.deepEqual(await currentWordPressSecurity(target, dependencies), JSON.parse(JSON.stringify(first)));
  assert.equal(calls, 2, "les sondages de l’interface ne rescannent pas les mêmes versions");
  await currentWordPressSecurity(target, { ...dependencies, fresh: true });
  assert.equal(calls, 4, "le contrôle horaire renouvelle les avis même sans changement de version");
  site.inventory!.plugins[0].version = "2";
  const waiting = await currentWordPressSecurity(target, { ...dependencies, cacheOnly: true });
  assert.ok(waiting.error);
  assert.equal(calls, 4, "l’ouverture d’une fiche ne déclenche aucun scan distant");
  assert.equal((await currentWordPressSecurity(target, dependencies)).check?.findings.length, 0);
  assert.equal(calls, 6, "une nouvelle version invalide le contrôle précédent");
  site.inventory!.collectionMode = "early";
  const early = await currentWordPressSecurity(target, dependencies);
  assert.equal(early.error, undefined, "les versions relevées par le connecteur signé restent analysables sans chargement complet de WordPress");
  assert.equal(early.check?.findings.length, 0);
  assert.ok(early.warnings.some(warning => warning.includes("mode de secours")));
  assert.ok(early.securityCoverage?.limitations.some(warning => warning.includes("Inventaire de secours")));
  assert.equal(calls, 8);
  assert.equal((await currentWordPressSecurity(target, { ...dependencies, cacheOnly: true })).warnings.some(warning => warning.includes("mode de secours")), true);
  assert.ok((await currentWordPressSecurity({ ...target, root: "/another" }, dependencies)).error);
  site.inventory!.plugins[0].version = "3";
  const failed = await currentWordPressSecurity(target, { ...dependencies, transport: (async () => { throw new Error("offline"); }) as typeof fetch });
  assert.ok(failed.error);
  assert.equal(failed.check, undefined);
});

test("Contrôle en lecture seule : interventions manuelles avant exécution et mises à jour publiques laissées admissibles", async () => {
  const target: UpdateTarget = { id: "wordpress:manual-readonly", remoteId: "manual-readonly", name: "Fixture", projectId: "project", connectionId: "hosting", root: "/home/fixture/site", provider: "o2switch", mode: "wordpress", url: "https://example.test", environmentId: null, repository: null, branch: null, configured: true, unavailable: null };
  const component = (slug: string) => ({ slug, version: "1", latestVersion: "2", updateState: "available", active: false });
  const site = { id: target.remoteId, project: healthFixture().project, connectionId: "hosting", documentRoot: target.root, inventory: { source: "wordpress-observer", observedAt: new Date().toISOString(), wordpress: { version: "7.1.3", updateState: "current" }, php: { version: "8.2.35" }, plugins: [component("public"), component("private")], themes: [component("parent")], error: null } } as unknown as HostingInstallationView;
  const dependencies = { site: async () => site, transport: (async input => {
    const url = new URL(String(input)), identity = url.pathname.split("/")[2];
    const issue = { uuid: "public-issue", operator: { max_version: "2", max_operator: "lt" } };
    return Response.json({ error: 0, updated: 1, data: url.pathname.startsWith("/core/") ? { core: identity, vulnerability: [] } : url.pathname.startsWith("/theme/") ? { theme: identity, name: identity, vulnerability: [] } : { plugin: identity, name: identity === "private" ? null : identity, link: `https://wordpress.org/plugins/${identity}/`, vulnerability: identity === "public" ? [issue] : [] } });
  }) as typeof fetch };
  const observation = await currentWordPressSecurity(target, dependencies);
  assert.equal(observation.check?.findings.length, 1, "la vulnérabilité publique reste visible");
  assert.ok(observation.securityCoverage?.limitations.some(warning => warning.includes("private")));
  assert.deepEqual(observation.manualUpdates?.map(item => item.package), ["plugins/private", "themes/parent"]);
  assert.equal(observation.manualUpdates?.[0].target, "2");
  assert.deepEqual((await currentWordPressSecurity(target, { ...dependencies, cacheOnly: true })).manualUpdates, observation.manualUpdates);
});
