import { stableVersion } from "./versions";
import { deploymentEvidence } from "../connectors/railway-evidence";
import { readRailwayInstance, vercelUpdateRequest } from "./providers";
import { ApiError } from "../http";
import type { UpdateCheck, UpdateResult, UpdateStage, UpdateTarget } from "./types";
import { readDockerNode, type DockerNodeProof } from "./docker-node";
import { readVercelRuntime } from "./vercel-runtime";

export type NodeDeploymentReference = { deploymentId: string; commit?: string };
type ActiveDeployment = { id: string; status: string; meta?: unknown };

export function activeNodeImage(target: UpdateTarget, reference: NodeDeploymentReference, expected: string, active: ActiveDeployment[]) {
  const fail = (message: string): never => { throw new ApiError(message, 422); };
  if (!stableVersion(expected)) return fail("Version Node cible invalide ; déploiement non validé.");
  const deployment = active.find(item => item.id === reference.deploymentId && item.status === "SUCCESS");
  if (!deployment || active.some(item => item.id !== reference.deploymentId)) return fail("Le déploiement attendu n’est pas le seul déploiement actif. Version Node non confirmée.");
  const evidence = deploymentEvidence(deployment.meta);
  if (!evidence) return fail(`Node ${expected} attendu : aucune attestation exploitable pour le déploiement actif.`);
  if (reference.commit && evidence.commit !== reference.commit) return fail("Le commit du déploiement actif ne correspond pas au commit testé. Version Node non confirmée.");
  if (target.mode === "git" && (evidence.repository !== target.repository || evidence.branch !== target.branch)) return fail("La source ou la branche du déploiement actif ne correspond pas au service. Version Node non confirmée.");
  if (evidence.rootDirectory !== null && evidence.rootDirectory !== undefined && evidence.rootDirectory.replace(/^\/+|\/+$/g, "") !== target.root.replace(/^\/+|\/+$/g, "")) return fail("Le répertoire du déploiement actif ne correspond pas au service. Version Node non vérifiable.");
  if (!evidence.imageDigest) return fail(`Node ${expected} attendu : empreinte de l’image active manquante.`);
  return evidence;
}

export function deployedNodeCheck(target: UpdateTarget, reference: NodeDeploymentReference, expected: string, active: ActiveDeployment[], runtime?: DockerNodeProof): UpdateCheck {
  const base = { tool: "Node" as const, phase: "after" as const, scope: target.root || "racine", checkedAt: new Date().toISOString(), findings: [] };
  const fail = (message: string): UpdateCheck => ({ ...base, status: "blocked", message });
  let evidence;
  try { evidence = activeNodeImage(target, reference, expected, active); }
  catch (error) { return fail(error instanceof ApiError ? error.message : "Image active non identifiable."); }
  if (runtime) {
    if (!evidence.imageDigest || runtime.imageDigest !== evidence.imageDigest || runtime.deploymentId !== reference.deploymentId || !runtime.instances.length || runtime.instances.length > 32 || new Set(runtime.instances.map(instance => instance.id)).size !== runtime.instances.length) return fail("La preuve Node ne correspond pas à l’image active attendue.");
    const versions = [...new Set(runtime.instances.flatMap(instance => [instance.node, ...instance.running]))];
    if (runtime.instances.some(instance => !instance.running.length) || versions.some(value => !stableVersion(value))) return fail("La preuve ne contient pas de runtime Node applicatif exact pour chaque instance.");
    if (versions.some(value => value !== expected)) return fail(`Node ${expected} attendu, Node ${versions.join(", ")} observé dans les conteneurs actifs. La version corrigée n’est pas déployée sur toutes les instances.`);
    return { ...base, status: "passed", nodeEvidence: { version: expected, deploymentId: reference.deploymentId, imageDigest: runtime.imageDigest, source: "container", usage: "runtime", instances: runtime.instances.map(instance => instance.id) }, message: `Node ${expected} lu dans les ${runtime.instances.length} conteneur(s) actif(s), y compris les exécutables Node applicatifs en cours. Image ${runtime.imageDigest}, déploiement ${reference.deploymentId} ; identité et instances revérifiées après la lecture.` };
  }
  const node = evidence.packages.find(item => item.name === "node");
  if (target.builder === "DOCKERFILE" || !evidence.imageDigest || !evidence.railpackVersion || !node || node.usage !== (evidence.staticSite ? "build" : "runtime")) return fail(`Node ${expected} attendu : aucune attestation exacte de Node pour l’image active. Un tag Docker, la configuration ou le seul contrôle HTTPS ne suffisent pas.`);
  if (node.version !== expected) return fail(`Node ${expected} attendu, Node ${node.version} attesté pour le déploiement actif ${reference.deploymentId}. La version corrigée n’est pas déployée ; vérification nécessaire.`);
  return { ...base, status: "passed", nodeEvidence: { version: expected, deploymentId: reference.deploymentId, imageDigest: evidence.imageDigest, source: "railpack", usage: evidence.staticSite ? "build" : "runtime" }, message: `Node ${expected} confirmé par le manifeste de construction de l’image active ${reference.deploymentId} (${evidence.staticSite ? "construction du site statique, sans runtime Node attesté" : "runtime déclaré"}). Cette attestation hébergeur n’est pas une commande exécutée dans le conteneur.` };
}

