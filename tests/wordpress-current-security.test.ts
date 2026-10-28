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
  assert.equal(calls, 2);
  assert.deepEqual(await currentWordPressSecurity(target, dependencies), JSON.parse(JSON.stringify(first)));
  assert.equal(calls, 2, "les sondages de l’interface ne rescannent pas les mêmes versions");
  site.inventory!.plugins[0].version = "2";
  assert.equal((await currentWordPressSecurity(target, dependencies)).check?.findings.length, 0);
  assert.equal(calls, 4, "une nouvelle version invalide le contrôle précédent");
  assert.ok((await currentWordPressSecurity({ ...target, root: "/another" }, dependencies)).error);
  site.inventory!.plugins[0].version = "3";
  const failed = await currentWordPressSecurity(target, { ...dependencies, transport: (async () => { throw new Error("offline"); }) as typeof fetch });
  assert.ok(failed.error);
  assert.equal(failed.check, undefined);
});
