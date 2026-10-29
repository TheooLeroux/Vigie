import test from "node:test";
import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { deployedImageReference } from "../src/lib/image-reference";
import { scanDeployedImage } from "../src/lib/updates/image-monitor";
import { controlSource } from "../src/lib/automatic-control-state";
import { healthFixture, healthUpdates } from "./project-health-fixture";
import type { runCommand } from "../src/lib/updates/process";

const digest = "sha256:" + "a".repeat(64), image = `docker.io/library/postgres@${digest}`;

test("Image observée : empreinte requise, registre public et référence sans ambiguïté", () => {
  assert.equal(deployedImageReference("postgres:17", digest), image);
  assert.equal(deployedImageReference("postgres:17", "A".repeat(64)), image, "les empreintes Railway peuvent être renvoyées sans préfixe");
  assert.equal(deployedImageReference(image, digest), image);
  assert.equal(deployedImageReference("ghcr.io/team/service:latest", digest), `ghcr.io/team/service@${digest}`);
  for (const invalid of ["http://localhost:5000/image", "localhost/image", "registry.private.test/image", "ghcr.io/../image", "--help", "postgres@" + digest + "@extra"]) assert.equal(deployedImageReference(invalid, digest), null);
  assert.equal(deployedImageReference("postgres:17", null), null);
  assert.equal(deployedImageReference(image, "sha256:" + "b".repeat(64)), null);
});

test("Image déployée : attestation liée aux instances actives, expiration et changement d’image", () => {
  const detail = healthFixture(), target = { ...healthUpdates().runs[0].targets[0], repository: null, mode: "archive" as const }, service = detail.railway![0].services[0];
  detail.railway![0].observedAt = new Date().toISOString();
  service.image = "postgres:17";
  const source = controlSource(target, detail)!;
  assert.equal(source.image, image);
  assert.equal(source.commit, null);
  service.activeDeployments[0].evidence!.imageDigest = "sha256:" + "b".repeat(64);
  assert.notEqual(controlSource(target, detail)?.identity, source.identity);
  service.activeDeployments.push(structuredClone(service.activeDeployments[0]));
  service.activeDeployments[1].evidence!.imageDigest = digest;
  assert.equal(controlSource(target, detail), null, "plusieurs images actives ne doivent pas être assimilées à une seule");
  service.activeDeployments.pop();
  detail.railway![0].observedAt = "2000-01-01T00:00:00Z";
  assert.equal(controlSource(target, detail), null);
});

test("Scanner image : lecture distante sans Docker ni secrets, fin de support distincte et nettoyage", async () => {
  let folder = "";
  const execute: typeof runCommand = async (command, args, options) => {
    assert.equal(command, "trivy"); assert.equal(args.at(-1), image);
    assert.equal(args[args.indexOf("--image-src") + 1], "remote");
    assert.equal(args[args.indexOf("--scanners") + 1], "vuln");
    assert.deepEqual(Object.keys(options!.env!).sort(), ["DOCKER_CONFIG", "HOME", "NODE_ENV", "PATH", "TMPDIR"]);
    folder = options!.cwd!;
    await writeFile(args[args.indexOf("--output") + 1], JSON.stringify({ SchemaVersion: 2, Metadata: { OS: { Family: "debian", EOSL: true } }, Results: [{ Target: "debian", Vulnerabilities: [{ VulnerabilityID: "CVE-2026-1111", PkgName: "openssl", InstalledVersion: "3.0.0", Severity: "HIGH" }] }] }));
    return "";
  };
  const result = await scanDeployedImage(image, execute);
  assert.equal(result.checks[0].findings.length, 2);
  assert.equal(result.securityCoverage?.scope, "image");
  await assert.rejects(access(folder));
  await assert.rejects(scanDeployedImage("postgres:latest", execute), /empreinte/);
  await assert.rejects(scanDeployedImage(image, async (_command, args) => { await writeFile(args[args.indexOf("--output") + 1], "{}"); return ""; }), /rapport/);
});