export async function verifyDeployedNode(target: UpdateTarget, reference: NodeDeploymentReference, expected: string, readers: { railway: typeof readRailwayInstance; vercel: typeof vercelUpdateRequest; runtime?: typeof readDockerNode; vercelRuntime?: typeof readVercelRuntime } = { railway: readRailwayInstance, vercel: vercelUpdateRequest }): Promise<UpdateCheck> {
  if (target.provider === "railway") {
    const { serviceInstance } = await readers.railway(target);
    if ((serviceInstance.rootDirectory || "").replace(/^\/+|\/+$/g, "") !== target.root.replace(/^\/+|\/+$/g, "")) return deployedNodeCheck(target, reference, expected, []);
    const active = serviceInstance.activeDeployments || [];
    const check = deployedNodeCheck(target, reference, expected, active);
    const evidence = deploymentEvidence(active.find((item: ActiveDeployment) => item.id === reference.deploymentId)?.meta);
    // Railway can report RAILPACK while auto-detecting a Dockerfile. Decide from
    // the actual image evidence as well as the configured builder.
    if (target.builder !== "DOCKERFILE" && evidence?.railpackVersion && evidence.packages.some(item => item.name === "node")) {
      if (check.status !== "passed" || evidence.staticSite) return check;
    }
    let digest: string;
    try { digest = activeNodeImage(target, reference, expected, active).imageDigest!; }
    catch { return check; }
    try {
      const proof = await (readers.runtime || readDockerNode)(target, reference.deploymentId, digest!);
      const current = (await readers.railway(target)).serviceInstance;
      if ((current.rootDirectory || "").replace(/^\/+|\/+$/g, "") !== target.root.replace(/^\/+|\/+$/g, "")) return deployedNodeCheck(target, reference, expected, []);
      return deployedNodeCheck(target, reference, expected, current.activeDeployments || [], proof);
    } catch (error) {
      return { ...check, status: "blocked", nodeEvidence: undefined, message: `Node ${expected} non confirmé dans l’image déployée : ${error instanceof ApiError ? error.message : "la lecture du runtime a échoué"}` };
    }
  }
  if (target.provider !== "vercel") return deployedNodeCheck(target, reference, expected, []);
  const base = { tool: "Node" as const, phase: "after" as const, scope: target.root || "racine", checkedAt: new Date().toISOString(), findings: [] };
  try {
    const proof = await (readers.vercelRuntime || readVercelRuntime)(target, reference, { vercel: readers.vercel });
    if (!stableVersion(expected) || proof.node !== expected) throw new ApiError(`Node ${expected} testé, Node ${proof.node} observé dans la fonction Vercel. Le correctif exécuté diffère ; validation non confirmée.`, 422);
    return { ...base, status: "passed", nodeEvidence: { version: proof.node, deploymentId: proof.deploymentId, source: "vercel-function", usage: "runtime", projectId: proof.projectId, commit: proof.commit, region: proof.region }, message: `Node ${proof.node} mesuré par la sonde signée de la fonction Vercel (${proof.region}), liée au projet, au commit et au déploiement actif ${proof.deploymentId}. Le build, les fonctions Edge et toutes les répliques ne sont pas attestés par cette mesure.` };
  } catch (error) { return { ...base, status: "blocked", message: `Node ${expected} non confirmé sur Vercel : ${error instanceof ApiError ? error.message : "preuve de runtime absente ou inexploitable"}` }; }
}

