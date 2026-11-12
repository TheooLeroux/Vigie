import { randomUUID } from "node:crypto";
import { z } from "zod";
import { auditActor, withAuditActor } from "../audit-context";
import { log, requireProject, transaction } from "../db";
import { ApiError } from "../http";
import { dispatchUpdate, githubRequest, updateRunner } from "./github";
import { readUpdateHistory, readUpdateRun, readUpdateSource, updateStorage, writeUpdateRun, writeUpdateSource } from "./storage";
import { updateScope, updateTargets } from "./targets";
import { activeUpdateStages, type UpdateRun, type UpdateState } from "./types";
import { currentSourceDeployment } from "./providers";
import { isPostgres } from "../storage";
import { cpanelAgentFiles, assertAgentRunStopped } from "./wordpress-agent";
import { requestAgentInstallation } from "./wordpress-agent-setup";
import { withHostingCredentials } from "../hosting-connections";
import type { SourceSettings } from "./types";
import { currentWordPressSecurity } from "./wordpress-current-security";
import { closedWordPressPlugin } from "./wordpress-free-security";
import { allowedWordPressRemovals } from "./wordpress-maintenance";
import { wordpressPluginSlug } from "./wordpress-security";
import { readAutomaticControl } from "../automatic-control-storage";
import { allowsAutomaticMaintenance } from "./capabilities";
import { refreshProjectHosting } from "./refresh-hosting";
import { observedProjectDetail } from "../project-observations";
import { controlSource } from "../automatic-control-state";
import { railwayState } from "../railway";
import { railpackImageIdentity } from "./railpack-image-report";
import { projectRailpackReports } from "./railpack-image-control";
import { assessmentHasNoTarget, noAssessmentTargetMessage } from "./assessment";

function attentionScopes(run: UpdateRun) {
  const targets = run.targets || [];
  const uncertain = targets.filter(target => run.results?.some(result => result.targetId === target.id && result.stage === "attention"));
  return (uncertain.length ? uncertain : targets).map(updateScope);
}

