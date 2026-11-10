import { ApiError } from "../http";
import { deploymentEvidence } from "../connectors/railway-evidence";
import { caddyCatalog } from "../connectors/software-releases";
import { normalizeImageDigest } from "../image-reference";
import { githubRequest, githubUpdateToken, repositoryAllowed } from "./github";
import { checkPublicMinimalStatic, minimalStaticCaddyCandidate, MinimalStaticCandidateVulnerable, scanMinimalStaticImage, testMinimalStaticRailway } from "./minimal-static";
import { minimalStaticProfile } from "./minimal-static-profile";
import { readRailwayInstance, waitForDeployment } from "./providers";
import { railpackCaddyVersion } from "./railpack-caddy";
import { cachedRailpackInventory, readRailpackScan, readRecentCaddyRefusal, saveCaddyRefusal, saveMinimalStaticScan } from "./railpack-image-control";
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

export async function migrateMinimalStatic(target: UpdateTarget, witness: UpdateTarget, result: UpdateResult, getSources: SourceReader, progress: Progress, qualificationCommit?: string) {
  const repository = target.repository, branch = target.branch;
  if (minimalStaticWitnessId(target) !== witness.remoteId || !repository || !branch || !repositoryAllowed(repository)) return false;
  const { serviceInstance } = await readRailwayInstance(target);
  const [deployment] = serviceInstance.activeDeployments || [];
  const evidence = deploymentEvidence(deployment?.meta);
  const caddy = railpackCaddyVersion(evidence), imageDigest = normalizeImageDigest(evidence?.imageDigest);
  if (serviceInstance.activeDeployments?.length !== 1 || deployment.status !== "SUCCESS" || !evidence?.commit || !imageDigest) return false;
  const commit = evidence.commit;
  if (qualificationCommit && (commit !== qualificationCommit || caddy)) throw new ApiError("L’image statique active a changé avant la qualification Caddy.", 409);
  const path = target.root + "/Dockerfile";
  let change: { version: string; digest: string; previousRecipe: string; recipe: string } | undefined;
  let removed = 0;
  if (caddy) {
    const identity = { targetId: target.id, projectId: target.projectId, deploymentId: deployment.id as string, imageDigest, commit, caddy };
    const cached = await readRailpackScan(target.id);
    const report = cached?.report && !cached.error && sameRailpackImage(cached, identity) && Date.now() - Date.parse(cached.report.check.checkedAt) < 15 * 60_000
      ? cached.report.check : (await scanRailpackImage(target, identity, await cachedRailpackInventory(identity))).check;
    const removable = report.findings.filter(item => item.packageManager === "apt" && !item.fixedVersions?.length);
    if (!removable.length || report.status === "blocked") return false;
    removed = report.findings.length;
    await progress("updating", `${target.name} : ${removable.length} signalement(s) Debian sans correctif renseigné ; qualification d’une image statique minimale.`);
  } else {
    if (evidence.railpackVersion || evidence.repository !== repository || evidence.branch !== branch) return false;
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const original = await githubRequest(`/repos/${repository}/contents/${encodedPath}?ref=${commit}`, githubUpdateToken(repository)).catch(() => null);
    if (original?.type !== "file" || original.encoding !== "base64" || typeof original.content !== "string" || original.size > 64_000) return false;
    const previousRecipe = Buffer.from(original.content, "base64").toString("utf8");
    const proposal = minimalStaticCaddyCandidate(previousRecipe, await caddyCatalog());
    if (!proposal) return false;
    const refusal = qualificationCommit ? undefined : await readRecentCaddyRefusal(target.id, proposal.digest);
    if (refusal) {
      result.warnings.push(`Refus Trivy réutilisé pour le même binaire Caddy. ${refusal.reason}`);
      return false;
    }
    await activeMinimalStaticImage(target, deployment.id, commit);
    change = { ...proposal, previousRecipe };
    await progress("updating", `${target.name} : qualification de Caddy ${change.version} pour l’image minimale.`);
  }

  const profile = minimalStaticProfile(target);
  await checkPublicMinimalStatic(target, profile);
  await assertSourceImpact([target], [path]);
  let candidate;
  try {
    candidate = await testMinimalStaticRailway(target, witness, commit, getSources, async message => {
      console.log(message);
      await progress("updating", message);
    }, change, profile);
  } catch (error) {
    if (!change || !(error instanceof MinimalStaticCandidateVulnerable)) throw error;
    const summary = error.findings.slice(0, 6).map(finding => `${finding.package} ${finding.version} (${finding.id})`).join(", ");
    const reason = `Caddy ${change.version} écarté par Trivy : ${error.findings.length} signalement(s) sur le binaire candidat (${summary}).`;
    result.warnings.push(reason);
    await saveCaddyRefusal(target.id, change.digest, reason);
    await progress("verifying", reason);
    const active = await activeMinimalStaticImage(target, deployment.id, commit);
    const scan = await scanMinimalStaticImage(target, deployment.id);
    await checkPublicMinimalStatic(target, profile);
    if (!sameRailpackImage(active, await activeMinimalStaticImage(target, deployment.id, commit))) throw new ApiError("L’image active a changé pendant les contrôles.", 409);
    const check = securityCheck("Trivy", "before", "Image statique minimale conservée sur Railway", scan.findings);
    check.message = `Image active ${active.imageDigest} : ${scan.findings.length} signalement(s). Les sondes configurées ont réussi.`;
    await saveMinimalStaticScan(active, check);
    (result.checks ||= []).push(check);
    await progress("verifying", check.message);
    return !!qualificationCommit;
  }
  result.checks ||= [];
  const proof = `${candidate.http} contrôle(s) HTTP et ${candidate.websocket} ouverture(s) WebSocket vérifiés.`;
  result.checks.push({ ...securityCheck("Trivy", "candidate", "Image statique minimale", []), message: "Image candidate qualifiée sur Railway. " + proof });
  if (qualificationCommit) return true;

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
  const tree = await githubRequest(`${api}/trees`, token, "POST", { base_tree: originalTree, tree: [{ path, mode: "100644", type: "blob", content: candidate.recipe }] });
  const published = await createCommit(change ? `chore: mettre à jour Caddy vers ${change.version} via Vigie` : "fix: déployer le frontend dans une image minimale via Vigie", tree.sha, commit);

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
    await checkPublicMinimalStatic(target, profile);
    if (!sameRailpackImage(active, await activeMinimalStaticImage(target, deploymentId, published))) throw new ApiError("L’image active a changé pendant les contrôles.", 409);
    const check = { ...securityCheck("Trivy", "after", "Image statique minimale déployée sur Railway", scan.findings),
      message: `${change ? `Caddy ${change.version} confirmé. ` : ""}Image ${active.imageDigest} : aucun signalement sur ${scan.instances} instance(s). ${removed ? `Les ${removed} signalements de l’image précédente sont absents. ` : ""}${proof}` };
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
        if (change) await activeMinimalStaticImage(target, restored, revert);
        else {
          const { serviceInstance: restoredInstance } = await readRailwayInstance(target);
          if (!railpackCaddyVersion(deploymentEvidence(restoredInstance.activeDeployments?.[0]?.meta))) throw new ApiError("Retour à Railpack non attesté.", 502);
        }
        await checkPublicMinimalStatic(target, profile);
        recovered = true;
        result.warnings.push(`Retour à la recette précédente vérifié sur Railway (${restored}).`);
      }
    } catch { result.warnings.push("Récupération Railway à vérifier. Les références Git et Railway sont conservées."); }
    const reason = error instanceof ApiError ? error.message : "Les contrôles du déploiement minimal ont échoué.";
    throw new ApiError(`${reason} ${recovered ? "Retour à la recette précédente vérifié." : "État du déploiement à vérifier."}`, 502);
  }
}
