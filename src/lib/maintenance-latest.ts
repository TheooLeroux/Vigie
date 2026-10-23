import { ApiError } from "./http";
import type {
  MaintenanceInspection,
  MaintenanceOperation,
} from "./maintenance-contract";

export function compareStableVersions(first: string, second: string) {
  const firstParts = first.split(".").map(Number);
  const secondParts = second.split(".").map(Number);
  for (const index of [0, 1, 2]) {
    const difference = firstParts[index] - secondParts[index];
    if (difference) return difference;
  }
  return 0;
}

export async function latestMaintenanceOperation(
  inspection: MaintenanceInspection,
  release: (name: string) => Promise<{ name: string; version: string }>,
): Promise<Extract<MaintenanceOperation, { kind: "all" }>> {
  if (inspection.dependencyBlocker)
    throw new ApiError(inspection.dependencyBlocker);
  const version = [...inspection.nodeVersions].sort(
    (first, second) => compareStableVersions(second, first),
  )[0];
  if (!version)
    throw new ApiError("Aucune version Node LTS supportée ne peut être proposée.");
  const dependencies = new Map<string, string[]>();
  for (const dependency of inspection.dependencies) {
    if (!/^(?:[~^=]|>=)?\s*\d+\.\d+\.\d+$/.test(dependency.declared))
      throw new ApiError(
        `${dependency.name} utilise une déclaration particulière (${dependency.declared}). Une revue avancée est nécessaire ; aucune mise à jour partielle n’est lancée.`,
      );
    dependencies.set(dependency.name, [
      ...(dependencies.get(dependency.name) || []),
      dependency.declared,
    ]);
  }
  if (dependencies.size > 100)
    throw new ApiError("Plus de 100 dépendances : une revue spécifique est nécessaire.");
  const updates: { name: string; version: string }[] = [];
  const entries = [...dependencies];
  for (let offset = 0; offset < entries.length; offset += 4) {
    const releases = await Promise.all(
      entries.slice(offset, offset + 4).map(async ([name, declarations]) => {
        const latest = await release(name);
        const newerDeclaration = declarations.some((declared) =>
          compareStableVersions(declared.match(/\d+\.\d+\.\d+/)![0], latest.version) > 0,
        );
        if (newerDeclaration)
          throw new ApiError(
            `${name} déclare une version plus récente que la dernière stable publique. Aucun retour à une version antérieure n’est effectué.`,
          );
        return declarations.every((declared) => declared === latest.version)
          ? null
          : { name, version: latest.version };
      }),
    );
    updates.push(...releases.filter((item) => item !== null));
  }
  return { kind: "all", version, updates };
}
