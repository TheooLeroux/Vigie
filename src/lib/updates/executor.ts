import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { withAuditActor } from "../audit-context";
import { log, transaction } from "../db";
import { ApiError } from "../http";
import { synchronizeVercel } from "../vercel";
import { synchronizeRailway } from "../railway";
import { collectHostingInventories } from "../hosting-inventory";
import { hostingInstallation } from "../hosting-discovery";
import { caddyCatalog } from "../connectors/software-releases";
import { githubRequest, githubUpdateToken, repositoryAllowed } from "./github";
import { changedSources, latestNode, nodeValidationRuntime, snapshotSources, type NodeUpdateChecks } from "./node";
import { NodePreparationError, prepareNodeServices } from "./node-services";
import { checkPublicSite, deployRailwayArchive, deployVercelArchive, providerPreflight, readRailwayInstance, vercelUpdateRequest, waitForDeployment } from "./providers";
import { activeNodeImage, confirmDeployedNode, preflightNodeRuntime, verifyNodeServices } from "./node-deployment";
import { runCommand } from "./process";
import { nodeRunsWithReceipts, readUpdateRun, readUpdateSource, saveUpdateSnapshot, updateStorage, writeUpdateRun, writeUpdateSource } from "./storage";
import { createUpdateProgressTracker } from "./progress";
import { updateScope, updateTargets } from "./targets";
import { executeLocalWordPress } from "./wordpress-agent-execution";
import { remainingNpmFindings, type UpdateRun, type UpdateTarget, type UpdateResult, type UpdateStage, type UpdateCheck, type SecurityFinding } from "./types";
import { npmResidualPolicy } from "./node-security";
import { dockerRuntimeBase, validateDockerfileCandidate, validatedDockerfileChange, type AlpineRepair, type DockerNodeBase } from "./dockerfile";
import { caddyImageSecurity, requireSecurityPass, requireZeroFinalFindings, scanDockerImage, scanNodeSources, createNodeScanCache, securityCheck, SecurityPolicyError } from "./security";
import { nodeCatalogState } from "./node-catalog-state";
import { checkCurrentNodeConfiguration, nodeImageReceipt, nodePolicyHash, nodeReceiptDraft, nodeReceiptGroupCompleted, nodeReceiptValidations, nodeSecurityHash, nodeSourceHash, nodeTargetsHash, reusableNodeReceipt, sameNodeReceiptProof, unchangedNodeImages, unchangedNodeInputs } from "./node-current";
import { refreshWordPressWeb } from "./wordpress-web-check";
import { nodeValidationPlan, managedNodeMessage } from "./managed-node";
import { refreshProjectHosting } from "./refresh-hosting";
import { buildStaticCandidate, qualifyStaticSources, staticPreflight, vercelStaticTarget, verifyStaticDeployment, type StaticBuild, type StaticProfile } from "./vercel-static";
import { executionGroup, sourceFamily, workerTarget } from "./capabilities";
import { assertSourceImpact } from "./source-impact";
import { executeRailwayImage } from "./railway-image";
import { recordCompletedImageControls } from "./image-control";
import { assessmentResultIsSafe, finishAssessment, nodeAssessmentChanges } from "./assessment";
import { recordAssessmentAfterUpdate } from "./assessment-after-update";
import { imageSecurityCheck } from "./image-policy";
import { caddyConfig, caddyPinVersion, caddyVersionChange, railpackCaddyVersion, validateRailpackCaddy, validatedRailpackChange, verifyRailwayCaddy, type CaddyChange, type CaddyFingerprint } from "./railpack-caddy";
import { planDebianFixes, verifyDebianFixes } from "./railpack-debian";
import { cachedRailpackInventory } from "./railpack-image-control";
import { scanRailpackImage } from "./railpack-image-scan";
import { activeMinimalStaticImage, minimalStaticWitnessId, migrateMinimalStatic } from "./minimal-static-migration";
import { checkPublicMinimalStatic, minimalStaticBuildNode, minimalStaticPins, minimalStaticRecipe, scanMinimalStaticImage } from "./minimal-static";
import { minimalStaticProfile } from "./minimal-static-profile";
import { officialNodeImageDigest } from "./node-catalog-state";
import { saveMinimalStaticScan } from "./railpack-image-control";
import { deploymentEvidence } from "../connectors/railway-evidence";
import type { RailpackImageIdentity } from "./railpack-image-report";
import { normalizeImageDigest } from "../image-reference";

