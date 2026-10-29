import "./auth-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readVercelSources, scanVercelSources } from "../src/lib/updates/vercel-source-monitor";
import { scanSourceSnapshot, inspectableSource } from "../src/lib/updates/source-snapshot";
import { browserDependencies, queryKnownPackages } from "../src/lib/updates/browser-dependencies";
import { healthUpdates } from "./project-health-fixture";
import { ApiError } from "../src/lib/http";
import { scanGitHubSources } from "../src/lib/updates/github-source-monitor";
import { cpanelReadClient } from "../src/lib/connectors/cpanel-read";
import { boundedSourceJson } from "../src/lib/updates/source-http";
import { scanHostingSources } from "../src/lib/updates/hosting-source-monitor";

const html = '<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>';
const sha = (text: string) => createHash("sha1").update(text).digest("hex");
const target = { ...healthUpdates().runs[0].targets[0], provider: "vercel" as const, remoteId: "prj_example", root: "", mode: "archive" as const, repository: null };
const credentials = async <T,>(_id: string, fn: (token: string, teamId: string) => Promise<T>) => fn("fixture-token", "team_example");

function vercelFixture(options: { wrongProject?: boolean; corrupt?: boolean; outputsOnly?: boolean; unreadable?: boolean } = {}) {
  const paths: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); paths.push(url.pathname);
    assert.equal(init?.method || "GET", "GET"); assert.equal(init?.redirect, "error"); assert.equal(url.hostname, "api.vercel.com");
    assert.equal(url.searchParams.get("teamId"), "team_example");
    if (url.pathname.startsWith("/v13/")) return Response.json({ id: "dpl_example", projectId: options.wrongProject ? "other" : target.remoteId, readyState: "READY" });
    if (url.pathname.startsWith("/v6/")) return Response.json([{ name: options.outputsOnly ? "out" : "src", type: "directory", children: [{ name: "index.html", type: "file", uid: sha(html) }, { name: ".env", type: "file", uid: "e".repeat(40) }, { name: "evil.js", type: "symlink", uid: "a".repeat(40) }, ...(options.unreadable ? [{ name: "other.js", type: "file", uid: "b".repeat(40) }] : [])] }]);
    if (url.pathname.endsWith("b".repeat(40))) return new Response("", { status: 403 });
    return Response.json({ data: Buffer.from(options.corrupt ? "corrupted" : html).toString("base64") });
  };
  return { paths, dependencies: { credentials, transport } };
}

test("Sources Vercel : lire le déploiement exact sans Git, exclure les secrets, liens et artefacts", async () => {
  const fixture = vercelFixture();
  const result = await readVercelSources(target, "dpl_example", fixture.dependencies);
  assert.deepEqual(result.files, [{ path: "index.html", content: html }]);
  assert.equal(fixture.paths.length, 3); assert.deepEqual(result.limitations, []);
  await assert.rejects(readVercelSources(target, "dpl_example", vercelFixture({ wrongProject: true }).dependencies), /correspondent/);
  await assert.rejects(readVercelSources(target, "dpl_example", vercelFixture({ outputsOnly: true }).dependencies), /compilée/);
  assert.equal((await readVercelSources(target, "dpl_example", vercelFixture({ corrupt: true }).dependencies)).files.length, 0);
  const partial = await readVercelSources(target, "dpl_example", vercelFixture({ unreadable: true }).dependencies);
  assert.equal(partial.files.length, 1); assert.match(partial.limitations[0], /403/);
});

test("Sources Vercel : propager le déploiement et les limites jusqu’au rapport", async () => {
  const result = await scanVercelSources(target, "dpl_example", { read: async () => ({ files: [{ path: "index.html", content: "<h1>Site</h1>" }], limitations: ["fichier manquant"] }), scan: scanSourceSnapshot });
  assert.equal(result.securityCoverage?.source, "vercel"); assert.equal(result.securityCoverage?.deploymentId, "dpl_example");
  assert.equal(result.securityCoverage?.files, 1); assert.ok(result.securityCoverage?.limitations.includes("fichier manquant"));
});

