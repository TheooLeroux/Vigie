import assert from "node:assert/strict";
import { test } from "node:test";
import { minimalStaticWitnessId } from "../src/lib/updates/minimal-static-migration";
import { minimalStaticBuildNode, minimalStaticDockerfile, minimalStaticRecipe } from "../src/lib/updates/minimal-static";
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