type Progress = (stage: UpdateStage, message: string) => Promise<void>;
const archiveScript = join(process.cwd(), "scripts", "update-archive.py");
export async function extractArchive(archive: string, folder: string, github = false): Promise<string[]> {
  return JSON.parse(await runCommand("python3", [archiveScript, github ? "extract-github" : "extract", archive, folder]));
}
export async function publishGitVersions(repository: string, branch: string, expected: string, files: { path: string; content: string }[], transport: typeof fetch = fetch, alpineRepairs?: ReadonlyMap<string, AlpineRepair>, caddyChanges?: ReadonlyMap<string, CaddyChange>, staticRecipes?: ReadonlyMap<string, string>) {
  if (!files.length || files.some(file => !/(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|\.nvmrc|\.node-version|Dockerfile|railpack\.json)$/.test(file.path) || file.path.split("/").some(part => !part || part === "." || part === ".." || part === ".git") || /[\\\x00-\x1f]/.test(file.path))) throw new ApiError("La publication doit se limiter aux versions et aux fichiers de verrouillage.");
  for (const file of files.filter(file => /(^|\/)railpack\.json$/.test(file.path))) {
    const change = caddyChanges?.get(file.path);
    if (!change || !validatedRailpackChange(change) || file.content !== caddyConfig(change)) throw new ApiError("Le fichier Railpack doit uniquement contenir les versions Caddy et Debian validées.");
  }
  if (!repositoryAllowed(repository)) throw new ApiError("Ce dépôt n’est pas autorisé pour la mise à jour.");
  const token = githubUpdateToken(repository);
  if (!token) throw new ApiError("Accès GitHub manquant.");
  const head = await githubRequest(`/repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`, token, "GET", undefined, transport);
  if (head.object.sha !== expected) throw new ApiError("Le dépôt a changé pendant les tests. Aucun changement n’a été écrasé.", 409);
  for (const file of files.filter(file => /(^|\/)Dockerfile$/.test(file.path))) {
    const original = await githubRequest(`/repos/${repository}/contents/${file.path.split("/").map(encodeURIComponent).join("/")}?ref=${expected}`, token, "GET", undefined, transport);
    if (staticRecipes?.get(file.path) === file.content && original.type === "file" && original.encoding === "base64" && typeof original.content === "string" && minimalStaticBuildNode(Buffer.from(original.content, "base64").toString("utf8")) && minimalStaticBuildNode(file.content)) continue;
    if (original.type !== "file" || original.encoding !== "base64" || typeof original.content !== "string" || typeof original.size !== "number" || original.size > 64_000 || !validatedDockerfileChange(Buffer.from(original.content, "base64").toString("utf8"), file.content, alpineRepairs?.get(file.path))) throw new ApiError("Le Dockerfile doit uniquement modifier les versions autorisées ou appliquer un correctif Alpine validé.");
  }
  const commit = await githubRequest(`/repos/${repository}/git/commits/${expected}`, token, "GET", undefined, transport);
  const tree = await githubRequest(`/repos/${repository}/git/trees`, token, "POST", { base_tree: commit.tree.sha, tree: files.map(file => ({ ...file, mode: "100644", type: "blob" })) }, transport);
  const next = await githubRequest(`/repos/${repository}/git/commits`, token, "POST", { message: "chore: update Node LTS and dependencies via Vigie", tree: tree.sha, parents: [expected] }, transport);
  await githubRequest(`/repos/${repository}/git/refs/heads/${encodeURIComponent(branch)}`, token, "PATCH", { sha: next.sha, force: false }, transport);
  return next.sha as string;
}
export async function downloadGitArchive(repository: string, sha: string, destination: string) {
  const response = await fetch(`https://api.github.com/repos/${repository}/zipball/${sha}`, { headers: { Authorization: `Bearer ${githubUpdateToken(repository)}`, Accept: "application/vnd.github+json" }, redirect: "manual", signal: AbortSignal.timeout(30000) });
  const location = response.headers.get("location");
  if (response.status !== 302 || !location) throw new ApiError("Les sources GitHub n’ont pas pu être récupérées.", 502);
  const url = new URL(location);
  if (url.protocol !== "https:" || url.hostname !== "codeload.github.com" || url.username || url.password) throw new ApiError("Adresse d’archive GitHub inattendue.");
  const download = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(60000) });
  if (!download.ok || !download.body) throw new ApiError("Le téléchargement des sources a échoué.", 502);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = download.body.getReader();
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
    if (size > 20_000_000) { await reader.cancel(); throw new ApiError("Sources limitées à 20 Mo compressés pour les mises à jour automatiques."); }
    chunks.push(part.value);
  }
  await writeFile(destination, Buffer.concat(chunks));
}
export async function checkNodeEndpoint(target: UpdateTarget, check = checkPublicSite) {
  if (workerTarget(target)) return;
  if (!target.url) throw new ApiError("Une URL publique est nécessaire pour ce parcours web.", 422);
  await check(target.url);
}
export function nodeCompletionMessage(target: UpdateTarget, result: UpdateResult, unchanged = false) {
  if (remainingNpmFindings(result).length) return unchanged
    ? "Déploiement actuel vérifié. Des failles npm restent à corriger."
    : "Mise à jour déployée et vérifiée. Des failles npm restent à corriger.";
  if (workerTarget(target)) return `${unchanged ? "Dépendances à jour et" : "Nouveau"} déploiement du traitement Node vérifié ; les résultats métier restent à contrôler.`;
  if (result.managedNode?.updatePending) return unchanged ? "Dépendances validées avec le runtime Vercel mesuré ; correctif Node en attente chez l’hébergeur." : "Dépendances déployées et validées avec le runtime Vercel mesuré ; correctif Node en attente chez l’hébergeur.";
  if (target.capability?.adapter === "node-static") return "Construction Node et publication du site statique vérifiées ; contrôle HTTPS réussi, sans runtime Node serveur revendiqué.";
  return unchanged ? "Node exact et dépendances déjà à jour ; déploiement et contrôle HTTPS vérifiés." : "Mise à jour déployée et contrôle HTTPS réussi.";
}
function failureStage(results: UpdateResult[], error: unknown): "attention" | "failed" {
  const unconfirmed = results.filter(result => result.stage !== "completed");
  const affected = unconfirmed.length ? unconfirmed : results;
  return affected.some(result => result.commit || result.deploymentId || result.backup) || (!(error instanceof ApiError && error.status === 409) && affected.some(result => ["publishing", "verifying", "attention"].includes(result.stage))) ? "attention" : "failed";
}
async function nodeGroup(run: UpdateRun, targets: UpdateTarget[], results: UpdateResult[], progress: Progress) {
  const representative = targets[0];
  if (representative.mode === "git" && new Set(targets.map(target => target.branch)).size !== 1) throw new ApiError("Ce dépôt est déployé depuis plusieurs branches. Séparez leurs mises à jour.");
  const latestLts = await latestNode();
  const runtimeChecks: (UpdateCheck | null)[] = [];
  const staticFrameworks = new Map<string, string>();
  const minimalStaticTargets = new Map<string, ReturnType<typeof minimalStaticProfile>>();
  const caddyDeployments = new Map<string, { current: string; commit: string | null; imageDigest: string | null }>();
  for (const [index, target] of targets.entries()) {
    results[index].previousDeploymentId = await providerPreflight(target, latestLts, undefined, evidence => {
      const current = railpackCaddyVersion(evidence);
      if (current && evidence && target.mode === "git") caddyDeployments.set(target.id, { current, commit: evidence.commit, imageDigest: normalizeImageDigest(evidence.imageDigest) });
    });
    await checkNodeEndpoint(target);
    if (workerTarget(target)) results[index].warnings.push("Traitement en arrière-plan : les tests isolés et le processus Node actif sont contrôlés. Aucun résultat de tâche, envoi externe ou parcours métier n’est certifié par la seule présence du processus.");
    if (vercelStaticTarget(target)) {
      if (!results[index].previousDeploymentId) throw new ApiError("Le déploiement statique actif doit être identifié avant la maintenance.", 422);
      const observed = await staticPreflight(target, { deploymentId: results[index].previousDeploymentId! });
      const framework = observed.framework || target.capability?.staticFramework;
      if (!framework || observed.framework && observed.framework !== target.capability?.staticFramework) throw new ApiError("Le framework statique du déploiement ne correspond plus aux sources qualifiées.", 422);
      staticFrameworks.set(target.id, framework);
      results[index].warnings.push("Site statique : Node sert à construire et valider les sources dans un conteneur isolé. La version du build distant Vercel n’est pas mesurée. Aucun serveur Node n’est revendiqué ; les parcours métier restent à tester.");
    }
    if (minimalStaticWitnessId(target) && results[index].previousDeploymentId && !caddyDeployments.has(target.id) && target.repository) {
      const { serviceInstance } = await readRailwayInstance(target);
      const active = serviceInstance.activeDeployments?.find((deployment: { id: string }) => deployment.id === results[index].previousDeploymentId);
      const commit = deploymentEvidence(active?.meta)?.commit;
      if (commit) {
        const path = target.root.split("/").map(encodeURIComponent).join("/") + "/Dockerfile";
        const file = await githubRequest(`/repos/${target.repository}/contents/${path}?ref=${commit}`, githubUpdateToken(target.repository)).catch(() => null);
        if (file?.type === "file" && file.encoding === "base64" && typeof file.content === "string" && minimalStaticBuildNode(Buffer.from(file.content, "base64").toString("utf8"))) {
          await activeMinimalStaticImage(target, active.id, commit);
          minimalStaticTargets.set(target.id, minimalStaticProfile(target));
        }
      }
    }
    const check = results[index].previousDeploymentId && !vercelStaticTarget(target) && !minimalStaticTargets.has(target.id) ? await preflightNodeRuntime(target, results[index].previousDeploymentId!, latestLts) : null;
    runtimeChecks.push(check);
    if (check) {
      results[index].checks ||= []; results[index].checks.push(check);
      await progress("checking", check.message);
      requireSecurityPass(check);
    }
  }
  const caddyRelease = caddyDeployments.size ? caddyCatalog().catch(() => null) : null;
  const plan = await nodeValidationPlan(targets, runtimeChecks, latestLts);
  const version = plan.version;
  for (const [index, target] of targets.entries()) {
    const managed = plan.managed.get(target.id);
    if (managed) { results[index].managedNode = managed; if (managed.updatePending || managed.migrationAvailable) results[index].warnings.push(managedNodeMessage(managed)); }
  }
  const temporary = await mkdtemp(join(tmpdir(), "vigie-update-"));
  try {
    const sourceFolder = join(temporary, "source"), archive = join(temporary, "source.zip");
    let expected = "";
    const original = representative.mode === "archive" ? await readUpdateSource(representative.id) : null;
    if (representative.mode === "git") {
      const ref = await githubRequest(`/repos/${representative.repository}/git/ref/heads/${encodeURIComponent(representative.branch!)}`, githubUpdateToken(representative.repository!));
      expected = z.string().regex(/^[a-f0-9]{40}$/).parse(ref.object.sha);
      await downloadGitArchive(representative.repository!, expected, archive);
    } else {
      if (!original?.settings.archive) throw new ApiError("Sources du projet manquantes.");
      if (original.settings.deploymentId !== (results[0].previousDeploymentId || null)) throw new ApiError("Ce service a été redéployé en dehors de Vigie. Réimportez ses sources actuelles avant de le mettre à jour.");
      await writeFile(archive, Buffer.from(original.settings.archive, "base64"));
    }
    const names = await extractArchive(archive, sourceFolder, representative.mode === "git");
    const staticProfiles = new Map<string, StaticProfile>();
    const initialManifests = new Map<string, Record<string, any>>();
    const staticBuilds = new Map<string, StaticBuild>();
    for (const target of targets) {
      const prefix = target.root ? target.root + "/" : "";
      const local = [...new Set(names.filter(name => name.startsWith(prefix)).map(name => name.slice(prefix.length).split("/")[0]))];
      const manifest = local.includes("package.json") ? JSON.parse(await readFile(join(sourceFolder, prefix + "package.json"), "utf8")) : undefined;
      if (manifest) initialManifests.set(target.id, structuredClone(manifest));
      const family = sourceFamily(local, manifest);
      if (vercelStaticTarget(target)) staticProfiles.set(target.id, await qualifyStaticSources(sourceFolder, target, names, staticFrameworks.get(target.id)!));
      if (family !== "node") throw new ApiError(`Les sources sélectionnées correspondent à ${family}. Aucun paquet n’est installé ni publié par le parcours Node ; un adaptateur dédié est nécessaire.`, 422);
      if (workerTarget(target) && typeof manifest?.scripts?.start !== "string") throw new ApiError("Le traitement en arrière-plan doit déclarer son script start pour qualifier son exécution.", 422);
    }
    if (names.some(name => /(^|\/)\.railway\//.test(name))) throw new ApiError("Retirez les fichiers locaux .railway des sources fournies.");
    if (representative.mode === "archive" && representative.provider === "railway" && names.some(name => /(^|\/)\.railwayignore$/.test(name))) throw new ApiError("La source Railway utilise un filtrage personnalisé des fichiers qui doit être vérifié avant l’envoi direct.");
    for (const name of names.filter(name => /(^|\/)(\.npmrc|\.yarnrc|\.yarnrc\.yml|pnpm-workspace\.yaml)$/.test(name))) {
      if (/(_auth\w*|npmAuthToken|npmAuthIdent|password|token)\s*[:=]/i.test(await readFile(join(sourceFolder, name), "utf8"))) throw new ApiError("Les sources contiennent des identifiants de registre. Utilisez un accès dédié avant l’automatisation.");
    }
    const before = await snapshotSources(sourceFolder, names);
    const roots = targets.map(target => target.root);
    const railpackCaddyPins = new Set<string>();
    const minimalStaticRoots = new Set<string>();
    for (const target of targets.filter(item => minimalStaticTargets.has(item.id))) {
      const prefix = target.root + "/";
      const recipe = names.includes(prefix + "Dockerfile") && await readFile(join(sourceFolder, prefix + "Dockerfile"), "utf8");
      if (!recipe || !minimalStaticBuildNode(recipe) || targets.some(item => item.id !== target.id && item.root === target.root)) {
        throw new ApiError("La recette Docker statique ou le périmètre des sources a changé.", 409);
      }
      minimalStaticRoots.add(target.root);
      railpackCaddyPins.add(prefix + "railpack.json");
    }
    const caddyCandidates = new Map<string, CaddyChange>();
    const caddyChanges = new Map<string, CaddyChange>();
    const caddyTested = new Map<string, CaddyFingerprint>();
    const caddyObserved = new Map<string, NonNullable<UpdateCheck["caddyEvidence"]>>();
    const debianPlans = new Map<string, { identity: RailpackImageIdentity; before: UpdateCheck; upgrades: Awaited<ReturnType<typeof planDebianFixes>> }>();
    if (caddyDeployments.size) {
      const release = await caddyRelease;
      for (const [index, target] of targets.entries()) {
        const deployed = caddyDeployments.get(target.id);
        if (!deployed) continue;
        const prefix = target.root ? target.root + "/" : "";
        if (deployed.commit !== expected || names.includes(prefix + "Dockerfile")) continue;
        try {
          const path = prefix + "railpack.json";
          const previous = names.includes(path) ? await readFile(join(sourceFolder, path), "utf8") : undefined;
          if (previous !== undefined && caddyPinVersion(previous) === deployed.current && targets.every(other => {
            if (other.root !== target.root) return !other.root.startsWith(prefix);
            const proof = caddyDeployments.get(other.id);
            return proof?.commit === expected && proof.current === deployed.current;
          })) railpackCaddyPins.add(path);
          const deploymentId = results[index].previousDeploymentId;
          if (deploymentId && deployed.imageDigest && (previous === undefined || railpackCaddyPins.has(path))) {
            const identity = { projectId: run.projectId, targetId: target.id, deploymentId, imageDigest: deployed.imageDigest, commit: expected, caddy: deployed.current };
            const inventory = await cachedRailpackInventory(identity);
            const { check: before } = await scanRailpackImage(target, identity, inventory);
            const upgrades = await planDebianFixes(before.findings);
            if (upgrades.length) {
              const change = { previous, current: deployed.current, version: deployed.current, debianPins: upgrades.map(item => `${item.package}=${item.to}`) };
              if (!validatedRailpackChange(change)) throw new ApiError("L’image active ne correspond pas aux versions Debian déjà demandées.", 422);
              debianPlans.set(target.id, { identity, before, upgrades });
              caddyCandidates.set(target.id, change);
              if (release && caddyVersionChange(deployed.current, release.version, previous)) results[index].warnings.push("La mise à jour Caddy sera évaluée séparément des correctifs Debian.");
              continue;
            }
          }
          if (!release) { results[index].warnings.push("Catalogue Caddy indisponible ; recherche de version reportée."); continue; }
          const change = caddyVersionChange(deployed.current, release.version, previous);
          if (change) caddyCandidates.set(target.id, change);
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          results[index].warnings.push(error.message);
        }
      }
      const unqualifiedRoots = new Set(targets.flatMap(target => {
        const candidate = caddyCandidates.get(target.id);
        return candidate && targets.some(other => other.root === target.root && JSON.stringify(caddyCandidates.get(other.id)) !== JSON.stringify(candidate)) ? [target.root] : [];
      }));
      for (const [index, target] of targets.entries()) {
        if (unqualifiedRoots.has(target.root) && caddyCandidates.delete(target.id)) {
          debianPlans.delete(target.id);
          results[index].warnings.push("Caddy : le même répertoire alimente un autre service sans candidate commune qualifiée.");
        }
      }
    }
    const catalogs = nodeCatalogState(fetch, Date.parse(run.purpose === "assessment" ? run.startedAt || run.createdAt : run.createdAt));
    const policyHash = await nodePolicyHash();
    const key = { sourceHash: nodeSourceHash(before), targetsHash: nodeTargetsHash(targets, minimalStaticTargets), policyHash, nodeVersion: version };
    await progress("checking", "Recherche d’une validation récente de la configuration actuelle.");
    const previous = run.purpose === "assessment" || caddyCandidates.size ? [] : await nodeRunsWithReceipts(run.projectId, [key.sourceHash, key.targetsHash, key.policyHash]);
    let receipt = previous.flatMap(prior => (prior.nodeReceipts || []).flatMap(raw => {
      const saved = reusableNodeReceipt(raw, key);
      return saved && nodeReceiptGroupCompleted(saved, prior.results || []) ? [saved] : [];
    })).at(0) ?? null;
    if (receipt) {
      try {
        for (const [index, target] of targets.entries()) {
          const proof = receipt.deployments.find(item => item.targetId === target.id);
          if (target.provider !== "railway" || !proof || proof.deploymentId !== results[index].previousDeploymentId) { receipt = null; break; }
          const minimal = minimalStaticTargets.has(target.id);
          if (minimal !== (proof.source === "railway-static")) { receipt = null; break; }
          const image = minimal ? await activeMinimalStaticImage(target, proof.deploymentId, expected)
            : activeNodeImage(target, { deploymentId: proof.deploymentId, commit: expected || undefined }, version, (await readRailwayInstance(target)).serviceInstance.activeDeployments || []);
          if (image.imageDigest !== proof.imageDigest) { receipt = null; break; }
        }
        if (receipt && !await unchangedNodeInputs(receipt)) receipt = null;
      } catch { receipt = null; }
    }
    let collectCatalogs = !receipt;
    const currentPackages = new Set<string>();
    const scanWithInventory: typeof scanNodeSources = (folder, selected, files) => scanNodeSources(folder, selected, files, runCommand, async names => {
      for (const name of names) currentPackages.add(name);
      if (collectCatalogs) await catalogs.packages(names);
    });
    const nodeScan = createNodeScanCache(sourceFolder, roots, scanWithInventory);
    const trivyCache = join(temporary, "trivy-cache");
    await mkdir(trivyCache, { mode: 0o700 });
    let imageScans = Promise.resolve();
    function scanImage(image: string, baseline = false) {
      const pending = imageScans.then(() => scanDockerImage(image, undefined, baseline, trivyCache));
      // Trivy's shared cache is exclusive; serialize scanners, not service builds.
      imageScans = pending.then(() => {}, () => {});
      return pending;
    }
    async function record(check: UpdateCheck, selected = results) {
      for (const result of selected) { result.checks ||= []; result.checks.push(check); }
      await progress(check.phase === "after" ? "verifying" : "updating", `${check.tool} : ${check.phase === "before" ? "analyse de la version actuelle" : check.phase === "after" ? "contrôle de l’image déployée" : "contrôle de la version candidate"}.`);
      requireSecurityPass(check);
    }
    async function recordOsv(phase: "before" | "candidate", scope: string, scan: Awaited<ReturnType<typeof nodeScan>>, selectedRoots = roots, workingFolder = sourceFolder, policy = npmPolicy) {
      const checkFindings = (label: string, findings: SecurityFinding[]) => phase === "before"
        ? securityCheck("OSV", phase, label, findings)
        : policy.check(workingFolder, label, findings);
      for (const [index, target] of targets.entries()) {
        if (!selectedRoots.includes(target.root)) continue;
        const findings = scan.findings.filter(finding => finding.scope === target.root);
        const check = await checkFindings(`${scope} · ${target.root || "racine"}`, findings);
        check.checkedAt = scan.checkedAt;
        if (scan.reused.includes(target.root)) check.message += " Verrou inchangé : analyse de cette exécution réutilisée (moins de cinq minutes).";
        const result = results[index];
        result.checks ||= [];
        result.checks.push(check);
      }
      await progress("updating", `OSV : ${phase === "before" ? "analyse de la version actuelle" : "contrôle de la version candidate"}.`);
      // The resolver needs all affected roots to search for compatible fixes.
      requireSecurityPass(await checkFindings(scope, scan.findings));
    }
    await progress("checking", "Analyse de sécurité des dépendances actuelles.");
    const baselineScan = await nodeScan(names);
    const baseline = baselineScan.findings;
    const scopedBaseline = await Promise.all(targets.map(async (target, index) => {
      const deploymentId = results[index].previousDeploymentId;
      if (target.mode !== "git" || !expected || !deploymentId || !baseline.some(finding => finding.scope === target.root)) return false;
      try {
        if (target.provider === "vercel") {
          const deployment = await vercelUpdateRequest(target, `/v13/deployments/${deploymentId}`);
          return deployment.id === deploymentId && deployment.projectId === target.remoteId && deployment.target === "production" &&
            deployment.readyState === "READY" && deployment.meta?.githubCommitSha === expected;
        }
        if (target.provider !== "railway") return false;
        if (minimalStaticTargets.has(target.id)) {
          await activeMinimalStaticImage(target, deploymentId, expected);
          return true;
        }
        const instance = (await readRailwayInstance(target)).serviceInstance;
        activeNodeImage(target, { deploymentId, commit: expected }, version, instance.activeDeployments || []);
        return true;
      } catch { return false; }
    }));
    const qualifiedBaseline = baseline.filter(finding => {
      const matches = targets.flatMap((target, index) => target.root === finding.scope ? [scopedBaseline[index]] : []);
      return matches.length > 0 && matches.every(Boolean);
    });
    const npmPolicy = await npmResidualPolicy(sourceFolder, names, qualifiedBaseline);
    await recordOsv("before", "Dépendances verrouillées", baselineScan);
    const imageBaselines = new Map<string, SecurityFinding[]>();
    const imageSecurity = new Map<string, string>();
    const imageReferences = new Map<string, DockerNodeBase[] | null>();
    for (const root of [...new Set(roots)]) {
      const dockerfile = (root ? root + "/" : "") + "Dockerfile";
      if (!names.includes(dockerfile) || minimalStaticRoots.has(root)) continue;
      const image = dockerRuntimeBase(await readFile(join(sourceFolder, dockerfile), "utf8"));
      const findings = (await scanImage(image, true)).map(entry => ({ ...entry, scope: root }));
      imageBaselines.set(root, findings);
      await record(securityCheck("Trivy", "before", `Image de base actuelle ${image} (hors code applicatif)`, findings), results.filter((_, index) => targets[index].root === root));
    }
    // A receipt replaces only version research and the prior exact-input script
    // validation. Security scans, image start/Node probes and production evidence
    // are always fresh, and any drift returns to the full solver.
    if (receipt && nodeSecurityHash(baseline) === receipt.securityHash) {
      await progress("checking", "Configuration inchangée : contrôle frais de sécurité et des images avant réutilisation de la validation.");
      const reference = receipt;
      const receiptPolicy = await npmResidualPolicy(sourceFolder, names, qualifiedBaseline);
      const currentImages = new Map<string, SecurityFinding[]>();
      let freshScan: Awaited<ReturnType<typeof nodeScan>> | undefined;
      const current = await checkCurrentNodeConfiguration(receipt, {
        baseline,
        images: async () => {
          await receiptPolicy.retain(sourceFolder, reference.npmRetained || []);
          requireSecurityPass(await receiptPolicy.check(sourceFolder, "Configuration déjà validée", baseline));
          for (const root of [...new Set(roots)]) {
            const file = (root ? root + "/" : "") + "Dockerfile";
            if (!names.includes(file) || minimalStaticRoots.has(root)) continue;
            await validateDockerfileCandidate(sourceFolder, root, names, version, async (image, bases) => {
              if (!bases?.every(base => reference.images.some(item => item.image === base.image && item.digest === base.digest))) throw new ApiError("Les images de base du Dockerfile ont changé.");
              currentImages.set(root, (await scanImage(image)).map(entry => ({ ...entry, scope: root })));
            });
            if (nodeSecurityHash(currentImages.get(root)!) !== reference.imageSecurity.find(item => item.root === root)?.hash) return false;
          }
          return true;
        },
        finalScan: async () => {
          freshScan = await nodeScan(names, true);
          return freshScan.findings;
        },
        sources: async () => { await changedSources(sourceFolder, before, new Set()); },
        catalogs: () => unchangedNodeInputs(reference),
      });
      if (current && freshScan) {
        const currentTargets = await updateTargets(run.projectId);
        if (targets.some(target => JSON.stringify(currentTargets.find(item => item.id === target.id)) !== JSON.stringify(target))) throw new ApiError("La configuration du projet a changé pendant la vérification. Validation annulée.");
        if (representative.mode === "git") {
          const head = await githubRequest(`/repos/${representative.repository}/git/ref/heads/${encodeURIComponent(representative.branch!)}`, githubUpdateToken(representative.repository!));
          if (head.object.sha !== expected) throw new ApiError("Le dépôt a changé pendant la vérification. La validation précédente ne peut pas être réutilisée.", 409);
        } else if ((await readUpdateSource(representative.id))?.revision !== original!.revision) throw new ApiError("Les sources ont changé pendant la vérification. Validation annulée.", 409);
        await recordOsv("candidate", "Contrôle final frais de la configuration actuelle", freshScan, roots, sourceFolder, receiptPolicy);
        for (const [root, findings] of currentImages) {
          await record(securityCheck("Trivy", "candidate", `Image Docker actuelle : ${root || "racine"}`, findings), results.filter((_, index) => targets[index].root === root));
        }
        await verifyNodeServices(results, async index => {
          const target = targets[index], result = results[index];
          await verifyNode(index, result.previousDeploymentId!);
          const proof = result.checks?.findLast(check => check.tool === "Node" && check.phase === "after")?.nodeEvidence;
          if (!sameNodeReceiptProof(reference, target.id, proof)) throw new ApiError("L’image active ou le type de preuve Node a changé pendant la vérification. Validation non réutilisable.", 422);
          await checkNodeEndpoint(target);
          const validation = reference.validations.find(item => item.targetId === target.id)!;
          result.checks!.push({ tool: "Validation", phase: "candidate", checkedAt: validation.checkedAt, scope: validation.scope, status: validation.status, findings: [], message: `Validation du ${validation.checkedAt} réutilisée pour les mêmes sources, catalogues et environnement ; scripts non réexécutés. ${validation.message}` });
          result.warnings = [...new Set([...result.warnings, ...(reference.warnings.find(item => item.targetId === target.id)?.messages || [])])];
          result.stage = "completed";
          result.message = nodeCompletionMessage(target, result, true);
        });
        run.nodeReceipts ||= [];
        run.nodeReceipts.push(reference); // Keep the original heavy-validation age.
        return;
      }
    }
    collectCatalogs = true;
    await catalogs.packages([...currentPackages]);
    await progress("updating", "Analyse complète nécessaire : actualisation de Node et des dépendances, puis validation isolée.");
    let runtimeRefreshed = false;
    const alpineRepairs = new Map<string, AlpineRepair>();
    const runtime = nodeValidationRuntime(version, async (command, args, options) => {
      if (!runtimeRefreshed) { await runCommand("docker", ["pull", `node:${version}-bookworm`], { timeout: 5 * 60_000 }); runtimeRefreshed = true; }
      return runCommand(command, args, options);
    });
    function serviceChecks(workingFolder: string, selectedRoots: string[]): NodeUpdateChecks {
      const scanSources = createNodeScanCache(workingFolder, selectedRoots, scanWithInventory);
      const selectedResults = results.filter((_, index) => selectedRoots.includes(targets[index].root));
      return {
      baseline,
      railpackCaddyPins,
      minimalStaticRoots,
      retain: (findings, scanned) => npmPolicy.retain(workingFolder, findings, scanned),
      alpineRepaired: (root, repair) => { alpineRepairs.set(root ? `${root}/Dockerfile` : "Dockerfile", repair); },
      resolved: async resolvedNames => {
        await recordOsv("candidate", "Dépendances verrouillées", await scanSources(resolvedNames), selectedRoots, workingFolder);
      },
      image: async (root, image, bases) => {
        const findings = (await scanImage(image)).map(entry => ({ ...entry, scope: root }));
        await record(securityCheck("Trivy", "candidate", `Image Docker finale : ${root || "racine"}`, findings, [...baseline, ...(imageBaselines.get(root) || [])]), results.filter((_, index) => targets[index].root === root));
        imageSecurity.set(root, nodeSecurityHash(findings));
        imageReferences.set(root, bases);
      },
      reused: message => progress("updating", message),
      validated: async (root, scripts) => {
        const browser = scripts.includes("test:e2e"), tests = scripts.some(name => name === "test" || name === "test:integration");
        await record({ tool: "Validation", phase: "candidate", scope: root || "racine", checkedAt: new Date().toISOString(), status: browser && tests ? "passed" : "warning", message: `Scripts réussis : ${scripts.join(", ")}. ${!browser ? "Aucun parcours navigateur test:e2e déclaré : les parcours métier ne sont pas certifiés." : "Le périmètre navigateur dépend des assertions du projet."} ${!tests ? "Aucun test unitaire ou d’intégration déclaré." : ""}`, findings: [] }, results.filter((_, index) => targets[index].root === root));
      },
      remediating: async message => {
        for (const result of selectedResults) result.warnings.push(message);
        await progress("updating", message);
      },
      };
    }
    const preparationStarted = performance.now();
    let prepared: Awaited<ReturnType<typeof prepareNodeServices>>;
    try {
      prepared = await prepareNodeServices(sourceFolder, roots, names, version, serviceChecks, {
        transport: catalogs.transport,
        runtime,
        dockerRoots: targets.filter(target => target.builder === "DOCKERFILE").map(target => target.root),
        onPreparationFailure: run.purpose === "assessment" ? async root => {
          await progress("updating", `${root || "racine"} : préparation interrompue. Poursuite des vérifications des autres services.`);
        } : undefined,
        progress: async (root, phase) => {
          const message = { preparing: "Préparation des versions", prepared: "Versions préparées ; attente du contrôle de l’ensemble", validating: "Validation des versions assemblées", ready: "Proposition validée ; attente de publication" }[phase];
          for (const [index, target] of targets.entries()) if (target.root === root) {
            results[index].stage = "updating";
            results[index].message = message;
          }
          await progress("updating", `${root || "racine"} : ${message}.`);
        },
      });
      const buildNames = [...new Set([...names, ...prepared.allowed])];
      for (const target of targets) if (vercelStaticTarget(target)) {
        await progress("updating", `${target.name} : reconstruction statique isolée des versions finales et contrôle des fichiers produits.`);
        staticBuilds.set(target.id, await buildStaticCandidate(sourceFolder, target, buildNames, staticProfiles.get(target.id)!, version, serviceChecks, runtime));
      }
    } finally { await runtime.dispose?.(); }
    const preparationMs = Math.round(performance.now() - preparationStarted);
    for (const [index, target] of targets.entries()) {
      const timing = "services" in prepared ? prepared.services.find(service => service.root === target.root) : null;
      const validation = results[index].checks?.findLast(check => check.tool === "Validation" && check.phase === "candidate");
      if (validation) validation.message += timing
        ? ` Durées du service : préparation ${Math.round(timing.prepareMs / 1000)} s ; validation assemblée ${Math.round(timing.validateMs / 1000)} s. Préparation et validation de tous les services : ${Math.round(preparationMs / 1000)} s écoulées (tâches parallèles).`
        : ` Préparation et validation : ${Math.round(preparationMs / 1000)} s.`;
    }
    for (const target of targets) {
      const candidate = caddyCandidates.get(target.id);
      if (!candidate) continue;
      const path = (target.root ? target.root + "/" : "") + "railpack.json";
      if (caddyChanges.has(path)) continue;
      const started = performance.now();
      const cacheKey = randomUUID();
      const selected = results.filter((_, i) => targets[i].root === target.root);
      const debian = debianPlans.get(target.id);
      await progress("updating", `${target.name} : construction de l’image Railpack candidate ${debian ? "avec les correctifs Debian" : `pour Caddy ${candidate.version}`}.`);
      const buildNames = [...new Set([...names, ...prepared.allowed])];
      let findings: SecurityFinding[] = [], previous: SecurityFinding[] = [];
      const tested = await validateRailpackCaddy(sourceFolder, target.root, buildNames, candidate.version, async image => {
        findings = (await scanImage(image)).map(finding => ({ ...finding, scope: target.root }));
      }, cacheKey, candidate.previous, candidate.debianPins);
      if (debian) {
        previous = debian.before.findings;
        for (const [i, service] of targets.entries()) if (service.root === target.root) {
          const plan = debianPlans.get(service.id)!;
          const active = await verifyRailwayCaddy(service, { deploymentId: plan.identity.deploymentId, commit: expected }, version, candidate.current);
          const proof = active.caddyEvidence!;
          if (proof.imageDigest !== plan.identity.imageDigest || tested.binaryHash !== proof.binaryHash ||
            JSON.stringify(plan.before.findings) !== JSON.stringify(previous)) throw new ApiError("L’image active ou le binaire Caddy ne correspond plus à la référence du correctif Debian.", 422);
          caddyObserved.set(service.id, proof);
          await record({ ...active, phase: "before" }, [results[i]]);
        }
        await record(debian.before, selected);
        verifyDebianFixes(previous, findings, debian.upgrades);
      } else if (findings.length) {
        await progress("updating", `${target.name} : comparaison Trivy avec l’image Caddy ${candidate.current} active.`);
        const baseline = await validateRailpackCaddy(sourceFolder, target.root, buildNames, candidate.current, async image => {
          previous = (await scanImage(image)).map(finding => ({ ...finding, scope: target.root }));
        }, cacheKey, candidate.previous);
        for (const [i, service] of targets.entries()) if (service.root === target.root) {
          const active = await verifyRailwayCaddy(service, { deploymentId: results[i].previousDeploymentId!, commit: expected }, version, caddyCandidates.get(service.id)!.current);
          const proof = active.caddyEvidence!;
          if (baseline.packagesHash !== proof.packagesHash || baseline.binaryHash !== proof.binaryHash || tested.packagesHash !== proof.packagesHash) {
            throw new ApiError("Les paquets Debian ou le binaire de référence diffèrent de l’image active. Les alertes Caddy ne peuvent pas être comparées avec certitude.", 422);
          }
          caddyObserved.set(service.id, proof);
          await record({ ...active, phase: "before" }, [results[i]]);
        }
        await record(securityCheck("Trivy", "before", `Image active Caddy ${candidate.current} reproduite`, previous), selected);
      }
      await record(caddyImageSecurity(debian ? "Image Railpack candidate avec correctifs Debian" : `Image Railpack Caddy ${candidate.version}`, previous, findings, debian?.upgrades), selected);
      await writeFile(join(sourceFolder, path), caddyConfig(candidate));
      prepared.allowed.add(path);
      caddyChanges.set(path, candidate);
      caddyTested.set(target.root, tested);
      await record({ tool: "Caddy", phase: "candidate", scope: target.root, status: "passed", checkedAt: new Date().toISOString(), findings: [],
        message: `${debian ? "Correctifs Debian " + candidate.debianPins!.join(", ") : `Caddy ${candidate.current} → ${candidate.version}`} : plan Railpack, image, scan Trivy et démarrage HTTP validés en ${Math.round(performance.now() - started)} ms.`,
      }, selected);
    }
    const staticRecipes = new Map<string, string>();
    for (const root of minimalStaticRoots) {
      const path = root + "/Dockerfile";
      const pins = minimalStaticPins(await readFile(join(sourceFolder, path), "utf8"));
      if (!pins) throw new ApiError("Recette minimale inconnue après les tests.", 422);
      if (pins.node === version) continue;
      const recipe = minimalStaticRecipe(version, await officialNodeImageDigest(`node:${version}-bookworm-slim`), pins.caddy, pins.buildArguments);
      await writeFile(join(sourceFolder, path), recipe);
      prepared.allowed.add(path);
      staticRecipes.set(path, recipe);
    }
    const changes = await changedSources(sourceFolder, before, prepared.allowed);
    const finalScan = await nodeScan([...new Set([...names, ...prepared.allowed])], true);
    await recordOsv("candidate", "Contrôle final frais avant publication", finalScan);
    requireZeroFinalFindings(results);
    for (const [index, result] of results.entries()) {
      const warnings = "services" in prepared ? prepared.services.find(service => service.root === targets[index].root)?.warnings || [] : prepared.warnings;
      result.warnings = [...new Set([...result.warnings, ...warnings])];
    }
    for (const [index, target] of targets.entries()) if (!caddyCandidates.has(target.id) && !imageBaselines.has(target.root) && !vercelStaticTarget(target) && !minimalStaticTargets.has(target.id)) results[index].warnings.push("Image finale gérée par l’hébergeur : son système n’est pas analysé par Trivy dans ce parcours.");
    if (run.purpose === "assessment") {
      if (changes.length) await assertSourceImpact(targets, changes.map(file => file.path));
      await refreshProjectHosting(run.projectId);
      const current = await updateTargets(run.projectId);
      if (targets.some(target => JSON.stringify(current.find(item => item.id === target.id)) !== JSON.stringify(target))) throw new ApiError("La configuration a changé pendant le bilan ; une nouvelle vérification est nécessaire.", 409);
      if (representative.mode === "git") {
        const head = await githubRequest(`/repos/${representative.repository}/git/ref/heads/${encodeURIComponent(representative.branch!)}`, githubUpdateToken(representative.repository!));
        if (head.object.sha !== expected) throw new ApiError("Les sources ont changé pendant le bilan ; proposition invalidée.", 409);
      } else if ((await readUpdateSource(representative.id))?.revision !== original!.revision) throw new ApiError("Les sources conservées ont changé pendant le bilan.", 409);
      for (const [index, target] of targets.entries()) {
        if (await providerPreflight(target, version) !== results[index].previousDeploymentId) throw new ApiError("Le déploiement a changé pendant le bilan ; proposition invalidée.", 409);
        const manifest = JSON.parse(await readFile(join(sourceFolder, target.root, "package.json"), "utf8"));
        finishAssessment(results[index], nodeAssessmentChanges(target, initialManifests.get(target.id)!, manifest, changes.map(file => file.path)), "Tests isolés des scripts disponibles ; les parcours métier et le déploiement de la candidate restent à vérifier lors de l’installation.");
        if (expected) results[index].assessment!.sourceCommit = expected;
      }
      return; // Publication, snapshots and production checks are unreachable.
    }
    async function verifyNode(index: number, deploymentId: string) {
      const result = results[index];
      if (vercelStaticTarget(targets[index])) {
        try {
          const check = await verifyStaticDeployment(targets[index], { deploymentId, commit: result.commit || expected || undefined }, staticBuilds.get(targets[index].id)!);
          result.checks ||= []; result.checks.push(check);
          await progress("verifying", check.message);
        } catch (error) {
          const check: UpdateCheck = { tool: "Static", phase: "after", scope: targets[index].root || "racine", checkedAt: new Date().toISOString(), status: "blocked", message: error instanceof Error ? error.message : "Publication statique non confirmée.", findings: [] };
          result.checks ||= []; result.checks.push(check);
          await progress("verifying", check.message);
          throw error;
        }
        return;
      }
      if (minimalStaticTargets.has(targets[index].id)) {
        const target = targets[index], commit = result.commit || expected;
        const buildNode = minimalStaticBuildNode(await readFile(join(sourceFolder, target.root, "Dockerfile"), "utf8"));
        if (buildNode !== version) throw new ApiError("La version Node du Dockerfile statique diffère de celle des tests.", 422);
        const image = await activeMinimalStaticImage(target, deploymentId, commit);
        const scan = await scanMinimalStaticImage(target, deploymentId);
        const check = securityCheck("Trivy", "after", "Image statique minimale sur Railway", scan.findings);
        await checkPublicMinimalStatic(target, minimalStaticTargets.get(target.id));
        const current = await activeMinimalStaticImage(target, deploymentId, commit);
        if (current.imageDigest !== image.imageDigest) throw new ApiError("L’image active a changé pendant les contrôles.", 409);
        await saveMinimalStaticScan(image, check);
        await record(check, [result]);
        await record({
          tool: "Node", phase: "after", scope: target.root, status: "passed", findings: [], checkedAt: check.checkedAt,
          message: `Node ${buildNode} épinglé dans la recette du déploiement actif pour la construction du site.`,
          nodeEvidence: { version: buildNode, deploymentId, imageDigest: image.imageDigest, commit, source: "railway-static", usage: "build" },
        }, [result]);
        return;
      }
      await confirmDeployedNode(targets[index], result, { deploymentId, commit: result.commit || expected || undefined }, version, progress);
    }
    async function rememberValidation() {
      try {
        const catalogEntries = await catalogs.snapshot();
        const validationImage = await runtime.image();
        const validationBase = await nodeImageReceipt(`node:${version}-bookworm`, validationImage);
        if (!catalogEntries || !validationBase || [...imageReferences.values()].some(value => !value)) return;
        const images = [...new Map([validationBase, ...[...imageReferences.values()].flatMap(value => value || [])].map(image => [image.image, image])).values()];
        const deployments = targets.flatMap((target, index) => {
          const proof = results[index].checks?.findLast(check => check.tool === "Node" && check.phase === "after" && check.status === "passed")?.nodeEvidence;
          return proof && proof.source !== "vercel-function" && proof.imageDigest ? [{ targetId: target.id, deploymentId: proof.deploymentId, imageDigest: proof.imageDigest, source: proof.source, usage: proof.usage }] : [];
        });
        const validations = nodeReceiptValidations(targets, results.map(result => result.checks));
        if (deployments.length !== targets.length || validations.length !== targets.length) return;
        const saved = nodeReceiptDraft({ ...key, sourceHash: nodeSourceHash(await snapshotSources(sourceFolder, [...new Set([...names, ...changes.map(file => file.path)])])) }, catalogEntries, {
          validatedAt: new Date(Math.min(...validations.map(item => Date.parse(item.checkedAt)))).toISOString(), images, validationImage, deployments, validations,
          securityHash: nodeSecurityHash(finalScan.findings),
          npmRetained: results.flatMap(remainingNpmFindings).flatMap(finding => finding.scope !== undefined && finding.explanation ? [{ ...finding, scope: finding.scope, explanation: finding.explanation }] : []),
          imageSecurity: [...imageSecurity].map(([root, hash]) => ({ root, hash })),
          warnings: results.map(result => ({ targetId: result.targetId, messages: result.warnings })),
        });
        if (!saved || !await unchangedNodeImages(saved)) return;
        run.nodeReceipts ||= [];
        run.nodeReceipts.push(saved);
      } catch { /* Optional optimization: an unavailable catalog never blesses a receipt. */ }
    }
    if (!changes.length) {
      await verifyNodeServices(results, async index => {
        const result = results[index];
        result.stage = "verifying";
        if (!result.previousDeploymentId) throw new ApiError("Aucun déploiement actif ne permet de vérifier la version Node exacte.");
        await verifyNode(index, result.previousDeploymentId);
        await checkNodeEndpoint(targets[index]);
        result.stage = "completed";
        result.message = nodeCompletionMessage(targets[index], result, true);
      });
      await rememberValidation();
      return;
    }
    await assertSourceImpact(targets, changes.map(file => file.path));
    await refreshProjectHosting(run.projectId);
    const currentTargets = await updateTargets(run.projectId);
    for (const [index, target] of targets.entries()) {
      const current = currentTargets.find(item => item.id === target.id);
      if (!current || current.unavailable || JSON.stringify(current) !== JSON.stringify(target)) throw new ApiError("La configuration du projet a changé pendant les tests. Publication annulée.");
      const caddy = caddyCandidates.get(target.id);
      let observedCaddy: string | undefined, observedImage: string | null | undefined;
      const currentDeployment = await providerPreflight(target, version, undefined, evidence => {
        observedCaddy = railpackCaddyVersion(evidence);
        observedImage = evidence?.imageDigest;
      });
      if (currentDeployment !== results[index].previousDeploymentId) throw new ApiError("Un autre déploiement a eu lieu pendant les tests. Publication annulée pour ne pas l’écraser.");
      if (caddy) {
        if (!currentDeployment || observedCaddy !== caddy.current) throw new ApiError("La construction Railpack a changé pendant les tests. Publication Caddy annulée.", 409);
        const proof = caddyObserved.get(target.id);
        if (proof && proof.imageDigest !== observedImage) throw new ApiError("L’image Caddy active a changé pendant les contrôles.", 409);
        if (!proof) await verifyRailwayCaddy(target, { deploymentId: currentDeployment, commit: expected }, version, caddy.current);
      }
      if (vercelStaticTarget(target)) {
        const observed = await staticPreflight(target, { deploymentId: currentDeployment! });
        if ((observed.framework || target.capability?.staticFramework) !== staticFrameworks.get(target.id)) throw new ApiError("Le framework Vercel a changé pendant la validation ; publication annulée.", 409);
      } else if (target.provider === "vercel") {
        const runtime = await preflightNodeRuntime(target, currentDeployment!, latestLts);
        if (!runtime || runtime.status !== "passed" || runtime.nodeEvidence?.version !== version) throw new ApiError("Le runtime Vercel a changé pendant les validations. Relancez pour tester sa nouvelle version ; aucun changement publié.", 409);
      }
    }
    await progress("publishing", "Vérifications réussies. Publication de la nouvelle version.");
    for (const result of results) result.stage = "publishing";
    await progress("publishing", "Publication de la nouvelle version.");
    if (representative.mode === "git") {
      for (const result of results) result.previousCommit = expected;
      const commit = await publishGitVersions(representative.repository!, representative.branch!, expected, changes, fetch, alpineRepairs, caddyChanges, staticRecipes);
      for (const result of results) result.commit = commit;
    } else {
      const packed = join(temporary, "updated.zip"), clean = join(temporary, "deploy");
      const updatedNames = [...new Set([...names, ...changes.map(file => file.path)])];
      await runCommand("python3", [archiveScript, "pack", packed, sourceFolder], { input: JSON.stringify(updatedNames) });
      const content = await readFile(packed);
      if (content.length > 2_000_000) throw new ApiError("Les sources actualisées dépassent la limite de conservation de 2 Mo.");
      await saveUpdateSnapshot(run.id, representative.id, { original: original!.settings, updatedArchive: content.toString("base64") });
      await mkdir(clean);
      await extractArchive(packed, clean);
      const deploymentId = representative.provider === "vercel" ? await deployVercelArchive(representative, clean, updatedNames, version, run.id) : await deployRailwayArchive(representative, clean, run.id);
      results[0].deploymentId = deploymentId;
      await transaction(async () => {
        const current = await readUpdateSource(representative.id);
        if (current?.revision !== original!.revision) throw new ApiError("Les sources ont changé pendant la publication. Leur sauvegarde a été conservée.", 409);
        await writeUpdateSource(representative.id, run.projectId, { ...original!.settings, archive: content.toString("base64"), deploymentId });
      });
    }
    await verifyNodeServices(results, async index => {
      const target = targets[index];
      const result = results[index];
      result.stage = "verifying";
      await progress("verifying", workerTarget(target) ? "Attente du déploiement et contrôle du processus Node." : "Attente du déploiement et contrôle du site.");
      await waitForDeployment(target, { commit: result.commit, deploymentId: result.deploymentId, runId: run.id, previousDeploymentId: result.previousDeploymentId }, async id => {
        result.deploymentId = id;
        await progress("verifying", "Contrôle du déploiement en cours.");
      });
      if (!result.deploymentId) throw new ApiError("Déploiement introuvable pour vérifier la version Node exacte.");
      await verifyNode(index, result.deploymentId);
      const caddy = caddyCandidates.get(target.id);
      if (caddy) {
        const check = await verifyRailwayCaddy(target, { deploymentId: result.deploymentId, commit: result.commit }, version, caddy.version);
        const tested = caddyTested.get(target.root)!;
        if (check.caddyEvidence?.packagesHash !== tested.packagesHash || check.caddyEvidence.binaryHash !== tested.binaryHash) throw new ApiError("Le Caddy déployé ou ses paquets Debian diffèrent de l’image candidate testée.", 422);
        await record(check, [result]);
        const debian = debianPlans.get(target.id);
        if (debian) {
          const identity = { ...debian.identity, deploymentId: result.deploymentId, commit: result.commit!, imageDigest: check.caddyEvidence!.imageDigest };
          const { check: report } = await scanRailpackImage(target, identity);
          const fixed = verifyDebianFixes(debian.before.findings, report.findings, debian.upgrades);
          const assessment = caddyImageSecurity("Image Railpack déployée après correctifs Debian", debian.before.findings, report.findings, debian.upgrades);
          if (assessment.status !== "blocked") assessment.message = `${fixed} signalement(s) Debian ciblé(s) absent(s) du scan de l’image active. ${assessment.message}`;
          await record({ ...assessment, phase: "after", checkedAt: report.checkedAt }, [result]);
        }
      }
      await checkNodeEndpoint(target);
      result.stage = "completed";
      result.message = nodeCompletionMessage(target, result);
    });
    await rememberValidation();
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
async function wordpressTarget(run: UpdateRun, target: UpdateTarget, result: UpdateResult, progress: Progress) {
  await refreshWordPressWeb(target, "preflight");
  const fresh = (await hostingInstallation(target.remoteId)).inventory;
  if (!fresh || fresh.source !== "wordpress-observer" || fresh.collectionMode === "early" || !fresh.php || fresh.error || !fresh.observedAt || Date.now() - Date.parse(fresh.observedAt) > 5 * 60_000) throw new ApiError("Un relevé WordPress récent avec la version PHP web est nécessaire avant la mise à jour.");
  if (fresh.site?.multisite || fresh.configuration?.fileModsDisabled) throw new ApiError("La configuration WordPress actuelle ne permet pas cette mise à jour automatique.");
  if (fresh.plugins.some(plugin => plugin.mustUse)) result.warnings.push("Extensions MU présentes : elles ne sont ni mises à jour ni qualifiées automatiquement ; une recette spécifique reste nécessaire.");
  return executeLocalWordPress(run, target, result, fresh, progress);
}
export async function executeUpdate(id: string, executeGroup = nodeGroup, executeWordPress = wordpressTarget, afterComplete = refreshUpdateInventories, executeImage = executeRailwayImage, executeStatic = migrateMinimalStatic) {
  z.string().uuid().parse(id);
  const db = await updateStorage();
  const claim = await db.prepare("UPDATE update_runs SET stage='checking' WHERE id=? AND stage='queued'").run(id);
  if (!claim.changes) return false;
  const run = await readUpdateRun(id);
  if (!run) return false;
  run.stage = "checking";
  run.startedAt ||= new Date().toISOString();
  run.workflowRunId = process.env.GITHUB_RUN_ID;
  let writes = Promise.resolve();
  const trackProgress = createUpdateProgressTracker(run);
  const persist = () => {
    const write = writes.then(() => writeUpdateRun(run));
    // The caller still sees the error, but the heartbeat and final transaction can retry persistence.
    writes = write.catch(() => {});
    return write;
  };
  const progress: Progress = (stage, message) => { trackProgress(stage, message); return persist(); };
  const heartbeat = setInterval(() => { void persist().catch(() => {}); }, 30_000);
  try {
    await withAuditActor(run.actor, async () => {
      await progress("checking", "Vérification des accès et de la configuration du projet.");
      if (process.env.VIGIE_UPDATES_RUNNER_SETUP_OK !== undefined && process.env.VIGIE_UPDATES_RUNNER_SETUP_OK !== "true") throw new ApiError("L’installation vérifiée des outils de sécurité ou de déploiement a échoué. Aucun service n’a été modifié.", 503);
      const groups = new Map<string, UpdateTarget[]>();
      for (const target of run.targets) {
        const scope = executionGroup(target);
        groups.set(scope, [...groups.get(scope) || [], target]);
      }
      const failures: string[] = [];
      for (const targets of groups.values()) {
        const results: UpdateResult[] = targets.map(target => ({ targetId: target.id, name: target.name, stage: "checking" as UpdateStage, message: "Vérification en cours.", warnings: [] as string[] }));
        run.results.push(...results);
        try {
          const current = await updateTargets(run.projectId);
          for (const target of targets) {
            const next = current.find(item => item.id === target.id);
            if (!next || next.unavailable || JSON.stringify(next) !== JSON.stringify(target)) throw new ApiError("La configuration du service a changé. Rechargez sa fiche avant de relancer.", 409);
            const lock = await db.prepare("SELECT run_id FROM update_locks WHERE scope=?").get(updateScope(target)) as { run_id: string } | undefined;
            if (lock?.run_id !== id) throw new ApiError("Le verrou de mise à jour n’est plus détenu par ce traitement.", 409);
          }
          if (targets[0].mode === "wordpress") await executeWordPress(run, targets[0], results[0], progress);
          else if (targets[0].mode === "image") await executeImage(run, targets[0], results[0], progress);
          else {
            async function migrate(target: UpdateTarget, index: number) {
              if (run!.purpose) return false;
              const witnessId = minimalStaticWitnessId(target);
              const witness = witnessId && current.find(item => item.remoteId === witnessId && item.environmentId === target.environmentId);
              if (!witness) return false;
              const result = results[index];
              const previousCommit = result.commit;
              try {
                return await executeStatic(target, witness, result, async (repository, commit, archive, folder) => {
                  await downloadGitArchive(repository, commit, archive);
                  return extractArchive(archive, folder, true);
                }, progress);
              } catch (error) {
                if (result.commit !== previousCommit || result.stage === "attention" || result.stage === "publishing") throw error;
                const reason = error instanceof ApiError ? error.message : "La qualification de l’image statique a échoué.";
                result.warnings.push(`Parcours Caddy : ${reason}`);
                await progress("checking", `Parcours Caddy : ${reason}`);
                return false;
              }
            }
            // A single-service migration qualifies the exact deployed code. A
            // multi-service update first finishes its shared Git publication.
            if (targets.length !== 1 || !await migrate(targets[0], 0)) {
              try {
                await executeGroup(run, targets, results, progress);
              } catch (error) {
                // After a failed preparation, Caddy can still qualify the active commit.
                // A publication in an uncertain state must be resolved before another Git write.
                if (targets.length > 1 && failureStage(results, error) === "failed") {
                  for (const [index, target] of targets.entries()) if (await migrate(target, index)) {
                    results[index].warnings.push("La maintenance npm du groupe n’a pas abouti. L’image statique a été vérifiée séparément.");
                  }
                }
                throw error;
              }
              if (targets.length > 1) for (const [index, target] of targets.entries()) await migrate(target, index);
            }
          }
          if (run.purpose === "assessment") {
            if (results.some(result => !assessmentResultIsSafe(result))) throw new ApiError("Le bilan préalable n’a pas produit de proposition vérifiable sans installation.", 422);
            if (targets[0].mode === "image") for (const result of results) {
              const before = result.checks?.find(check => check.tool === "Trivy" && check.phase === "before");
              const candidate = result.checks?.findLast(check => check.tool === "Trivy" && check.phase === "candidate");
              if (!before || !candidate || candidate.scope !== result.imageUpdate?.candidate) throw new ApiError("Le bilan image n’est pas lié à l’empreinte candidate analysée.", 422);
              requireSecurityPass(imageSecurityCheck("candidate", candidate.scope, candidate.findings, before.findings));
            } else requireZeroFinalFindings(results);
          } else requireZeroFinalFindings(results);
          if (results.some(result => result.stage !== "completed")) throw new ApiError("Le résultat final du service n’est pas confirmé.", 502);
        } catch (error) {
          const stage = run.purpose === "assessment" ? "failed" : failureStage(results, error);
          const reason = error instanceof ApiError ? error.message : "Le traitement de ce groupe a échoué. Les informations de récupération sont conservées.";
          const blocked = error instanceof SecurityPolicyError && stage === "failed" ? results.filter(result => result.checks?.findLast(check => check.tool === error.check.tool)?.status === "blocked") : [];
          for (const [index, result] of results.entries()) {
            // Final security checks already mark the failing result. Earlier candidate refusals are history.
            if (result.stage === "completed") continue;
            result.stage = stage;
            if (error instanceof NodePreparationError) {
              const root = targets[index].root;
              const localFailure = error.failures.get(root);
              result.message = localFailure instanceof ApiError ? localFailure.message : error.failures.has(root)
                ? "La préparation de ce service a échoué."
                : "Contrôles isolés terminés. La validation de l’ensemble est bloquée par un autre service du dépôt.";
            } else result.message = blocked.length && !blocked.includes(result)
              ? `Validation du groupe arrêtée par un blocage de sécurité sur ${blocked.map(item => item.name).join(", ")}. Le résultat de ce service reste à confirmer.`
              : reason;
          }
          // A rejected final security guard also revokes a provisional success.
          if (results.every(result => result.stage === "completed")) for (const result of results) { result.stage = stage; result.message = reason; }
          failures.push(`${targets.map(target => target.name).join(", ")} : ${reason}`);
          await progress("checking", "Poursuite des autres groupes indépendants ; un résultat demande une intervention.");
        }
      }
      if (failures.length) {
        run.stage = run.results.some(result => result.stage === "attention") ? "attention" : "failed";
        run.message = `${run.results.filter(result => result.stage === "completed").length} service(s) terminé(s), ${run.results.filter(result => result.stage !== "completed").length} service(s) non confirmé(s). ${failures.join(" ")} Les groupes indépendants ont été traités ; le succès global n’est pas confirmé.`;
        if (run.purpose !== "assessment") await log("live", "updates.failed", run.message, run.projectId);
        return;
      }
      if (run.purpose === "assessment") {
        run.stage = "completed";
        run.message = "Bilan préalable terminé. Aucun composant installé ni déployé.";
        return;
      }
      requireZeroFinalFindings(run.results);
      run.stage = "completed";
      const manualCount = run.results.reduce((count, result) => count + (result.manualUpdates?.length || 0), 0);
      const wordpressNoChanges = run.results.length > 0 && run.results.every(result => result.wordpressNoChanges);
      run.message = wordpressNoChanges ? `Aucune mise à jour automatique applicable.${manualCount ? ` ${manualCount} composant(s) restent à traiter manuellement.` : ""}` : manualCount ? `Mises à jour automatiques terminées. ${manualCount} composant(s) restent à traiter manuellement ; consultez les interventions restantes.` : run.results.some(result => result.warnings.length || result.checks?.some(check => check.status === "warning")) ? "Mise à jour terminée avec réserves. Consultez les contrôles dans les détails." : "Mise à jour terminée et déploiement vérifié.";
      const pendingNodes = run.results.filter(result => result.managedNode?.updatePending).length;
      if (pendingNodes) run.message = `Maintenance des dépendances terminée avec réserves. ${pendingNodes} runtime(s) Node restent à actualiser chez Vercel.${manualCount ? ` ${manualCount} autre(s) composant(s) restent à traiter manuellement.` : ""} Le site n’est pas déclaré entièrement corrigé.`;
      const imageFindings = run.results.reduce((count, result) => count + (result.imageUpdate?.remainingFindings || 0), 0);
      if (imageFindings) run.message += ` ${imageFindings} signalement(s) non classé(s) déjà présents dans les images restent à qualifier ; ils restent visibles dans le compteur de sécurité.`;
      if (run.results.some(result => remainingNpmFindings(result).length)) run.message += " Des failles npm restent à corriger. Le motif est indiqué pour chaque service concerné.";
      if (run.excludedTargets?.length) run.message += ` ${run.excludedTargets.length} service(s) non sélectionné(s) restent à traiter séparément ; seuls les services sélectionnés sont couverts par ce résultat.`;
      await log("live", "updates.completed", run.message, run.projectId);
    });
  } catch (error) {
    const published = run.results.some(result => result.commit || result.deploymentId || result.backup) || (!(error instanceof ApiError && error.status === 409) && run.results.some(result => ["publishing", "verifying", "attention"].includes(result.stage)));
    run.stage = run.purpose === "assessment" ? "failed" : published ? "attention" : "failed";
    run.message = error instanceof ApiError ? error.message : "Une étape de mise à jour a échoué. Les informations de récupération sont conservées.";
    for (const result of run.results.filter(result => result.stage !== "completed" && result.stage !== "attention")) { result.stage = run.stage; result.message = run.message; }
    if (run.purpose !== "assessment") await withAuditActor(run.actor, () => log("live", "updates.failed", run.message, run.projectId));
  } finally {
    clearInterval(heartbeat);
    await writes;
    trackProgress(run.stage, run.message);
    await transaction(async () => {
      if (run.purpose === "assessment") await withAuditActor(run.actor, async () => {
        if (run.stage === "failed") {
          await log("live", "updates.assessment_failed", run.message, run.projectId);
        } else if (run.results.some(result => result.assessment?.changes.length)) {
          const row = await db.prepare("SELECT data FROM update_runs WHERE project_id=? AND stage='completed' AND json_extract(data,'$.purpose')='assessment' ORDER BY json_extract(data,'$.createdAt') DESC, id DESC LIMIT 1").get(run.projectId) as { data: string } | undefined;
          const previous = row ? JSON.parse(row.data) as UpdateRun : undefined;
          const previousChanges = new Map(previous?.results.map(result => [result.targetId, new Set(result.assessment?.changes)]));
          if (run.results.some(result => result.assessment?.changes.some(change => !previousChanges.get(result.targetId)?.has(change)))) {
            await log("live", "updates.assessment_changed", "Consultez le bilan dans la fiche du projet.", run.projectId);
          }
        }
      });
      await writeUpdateRun(run);
      if (run.stage !== "attention") await db.prepare("DELETE FROM update_locks WHERE run_id=?").run(id);
      else for (const scope of new Set(run.targets.map(updateScope))) {
        const affected = run.targets.filter(target => updateScope(target) === scope);
        if (!affected.some(target => run.results.some(result => result.targetId === target.id && result.stage === "attention"))) await db.prepare("DELETE FROM update_locks WHERE scope=? AND run_id=?").run(scope, id);
      }
    });
  }
  const observedTargets = run.purpose === "assessment" ? [] : run.targets.filter(target => run.results.some(result => result.targetId === target.id && (result.stage === "completed" || target.mode === "image" && result.stage === "attention")));
  if (observedTargets.length) {
    await afterComplete(observedTargets);
    const pending = await recordCompletedImageControls(run);
    if (pending.length) {
      for (const result of run.results.filter(result => pending.includes(result.targetId))) result.warnings.push("Le compteur de sécurité n’a pas pu être actualisé en fin de maintenance. L’ancien rapport reste historique ; un nouveau relevé est nécessaire.");
      run.message += " Actualisation du compteur de sécurité en attente de confirmation.";
      await writeUpdateRun(run);
    }
  }
  try { await recordAssessmentAfterUpdate(run); }
  catch { /* A failed observation never turns a completed installation into a claim of current versions. */ }
  return true;
}
async function refreshUpdateInventories(targets: UpdateTarget[]) {
  const refreshed = new Set<string>();
  for (const target of targets) {
    const key = target.provider === "o2switch" ? target.id : `${target.provider}:${target.connectionId}`;
    if (refreshed.has(key)) continue;
    refreshed.add(key);
    try {
      if (target.provider === "vercel") await synchronizeVercel(target.connectionId);
      else if (target.provider === "railway") await synchronizeRailway(target.connectionId);
      else await collectHostingInventories(target.connectionId, fetch, fetch, target.remoteId);
    } catch {}
  }
}
