import { stableVersion } from "./versions";
import { deploymentEvidence } from "../connectors/railway-evidence";
import { readRailwayInstance, vercelUpdateRequest } from "./providers";
import { ApiError } from "../http";
import type { UpdateCheck, UpdateResult, UpdateStage, UpdateTarget } from "./types";

export type NodeDeploymentReference = { deploymentId: string; commit?: string };

export function deployedNodeCheck(target: UpdateTarget, reference: NodeDeploymentReference, expected: string, active: { id: string; status: string; meta?: unknown }[]): UpdateCheck {
  const base = { tool: "Node" as const, phase: "after" as const, scope: target.root || "racine", checkedAt: new Date().toISOString(), findings: [] };
  const fail = (message: string): UpdateCheck => ({ ...base, status: "blocked", message });
  if (!stableVersion(expected)) return fail("Version Node cible invalide ; déploiement non validé.");
  const deployment = active.find(item => item.id === reference.deploymentId && item.status === "SUCCESS");
  if (!deployment || active.some(item => item.id !== reference.deploymentId)) return fail("Le déploiement attendu n’est pas le seul déploiement actif. Version Node non confirmée.");
  const evidence = deploymentEvidence(deployment.meta);
  if (!evidence) return fail(`Node ${expected} attendu : aucune attestation exploitable pour le déploiement actif.`);
  if (reference.commit && evidence?.commit !== reference.commit) return fail("Le commit du déploiement actif ne correspond pas au commit testé. Version Node non confirmée.");
  if (target.mode === "git" && (evidence.repository !== target.repository || evidence.branch !== target.branch)) return fail("La source ou la branche du déploiement actif ne correspond pas au service. Version Node non confirmée.");
  if (evidence?.rootDirectory !== null && evidence?.rootDirectory !== undefined && evidence.rootDirectory.replace(/^\/+|\/+$/g, "") !== target.root.replace(/^\/+|\/+$/g, "")) return fail("Le répertoire du déploiement actif ne correspond pas au service. Version Node non vérifiable.");
  const node = evidence.packages.find(item => item.name === "node");
  if (!evidence.imageDigest || !evidence.railpackVersion || !node || node.usage !== (evidence.staticSite ? "build" : "runtime")) return fail(`Node ${expected} attendu : aucune attestation exacte de Node pour l’image active. Un tag Docker, la configuration ou le seul contrôle HTTPS ne suffisent pas.`);
  if (node.version !== expected) return fail(`Node ${expected} attendu, Node ${node.version} attesté pour le déploiement actif ${reference.deploymentId}. La version corrigée n’est pas déployée ; vérification nécessaire.`);
  return { ...base, status: "passed", message: `Node ${expected} confirmé par le manifeste de construction de l’image active ${reference.deploymentId} (${evidence.staticSite ? "construction du site statique, sans runtime Node attesté" : "runtime déclaré"}). Cette attestation hébergeur n’est pas une commande exécutée dans le conteneur.` };
}

export async function verifyDeployedNode(target: UpdateTarget, reference: NodeDeploymentReference, expected: string, readers = { railway: readRailwayInstance, vercel: vercelUpdateRequest }): Promise<UpdateCheck> {
  if (target.provider === "railway") {
    const { serviceInstance } = await readers.railway(target);
    if ((serviceInstance.rootDirectory || "").replace(/^\/+|\/+$/g, "") !== target.root.replace(/^\/+|\/+$/g, "")) return deployedNodeCheck(target, reference, expected, []);
    return deployedNodeCheck(target, reference, expected, serviceInstance.activeDeployments || []);
  }
  if (target.provider !== "vercel") return deployedNodeCheck(target, reference, expected, []);
  const project = await readers.vercel(target, `/v9/projects/${target.remoteId}`);
  return { tool: "Node", phase: "after", scope: target.root || "racine", checkedAt: new Date().toISOString(), status: "blocked", findings: [], message: project.targets?.production?.id !== reference.deploymentId ? "Le déploiement Vercel actif a changé. Version Node non confirmée." : `Node ${expected} attendu : Vercel ne fournit pas ici d’attestation du correctif Node effectivement exécuté. Une configuration de branche majeure ne permet pas de valider cette mise à jour.` };
}

export async function confirmDeployedNode(target: UpdateTarget, result: UpdateResult, reference: NodeDeploymentReference, expected: string, progress: (stage: UpdateStage, message: string) => Promise<void>, verify = verifyDeployedNode) {
  result.stage = "verifying";
  const check = await verify(target, reference, expected);
  result.checks ||= [];
  result.checks.push(check);
  await progress("verifying", check.message);
  if (check.status !== "passed") throw new ApiError(check.message, 422);
}
