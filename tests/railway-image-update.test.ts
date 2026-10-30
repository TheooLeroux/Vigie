import "./auth-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { executeRailwayImage, qualifyTailscaleConfiguration, imageClientVersion } from "../src/lib/updates/railway-image";
import { imageSecurityCheck, retainedImageFindings, tailscaleImage } from "../src/lib/updates/image-policy";
import { resolveTailscaleImage } from "../src/lib/updates/image-registry";
import { parseTailscaleProbe, tailscaleProbeCommand } from "../src/lib/updates/tailscale-probe";
import { verifyTailscaleAuthorization } from "../src/lib/updates/tailscale-auth";
import { requireZeroFinalFindings } from "../src/lib/updates/security";
import { completedImageControl } from "../src/lib/updates/image-control";
import { maintenanceCapability } from "../src/lib/updates/capabilities";
import { healthFixture } from "./project-health-fixture";
import { projectHealth } from "../src/lib/project-health";
import type { SecurityFinding, UpdateResult, UpdateRun, UpdateTarget } from "../src/lib/updates/types";
import { createProject, transaction } from "../src/lib/db";
import { createProjectSchema } from "../src/lib/validation";
import { saveRailwayConnection, applyRailwaySnapshot, linkRailwayProject } from "../src/lib/railway";
import { updateTargets } from "../src/lib/updates/targets";
import { configureUpdateSource, startProjectUpdate } from "../src/lib/updates/service";
import { executeUpdate } from "../src/lib/updates/executor";
import { readUpdateRun } from "../src/lib/updates/storage";
import { ApiError } from "../src/lib/http";

const oldDigest = "sha256:" + "a".repeat(64), newDigest = "sha256:" + "b".repeat(64);
const oldReference = `docker.io/tailscale/tailscale@${oldDigest}`, newReference = `docker.io/tailscale/tailscale@${newDigest}`;
const oldDeployment = randomUUID(), newDeployment = randomUUID(), rollbackDeployment = randomUUID();
const target: UpdateTarget = { id: "image-target", projectId: "project", name: "Tailscale", provider: "railway", connectionId: "connection", remoteId: randomUUID(), environmentId: randomUUID(), root: "", repository: null, branch: null, url: null, mode: "image", image: "tailscale/tailscale", configured: true, unavailable: null };
const finding = (patch: Partial<SecurityFinding> = {}): SecurityFinding => ({ id: "CVE-old", aliases: [], package: "golang.org/x/net", version: "0.60.0", severity: "unknown", ...patch });
const values = () => ({ TS_AUTHKEY: "tskey-client-fixture-not-real", TS_HOSTNAME: "proxy", TS_USERSPACE: "true", TS_SOCKS5_SERVER: "[::]:1055", TS_EXTRA_ARGS: "--advertise-tags=tag:proxy", RAILWAY_DEPLOYMENT_ID: oldDeployment });
const raw = () => ({ service: { projectId: randomUUID() }, serviceInstance: { source: { image: target.image!, repo: null }, numReplicas: null, startCommand: null, preDeployCommand: null, latestDeployment: { id: oldDeployment, status: "SUCCESS", meta: { imageDigest: oldDigest } }, activeDeployments: [{ id: oldDeployment, status: "SUCCESS", meta: { imageDigest: oldDigest } }] }, environment: { volumeInstances: { edges: [] as { node: { id: string; serviceId: string; volumeId: string; mountPath: string } }[], pageInfo: { hasNextPage: false } } } });

