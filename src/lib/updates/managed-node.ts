import { gt } from "semver";
import { ApiError } from "../http";
import { nodeVersionInfo } from "../connectors/software-releases";
import { stableVersion } from "./versions";
import type { ManagedNode, UpdateCheck, UpdateTarget } from "./types";
const vercelRuntime = (target: UpdateTarget) => target.provider === "vercel" && target.capability?.adapter !== "node-static";

export async function nodeValidationPlan(targets: UpdateTarget[], checks: (UpdateCheck | null)[], latestLts: string, release = nodeVersionInfo) {
  const observed = targets.flatMap((target, index) => {
    if (!vercelRuntime(target)) return [];
    const check = checks[index], proof = check?.nodeEvidence;
    if (check?.status !== "passed" || proof?.source !== "vercel-function" || proof.projectId !== target.remoteId || !stableVersion(proof.version)) throw new ApiError("La version Node fournie par Vercel doit être mesurée avant les installations.", 422);
    return [proof.version];
  });
  const versions = new Set([...observed, ...targets.filter(target => !vercelRuntime(target)).map(() => latestLts)]);
  if (versions.size !== 1) throw new ApiError("Les services partagent leurs sources mais utilisent des versions Node différentes. Une validation commune ne peut pas être affirmée.", 422);
  const version = [...versions][0];
  const managed = new Map<string, ManagedNode>();
  if (observed.length) {
    const info = await release(version);
    if (info.supported !== true || !info.checkedAt || info.state === "unknown") throw new ApiError("Le support de la version Node fournie par Vercel n’a pas pu être confirmé.", 422);
    const branchLatest = info.latestVersion;
    if (!branchLatest || !stableVersion(branchLatest) || branchLatest.split(".")[0] !== version.split(".")[0] || gt(version, branchLatest)) throw new ApiError("Le catalogue des correctifs de la branche Node mesurée n’est pas confirmé.", 422);
    for (const [index, target] of targets.entries()) if (vercelRuntime(target)) managed.set(target.id, { provider: "vercel", version, latestLts, branchLatest, migrationAvailable: gt(latestLts, version) && latestLts.split(".")[0] !== version.split(".")[0], updatePending: gt(branchLatest, version), securityUpdate: info.securityUpdate, checkedAt: checks[index]!.checkedAt });
  }
  return { version, managed };
}
export function managedNodeMessage(runtime: ManagedNode) {
  return `Node ${runtime.version} est fourni par Vercel et utilisé pour valider les dépendances sur sa branche prise en charge. ${runtime.updatePending ? `${runtime.securityUpdate ? "Correctif de sécurité" : "Correctif Node"} ${runtime.branchLatest || runtime.latestLts} en attente chez l’hébergeur ; la mise à jour du runtime n’est pas confirmée. Vigie ne peut pas imposer ce correctif à Vercel.` : "Aucun correctif manquant identifié sur cette branche."}${runtime.migrationAvailable ? ` Migration vers la LTS ${runtime.latestLts} à planifier séparément ; elle ne bloque pas les dépendances compatibles.` : ""}`;
}