test("Bibliothèques navigateur : CDN exacts, imports, alias et versions non résolues", () => {
  const result = browserDependencies([{ path: "index.html", content: html + '<script src="https://cdn.jsdelivr.net/npm/@scope/lib@1.2.3/dist.js"></script><script src="https://unpkg.com/lodash@latest/lodash.js"></script><link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Inter"><script src="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css"></script>' }, { path: "app.js", content: 'import "https://esm.sh/react@18.2.0"; import(userUrl)' }]);
  assert.deepEqual(result.inventory.map(i => i.name), ["jspdf", "@scope/lib", "@fortawesome/fontawesome-free", "react"]);
  assert.equal(result.limitations.length, 2); assert.ok(result.limitations.every(x => !x.includes("googleapis")));
  assert.equal(inspectableSource(".env"), false); assert.equal(inspectableSource("secrets.js"), false); assert.equal(inspectableSource("js/config.js"), true);
  const chart = browserDependencies([{ path: "index.html", content: '<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.4/chart.umd.min.js"></script>' }]);
  assert.deepEqual(chart.inventory, [{ name: "chart.js", version: "4.4.4", origin: "index.html" }]); assert.deepEqual(chart.limitations, []);
});

test("Catalogue OSV : pagination complète et aucune transmission de code ou de jeton", async () => {
  let calls = 0;
  const findings = await queryKnownPackages([{ name: "jspdf", version: "2.5.1", origin: "index.html" }], async (input, init) => {
    assert.equal(input, "https://api.osv.dev/v1/query"); assert.deepEqual(Object.keys(init!.headers!), ["Content-Type"]);
    const body = JSON.parse(String(init!.body)); assert.deepEqual(body.package, { name: "jspdf", ecosystem: "npm" }); assert.equal(body.version, "2.5.1");
    calls++;
    return Response.json(calls === 1 ? { vulns: [{ id: "GHSA-aaaa-bbbb-cccc", aliases: ["CVE-2026-1234"], database_specific: { severity: "HIGH" } }], next_page_token: "next" } : { vulns: [] });
  });
  assert.equal(calls, 2); assert.equal(findings[0].severity, "high"); assert.equal(findings[0].usage, "runtime");
  await assert.rejects(queryKnownPackages([{ name: "a", version: "latest", origin: "x" }]), /invalide/);
  await assert.rejects(queryKnownPackages([{ name: "a", version: "1.0.0", origin: "x" }], async () => Response.json({ next_page_token: "loop" })), /incomplet/);
  await assert.rejects(queryKnownPackages([{ name: "a", version: "1.0.0", origin: "x" }], async () => new Response("", { status: 503 })), /disponible/);
});

test("Sources statiques : compter les bibliothèques analysées et conserver le périmètre partiel", async () => {
  const result = await scanSourceSnapshot([{ path: "index.html", content: html }], { source: "vercel" }, { node: async () => { throw Error("No lock"); }, generic: async () => { throw Error("No lock"); }, query: async packages => { assert.equal(packages[0].name, "jspdf"); return [{ id: "CVE-2026-1234", aliases: [], package: "jspdf", version: "2.5.1", severity: "high", usage: "runtime" }]; } });
  assert.equal(result.checks[0].findings.length, 1); assert.equal(result.securityCoverage?.packages, 1);
  assert.ok(result.securityCoverage?.limitations.some(x => x.includes("code personnalisé")));
  const failed = await scanSourceSnapshot([{ path: "index.html", content: html }], { source: "vercel" }, { node: async () => [], generic: async () => ({ findings: [], packages: 0 }), query: async () => { throw Error("offline"); } });
  assert.deepEqual(failed.checks, [], "une panne de catalogue ne devient pas zéro faille"); assert.equal(failed.coverage, "partial");
});