function harness(options: { candidateFindings?: SecurityFinding[]; afterFindings?: SecurityFinding[]; networkFailure?: boolean; httpFailure?: boolean; changedBefore?: boolean; changedAfter?: boolean; changedDuringScan?: boolean; startupDelay?: boolean; rawDigests?: boolean; same?: boolean; authorizationFailure?: boolean; version?: string } = {}) {
  const state = raw(), variables = values(), writes: any[] = [], scans: string[] = [], probes: string[] = [], snapshots: unknown[] = [];
  let reads = 0, deployed = 0;
  if (options.rawDigests) { state.serviceInstance.latestDeployment.meta.imageDigest = oldDigest.slice(7); state.serviceInstance.activeDeployments[0].meta.imageDigest = oldDigest.slice(7); }
  if (options.same) { state.serviceInstance.source.image = newReference; state.serviceInstance.latestDeployment.meta.imageDigest = newDigest; state.serviceInstance.activeDeployments[0].meta.imageDigest = newDigest; }
  const selected = { ...target, image: state.serviceInstance.source.image };
  const run: UpdateRun = { id: randomUUID(), projectId: target.projectId, stage: "checking", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), actor: { name: "QA", email: "qa@example.test" }, targets: [selected], results: [], message: "" };
  const result: UpdateResult = { targetId: target.id, name: target.name, stage: "checking", message: "", warnings: [] };
  const dependencies = {
    request: async (_target: UpdateTarget, query: string, args: any) => {
      if (query.includes("query ImageConfiguration")) { reads++; if (options.changedBefore && reads === 2 || options.changedAfter && deployed > 0) variables.TS_HOSTNAME = "manually-changed"; return structuredClone(state); }
      if (query.includes("query ImageVariables")) return { variables: { ...variables } };
      if (query.includes("mutation ImageSource")) { writes.push(structuredClone(args.input)); state.serviceInstance.source.image = args.input.source.image; return { serviceInstanceUpdate: true }; }
      if (query.includes("mutation ImageDeploy")) {
        deployed++;
        const next = { id: deployed === 1 ? newDeployment : rollbackDeployment, status: "SUCCESS", meta: { imageDigest: deployed === 1 ? newDigest : oldDigest } };
        if (options.rawDigests) next.meta.imageDigest = next.meta.imageDigest.slice(7);
        state.serviceInstance.latestDeployment = next; state.serviceInstance.activeDeployments = [next];
        return { serviceInstanceDeployV2: next.id };
      }
      throw new Error("unexpected query");
    },
    resolve: async () => ({ channel: "docker.io/tailscale/tailscale:stable", reference: newReference, digest: newDigest, indexDigest: "sha256:" + "c".repeat(64) }),
    scan: async (reference: string) => { scans.push(reference); if (options.changedDuringScan && scans.length === 3) variables.TS_HOSTNAME = "changed-during-scan"; return scans.length === 1 ? [finding({ version: "0.50.0" }), finding({ version: "0.50.0", scope: "other-binary" })] : scans.length === 2 ? options.candidateFindings ?? [finding()] : options.afterFindings ?? [finding()]; },
    probe: async (_target: UpdateTarget, id: string, port: number, peer?: string) => { probes.push(id); assert.equal(port, 1055); if (id === newDeployment && options.networkFailure) throw new Error("no network"); if (id === newDeployment && options.startupDelay && probes.length === 2) throw new ApiError("Le client Tailscale n’est pas connecté.", 422); if (probes.length > 1) assert.equal(peer, "100.65.1.2"); return { version: id === oldDeployment && !options.same ? "1.98.4" : id === rollbackDeployment ? "1.98.4" : "1.104.4", device: id === oldDeployment ? "old-device" : "new-device", addresses: ["100.65.3.4"], onlinePeers: ["100.65.1.2"] }; },
    version: async () => options.version || "1.104.4",
    authorization: async () => { if (options.authorizationFailure) throw new Error("authorization refused"); },
    networkPlan: async () => [],
    network: async () => { if (options.httpFailure && state.serviceInstance.source.image === newReference) throw new ApiError("Témoin HTTP indisponible.", 502); return [{ serviceId: target.remoteId, deploymentId: oldDeployment, status: 200 as const, checkedAt: new Date().toISOString() }]; },
    snapshot: async (_run: string, _target: string, snapshot: unknown) => { snapshots.push(snapshot); },
    pause: async () => {},
  };
  const execute = () => executeRailwayImage(run, selected, result, async () => {}, dependencies);
  return { state, variables, selected, run, result, writes, scans, probes, snapshots, dependencies, execute };
}

