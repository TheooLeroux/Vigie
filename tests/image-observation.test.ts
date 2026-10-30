import test from "node:test";
import assert from "node:assert/strict";
import { healthFixture, healthUpdates } from "./project-health-fixture";
import { controlSource } from "../src/lib/automatic-control-state";
import { projectHealth } from "../src/lib/project-health";
import { projectSecurity } from "../src/lib/project-security";
import { imageObservationPending } from "../src/lib/updates/image-observation";
import { recordCompletedImageControls } from "../src/lib/updates/image-control";

function fixture() {
  const detail = healthFixture(), state = healthUpdates(), target = state.runs[0].targets[0], result = state.runs[0].results[0], service = detail.railway![0].services[0];
  const now = new Date().toISOString(), before = new Date(Date.now() - 120_000).toISOString();
  const oldImage = `docker.io/tailscale/tailscale@sha256:${"a".repeat(64)}`, newDigest = "sha256:" + "c".repeat(64), newImage = `docker.io/tailscale/tailscale@${newDigest}`;
  target.mode = "image"; target.repository = null; target.image = oldImage; target.root = ""; service.image = oldImage; service.repository = null;
  detail.railway![0].observedAt = before;
  const finding = (id: string) => ({ id, aliases: [], package: "library", version: "1.0.0", severity: "unknown" as const });
  state.targets = [target]; state.automaticControls = [{ targetId: target.id, identity: controlSource(target, detail)!.identity, attemptedAt: before, checkedAt: before, checks: [{ tool: "Trivy", phase: "before", scope: oldImage, status: "warning", checkedAt: before, message: "Avant", findings: Array.from({ length: 124 }, (_, i) => finding("CVE-" + i)) }], updates: [], warnings: [], securityCoverage: { scope: "image", limitations: [] } }];
  result.previousDeploymentId = service.activeDeployments[0].id;
  result.deploymentId = "new-deployment"; result.imageUpdate = { channel: "stable", candidate: newImage, previous: oldImage, digest: newDigest, state: "ephemeral-socks", remainingFindings: 3, verified: { deploymentId: "new-deployment", digest: newDigest, version: "1.104.4", device: "new" } };
  result.checks = [{ tool: "Trivy", phase: "after", scope: newImage, status: "warning", checkedAt: now, message: "Après", findings: [finding("CVE-0"), finding("CVE-1"), finding("CVE-2")] }];
  return { detail, state, target, result, service, now, before };
}

test("Compteur : un relevé antérieur au remplacement ne valide jamais les 124 anciennes alertes comme état courant", () => {
  const f = fixture(), health = projectHealth(f.detail, f.state), security = projectSecurity(f.detail, f.state, health);
  assert.equal(imageObservationPending(f.target, f.detail, f.state), true);
  assert.equal(health.securityEvidence.length, 0); assert.equal(security.status, "stale"); assert.equal(security.known, false);
  assert.equal(security.lastKnown?.count, 124, "conserver l’ancien chiffre avec son caractère historique");
  assert.match(security.services[0].reason, /historique/);
});

test("Compteur : un contrôle concurrent de l’ancienne image ne peut pas rendre actuel un relevé périmé", () => {
  const f = fixture(); f.state.automaticControls![0].checkedAt = f.now;
  assert.equal(projectSecurity(f.detail, f.state).status, "stale");
});

test("Compteur : un relevé récent confirmant une restauration extérieure reste utilisable", () => {
  const f = fixture(); f.detail.railway![0].observedAt = new Date(Date.now() + 1000).toISOString();
  assert.equal(imageObservationPending(f.target, f.detail, f.state), false);
  assert.equal(projectSecurity(f.detail, f.state).count, 124);
});

test("Compteur : image inchangée et historique d’un autre projet n’invalident pas le rapport actuel", () => {
  const f = fixture(); f.result.deploymentId = f.result.previousDeploymentId;
  assert.equal(imageObservationPending(f.target, f.detail, f.state), false);
  f.result.deploymentId = "new-deployment"; f.state.runs[0].projectId = "other-project";
  assert.equal(imageObservationPending(f.target, f.detail, f.state), false);
});

test("Compteur : une récupération en attente de relevé n’est pas présentée comme l’ancien état confirmé", () => {
  const f = fixture(); f.result.stage = "attention"; f.result.imageUpdate!.rollbackDeploymentId = "rollback-deployment"; f.state.runs[0].updatedAt = f.now;
  assert.equal(imageObservationPending(f.target, f.detail, f.state), true);
});

test("Publication du rapport : inventaire périmé ou écriture refusée sont renvoyés à l’exécuteur", async () => {
  const f = fixture();
  assert.deepEqual(await recordCompletedImageControls(f.state.runs[0], { detail: async () => f.detail, write: async () => { throw new Error("must not write old identity"); } }), [f.target.id]);
  f.service.image = f.result.imageUpdate!.candidate; f.service.activeDeployments[0].id = f.result.deploymentId!; f.service.activeDeployments[0].evidence!.imageDigest = f.result.imageUpdate!.digest; f.detail.railway![0].observedAt = f.now;
  assert.deepEqual(await recordCompletedImageControls(f.state.runs[0], { detail: async () => f.detail, write: async () => { throw new Error("storage unavailable"); } }), [f.target.id]);
  let count = 0;
  assert.deepEqual(await recordCompletedImageControls(f.state.runs[0], { detail: async () => f.detail, write: async control => { count = control.checks[0].findings.length; f.state.automaticControls = [control]; } }), []);
  assert.equal(count, 3); assert.equal(projectSecurity(f.detail, f.state).count, 3);
});