export async function confirmDeployedNode(target: UpdateTarget, result: UpdateResult, reference: NodeDeploymentReference, expected: string, progress: (stage: UpdateStage, message: string) => Promise<void>, verify = verifyDeployedNode) {
  result.stage = "verifying";
  const check = await verify(target, reference, expected);
  result.checks ||= [];
  result.checks.push(check);
  await progress("verifying", check.message);
  if (check.status !== "passed") throw new ApiError(check.message, 422);
}

export async function preflightNodeRuntime(target: UpdateTarget, deploymentId: string, expected: string, vercelProbe = readVercelRuntime): Promise<UpdateCheck | null> {
  if (target.provider === "vercel") {
    const base = { tool: "Node" as const, phase: "before" as const, scope: target.root || "racine", checkedAt: new Date().toISOString(), findings: [] };
    try {
      const proof = await vercelProbe(target, { deploymentId });
      return { ...base, status: "passed", nodeEvidence: { version: proof.node, deploymentId: proof.deploymentId, source: "vercel-function", usage: "runtime", projectId: proof.projectId, commit: proof.commit, region: proof.region }, message: `Sonde Vercel qualifiée sur le déploiement actuel : Node ${proof.node} mesuré. La version réellement testée sera contrôlée après déploiement ; dernière LTS publiée ${expected}.` };
    } catch (error) { return { ...base, status: "blocked", message: `Sonde Vercel non qualifiée avant publication : ${error instanceof ApiError ? error.message : "preuve absente ou inexploitable"}. Aucun changement publié.` }; }
  }
  if (target.provider !== "railway") return null;
  const base = { tool: "Node" as const, phase: "before" as const, scope: target.root || "racine", checkedAt: new Date().toISOString(), findings: [] };
  try {
    const { serviceInstance } = await readRailwayInstance(target);
    const image = activeNodeImage(target, { deploymentId }, expected, serviceInstance.activeDeployments || []);
    if (target.builder !== "DOCKERFILE" && image.railpackVersion && image.staticSite) return null;
    const proof = await readDockerNode(target, deploymentId, image.imageDigest!);
    const current = (await readRailwayInstance(target)).serviceInstance;
    const after = activeNodeImage(target, { deploymentId }, expected, current.activeDeployments || []);
    if (after.imageDigest !== proof.imageDigest || (current.rootDirectory || "").replace(/^\/+|\/+$/g, "") !== target.root.replace(/^\/+|\/+$/g, "")) throw new ApiError("L’image ou le répertoire actif a changé pendant la sonde Node.", 422);
    const observed = [...new Set(proof.instances.flatMap(instance => [instance.node, ...instance.running]))];
    return { ...base, status: "passed", message: `Lecture du runtime accessible ; Node ${observed.join(", ")} actuellement observé. Le correctif cible ${expected} sera contrôlé dans le nouveau déploiement avant de conclure au succès.` };
  } catch (error) {
    const reason = (error instanceof ApiError ? error.message : "accès au conteneur non confirmé").replace(/[.\s]+$/, "");
    return { ...base, status: "blocked", message: `Vérification du runtime indisponible avant publication : ${reason}. Mise à jour arrêtée avant les installations et la publication.` };
  }
}

// One failed service must not prevent collecting evidence for the remaining
// deployments. The overall run still fails closed, retaining each real result.
export async function verifyNodeServices(results: UpdateResult[], verify: (index: number) => Promise<void>) {
  const errors: ApiError[] = [];
  for (const [index, result] of results.entries()) {
    try { await verify(index); }
    catch (error) {
      const failure = error instanceof ApiError ? error : new ApiError("La vérification du service a échoué.", 502);
      result.stage = "attention";
      result.message = failure.message;
      errors.push(failure);
    }
  }
  if (errors.length) throw errors[0];
}
