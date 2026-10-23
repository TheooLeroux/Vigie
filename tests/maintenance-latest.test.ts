import assert from "node:assert/strict";
import test from "node:test";
import { latestMaintenanceOperation } from "../src/lib/maintenance-latest";
import type { MaintenanceInspection } from "../src/lib/maintenance-contract";

function inspection(dependencies: MaintenanceInspection["dependencies"] = []) {
  return {
    nodeVersions: ["22.9.0", "24.2.0", "24.12.0"],
    dependencyBlocker: null,
    dependencies,
  } as MaintenanceInspection;
}

test("Dernières versions : Node LTS la plus récente et toutes les dépendances, sans doublons", async () => {
  const input = inspection([
    { name: "react", declared: "^19.0.0", scope: "dependencies" },
    { name: "react", declared: "19.1.0", scope: "optionalDependencies" },
    { name: "typescript", declared: "5.9.3", scope: "devDependencies" },
  ]);
  const names: string[] = [];
  const operation = await latestMaintenanceOperation(input, async (name) => {
    names.push(name);
    return { name, version: name === "react" ? "19.1.0" : "5.9.3", node: ">=18" };
  });
  assert.deepEqual(operation, {
    kind: "all", version: "24.12.0", updates: [{ name: "react", version: "19.1.0" }],
  });
  assert.deepEqual(names, ["react", "typescript"]);
  assert.equal(input.dependencies[0].declared, "^19.0.0");
});

test("Dernières versions : plus de douze dépendances, concurrence registre bornée", async () => {
  const input = inspection(Array.from({ length: 17 }, (_, index) => ({
    name: `package-${index}`, declared: "^1.0.0", scope: "dependencies",
  })));
  let active = 0;
  let peak = 0;
  const result = await latestMaintenanceOperation(input, async (name) => {
    active++;
    peak = Math.max(active, peak);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    return { name, version: "2.0.0" };
  });
  assert.equal(result.updates.length, 17);
  assert.equal(peak, 4);
});

test("Dernières versions : pas de rétrogradation, ni résolution partielle ou déclaration spéciale", async () => {
  const release = async (name: string) => ({ name, version: "1.0.0" });
  for (const declared of ["workspace:*", "catalog:", "npm:other@1.0.0", "1.0.0-beta.1", "^1 || ^2", "git+ssh://host/repo"])
    await assert.rejects(latestMaintenanceOperation(inspection([
      { name: "pkg", declared, scope: "dependencies" },
    ]), release), /déclaration particulière/);
  await assert.rejects(latestMaintenanceOperation(inspection([
    { name: "pkg", declared: "^2.0.0", scope: "dependencies" },
  ]), release), /antérieure/);
  await assert.rejects(latestMaintenanceOperation({ ...inspection(), dependencyBlocker: "Gestionnaire bloqué" }, release), /Gestionnaire bloqué/);
  await assert.rejects(latestMaintenanceOperation({ ...inspection(), nodeVersions: [] }, release), /Aucune version Node/);
  await assert.rejects(latestMaintenanceOperation(inspection([
    { name: "pkg", declared: "^1.0.0", scope: "dependencies" },
  ]), async () => { throw new Error("Registre indisponible"); }), /Registre indisponible/);
});
