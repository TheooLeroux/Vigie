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
import { changedSources, latestNode, prepareNodeSources, snapshotSources } from "./node";
import { checkPublicSite, deployRailwayArchive, deployVercelArchive, providerPreflight, waitForDeployment } from "./providers";
import { confirmDeployedNode, preflightNodeRuntime, verifyNodeServices } from "./node-deployment";
import { runCommand } from "./process";
import { readUpdateRun, readUpdateSource, saveUpdateSnapshot, updateStorage, writeUpdateRun, writeUpdateSource } from "./storage";
import { updateScope, updateTargets } from "./targets";
import { withWordPressUpdater, wordpressBackupScript, wordpressUpdateScript } from "./wordpress";
import type { UpdateRun, UpdateTarget, UpdateResult, UpdateStage, UpdateCheck, SecurityFinding } from "./types";
import { dockerRuntimeBase, versionOnlyDockerfile } from "./dockerfile";
import { requireSecurityPass, scanDockerImage, createNodeScanCache, securityCheck } from "./security";
import { checkWordPressRequirements, parseWordPressPlan, wordPressScanner, wordpressPlanScript } from "./wordpress-security";

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
  const version = await latestNode();
  for (const [index, target] of targets.entries()) {
    results[index].previousDeploymentId = await providerPreflight(target, version);
    await checkPublicSite(target.url!);
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
    const nodeScan = createNodeScanCache(sourceFolder, roots);
    const trivyCache = join(temporary, "trivy-cache");
    await mkdir(trivyCache, { mode: 0o700 });
    async function record(check: UpdateCheck, selected = results) {
      for (const result of selected) { result.checks ||= []; result.checks.push(check); }
      await progress("updating", `${check.tool} : ${check.phase === "before" ? "analyse de la version actuelle" : "contrôle de la version candidate"}.`);
      requireSecurityPass(check);
    }
    for (const [index, target] of targets.entries()) {
      if (!results[index].previousDeploymentId) continue;
      await progress("checking", "Vérification préalable de l’accès au runtime déployé.");
      const check = await preflightNodeRuntime(target, results[index].previousDeploymentId!, version);
      if (check) await record(check, [results[index]]);
    }
    await progress("checking", "Analyse de sécurité des dépendances actuelles.");
    const baselineScan = await nodeScan(names);
    const baseline = baselineScan.findings;
    await record({ ...securityCheck("OSV", "before", "Dépendances verrouillées des services sélectionnés", baseline), checkedAt: baselineScan.checkedAt });
    const imageBaselines = new Map<string, SecurityFinding[]>();
    for (const root of [...new Set(roots)]) {
      const dockerfile = (root ? root + "/" : "") + "Dockerfile";
      if (!names.includes(dockerfile)) continue;
      const image = dockerRuntimeBase(await readFile(join(sourceFolder, dockerfile), "utf8"));
      const findings = (await scanDockerImage(image, undefined, true, trivyCache)).map(entry => ({ ...entry, scope: root }));
      imageBaselines.set(root, findings);
      await record(securityCheck("Trivy", "before", `Image de base actuelle ${image} (hors code applicatif)`, findings), results.filter((_, index) => targets[index].root === root));
    }
    await progress("updating", "Actualisation de Node et des dépendances, puis validation isolée.");
    const prepared = await prepareNodeSources(sourceFolder, roots, names, version, fetch, targets.filter(target => target.builder === "DOCKERFILE").map(target => target.root), undefined, {
      resolved: async resolvedNames => {
        const scan = await nodeScan(resolvedNames);
        const check = securityCheck("OSV", "candidate", "Dépendances directes et transitives verrouillées", scan.findings, baseline);
        await record({ ...check, checkedAt: scan.checkedAt, message: check.message + (scan.reused.length ? ` ${scan.reused.length} verrou(s) inchangé(s) : analyse de cette exécution réutilisée (moins de cinq minutes).` : "") });
      },
      image: async (root, image) => { await record(securityCheck("Trivy", "candidate", `Image Docker finale : ${root || "racine"}`, (await scanDockerImage(image, undefined, false, trivyCache)).map(entry => ({ ...entry, scope: root })), [...baseline, ...(imageBaselines.get(root) || [])]), results.filter((_, index) => targets[index].root === root)); },
      reused: message => progress("updating", message),
      validated: async (root, scripts) => {
        const browser = scripts.includes("test:e2e"), tests = scripts.some(name => name === "test" || name === "test:integration");
        await record({ tool: "Validation", phase: "candidate", scope: root || "racine", checkedAt: new Date().toISOString(), status: browser && tests ? "passed" : "warning", message: `Scripts réussis : ${scripts.join(", ")}. ${!browser ? "Aucun parcours navigateur test:e2e déclaré : les parcours métier ne sont pas certifiés." : "Le périmètre navigateur dépend des assertions du projet."} ${!tests ? "Aucun test unitaire ou d’intégration déclaré." : ""}`, findings: [] }, results.filter((_, index) => targets[index].root === root));
      },
      remediating: async message => {
        for (const result of results) result.warnings.push(message);
        await progress("updating", message);
      },
    });
    const changes = await changedSources(sourceFolder, before, prepared.allowed);
    const finalScan = await nodeScan([...new Set([...names, ...prepared.allowed])], true);
    await record({ ...securityCheck("OSV", "candidate", "Contrôle final frais de tous les verrous avant publication", finalScan.findings, baseline), checkedAt: finalScan.checkedAt });
    for (const result of results) result.warnings = [...new Set([...result.warnings, ...prepared.warnings])];
    for (const [index, target] of targets.entries()) if (!imageBaselines.has(target.root)) results[index].warnings.push("Image finale gérée par l’hébergeur : son système n’est pas analysé par Trivy dans ce parcours.");
    async function verifyNode(index: number, deploymentId: string) {
      const result = results[index];
      await confirmDeployedNode(targets[index], result, { deploymentId, commit: result.commit || expected || undefined }, version, progress);
    }
    if (!changes.length) {
      await verifyNodeServices(results, async index => {
        const result = results[index];
        result.stage = "verifying";
        if (!result.previousDeploymentId) throw new ApiError("Aucun déploiement actif ne permet de vérifier la version Node exacte.");
        await verifyNode(index, result.previousDeploymentId);
        await checkPublicSite(targets[index].url!);
        result.stage = "completed";
        result.message = "Node exact et dépendances déjà à jour ; déploiement et contrôle HTTPS vérifiés.";
      });
      return;
    }
    const currentTargets = await updateTargets(run.projectId);
    for (const [index, target] of targets.entries()) {
      const current = currentTargets.find(item => item.id === target.id);
      if (!current || current.unavailable || JSON.stringify(current) !== JSON.stringify(target)) throw new ApiError("La configuration du projet a changé pendant les tests. Publication annulée.");
      const currentDeployment = await providerPreflight(target, version);
      if (currentDeployment !== results[index].previousDeploymentId) throw new ApiError("Un autre déploiement a eu lieu pendant les tests. Publication annulée pour ne pas l’écraser.");
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
      result.message = "Mise à jour déployée et contrôle HTTPS réussi.";
    });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