test("Images : seuls le dépôt officiel et le profil Railway disposent du parcours automatique", () => {
  for (const image of ["tailscale/tailscale", "tailscale/tailscale:stable", newReference, "docker.io/tailscale/tailscale:v1.104.4"]) assert.equal(tailscaleImage(image), true);
  for (const image of ["attacker/tailscale", "tailscale/tailscale:unstable", "tailscale/tailscale.evil:stable", "private.test/tailscale/tailscale", "postgres:18"]) assert.equal(tailscaleImage(image), false);
  assert.equal(maintenanceCapability(target, { image: target.image }).adapter, "railway-image");
  assert.equal(maintenanceCapability(target, { image: "postgres:18" }).adapter, null);
});

test("Registre : contrôle du contenu de l’index et sélection explicite Linux amd64", async () => {
  const body = JSON.stringify({ manifests: [{ digest: newDigest, platform: { os: "linux", architecture: "amd64" } }, { digest: oldDigest, platform: { os: "linux", architecture: "arm64" } }] });
  const indexDigest = "sha256:" + createHash("sha256").update(body).digest("hex");
  const transport = (async (url: any, init: any) => {
    assert.equal(init.redirect, "error");
    if (String(url).includes("auth.docker.io")) return Response.json({ token: "fixture-registry-token" });
    assert.equal(init.headers.Authorization, "Bearer fixture-registry-token");
    return new Response(body, { headers: { "docker-content-digest": indexDigest } });
  }) as typeof fetch;
  assert.deepEqual(await resolveTailscaleImage(transport), { channel: "docker.io/tailscale/tailscale:stable", reference: newReference, digest: newDigest, indexDigest });
  await assert.rejects(resolveTailscaleImage((async (url: any) => String(url).includes("auth.docker.io") ? Response.json({ token: "fixture" }) : new Response(body, { headers: { "docker-content-digest": oldDigest } })) as typeof fetch), /empreinte/);
});

test("Image : suppression des doublons entre binaires, sans masquer les alertes résiduelles ni desserrer la politique Node", () => {
  const before = [finding({ version: "0.50.0" })];
  const check = imageSecurityCheck("candidate", newReference, [finding(), finding({ scope: "other" })], before);
  assert.equal(check.findings.length, 1); assert.equal(check.status, "warning");
  for (const patch of [{ id: "CVE-new" }, { package: "other-lib" }, { severity: "low" as const }, { kind: "supply-chain" as const }]) assert.equal(retainedImageFindings([finding(patch)], before), false);
  assert.equal(retainedImageFindings([finding(), finding({ version: "0.61.0" })], before), false, "ne pas multiplier les composants affectés par la même alerte");
  assert.throws(() => requireZeroFinalFindings([{ targetId: target.id, name: "Node", stage: "completed", message: "", warnings: [], checks: [{ ...check, phase: "after" }] }]), /Publication arrêtée/);
});

test("Qualification : volumes, routes entrantes, commandes et replicas personnalisés restent bloqués ; secrets seulement empreintés", () => {
  const baseline = qualifyTailscaleConfiguration(raw(), values(), target);
  assert.equal(baseline.port, 1055); assert.doesNotMatch(baseline.fingerprint, /tskey/);
  assert.notEqual(qualifyTailscaleConfiguration(raw(), { ...values(), TS_AUTHKEY: "changed" }, target).fingerprint, baseline.fingerprint);
  assert.equal(qualifyTailscaleConfiguration(raw(), { ...values(), RAILWAY_DEPLOYMENT_ID: "generated" }, target).fingerprint, baseline.fingerprint);
  const changes: Record<string, string>[] = [{ TS_STATE_DIR: "/state" }, { TS_EXTRA_ARGS: "--advertise-exit-node" }, { TS_ROUTES: "10.0.0.0/8" }, { TS_USERSPACE: "false" }];
  for (const update of changes) assert.throws(() => qualifyTailscaleConfiguration(raw(), { ...values(), ...update }, target));
  const volume = raw(); volume.environment.volumeInstances.edges.push({ node: { id: "v", serviceId: target.remoteId, volumeId: "v", mountPath: "/state" } });
  assert.throws(() => qualifyTailscaleConfiguration(volume, values(), target), /sauvegarde/);
});

