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
import { githubRequest, githubUpdateToken, repositoryAllowed } from "./github";
import { changedSources, latestNode, nodeValidationRuntime, snapshotSources, type NodeUpdateChecks } from "./node";
import { prepareNodeServices } from "./node-services";
import { checkPublicSite, deployRailwayArchive, deployVercelArchive, providerPreflight, readRailwayInstance, waitForDeployment } from "./providers";
import { activeNodeImage, confirmDeployedNode, preflightNodeRuntime, verifyNodeServices } from "./node-deployment";
import { runCommand } from "./process";
import { completedNodeRuns, readUpdateRun, readUpdateSource, saveUpdateSnapshot, updateStorage, writeUpdateRun, writeUpdateSource } from "./storage";
import { updateScope, updateTargets } from "./targets";
import { withWordPressUpdater, wordpressBackupScript, wordpressUpdateScript } from "./wordpress";
import { executeLocalWordPress } from "./wordpress-agent-execution";
import type { UpdateRun, UpdateTarget, UpdateResult, UpdateStage, UpdateCheck, SecurityFinding } from "./types";
import { dockerNodeBases, dockerRuntimeBase, validateDockerfileCandidate, versionOnlyDockerfile } from "./dockerfile";
import { requireSecurityPass, requireZeroFinalFindings, scanDockerImage, scanNodeSources, createNodeScanCache, securityCheck } from "./security";
import { nodeCatalogState } from "./node-catalog-state";
import { checkCurrentNodeConfiguration, nodeImageReceipt, nodePolicyHash, nodeReceiptDraft, nodeReceiptValidations, nodeSecurityHash, nodeSourceHash, nodeTargetsHash, reusableNodeReceipt, sameNodeReceiptProof, unchangedNodeImages, unchangedNodeInputs, type NodeValidationReceipt } from "./node-current";
import { checkWordPressRequirements, parseWordPressPlan, wordpressPlanScript } from "./wordpress-security";
import { freeWordPressScanner } from "./wordpress-free-security";
import { wordpressMaintenanceCheck, recordWordPressManualUpdates, wordpressCompletionMessage } from "./wordpress-maintenance";
import { refreshWordPressWeb } from "./wordpress-web-check";
import { nodeValidationPlan, managedNodeMessage } from "./managed-node";