test("Dépendances : verrou npm réellement vide et versions manquantes restent distincts", async () => {
  let scans = 0;
  const dependencies = { node: async () => { scans++; throw new ApiError("lock invalid"); }, generic: async () => ({ findings: [], packages: 0 }), query: async () => [] };
  const empty = await scanSourceSnapshot([{ path: "package.json", content: '{"name":"empty"}' }, { path: "package-lock.json", content: '{"lockfileVersion":3,"packages":{"":{}}}' }], { source: "vercel" }, dependencies);
  assert.equal(scans, 0); assert.equal(empty.checks.length, 1); assert.equal(empty.securityCoverage?.packages, 0);
  const unresolved = await scanSourceSnapshot([{ path: "package.json", content: '{"dependencies":{"lodash":"^4"}}' }], { source: "vercel" }, dependencies);
  assert.deepEqual(unresolved.checks, []); assert.equal(unresolved.coverage, "partial");
  const invalid = await scanSourceSnapshot([{ path: "package.json", content: 'null' }, { path: "index.html", content: html }], { source: "vercel" }, dependencies);
  assert.ok(invalid.securityCoverage?.limitations.some(x => x.includes("manifeste invalide")));
  assert.equal(invalid.securityCoverage?.inventory?.[0].name, "jspdf");
  await assert.rejects(scanSourceSnapshot([{ path: "../package.json", content: "{}" }], { source: "vercel" }), /ambigu/);
});

test("Sources GitHub statiques : lier les empreintes au commit et lire les fichiers utiles", async () => {
  process.env.VIGIE_UPDATES_GITHUB_TOKENS = '{"example":"test-only"}';
  const hash = createHash("sha1").update(`blob ${Buffer.byteLength(html)}\0`).update(html).digest("hex");
  const result = await scanGitHubSources({ ...target, repository: "example/site" }, "a".repeat(40), { github: async path => path.includes("/trees/") ? { truncated: false, tree: [{ path: "index.html", type: "blob", mode: "100644", sha: hash, size: Buffer.byteLength(html) }, { path: ".env", type: "blob", mode: "100644" }] } : { sha: hash, encoding: "base64", content: Buffer.from(html).toString("base64") }, scan: async (files, options) => { assert.deepEqual(files, [{ path: "index.html", content: html }]); assert.equal(options.source, "github"); return { checks: [], updates: [], warnings: [] }; } });
  assert.deepEqual(result.checks, []);
});

test("Sources o2switch : lectures ciblées dans la racine, secrets et traversées refusés", async () => {
  const input = { name: "fixture", endpoint: "https://gaz.o2switch.net:2083", username: "testuser", authMode: "token" as const, secret: "test-only" };
  const calls: string[] = [];
  const transport: typeof fetch = async (input, options) => {
    const url = new URL(String(input)); calls.push(url.pathname);
    assert.equal(options?.method, "GET"); assert.equal(options?.redirect, "manual");
    assert.match(url.searchParams.get("dir")!, /^\/home\/testuser\/site/);
    const data = url.pathname.endsWith("list_files") ? [{ file: "index.html", type: "file", size: html.length }, { file: ".env", type: "file", size: 30 }, { file: "linked.js", type: "link", size: 40 }] : { content: html };
    return Response.json({ result: { status: 1, data } });
  };
  const client = cpanelReadClient(input, transport);
  await assert.rejects(client.readSource("/home/testuser/site", "../other/index.html"), /périmètre/);
  await assert.rejects(client.readSource("/home/testuser/site", ".env"), /périmètre/);
  await assert.rejects(client.read("/home/testuser/site", "index.html"), /autorisée/, "les permissions de l’ancien inventaire ne sont pas élargies");
  assert.equal(calls.length, 0);
  const result = await scanHostingSources({ ...target, provider: "o2switch", root: "/home/testuser/site" }, {
    credentials: async (_id, fn) => fn({ ...input, id: "fixture", configured: true } as any), client: () => client,
    scan: async (files, options) => { assert.deepEqual(files, [{ path: "index.html", content: html }]); assert.equal(options.source, "hosting"); return { checks: [], updates: [], warnings: [] }; },
  });
  assert.deepEqual(result.checks, []); assert.equal(calls.length, 2);
  await assert.rejects(boundedSourceJson(new Response("x".repeat(101)), 100), /volumineuse/);
});
