import { ApiError } from "../http";
import { deploymentEvidence } from "../connectors/railway-evidence";
import { normalizeImageDigest } from "../image-reference";
import { githubRequest, githubUpdateToken, repositoryAllowed } from "./github";
import { checkPublicMinimalStatic, minimalStaticDockerfile, scanMinimalStaticImage, testMinimalStaticRailway } from "./minimal-static";
import { readRailwayInstance, waitForDeployment } from "./providers";
import { railpackCaddyVersion } from "./railpack-caddy";
import { cachedRailpackInventory, readRailpackScan, saveMinimalStaticScan } from "./railpack-image-control";
import { sameRailpackImage } from "./railpack-image-report";
import { scanRailpackImage } from "./railpack-image-scan";
import { securityCheck } from "./security";
import { assertSourceImpact } from "./source-impact";
import type { UpdateResult, UpdateStage, UpdateTarget } from "./types";

type Progress = (stage: UpdateStage, message: string) => Promise<void>;
type SourceReader = Parameters<typeof testMinimalStaticRailway>[3];

export function minimalStaticWitnessId(target: UpdateTarget, grants = process.env.VIGIE_MINIMAL_STATIC_SERVICES || "") {
  if (target.provider !== "railway" || target.mode !== "git" || !target.environmentId || !target.url || !target.root) return;
  const key = [target.projectId, target.environmentId, target.remoteId].join(":");
  const matches = grants.split(/[\s,]+/).map(grant => grant.split(":")).filter(parts => parts.slice(0, 3).join(":") === key);
  const witness = matches[0]?.[3];
  if (matches.length === 1 && matches[0].length === 4 && witness !== target.remoteId && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(witness)) return witness;
}

export async function activeMinimalStaticImage(target: UpdateTarget, deploymentId: string, commit: string) {
  const { serviceInstance: instance } = await readRailwayInstance(target);
  const [active] = instance.activeDeployments || [];
  const evidence = deploymentEvidence(active?.meta);
  const imageDigest = normalizeImageDigest(evidence?.imageDigest);
  if (instance.activeDeployments?.length !== 1 || active.id !== deploymentId || active.status !== "SUCCESS" || !imageDigest ||
    evidence?.railpackVersion || evidence?.commit !== commit || evidence.repository !== target.repository || evidence.branch !== target.branch ||
    (instance.rootDirectory || "").replace(/^\/+|\/+$/g, "") !== target.root) throw new ApiError("L’image Docker active ne correspond pas au déploiement statique attendu.", 422);
  return { targetId: target.id, projectId: target.projectId, deploymentId, imageDigest, commit, caddy: "minimal-static" };
}