type Progress = (stage: UpdateStage, message: string) => Promise<void>;
const archiveScript = join(process.cwd(), "scripts", "update-archive.py");
async function extractArchive(archive: string, folder: string, github = false): Promise<string[]> {
  return JSON.parse(await runCommand("python3", [archiveScript, github ? "extract-github" : "extract", archive, folder]));
}
export async function publishGitVersions(repository: string, branch: string, expected: string, files: { path: string; content: string }[], transport: typeof fetch = fetch) {
  if (!files.length || files.some(file => !/(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|\.nvmrc|\.node-version|Dockerfile)$/.test(file.path) || file.path.split("/").some(part => !part || part === "." || part === ".." || part === ".git") || /[\\\x00-\x1f]/.test(file.path))) throw new ApiError("La publication doit se limiter aux versions et aux fichiers de verrouillage.");
  if (!repositoryAllowed(repository)) throw new ApiError("Ce dépôt n’est pas autorisé pour la mise à jour.");
  const token = githubUpdateToken(repository);
  if (!token) throw new ApiError("Accès GitHub manquant.");
  const head = await githubRequest(`/repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`, token, "GET", undefined, transport);
  if (head.object.sha !== expected) throw new ApiError("Le dépôt a changé pendant les tests. Aucun changement n’a été écrasé.", 409);
  for (const file of files.filter(file => /(^|\/)Dockerfile$/.test(file.path))) {
    const original = await githubRequest(`/repos/${repository}/contents/${file.path.split("/").map(encodeURIComponent).join("/")}?ref=${expected}`, token, "GET", undefined, transport);
    if (original.type !== "file" || original.encoding !== "base64" || typeof original.content !== "string" || typeof original.size !== "number" || original.size > 64_000 || !versionOnlyDockerfile(Buffer.from(original.content, "base64").toString("utf8"), file.content)) throw new ApiError("Le Dockerfile doit uniquement modifier les versions Node et des paquets npm, sans changer ses instructions.");
  }
  const commit = await githubRequest(`/repos/${repository}/git/commits/${expected}`, token, "GET", undefined, transport);
  const tree = await githubRequest(`/repos/${repository}/git/trees`, token, "POST", { base_tree: commit.tree.sha, tree: files.map(file => ({ ...file, mode: "100644", type: "blob" })) }, transport);
  const next = await githubRequest(`/repos/${repository}/git/commits`, token, "POST", { message: "chore: update Node LTS and dependencies via Vigie", tree: tree.sha, parents: [expected] }, transport);
  await githubRequest(`/repos/${repository}/git/refs/heads/${encodeURIComponent(branch)}`, token, "PATCH", { sha: next.sha, force: false }, transport);
  return next.sha as string;
}
async function downloadGitArchive(repository: string, sha: string, destination: string) {
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
async function nodeGroup(run: UpdateRun, targets: UpdateTarget[], results: UpdateResult[], progress: Progress) {
  const representative = targets[0];
  if (representative.mode === "git" && new Set(targets.map(target => target.branch)).size !== 1) throw new ApiError("Ce dépôt est déployé depuis plusieurs branches. Séparez leurs mises à jour.");
  const latestLts = await latestNode();
  const runtimeChecks: (UpdateCheck | null)[] = [];
  for (const [index, target] of targets.entries()) {
    results[index].previousDeploymentId = await providerPreflight(target, latestLts);
    await checkPublicSite(target.url!);
    const check = results[index].previousDeploymentId ? await preflightNodeRuntime(target, results[index].previousDeploymentId!, latestLts) : null;
    runtimeChecks.push(check);
    if (check) {
      results[index].checks ||= []; results[index].checks.push(check);
      await progress("checking", check.message);
      requireSecurityPass(check);
    }
  }
  const plan = await nodeValidationPlan(targets, runtimeChecks, latestLts);
  const version = plan.version;
  for (const [index, target] of targets.entries()) {
    const managed = plan.managed.get(target.id);
    if (managed) { results[index].managedNode = managed; if (managed.updatePending) results[index].warnings.push(managedNodeMessage(managed)); }
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
    if (names.some(name => /(^|\/)\.railway\//.test(name))) throw new ApiError("Retirez les fichiers locaux .railway des sources fournies.");
    if (representative.mode === "archive" && representative.provider === "railway" && names.some(name => /(^|\/)\.railwayignore$/.test(name))) throw new ApiError("La source Railway utilise un filtrage personnalisé des fichiers qui doit être vérifié avant l’envoi direct.");
    for (const name of names.filter(name => /(^|\/)(\.npmrc|\.yarnrc|\.yarnrc\.yml|pnpm-workspace\.yaml)$/.test(name))) {
      if (/(_auth\w*|npmAuthToken|npmAuthIdent|password|token)\s*[:=]/i.test(await readFile(join(sourceFolder, name), "utf8"))) throw new ApiError("Les sources contiennent des identifiants de registre. Utilisez un accès dédié avant l’automatisation.");
    }
    const before = await snapshotSources(sourceFolder, names);
    const roots = targets.map(target => target.root);
    const catalogs = nodeCatalogState(fetch, Date.parse(run.createdAt));
    const policyHash = await nodePolicyHash();
    const key = { sourceHash: nodeSourceHash(before), targetsHash: nodeTargetsHash(targets), policyHash, nodeVersion: version };
    await progress("checking", "Recherche d’une validation récente de la configuration actuelle.");
    const previous = await completedNodeRuns(run.projectId, [key.sourceHash, key.targetsHash, key.policyHash]);
    let receipt: NodeValidationReceipt | null = previous.flatMap(run => run.nodeReceipts || []).map(raw => reusableNodeReceipt(raw, key)).find(Boolean) || null;
    if (receipt) {
      try {
        for (const [index, target] of targets.entries()) {
          const proof = receipt.deployments.find(item => item.targetId === target.id);
          if (target.provider !== "railway" || !proof || proof.deploymentId !== results[index].previousDeploymentId) { receipt = null; break; }
          const instance = (await readRailwayInstance(target)).serviceInstance;
          const image = activeNodeImage(target, { deploymentId: proof.deploymentId, commit: expected || undefined }, version, instance.activeDeployments || []);
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
      await progress("updating", `${check.tool} : ${check.phase === "before" ? "analyse de la version actuelle" : "contrôle de la version candidate"}.`);
      requireSecurityPass(check);
    }
    await progress("checking", "Analyse de sécurité des dépendances actuelles.");
    const baselineScan = await nodeScan(names);
    const baseline = baselineScan.findings;
    await record({ ...securityCheck("OSV", "before", "Dépendances verrouillées des services sélectionnés", baseline), checkedAt: baselineScan.checkedAt });
    const imageBaselines = new Map<string, SecurityFinding[]>();
    const imageSecurity = new Map<string, string>();
    const imageReferences = new Map<string, { image: string; digest: string }[] | null>();
    for (const root of [...new Set(roots)]) {
      const dockerfile = (root ? root + "/" : "") + "Dockerfile";
      if (!names.includes(dockerfile)) continue;
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
      const current = await checkCurrentNodeConfiguration(receipt, {
        baseline,
        images: async () => {
          let unchanged = true;
          requireSecurityPass(securityCheck("OSV", "candidate", "Configuration déjà validée", baseline, baseline));
          for (const root of [...new Set(roots)]) {
            const file = (root ? root + "/" : "") + "Dockerfile";
            if (!names.includes(file)) continue;
            await validateDockerfileCandidate(sourceFolder, root, names, version, async image => {
              const findings = (await scanImage(image)).map(entry => ({ ...entry, scope: root }));
              await record(securityCheck("Trivy", "candidate", `Image Docker actuelle : ${root || "racine"}`, findings, [...baseline, ...(imageBaselines.get(root) || [])]), results.filter((_, index) => targets[index].root === root));
              if (nodeSecurityHash(findings) !== reference.imageSecurity.find(item => item.root === root)?.hash) unchanged = false;
            });
          }
          return unchanged;
        },
        finalScan: async () => {
          const final = await nodeScan(names, true);
          await record({ ...securityCheck("OSV", "candidate", "Contrôle final frais de la configuration actuelle", final.findings, baseline), checkedAt: final.checkedAt });
          return final.findings;
        },
        sources: async () => { await changedSources(sourceFolder, before, new Set()); },
        catalogs: () => unchangedNodeInputs(reference),
      });
      if (current) {
        const currentTargets = await updateTargets(run.projectId);
        if (targets.some(target => JSON.stringify(currentTargets.find(item => item.id === target.id)) !== JSON.stringify(target))) throw new ApiError("La configuration du projet a changé pendant la vérification. Validation annulée.");
        if (representative.mode === "git") {
          const head = await githubRequest(`/repos/${representative.repository}/git/ref/heads/${encodeURIComponent(representative.branch!)}`, githubUpdateToken(representative.repository!));
          if (head.object.sha !== expected) throw new ApiError("Le dépôt a changé pendant la vérification. La validation précédente ne peut pas être réutilisée.", 409);
        } else if ((await readUpdateSource(representative.id))?.revision !== original!.revision) throw new ApiError("Les sources ont changé pendant la vérification. Validation annulée.", 409);
        await verifyNodeServices(results, async index => {
          const target = targets[index], result = results[index];
          await confirmDeployedNode(target, result, { deploymentId: result.previousDeploymentId!, commit: expected || undefined }, version, progress);
          const proof = result.checks?.findLast(check => check.tool === "Node" && check.phase === "after")?.nodeEvidence;
          if (!sameNodeReceiptProof(reference, target.id, proof)) throw new ApiError("L’image active ou le type de preuve Node a changé pendant la vérification. Validation non réutilisable.", 422);
          await checkPublicSite(target.url!);
          const validation = receipt!.validations.find(item => item.targetId === target.id)!;
          result.checks!.push({ tool: "Validation", phase: "candidate", checkedAt: validation.checkedAt, scope: validation.scope, status: validation.status, findings: [], message: `Validation du ${validation.checkedAt} réutilisée pour les mêmes sources, catalogues et environnement ; scripts non réexécutés. ${validation.message}` });
          result.warnings = [...new Set([...result.warnings, ...(receipt!.warnings.find(item => item.targetId === target.id)?.messages || [])])];
          result.stage = "completed";
          result.message = "Configuration déjà validée et toujours à jour ; sécurité, Node déployé et HTTPS revérifiés.";
        });
        run.nodeReceipts ||= [];
        run.nodeReceipts.push(receipt); // Keep the original heavy-validation age.
        return;
      }
    }
    collectCatalogs = true;
    await catalogs.packages([...currentPackages]);
    await progress("updating", "Analyse complète nécessaire : actualisation de Node et des dépendances, puis validation isolée.");
    let runtimeRefreshed = false;
    const runtime = nodeValidationRuntime(version, async (command, args, options) => {
      if (!runtimeRefreshed) { await runCommand("docker", ["pull", `node:${version}-bookworm`], { timeout: 5 * 60_000 }); runtimeRefreshed = true; }
      return runCommand(command, args, options);
    });
    function serviceChecks(workingFolder: string, selectedRoots: string[]): NodeUpdateChecks {
      const scanSources = createNodeScanCache(workingFolder, selectedRoots, scanWithInventory);
      const selectedResults = results.filter((_, index) => selectedRoots.includes(targets[index].root));
      return {
      resolved: async resolvedNames => {
        const scan = await scanSources(resolvedNames);
        const check = securityCheck("OSV", "candidate", `Dépendances verrouillées : ${selectedRoots.map(root => root || "racine").join(", ")}`, scan.findings, baseline);
        await record({ ...check, checkedAt: scan.checkedAt, message: check.message + (scan.reused.length ? ` ${scan.reused.length} verrou(s) inchangé(s) : analyse de cette exécution réutilisée (moins de cinq minutes).` : "") }, selectedResults);
      },
      image: async (root, image) => {
        const findings = (await scanImage(image)).map(entry => ({ ...entry, scope: root }));
        await record(securityCheck("Trivy", "candidate", `Image Docker finale : ${root || "racine"}`, findings, [...baseline, ...(imageBaselines.get(root) || [])]), results.filter((_, index) => targets[index].root === root));
        imageSecurity.set(root, nodeSecurityHash(findings));
        const file = (root ? root + "/" : "") + "Dockerfile";
        const references = await Promise.all(dockerNodeBases(await readFile(join(workingFolder, file), "utf8")).map(image => nodeImageReceipt(image, image)));
        imageReferences.set(root, references.every(Boolean) ? references as { image: string; digest: string }[] : null);
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
    const prepared = await prepareNodeServices(sourceFolder, roots, names, version, serviceChecks, {
      transport: catalogs.transport,
      runtime,
      dockerRoots: targets.filter(target => target.builder === "DOCKERFILE").map(target => target.root),
      progress: async (root, phase) => {
        const message = { preparing: "Préparation des versions", prepared: "Versions préparées ; attente du contrôle de l’ensemble", validating: "Validation des versions assemblées", ready: "Proposition validée ; attente de publication" }[phase];
        for (const [index, target] of targets.entries()) if (target.root === root) {
          results[index].stage = "updating";
          results[index].message = message;
        }
        await progress("updating", `${root || "racine"} : ${message}.`);
      },
    }).finally(() => runtime.dispose?.());
    const preparationMs = Math.round(performance.now() - preparationStarted);
    for (const [index, target] of targets.entries()) {
      const timing = "services" in prepared ? prepared.services.find(service => service.root === target.root) : null;
      const validation = results[index].checks?.findLast(check => check.tool === "Validation" && check.phase === "candidate");
      if (validation) validation.message += timing
        ? ` Durées du service : préparation ${Math.round(timing.prepareMs / 1000)} s ; validation assemblée ${Math.round(timing.validateMs / 1000)} s. Préparation et validation de tous les services : ${Math.round(preparationMs / 1000)} s écoulées (tâches parallèles).`
        : ` Préparation et validation : ${Math.round(preparationMs / 1000)} s.`;
    }
    const changes = await changedSources(sourceFolder, before, prepared.allowed);
    const finalScan = await nodeScan([...new Set([...names, ...prepared.allowed])], true);
    await record({ ...securityCheck("OSV", "candidate", "Contrôle final frais de tous les verrous avant publication", finalScan.findings, baseline), checkedAt: finalScan.checkedAt });
    for (const [index, result] of results.entries()) {
      const warnings = "services" in prepared ? prepared.services.find(service => service.root === targets[index].root)?.warnings || [] : prepared.warnings;
      result.warnings = [...new Set([...result.warnings, ...warnings])];
    }
    for (const [index, target] of targets.entries()) if (!imageBaselines.has(target.root)) results[index].warnings.push("Image finale gérée par l’hébergeur : son système n’est pas analysé par Trivy dans ce parcours.");
    async function verifyNode(index: number, deploymentId: string) {
      const result = results[index];
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
          securityHash: nodeSecurityHash(finalScan.findings), imageSecurity: [...imageSecurity].map(([root, hash]) => ({ root, hash })),
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
        await checkPublicSite(targets[index].url!);
        result.stage = "completed";
        result.message = result.managedNode?.updatePending ? "Dépendances validées avec le runtime Vercel mesuré ; correctif Node en attente chez l’hébergeur." : "Node exact et dépendances déjà à jour ; déploiement et contrôle HTTPS vérifiés.";
      });
      await rememberValidation();
      return;
    }
    const currentTargets = await updateTargets(run.projectId);
    for (const [index, target] of targets.entries()) {
      const current = currentTargets.find(item => item.id === target.id);
      if (!current || current.unavailable || JSON.stringify(current) !== JSON.stringify(target)) throw new ApiError("La configuration du projet a changé pendant les tests. Publication annulée.");
      const currentDeployment = await providerPreflight(target, version);
      if (currentDeployment !== results[index].previousDeploymentId) throw new ApiError("Un autre déploiement a eu lieu pendant les tests. Publication annulée pour ne pas l’écraser.");
      if (target.provider === "vercel") {
        const runtime = await preflightNodeRuntime(target, currentDeployment!, latestLts);
        if (!runtime || runtime.status !== "passed" || runtime.nodeEvidence?.version !== version) throw new ApiError("Le runtime Vercel a changé pendant les validations. Relancez pour tester sa nouvelle version ; aucun changement publié.", 409);
      }
    }
    await progress("publishing", "Vérifications réussies. Publication de la nouvelle version.");
    for (const result of results) result.stage = "publishing";
    await progress("publishing", "Publication de la nouvelle version.");
    if (representative.mode === "git") {
      for (const result of results) result.previousCommit = expected;
      const commit = await publishGitVersions(representative.repository!, representative.branch!, expected, changes);
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
      await progress("verifying", "Attente du déploiement et contrôle du site.");
      await waitForDeployment(target, { commit: result.commit, deploymentId: result.deploymentId, runId: run.id, previousDeploymentId: result.previousDeploymentId }, async id => {
        result.deploymentId = id;
        await progress("verifying", "Contrôle du déploiement en cours.");
      });
      if (!result.deploymentId) throw new ApiError("Déploiement introuvable pour vérifier la version Node exacte.");
      await verifyNode(index, result.deploymentId);
      await checkPublicSite(target.url!);
      result.stage = "completed";
      result.message = result.managedNode?.updatePending ? "Dépendances déployées et validées avec le runtime Vercel mesuré ; correctif Node en attente chez l’hébergeur." : "Mise à jour déployée et contrôle HTTPS réussi.";
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
  if ((await readUpdateSource(target.id))?.settings.localAgent) return executeLocalWordPress(run, target, result, fresh, progress);
  await withWordPressUpdater(target, async (execute, username) => {
    const scan = freeWordPressScanner();
    const plan = await scan.prepare(parseWordPressPlan(await execute(wordpressPlanScript(target.root))));
    checkWordPressRequirements(plan);
    const baseline = await scan(plan, false);
    result.checks = [securityCheck("WPVulnerability", "before", "WordPress, extensions et thèmes publics identifiables", baseline)];
    await progress("checking", "Vérification de sécurité des versions WordPress candidates.");
    const candidateFindings = await scan(plan, true);
    recordWordPressManualUpdates(result, plan, fresh, candidateFindings);
    const candidate = wordpressMaintenanceCheck(plan, "candidate", "Versions proposées et composants conservés de WordPress", candidateFindings);
    result.checks.push(candidate);
    await progress("checking", "Contrôle des versions à installer terminé ; composants manuels conservés.");
    requireSecurityPass(candidate);
    result.warnings.push(...scan.warnings);
    if (plan.wordpress.current === plan.wordpress.target && plan.plugins.every(item => item.current === item.target)) { result.stage = "completed"; result.message = wordpressCompletionMessage(result, false); return; }
    await progress("checking", "Vérification de WordPress et sauvegarde des fichiers et de la base.");
    const backupOutput = await execute(wordpressBackupScript(target.root, username, run.id, target.url!, fresh.php!.version));
    const backup = backupOutput.match(/^VIGIE_BACKUP=(\/home\/[\w-]+\/\.vigie-backups\/[a-f0-9-]{36}\/[a-f0-9]{12})$/m)?.[1];
    if (!backup) throw new ApiError("La sauvegarde WordPress n’a pas pu être confirmée. Mise à jour annulée.");
    result.backup = backup;
    result.stage = "publishing";
    await progress("publishing", "Sauvegarde vérifiée. Mise à jour de WordPress et des extensions ; PHP et thèmes conservés.");
    const output = await execute(wordpressUpdateScript(target.root, backup, plan));
    const plugins = output.match(/^VIGIE_PLUGINS=(\d+)$/m), themes = output.match(/^VIGIE_THEMES=(\d+)$/m);
    if (!plugins || !themes) throw new ApiError("Les composants WordPress n’ont pas pu être vérifiés. La sauvegarde est conservée.");
    result.stage = "verifying";
    await progress("verifying", "Contrôle du site après mise à jour WordPress.");
    await checkPublicSite(target.url!);
    const installed = parseWordPressPlan(await execute(wordpressPlanScript(target.root)));
    if (installed.wordpress.current !== plan.wordpress.target || ["plugins", "themes"].some(kind => {
      const key = kind as "plugins" | "themes";
      return installed[key].length !== plan[key].length || plan[key].some(item => installed[key].find(next => next.slug === item.slug)?.current !== item.target);
    })) throw new ApiError("Les versions WordPress installées ne correspondent pas au plan vérifié. Sauvegarde conservée.");
    const finalCheck = wordpressMaintenanceCheck(plan, "after", "Versions réellement installées après mise à jour", await scan(installed, false));
    result.checks.push(finalCheck);
    await progress("verifying", "Contrôle de sécurité WordPress après installation.");
    requireSecurityPass(finalCheck);
    result.stage = "completed";
    result.message = wordpressCompletionMessage(result, true);
    result.warnings.push("Les extensions sans accès à leur catalogue (licence expirée ou distribution privée) peuvent ne pas signaler de mise à jour. Une sauvegarde ne remplace pas un test métier.");
  });
}
export async function executeUpdate(id: string, executeGroup = nodeGroup, executeWordPress = wordpressTarget, afterComplete = refreshUpdateInventories) {
  z.string().uuid().parse(id);
  const db = await updateStorage();
  const claim = await db.prepare("UPDATE update_runs SET stage='checking' WHERE id=? AND stage='queued'").run(id);
  if (!claim.changes) return false;
  const run = await readUpdateRun(id);
  if (!run) return false;
  run.stage = "checking";
  run.workflowRunId = process.env.GITHUB_RUN_ID;
  let writes = Promise.resolve();
  const progress: Progress = (stage, message) => {
    run.stage = stage;
    run.message = message;
    writes = writes.then(() => writeUpdateRun(run));
    return writes;
  };
  const heartbeat = setInterval(() => { void progress(run.stage, run.message).catch(() => {}); }, 30_000);
  try {
    await withAuditActor(run.actor, async () => {
      await progress("checking", "Vérification des accès et de la configuration du projet.");
      if (process.env.VIGIE_UPDATES_RUNNER_SETUP_OK !== undefined && process.env.VIGIE_UPDATES_RUNNER_SETUP_OK !== "true") throw new ApiError("L’installation vérifiée des outils de sécurité ou de déploiement a échoué. Aucun service n’a été modifié.", 503);
      const current = await updateTargets(run.projectId);
      for (const target of run.targets) {
        const next = current.find(item => item.id === target.id);
        if (!next || next.unavailable || JSON.stringify(next) !== JSON.stringify(target)) throw new ApiError("La configuration du projet a changé. Rechargez sa fiche avant de relancer.");
        const lock = await db.prepare("SELECT run_id FROM update_locks WHERE scope=?").get(updateScope(target)) as { run_id: string } | undefined;
        if (lock?.run_id !== id) throw new ApiError("Le verrou de mise à jour n’est plus détenu par ce traitement.");
      }
      const groups = new Map<string, UpdateTarget[]>();
      for (const target of run.targets) {
        const scope = updateScope(target);
        groups.set(scope, [...groups.get(scope) || [], target]);
      }
      for (const targets of groups.values()) {
        const results = targets.map(target => ({ targetId: target.id, name: target.name, stage: "checking" as UpdateStage, message: "Vérification en cours.", warnings: [] as string[] }));
        run.results.push(...results);
        if (targets[0].mode === "wordpress") await executeWordPress(run, targets[0], results[0], progress);
        else await executeGroup(run, targets, results, progress);
      }
      requireZeroFinalFindings(run.results);
      run.stage = "completed";
      const manualCount = run.results.reduce((count, result) => count + (result.manualUpdates?.length || 0), 0);
      run.message = manualCount ? `Mises à jour automatiques terminées. ${manualCount} composant(s) restent à traiter manuellement ; consultez les interventions restantes.` : run.results.some(result => result.warnings.length || result.checks?.some(check => check.status === "warning")) ? "Mise à jour terminée avec réserves. Consultez les contrôles dans les détails." : "Mise à jour terminée et déploiement vérifié.";
      const pendingNodes = run.results.filter(result => result.managedNode?.updatePending).length;
      if (pendingNodes) run.message = `Maintenance des dépendances terminée avec réserves. ${pendingNodes} runtime(s) Node restent à actualiser chez Vercel.${manualCount ? ` ${manualCount} autre(s) composant(s) restent à traiter manuellement.` : ""} Le site n’est pas déclaré entièrement corrigé.`;
      await log("live", "updates.completed", run.message, run.projectId);
    });
  } catch (error) {
    const published = run.results.some(result => result.commit || result.deploymentId || result.backup) || (!(error instanceof ApiError && error.status === 409) && run.results.some(result => ["publishing", "verifying", "attention"].includes(result.stage)));
    run.stage = published ? "attention" : "failed";
    run.message = error instanceof ApiError ? error.message : "Une étape de mise à jour a échoué. Les informations de récupération sont conservées.";
    for (const result of run.results.filter(result => result.stage !== "completed" && result.stage !== "attention")) { result.stage = run.stage; result.message = run.message; }
    await withAuditActor(run.actor, () => log("live", "updates.failed", run.message, run.projectId));
  } finally {
    clearInterval(heartbeat);
    await writes;
    await transaction(async () => {
      await writeUpdateRun(run);
      if (run.stage !== "attention") await db.prepare("DELETE FROM update_locks WHERE run_id=?").run(id);
    });
  }
  if ((run.stage as UpdateStage) === "completed") {
    await afterComplete(run.targets);
  }
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