test("OAuth : vérification des droits de reconnexion existants sans créer de clé/device ni conserver le token", async () => {
  let calls = 0;
  const transport = (async (url: any, init: any) => {
    calls++; assert.equal(url, "https://api.tailscale.com/api/v2/oauth/token"); assert.equal(init.body.get("scope"), "auth_keys"); assert.equal(init.body.get("tags"), "tag:proxy");
    return Response.json({ access_token: "short-lived-fixture-token", token_type: "Bearer", expires_in: 3600 });
  }) as typeof fetch;
  assert.equal(await verifyTailscaleAuthorization(values(), transport), undefined); assert.equal(calls, 1);
  await assert.rejects(verifyTailscaleAuthorization({ ...values(), TS_AUTHKEY: "tskey-auth-expiring" }, transport), /ponctuelle/);
  await assert.rejects(verifyTailscaleAuthorization({ ...values(), TS_AUTHKEY: values().TS_AUTHKEY + "?baseURL=https://evil.test" }, transport)); assert.equal(calls, 1);
  await assert.rejects(verifyTailscaleAuthorization(values(), (async () => new Response("denied", { status: 403 })) as typeof fetch), /Aucune image remplacée/);
});

test("Sonde : identité du conteneur, plateforme, connexion et écoute SOCKS requises ; aucune interpolation de pair arbitraire", () => {
  const nonce = randomUUID(), header = [`VIGIE:${nonce}`, oldDeployment, target.remoteId, target.environmentId, "x86_64"].join("\n") + "\n";
  const payload = { Version: "1.104.4-tabcd", BackendState: "Running", Self: { ID: "device", Online: true, TailscaleIPs: ["100.65.3.4"] }, Peer: { p: { Online: true, TailscaleIPs: ["100.65.1.2", "fd00::1"] } } };
  assert.equal(parseTailscaleProbe(header + JSON.stringify(payload), nonce, target, oldDeployment).version, "1.104.4");
  assert.throws(() => parseTailscaleProbe(header + JSON.stringify({ ...payload, BackendState: "NeedsLogin" }), nonce, target, oldDeployment), /connecté/);
  assert.throws(() => parseTailscaleProbe(header + JSON.stringify(payload), randomUUID(), target, oldDeployment), /déploiement/);
  assert.throws(() => tailscaleProbeCommand(nonce, 1055, "100.65.1.2; touch /tmp/bad"), /invalides/);
  assert.throws(() => tailscaleProbeCommand(nonce, 1055, "8.8.8.8"), /invalides/);
  const command = tailscaleProbeCommand(nonce, 1055, "100.65.1.2"); assert.match(command, /proc\/net\/tcp/); assert.match(command, /tailscale ping/); assert.doesNotMatch(command, /TS_AUTHKEY|printenv/);
});

test("Version candidate : conteneur sans réseau ni volumes, avec un environnement réduit sans secrets", async () => {
  const calls: string[][] = [];
  assert.equal(await imageClientVersion(newReference, async (command, args, options) => {
    assert.equal(command, "docker"); calls.push(args); assert.deepEqual(Object.keys(options!.env!).filter(key => !["NODE_ENV", "PATH", "HOME", "DOCKER_HOST"].includes(key)), []);
    return args[0] === "run" ? JSON.stringify({ short: "1.104.4" }) : "";
  }), "1.104.4");
  assert.ok(calls[1].includes("--network=none")); assert.ok(calls[1].includes("--read-only")); assert.ok(!calls[1].includes("-v"));
});