export async function migrateMinimalStatic(target: UpdateTarget, witness: UpdateTarget, result: UpdateResult, getSources: SourceReader, progress: Progress) {
  const repository = target.repository, branch = target.branch;
  if (minimalStaticWitnessId(target) !== witness.remoteId || !repository || !branch || !repositoryAllowed(repository)) return false;
  const { serviceInstance } = await readRailwayInstance(target);
  const [deployment] = serviceInstance.activeDeployments || [];
  const evidence = deploymentEvidence(deployment?.meta);
  const caddy = railpackCaddyVersion(evidence), imageDigest = normalizeImageDigest(evidence?.imageDigest);
  if (serviceInstance.activeDeployments?.length !== 1 || deployment.status !== "SUCCESS" || !evidence?.commit || !imageDigest || !caddy) return false;
  const commit = evidence.commit;
  const identity = { targetId: target.id, projectId: target.projectId, deploymentId: deployment.id as string, imageDigest, commit, caddy };
  const cached = await readRailpackScan(target.id);
  const report = cached?.report && !cached.error && sameRailpackImage(cached, identity) && Date.now() - Date.parse(cached.report.check.checkedAt) < 15 * 60_000
    ? cached.report.check : (await scanRailpackImage(target, identity, await cachedRailpackInventory(identity))).check;
  const removable = report.findings.filter(item => item.packageManager === "apt" && !item.fixedVersions?.length);
  if (!removable.length || report.status === "blocked") return false;

  const path = target.root + "/Dockerfile";
  await checkPublicMinimalStatic(target);
  await assertSourceImpact([target], [path]);
  await progress("updating", `${target.name} : ${removable.length} signalement(s) Debian sans correctif renseigné ; qualification d’une image statique minimale.`);
  const candidate = await testMinimalStaticRailway(target, witness, commit, getSources, async message => {
    console.log(message);
    await progress("updating", message);
  });
  result.checks ||= [];
  result.checks.push({ ...securityCheck("Trivy", "candidate", "Image statique minimale", []), message: "Image candidate qualifiée sur Railway. Site, API et ouverture WebSocket vérifiés." });

  const current = async (service: UpdateTarget, id: string) => {
    const { serviceInstance: instance } = await readRailwayInstance(service);
    return instance.activeDeployments?.length === 1 && instance.activeDeployments[0].id === id &&
      instance.activeDeployments[0].status === "SUCCESS" && !["INITIALIZING", "QUEUED", "BUILDING", "DEPLOYING", "WAITING"].includes(instance.latestDeployment?.status);
  };
  if (candidate.previousDeploymentId !== deployment.id || !await current(target, deployment.id) || !await current(witness, candidate.witnessDeploymentId)) throw new ApiError("Le frontend ou le backend a changé pendant la qualification.", 409);
  await assertSourceImpact([target], [path]);

  const token = githubUpdateToken(repository), api = `/repos/${repository}/git`;
  const ref = `${api}/refs/heads/${encodeURIComponent(branch)}`;
  const head = async () => (await githubRequest(`${api}/ref/heads/${encodeURIComponent(branch)}`, token)).object.sha as string;
  const publish = (sha: string) => githubRequest(ref, token, "PATCH", { sha, force: false });
  const createCommit = async (message: string, tree: string, parent: string) =>
    (await githubRequest(`${api}/commits`, token, "POST", { message, tree, parents: [parent] })).sha as string;
  if (await head() !== commit) throw new ApiError("La branche a changé pendant la qualification.", 409);
  const originalTree = (await githubRequest(`${api}/commits/${commit}`, token)).tree.sha;
  const tree = await githubRequest(`${api}/trees`, token, "POST", { base_tree: originalTree, tree: [{ path, mode: "100644", type: "blob", content: minimalStaticDockerfile }] });
  const published = await createCommit("fix: déployer le frontend dans une image minimale via Vigie", tree.sha, commit);

  result.stage = "publishing";
  result.previousDeploymentId = deployment.id;
  result.previousCommit = commit;
  result.commit = published;
  result.deploymentId = undefined;
  await progress("publishing", `${target.name} : publication de la recette minimale qualifiée.`);
  try {
    await publish(published);
    result.stage = "verifying";
    const deploymentId = await waitForDeployment(target, { commit: published, runId: published }, async id => {
      result.deploymentId = id;
      await progress("verifying", `${target.name} : attente du déploiement minimal Railway.`);
    });
    const active = await activeMinimalStaticImage(target, deploymentId, published);
    const scan = await scanMinimalStaticImage(target, deploymentId, candidate.binaryHash);
    if (scan.findings.length) throw new ApiError("Le scan du déploiement minimal actif signale encore des vulnérabilités.", 422);
    await checkPublicMinimalStatic(target);
    if (!sameRailpackImage(active, await activeMinimalStaticImage(target, deploymentId, published))) throw new ApiError("L’image active a changé pendant les contrôles.", 409);
    const check = { ...securityCheck("Trivy", "after", "Image statique minimale déployée sur Railway", scan.findings),
      message: `Image ${active.imageDigest} : aucun signalement sur ${scan.instances} instance(s). Les ${report.findings.length} signalements de l’image précédente sont absents. Site et santé HTTP 200, API HTTP 401 attendue sans session, ouverture WebSocket HTTP 101.` };
    await saveMinimalStaticScan(active, check);
    result.checks.push(check);
    result.stage = "completed";
    result.message = check.message;
    await progress("verifying", check.message);
    return true;
  } catch (error) {
    result.stage = "attention";
    let recovered = false;
    try {
      if (await head() === published) {
        const revert = await createCommit("revert: restaurer la recette Railway précédente", originalTree, published);
        await publish(revert);
        const restored = await waitForDeployment(target, { commit: revert, runId: revert }, async () => {});
        const { serviceInstance: restoredInstance } = await readRailwayInstance(target);
        if (!railpackCaddyVersion(deploymentEvidence(restoredInstance.activeDeployments?.[0]?.meta))) throw new ApiError("Retour à Railpack non attesté.", 502);
        await checkPublicMinimalStatic(target);
        recovered = true;
        result.warnings.push(`Retour à Railpack vérifié sur Railway (${restored}).`);
      }
    } catch { result.warnings.push("Récupération Railway à vérifier. Les références Git et Railway sont conservées."); }
    const reason = error instanceof ApiError ? error.message : "Les contrôles du déploiement minimal ont échoué.";
    throw new ApiError(`${reason} ${recovered ? "Retour à Railpack vérifié." : "État de la migration à vérifier."}`, 502);
  }
}
