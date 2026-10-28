import { gt } from "semver";
import { ApiError } from "../http";
import { nodeVersionInfo } from "../connectors/software-releases";
import { stableVersion } from "./versions";
import type { ManagedNode, UpdateCheck, UpdateTarget } from "./types";

export async function nodeValidationPlan(targets: UpdateTarget[], checks: (UpdateCheck | null)[], latestLts: string, release = nodeVersionInfo) {
  const observed = targets.flatMap((target, index) => {
    if (target.provider !== "vercel") return [];
    const check = checks[index], proof = check?.nodeEvidence;
    if (check?.status !== "passed" || proof?.source !== "vercel-function" || proof.projectId !== target.remoteId || !stableVersion(proof.version)) throw new ApiError("La version Node fournie par Vercel doit être mesurée avant les installations.", 422);
    if (proof.version.split(".")[0] !== latestLts.split(".")[0]) throw new ApiError(`Vercel doit utiliser la branche LTS ${latestLts.split(".")[0]}.x avant cette maintenance ; aucun changement de majeure implicite.`, 422);
    return [proof.version];
  });
  const versions = new Set([...observed, ...targets.filter(target => target.provider !== "vercel").map(() => latestLts)]);
  if (versions.size !== 1) throw new ApiError("Les services partagent leurs sources mais utilisent des versions Node différentes. Une validation commune ne peut pas être affirmée.", 422);
  const version = [...versions][0];
  const managed = new Map<string, ManagedNode>();
  if (observed.length) {
    const info = await release(version);
    if (info.supported !== true || !info.checkedAt || info.state === "unknown") throw new ApiError("Le support de la version Node fournie par Vercel n’a pas pu être confirmé.", 422);
    for (const [index, target] of targets.entries()) if (target.provider === "vercel") managed.set(target.id, { provider: "vercel", version, latestLts, updatePending: gt(latestLts, version), securityUpdate: info.latestVersion === latestLts ? info.securityUpdate : null, checkedAt: checks[index]!.checkedAt });
  }
  return { version, managed };
}
export function managedNodeMessage(runtime: ManagedNode) {
  return `Node ${runtime.version} est fourni par Vercel et utilisé pour valider les dépendances. ${runtime.securityUpdate ? "Correctif de sécurité" : "Version LTS"} ${runtime.latestLts} en attente chez l’hébergeur ; la mise à jour du runtime n’est pas confirmée. Vigie ne peut pas imposer ce correctif à Vercel.`;
}