async function wordpressTarget(run: UpdateRun, target: UpdateTarget, result: UpdateResult, progress: Progress) {
  if (!process.env.VIGIE_UPDATES_WPSCAN_TOKEN) throw new ApiError("Configurez le jeton WPScan sur l’exécuteur avant la mise à jour WordPress. Aucun site n’a été modifié.", 503);
  await checkPublicSite(target.url!);
  await collectHostingInventories(target.connectionId, fetch, fetch, target.remoteId);
  const fresh = (await hostingInstallation(target.remoteId)).inventory;
  if (!fresh || fresh.source !== "wordpress-observer" || fresh.collectionMode === "early" || !fresh.php || fresh.error || !fresh.observedAt || Date.now() - Date.parse(fresh.observedAt) > 5 * 60_000) throw new ApiError("Un relevé WordPress récent avec la version PHP web est nécessaire avant la mise à jour.");
  if (fresh.site?.multisite || fresh.configuration?.fileModsDisabled) throw new ApiError("La configuration WordPress actuelle ne permet pas cette mise à jour automatique.");
  if (fresh.plugins.some(plugin => plugin.mustUse)) result.warnings.push("Extensions MU présentes : elles ne sont ni mises à jour ni qualifiées automatiquement ; une recette spécifique reste nécessaire.");
  await withWordPressUpdater(target, async (execute, username) => {
    const plan = parseWordPressPlan(await execute(wordpressPlanScript(target.root)));
    checkWordPressRequirements(plan);
    const scan = wordPressScanner();
    const baseline = await scan(plan, false);
    result.checks = [securityCheck("WPScan", "before", "WordPress, extensions et thèmes installés", baseline)];
    await progress("checking", "Vérification de sécurité des versions WordPress candidates.");
    const candidate = securityCheck("WPScan", "candidate", "Versions WordPress prévues et exigences PHP/WordPress", await scan(plan, true), baseline);
    result.checks.push(candidate);
    await progress("checking", "Sécurité WordPress et prérequis vérifiés.");
    requireSecurityPass(candidate);
    await progress("checking", "Vérification de WordPress et sauvegarde des fichiers et de la base.");
    const backupOutput = await execute(wordpressBackupScript(target.root, username, run.id, target.url!, fresh.php!.version));
    const backup = backupOutput.match(/^VIGIE_BACKUP=(\/home\/[\w-]+\/\.vigie-backups\/[a-f0-9-]{36}\/[a-f0-9]{12})$/m)?.[1];
    if (!backup) throw new ApiError("La sauvegarde WordPress n’a pas pu être confirmée. Mise à jour annulée.");
    result.backup = backup;
    result.stage = "publishing";
    await progress("publishing", "Sauvegarde vérifiée. Mise à jour de WordPress, des extensions et des thèmes.");
    const output = await execute(wordpressUpdateScript(target.root, backup, plan));
    const plugins = output.match(/^VIGIE_PLUGINS=(\d+)$/m), themes = output.match(/^VIGIE_THEMES=(\d+)$/m);
    if (!plugins || !themes || Number(plugins[1]) || Number(themes[1])) throw new ApiError("Certains composants WordPress n’ont pas pu être mis à jour. La sauvegarde est conservée.");
    result.stage = "verifying";
    await progress("verifying", "Contrôle du site après mise à jour WordPress.");
    await checkPublicSite(target.url!);
    const installed = parseWordPressPlan(await execute(wordpressPlanScript(target.root)));
    if (installed.wordpress.current !== plan.wordpress.target || ["plugins", "themes"].some(kind => {
      const key = kind as "plugins" | "themes";
      return installed[key].length !== plan[key].length || plan[key].some(item => installed[key].find(next => next.slug === item.slug)?.current !== item.target);
    })) throw new ApiError("Les versions WordPress installées ne correspondent pas au plan vérifié. Sauvegarde conservée.");
    const finalCheck = securityCheck("WPScan", "after", "Versions réellement installées après mise à jour", await scan(installed, false), baseline);
    result.checks.push(finalCheck);
    await progress("verifying", "Contrôle de sécurité WordPress après installation.");
    requireSecurityPass(finalCheck);
    result.stage = "completed";
    result.message = "WordPress, extensions et thèmes mis à jour ; contrôle HTTPS réussi.";
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
      run.stage = "completed";
      run.message = run.results.some(result => result.warnings.length || result.checks?.some(check => check.status === "warning")) ? "Mise à jour terminée avec réserves. Consultez les contrôles dans les détails." : "Mise à jour terminée et déploiement vérifié.";
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