test("Exécution : image figée remplacée, réseau vérifié, scan final et réserves conservées", async () => {
  const h = harness(); await h.execute();
  assert.equal(h.result.stage, "completed"); assert.equal(h.result.deploymentId, newDeployment);
  assert.deepEqual(h.writes, [{ source: { image: newReference } }]);
  assert.deepEqual(h.scans, [oldReference, newReference, newReference]);
  assert.equal(h.result.imageUpdate?.remainingFindings, 1); assert.equal(h.snapshots.length, 1);
  assert.doesNotMatch(JSON.stringify(h.snapshots), /tskey-client/);
  assert.doesNotThrow(() => requireZeroFinalFindings([h.result]));
  const broken = structuredClone(h.result); broken.imageUpdate!.verified!.digest = oldDigest;
  assert.throws(() => requireZeroFinalFindings([broken]));
  const noHttp = structuredClone(h.result); noHttp.imageUpdate!.networkChecks = [];
  assert.throws(() => requireZeroFinalFindings([noHttp]), "une validation sans preuve HTTP ne permet pas l’exception image");
});

for (const [name, options] of Object.entries({ nouvelleAlerte: { candidateFindings: [finding({ id: "CVE-new" })] }, severite: { candidateFindings: [finding({ severity: "high" as const })] }, configuration: { changedBefore: true }, autorisation: { authorizationFailure: true }, reculVersion: { version: "1.90.0" } })) {
  test(`Prépublication : ${name} interdit tout remplacement`, async () => { const h = harness(options); await assert.rejects(h.execute()); assert.equal(h.writes.length, 0); assert.equal(h.result.deploymentId, undefined); });
}

test("Récupération : échec réseau ou nouvelle alerte finale restaure l’empreinte précédente et vérifie la reconnexion", async () => {
  for (const options of [{ networkFailure: true }, { httpFailure: true }, { afterFindings: [finding({ id: "CVE-just-published" })] }]) {
    const h = harness(options); await assert.rejects(h.execute());
    assert.equal(h.result.stage, "attention"); assert.equal(h.writes.length, 2);
    assert.deepEqual(h.writes[1], { source: { image: oldReference } }); assert.equal(h.result.imageUpdate?.rollbackDeploymentId, rollbackDeployment);
    assert.equal(h.probes.at(-1), rollbackDeployment); assert.equal(h.result.imageUpdate?.verified, undefined);
  }
});

test("Récupération : une modification concurrente bloque le retour automatique et reste visible comme intervention", async () => {
  const h = harness({ changedAfter: true }); await assert.rejects(h.execute()); assert.equal(h.result.stage, "attention"); assert.equal(h.writes.length, 1);
});

test("Image identique : contrôle réseau et scan renouvelés sans redéploiement", async () => {
  const h = harness({ same: true }); await h.execute(); assert.equal(h.writes.length, 0); assert.equal(h.result.deploymentId, oldDeployment); assert.equal(h.result.stage, "completed"); assert.equal(h.scans.length, 2);
});

test("Validation : tolérance bornée au démarrage et prise en charge des empreintes Railway sans préfixe", async () => {
  const h = harness({ startupDelay: true, rawDigests: true }); await h.execute(); assert.equal(h.result.stage, "completed"); assert.equal(h.writes.length, 1); assert.equal(h.probes.length, 3);
});

test("Validation finale : une dérive pendant le dernier scan interdit le succès et toute restauration qui l’écraserait", async () => {
  const h = harness({ changedDuringScan: true }); await assert.rejects(h.execute(), /contrôles finaux/); assert.equal(h.result.stage, "attention"); assert.equal(h.writes.length, 1); assert.equal(h.result.imageUpdate?.verified, undefined);
});

