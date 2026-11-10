import assert from "node:assert/strict";
import { test } from "node:test";
import { minimalStaticWitnessId } from "../src/lib/updates/minimal-static-migration";
import { minimalStaticBuildNode, minimalStaticCaddyCandidate, minimalStaticDockerfile, minimalStaticPins, minimalStaticRecipe } from "../src/lib/updates/minimal-static";
import type { UpdateTarget } from "../src/lib/updates/types";

test("Migration statique : autorisation limitée au projet, au service et à son environnement Railway", () => {
  const target = {
    provider: "railway", mode: "git", projectId: "project", environmentId: "production", remoteId: "frontend",
    url: "https://app.up.railway.app/", root: "frontend",
  } as UpdateTarget;
  const backend = "00000000-0000-4000-8000-000000000001";
  const grant = `project:production:frontend:${backend}`;
  assert.equal(minimalStaticWitnessId(target, grant), backend);
  assert.equal(minimalStaticWitnessId({ ...target, environmentId: "staging" }, grant), undefined);
  assert.equal(minimalStaticWitnessId({ ...target, mode: "image" }, grant), undefined);
  assert.equal(minimalStaticWitnessId(target, `${grant},${grant}`), undefined);
});

test("Recette minimale : une autre version Node épinglée est admise, toute autre modification sort du parcours", () => {
  assert.equal(minimalStaticBuildNode(minimalStaticDockerfile), "26.13.0");
  const updated = minimalStaticRecipe("26.14.0", "sha256:" + "c".repeat(64));
  assert.equal(minimalStaticBuildNode(updated), "26.14.0");
  assert.equal(minimalStaticBuildNode(updated + "COPY secret /secret\n"), undefined);
});

test("Caddy minimal : archive officielle épinglée, aucun recul ni changement silencieux du binaire", () => {
  const digest = "sha256:" + "a".repeat(64);
  const candidate = minimalStaticCaddyCandidate(minimalStaticDockerfile, { version: "2.11.9", linuxAmd64Digest: digest });
  assert.ok(candidate);
  const pins = minimalStaticPins(candidate.recipe)!;
  assert.deepEqual(pins.caddy, { version: "2.11.9", digest });
  assert.equal(pins.node, "26.13.0");
  assert.equal(minimalStaticCaddyCandidate(candidate.recipe, { version: "2.11.9", linuxAmd64Digest: "sha256:" + "b".repeat(64) }), undefined);
  assert.equal(minimalStaticCaddyCandidate(candidate.recipe, { version: "2.11.8", linuxAmd64Digest: digest }), undefined);
  assert.equal(minimalStaticCaddyCandidate(candidate.recipe, { version: "2.12.0-beta.1", linuxAmd64Digest: digest }), undefined);
  assert.equal(minimalStaticCaddyCandidate(candidate.recipe, { version: "2.12.0" }), undefined);
  assert.equal(minimalStaticPins(candidate.recipe.replace("github.com/caddyserver", "example.org/caddyserver")), undefined);
  assert.deepEqual(minimalStaticPins(minimalStaticRecipe("26.14.0", pins.digest, pins.caddy))?.caddy, pins.caddy);
});