export function updatesEnabled() {
  return process.env.VIGIE_UPDATES_ENABLED === "1" && !!updateRunner();
}
export function updatesDisabledReason() {
  if (process.env.VIGIE_UPDATES_ENABLED !== "1") return "Les mises à jour ne sont pas activées sur cette instance de Vigie.";
  if (!updateRunner()) return "L’exécuteur de maintenance n’est pas connecté à cette instance de Vigie.";
}
export async function projectUpdates(projectId: string): Promise<UpdateState> {
  const railway = railwayState();
  const [targets, { projects }] = await Promise.all([updateTargets(projectId, railway), railway]);
  const db = await updateStorage();
  const { runs, assessment } = (await readUpdateHistory([projectId])).get(projectId)!;
  const pendingRows = await db.prepare("SELECT data FROM update_runs WHERE project_id=? AND stage='attention' ORDER BY json_extract(data,'$.createdAt') DESC").all(projectId) as { data: string }[];
  const pending = pendingRows.map(row => JSON.parse(row.data) as UpdateRun);
  const blockedScopes = new Set(pending.flatMap(attentionScopes));
  const identities = targets.map(target => railpackImageIdentity(target, projects)).filter(identity => identity !== null);
  const wordpressTargets = targets.filter(target => target.mode === "wordpress");
  const [railpackImageReports, automaticControls, currentSecurity, wordpressSources] = await Promise.all([
    projectRailpackReports(projectId, identities, runs),
    Promise.all(targets.map(target => readAutomaticControl(target.id))),
    Promise.all(wordpressTargets.map(target => currentWordPressSecurity(target, { cacheOnly: true }))),
    Promise.all(wordpressTargets.map(target => readUpdateSource(target.id))),
  ]);
  const wordpressSettings = wordpressTargets.map((target, index) => {
    const allowed = allowedWordPressRemovals(target, wordpressSources[index]?.settings);
    const history = [...runs, ...(assessment ? [assessment] : [])].flatMap(run => run.results.filter(result => result.targetId === target.id));
    const licenses = history.flatMap(result => result.wordpressLicenses ? [result.wordpressLicenses] : [])
      .sort((first, second) => second.checkedAt.localeCompare(first.checkedAt))[0];
    const lastSignedPlan = licenses && history.find(result => result.wordpressLicenses === licenses && result.manualUpdates);
    const closed = new Set(currentSecurity[index].closedPlugins ?? lastSignedPlan?.manualUpdates?.filter(item => item.closed).map(item => item.package.slice("plugins/".length)));
    return { targetId: target.id, licenses, removablePlugins: [...new Set([...closed, ...allowed])].map(slug => ({ slug, allowed: allowed.includes(slug), listedAsClosed: closed.has(slug) })) };
  });
  return { assessment, wordpressSettings, enabled: updatesEnabled(), disabledReason: updatesDisabledReason(), targets, railpackImageReports, automaticControls: automaticControls.filter(item => item !== null), currentSecurity, runs,
    blockedTargetIds: targets.filter(target => blockedScopes.has(updateScope(target))).map(target => target.id),
    pendingRuns: pending.map(({ id, stage, updatedAt, message }) => ({ id, stage, updatedAt, message })),
  };
}
const startSchema = z.object({ projectId: z.string().uuid(), targetIds: z.array(z.string().max(300)).min(1).max(30).optional() });
export async function startProjectUpdate(raw: unknown, dispatch = dispatchUpdate, options: { assessment?: boolean; retryAssessment?: boolean } = {}) {
  const input = startSchema.parse(raw);
  if (!options.assessment && !updatesEnabled()) throw new ApiError("Le service de mise à jour n’est pas encore activé.", 503);
  await refreshProjectHosting(input.projectId);
  const all = await updateTargets(input.projectId);
  const targets = input.targetIds ? input.targetIds.map(id => {
    const target = all.find(target => target.id === id);
    if (!target) throw new ApiError("Ce service ne fait pas partie de ce projet.", 404);
    return target;
  }) : all.filter(allowsAutomaticMaintenance);
  if ((!targets.length && !options.assessment) || targets.length > 30 || new Set(targets.map(target => target.id)).size !== targets.length || targets.some(target => target.unavailable)) throw new ApiError(targets.find(target => target.unavailable)?.unavailable || "Choisissez entre 1 et 30 services distincts pouvant être mis à jour.");
  const now = new Date().toISOString();
  const candidate: UpdateRun = { id: randomUUID(), projectId: input.projectId, stage: "queued", createdAt: now, updatedAt: now, actor: auditActor() || { name: "Équipe Vigie", email: "" }, targets, results: [], excludedTargets: all.filter(target => !targets.some(selected => selected.id === target.id)).map(target => ({ targetId: target.id, name: target.name, reason: target.unavailable || (input.targetIds ? "Service non sélectionné pour cette maintenance." : target.capability?.reason) || "Service non sélectionné." })), message: "La mise à jour des services compatibles va démarrer." };
  const db = await updateStorage();
  if (options.assessment) {
    candidate.purpose = "assessment";
    candidate.actor = { name: "Bilan quotidien Vigie", email: "" };
    candidate.message = "Recherche quotidienne de versions stables, sans installation.";
    if (targets.length) {
      const detail = await observedProjectDetail(input.projectId, "live");
      candidate.assessmentSources = Object.fromEntries(targets.flatMap(target => {
        const source = controlSource(target, detail);
        return source ? [[target.id, source.identity]] : [];
      }));
    } else {
      candidate.stage = "completed";
      candidate.message = noAssessmentTargetMessage;
    }
  }
  const { run, created } = await transaction(async () => {
    if (isPostgres()) await db.prepare("SELECT id FROM projects WHERE id=? FOR UPDATE").get(input.projectId);
    if ((await requireProject(input.projectId, "live")).lifecycle !== "active") throw new ApiError("Projet archivé.", 409);
    for (const target of targets.filter(target => target.mode === "wordpress")) {
      const setup = (await readUpdateSource(target.id))?.settings.agentInstallation;
      if (setup && setup.state !== "ready") throw new ApiError("L’installation automatique de l’agent doit se terminer avant la mise à jour. Rechargez le suivi.", 409);
    }
    const rows = await db.prepare("SELECT data FROM update_runs WHERE project_id=?").all(input.projectId) as { data: string }[];
    const recorded = rows.map(row => JSON.parse(row.data) as UpdateRun);
    const existing = recorded.find(run => activeUpdateStages.includes(run.stage));
    if (existing?.purpose === "assessment" && !options.assessment) throw new ApiError("Un bilan préalable est en cours. Attendez sa fin avant de lancer une installation.", 409);
    if (existing) return { run: existing, created: false };
    if (options.assessment) {
      const today = recorded.filter(run => run.purpose === "assessment" && run.assessmentOrigin !== "maintenance" && run.createdAt.slice(0, 10) === now.slice(0, 10))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      if (today) {
        const canRetry = today.stage === "failed" || (assessmentHasNoTarget(today) && targets.length > 0);
        if (!options.retryAssessment || !canRetry) return { run: today, created: false };
      }
    }
    const scopes = [...new Set(targets.map(updateScope))].sort();
    const pending = recorded.some(previous => previous.stage === "attention" && attentionScopes(previous).some(scope => scopes.includes(scope)));
    if (pending) throw new ApiError("Une publication précédente utilise ces sources et doit être vérifiée avant de relancer.", 409);
    await db.prepare("INSERT INTO update_runs(id,project_id,stage,data) VALUES(?,?,?,?)").run(candidate.id, candidate.projectId, candidate.stage, JSON.stringify(candidate));
    for (const scope of scopes) {
      const lock = await db.prepare("INSERT INTO update_locks(scope,run_id) VALUES(?,?) ON CONFLICT(scope) DO NOTHING").run(scope, candidate.id);
      if (!lock.changes) throw new ApiError("Une mise à jour utilise déjà ces sources. Son suivi reste disponible sur le projet concerné.", 409);
    }
    if (!options.assessment) await log("live", "updates.started", "Mise à jour du projet demandée.", input.projectId);
    return { run: candidate, created: true };
  });
  if (created && run.stage === "queued") {
    try { await dispatch(run.id); }
    catch (error) {
      run.stage = "queued";
      run.message = "Le lancement n’a pas été confirmé. Vérifiez l’exécuteur avant de relancer.";
      if (error instanceof ApiError && /GitHub refuse/.test(error.message)) {
        run.stage = "failed";
        run.message = "Le service de mise à jour n’a pas pu démarrer. Vérifiez sa configuration GitHub Actions.";
      }
      await transaction(async () => {
        const changed = await db.prepare("UPDATE update_runs SET stage=?,data=? WHERE id=? AND stage='queued'").run(run.stage, JSON.stringify(run), run.id);
        if (changed.changes && run.stage === "failed") {
          await db.prepare("DELETE FROM update_locks WHERE run_id=?").run(run.id);
          if (run.purpose === "assessment") await withAuditActor(run.actor, () => log("live", "updates.assessment_failed", run.message, run.projectId));
        }
      });
    }
  }
  return (await readUpdateRun(run.id))!;
}
const settingsSchema = z.object({
  targetId: z.string().min(1).max(300),
  archive: z.string().max(2_800_000).regex(/^[A-Za-z0-9+/]*={0,2}$/).optional(),
  filename: z.string().max(120).optional(),
  sshKey: z.string().trim().min(50).max(20000).optional(),
  hostKey: z.string().trim().regex(/^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/]+={0,2}$/).max(2000).optional(),
  localAgent: z.boolean().optional(),
});
export async function configureUpdateSource(projectId: string, raw: unknown, readDeployment = currentSourceDeployment) {
  const input = settingsSchema.parse(raw);
  const target = (await updateTargets(projectId)).find(target => target.id === input.targetId);
  if (!target) throw new ApiError("Service introuvable.", 404);
  if (target.provider === "o2switch" && target.mode !== "wordpress") throw new ApiError("Cette application demande un parcours de maintenance dédié ; ses sources ne sont pas traitées comme une archive Node.", 422);
  if (target.mode === "git") throw new ApiError("Les sources de ce service sont gérées par GitHub.");
  if (target.mode === "image") throw new ApiError("L’image et ses accès sont gérés par le connecteur Railway ; aucune archive source n’est nécessaire.", 422);
  if (target.mode === "wordpress" && input.localAgent) return { configured: false, ...(await requestAgentInstallation(target.remoteId, undefined, true)) };
  if (target.mode === "archive" && (!input.archive || Buffer.from(input.archive, "base64").length > 2_000_000 || !Buffer.from(input.archive, "base64").subarray(0, 2).equals(Buffer.from("PK")))) throw new ApiError("Fournissez une archive ZIP des sources, limitée à 2 Mo, sans node_modules ni secrets.");
  const scope = updateScope(target), db = await updateStorage();
  const previous = await readUpdateSource(target.id);
  const settings: SourceSettings = target.mode === "archive" ? { archive: input.archive, filename: input.filename || "sources.zip", deploymentId: await readDeployment(target) } : { wordpressAutoRemoval: previous?.settings.wordpressAutoRemoval, sshKey: input.sshKey || previous?.settings.sshKey, hostKey: input.hostKey || previous?.settings.hostKey };
  if (previous?.settings.agentInstallation?.state === "installing") throw new ApiError("L’installation automatique de l’agent est en cours.", 409);
  if (target.mode === "wordpress" && !settings.localAgent && (!settings.sshKey || !settings.hostKey || !/^-----BEGIN (OPENSSH |RSA |EC |)PRIVATE KEY-----/.test(settings.sshKey))) throw new ApiError("Renseignez une clé SSH privée et l’empreinte publique du serveur obtenue auprès de l’hébergeur.");
  await transaction(async () => {
    if (isPostgres()) {
      await db.prepare("SELECT id FROM projects WHERE id=? FOR UPDATE").get(projectId);
      await db.prepare("SELECT target_id FROM update_sources WHERE target_id=? FOR UPDATE").get(target.id);
    }
    if (await db.prepare("SELECT scope FROM update_locks WHERE scope=?").get(scope)) throw new ApiError("Attendez la fin de la mise à jour avant de modifier ses accès ou ses sources.", 409);
    if ((await readUpdateSource(target.id))?.revision !== previous?.revision) throw new ApiError("La configuration vient de changer. Rechargez avant de réessayer.", 409);
    await writeUpdateSource(target.id, projectId, settings);
    await log("live", "updates.source_configured", `Accès de mise à jour configuré pour ${target.name}.`, projectId);
  });
  return { configured: true };
}
export async function configureWordPressRemoval(projectId: string, raw: unknown) {
  const input = z.object({ targetId: z.string().min(1).max(300), slug: wordpressPluginSlug, allowed: z.boolean() }).parse(raw);
  const target = (await updateTargets(projectId)).find(target => target.id === input.targetId && target.mode === "wordpress");
  if (!target?.root) throw new ApiError("Site WordPress introuvable dans ce projet.", 404);
  const root = target.root;
  if (input.allowed) {
    const observation = await currentWordPressSecurity(target);
    const current = observation.closedPlugins === undefined && !observation.error ? await currentWordPressSecurity(target, { fresh: true }) : observation;
    if (!current.closedPlugins?.includes(input.slug) || !await closedWordPressPlugin(input.slug)) {
      throw new ApiError("Le contrôle actuel doit confirmer que cette extension installée est fermée sur WordPress.org.", 422);
    }
  }
  const db = await updateStorage();
  await transaction(async () => {
    if (isPostgres()) {
      await db.prepare("SELECT id FROM projects WHERE id=? FOR UPDATE").get(projectId);
      await db.prepare("SELECT target_id FROM update_sources WHERE target_id=? FOR UPDATE").get(target.id);
    }
    if (await db.prepare("SELECT scope FROM update_locks WHERE scope=?").get(updateScope(target))) {
      throw new ApiError("Attendez la fin de la maintenance pour modifier les autorisations de retrait.", 409);
    }
    const settings = (await readUpdateSource(target.id))?.settings || {};
    const allowed = new Set(allowedWordPressRemovals(target, settings));
    if (allowed.has(input.slug) === input.allowed) return;
    if (input.allowed) allowed.add(input.slug);
    else allowed.delete(input.slug);
    await writeUpdateSource(target.id, projectId, { ...settings, wordpressAutoRemoval: { projectId, root, slugs: [...allowed] } });
    await log("live", "updates.wordpress_removal_configured",
      `${input.allowed ? "Retrait automatique autorisé" : "Autorisation de retrait automatique révoquée"} pour ${input.slug} sur ${target.name}.`, projectId);
  });
  return { allowed: input.allowed };
}
export async function closeInterruptedUpdate(id: string, raw: unknown) {
  z.object({ confirmed: z.literal(true) }).parse(raw);
  const run = await readUpdateRun(id);
  if (!run) throw new ApiError("Mise à jour introuvable.", 404);
  await requireProject(run.projectId, "live");
  if (["completed", "failed"].includes(run.stage)) return run;
  if (Date.now() - Date.parse(run.updatedAt) < 30 * 60_000) throw new ApiError("La mise à jour peut encore être en cours. Attendez avant de clôturer son suivi.", 409);
  const runner = updateRunner();
  if (!runner) throw new ApiError("Accès à l’exécuteur manquant.", 503);
  const remote = await githubRequest(`/repos/${runner.repository}/actions/workflows/vigie-updates.yml/runs?event=workflow_dispatch&per_page=100`, runner.token);
  const matches = remote.workflow_runs.filter((item: { display_title: string }) => item.display_title === `vigie-update-${id}`);
  if (!matches.length || matches.some((item: { status: string }) => item.status !== "completed")) throw new ApiError("L’arrêt de l’exécuteur n’est pas confirmé. Vérifiez GitHub Actions.", 409);
  for (const target of run.targets.filter(target => target.mode === "wordpress")) {
    const settings = (await readUpdateSource(target.id))?.settings.localAgent;
    if (settings) await withHostingCredentials(target.connectionId, connection => assertAgentRunStopped(cpanelAgentFiles(connection, settings.directory), settings, target.root, run.id));
  }
  await transaction(async () => {
    const current = await readUpdateRun(id);
    if (current?.updatedAt !== run.updatedAt) throw new ApiError("Le traitement vient de reprendre. Rechargez son suivi.", 409);
    run.stage = "failed";
    run.message = "Suivi clôturé après vérification manuelle de l’hébergement. Les modifications déjà publiées sont conservées.";
    await writeUpdateRun(run);
    await (await updateStorage()).prepare("DELETE FROM update_locks WHERE run_id=?").run(id);
    await log("live", "updates.closed", run.message, run.projectId);
  });
  return run;
}