test("Compteur : le nouveau scan est lié au digest actif ; aucune preuve réutilisée après dérive", async () => {
  const h = harness(); await h.execute();
  const detail = healthFixture(), service = detail.railway![0].services[0];
  detail.railway![0].observedAt = new Date().toISOString(); service.id = target.remoteId; service.environmentId = target.environmentId!; service.image = newReference; service.repository = null;
  service.activeDeployments[0].id = newDeployment; service.activeDeployments[0].evidence!.imageDigest = newDigest;
  const control = completedImageControl(target, h.result, detail); assert.ok(control); assert.equal(control.checks[0].findings.length, 1);
  const health = projectHealth(detail, { enabled: true, targets: [target], runs: [{ ...h.run, results: [h.result] }], automaticControls: [control] });
  assert.equal(health.securityEvidence.length, 1);
  service.activeDeployments[0].evidence!.imageDigest = oldDigest;
  assert.equal(completedImageControl(target, h.result, detail), null);
});

test("Intégration : image sans Git/URL/ZIP sélectionnée et verrouillée indépendamment, puis exécutée par son adaptateur", async () => {
  process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  process.env.VIGIE_UPDATES_ENABLED = "1"; process.env.VIGIE_UPDATES_RUNNER_REPOSITORY = "qa/runner";
  process.env.VIGIE_UPDATES_GITHUB_TOKENS = JSON.stringify({ qa: "fake-test-token" });
  const project = await transaction(() => createProject("live", createProjectSchema.parse({ name: "Image QA" })));
  const connection = await saveRailwayConnection({ name: "Image QA", workspaceId: randomUUID(), secret: "fake-railway-test-token" });
  const remote = { id: randomUUID(), name: "Image QA", workspaceId: connection.workspaceId, workspaceName: "QA", environments: [{ id: target.environmentId!, name: "production", ephemeral: false }], services: [{ id: target.remoteId, name: "Tailscale", environmentId: target.environmentId!, environmentName: "production", domains: [], repository: null, image: target.image!, builder: "DOCKERFILE", region: null, replicas: 1, rootDirectory: null, healthcheckPath: null, cronSchedule: null, latestDeployment: null, activeDeployments: [] }] };
  await applyRailwaySnapshot(connection.id, [remote]); await linkRailwayProject(connection.id, remote.id, project.id);
  const image = (await updateTargets(project.id))[0];
  assert.equal(image.mode, "image"); assert.equal(image.unavailable, null); assert.equal(image.capability?.adapter, "railway-image");
  await assert.rejects(configureUpdateSource(project.id, { targetId: image.id }), /connecteur Railway/);
  let dispatches = 0, images = 0;
  const run = await startProjectUpdate({ projectId: project.id, targetIds: [image.id] }, async () => { dispatches++; });
  assert.equal((await startProjectUpdate({ projectId: project.id }, async () => { dispatches++; })).id, run.id); assert.equal(dispatches, 1);
  const h = harness();
  await executeUpdate(run.id, async () => { throw new Error("must not use Node"); }, async () => { throw new Error("must not use WordPress"); }, async () => {}, async (run, selected, result, progress) => { images++; await executeRailwayImage(run, selected, result, progress, h.dependencies); });
  const completed = await readUpdateRun(run.id); assert.equal(images, 1); assert.equal(completed?.stage, "completed");
  assert.match(completed!.message, /restent visibles dans le compteur/); assert.equal(completed?.results[0].imageUpdate?.remainingFindings, 1);
  const failed = await startProjectUpdate({ projectId: project.id }, async () => {}), recovery = harness({ networkFailure: true }); let refreshes = 0;
  await executeUpdate(failed.id, undefined, undefined, async targets => { refreshes++; assert.equal(targets[0].id, image.id); }, (run, selected, result, progress) => executeRailwayImage(run, selected, result, progress, recovery.dependencies));
  assert.equal((await readUpdateRun(failed.id))?.stage, "attention"); assert.equal(refreshes, 1, "rafraîchir aussi l’inventaire après une récupération, sans faux succès");
});
