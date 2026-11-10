import { z } from "zod";
import { ApiError } from "../http";
import type { SiteInventory } from "../types";
import type { UpdateRun, UpdateTarget, UpdateResult, UpdateStage } from "./types";
import { agentPlan, withLocalWordPressAgent } from "./wordpress-agent";
import { checkWordPressRequirements } from "./wordpress-security";
import { closedWordPressPlugin, freeWordPressScanner } from "./wordpress-free-security";
import { requireSecurityPass, securityCheck } from "./security";
import { hostingInstallation } from "../hosting-discovery";
import { refreshWordPressWeb } from "./wordpress-web-check";
import { wordpressMaintenanceCheck, recordWordPressManualUpdates, selectWordPressRemovals, wordpressCompletionMessage } from "./wordpress-maintenance";
import { finishAssessment, wordpressAssessmentChanges } from "./assessment";

export async function executeLocalWordPress(run: UpdateRun, target: UpdateTarget, result: UpdateResult, inventory: SiteInventory, progress: (stage: UpdateStage, message: string) => Promise<void>, dependencies: { agent: typeof withLocalWordPressAgent; scanner: typeof freeWordPressScanner; closed?: typeof closedWordPressPlugin } = { agent: withLocalWordPressAgent, scanner: freeWordPressScanner }) {
  return dependencies.agent(target, async (operation, _settings, allowedRemovals = []) => {
    await progress("checking", "L’agent local prépare le plan WordPress sans connexion SSH.");
    const inspection = await operation(run.id, "inspect");
    const eligibility = z.object({ multisite: z.boolean(), fileModsDisabled: z.boolean(), home: z.string().url() }).parse(inspection.eligibility);
    if (eligibility.multisite || eligibility.fileModsDisabled || new URL(eligibility.home).hostname.replace(/^www\./, "") !== new URL(target.url!).hostname.replace(/^www\./, "")) throw new ApiError("Le site ou sa configuration ne correspond pas au parcours de maintenance.");
    const proposed = agentPlan(inspection.plan);
    if (proposed.licenses) result.wordpressLicenses = { checkedAt: new Date().toISOString(), items: proposed.licenses };
    if (proposed.php !== inventory.php?.version) throw new ApiError("Le PHP de l’agent local diffère du PHP web. Aucun site n’a été modifié.");
    const scan = dependencies.scanner();
    const plan = await scan.prepare(proposed);
    checkWordPressRequirements(plan);
    const baseline = await scan(plan, false);
    result.checks = [securityCheck("WPVulnerability", "before", "WordPress, extensions et thèmes publics identifiables", baseline)];
    const removals: string[] = [];
    for (const slug of selectWordPressRemovals(plan, allowedRemovals)) {
      if (await (dependencies.closed || closedWordPressPlugin)(slug)) removals.push(slug);
      else result.warnings.push(`${slug} : fermeture non confirmée par WordPress.org, extension conservée.`);
    }
    const remainingPlan = { ...plan, plugins: plan.plugins.filter(item => !removals.includes(item.slug)) };
    const candidateFindings = await scan(remainingPlan, true);
    // Keep catalogue closure evidence in the run history, including on assessments.
    recordWordPressManualUpdates(result, plan, inventory, candidateFindings);
    const candidate = wordpressMaintenanceCheck(remainingPlan, "candidate", "Versions proposées et composants conservés de WordPress", candidateFindings);
    result.warnings.push(...scan.warnings.filter(warning => !removals.some(slug => warning.startsWith(`${slug} :`))), "PHP reste géré par l’hébergeur.");
    result.checks.push(candidate); requireSecurityPass(candidate);
    if (scan.warnings.length && candidate.status === "passed") { candidate.status = "warning"; candidate.message += " Certains composants sont conservés et hors couverture ; détails dans le suivi."; }
    if (removals.length) plan.removePlugins = removals;
    if (run.purpose === "assessment") {
      finishAssessment(result, wordpressAssessmentChanges(plan), "Plan de l’agent, prérequis et vulnérabilités contrôlés. La recette métier sur une copie du site reste nécessaire ; aucune sauvegarde ni installation lancée.");
      return;
    }
    if (wordpressAssessmentChanges(plan).length === 0) {
      result.wordpressNoChanges = true;
      result.stage = "completed"; result.message = wordpressCompletionMessage(result, false); return;
    }
    result.stage = "publishing";
    await progress("publishing", removals.length ? "L’agent local applique les mises à jour et les retraits autorisés." : "L’agent local installe les mises à jour officielles compatibles.");
    const update = await operation(run.id, "update", { plan, webPhp: inventory.php!.version }).catch(async error => {
      await progress("verifying", "La mise à jour a été interrompue. Vérification de l’accès au site.");
      await refreshWordPressWeb(target, "postflight");
      throw error;
    });
    const checkedAt = Date.now();
    await progress("verifying", "Contrôle du site et des versions installées par l’agent local.");
    await refreshWordPressWeb(target, "postflight");
    const installed = agentPlan(update.plan);
    result.stage = "verifying";
    if (installed.wordpress.current !== plan.wordpress.target || ["plugins", "themes"].some(kind => {
      const key = kind as "plugins" | "themes";
      return installed[key].length !== remainingPlan[key].length || remainingPlan[key].some(item => installed[key].find(next => next.slug === item.slug)?.current !== item.target);
    })) throw new ApiError("Les versions installées ne correspondent pas au plan vérifié.");
    // A cached public page can still answer while the actual WordPress is broken.
    const web = (await hostingInstallation(target.remoteId)).inventory;
    if (!web || web.source !== "wordpress-observer" || web.collectionMode === "early" || web.error || !web.observedAt || Date.parse(web.observedAt) < checkedAt - 5000 || web.wordpress?.version !== installed.wordpress.current || web.php?.version !== installed.php || web.plugins.some(plugin => !plugin.mustUse && removals.includes(plugin.slug)) || installed.plugins.some(item => (web.plugins.find(plugin => !plugin.mustUse && plugin.slug === item.slug)?.version || "") !== item.current) || installed.themes.some(item => (web.themes.find(theme => theme.slug === item.slug)?.version || "") !== item.current)) throw new ApiError("Le WordPress chargé côté web ne confirme pas les versions installées.");
    if (installed.licenses) result.wordpressLicenses = { checkedAt: new Date().toISOString(), items: installed.licenses };
    const final = wordpressMaintenanceCheck(remainingPlan, "after", "WordPress, extensions et thèmes réellement installés", await scan(installed, false));
    result.checks.push(final); requireSecurityPass(final);
    result.stage = "completed";
    if (removals.length) {
      result.removedWordPressPlugins = removals;
      result.manualUpdates = result.manualUpdates?.filter(item => !removals.some(slug => item.package === `plugins/${slug}`));
    }
    result.message = wordpressCompletionMessage(result, true);
    result.warnings.push("Le module Backup gère les sauvegardes. Le contrôle web couvre l’accès au site et le chargement de WordPress.");
  });
}
