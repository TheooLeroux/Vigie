import { z } from "zod";
import { ApiError } from "../http";
import type { SiteInventory } from "../types";
import type { UpdateRun, UpdateTarget, UpdateResult, UpdateStage } from "./types";
import { agentPlan, withLocalWordPressAgent } from "./wordpress-agent";
import { checkWordPressRequirements } from "./wordpress-security";
import { freeWordPressScanner } from "./wordpress-free-security";
import { requireSecurityPass, securityCheck } from "./security";
import { checkPublicSite } from "./providers";
import { collectHostingInventories } from "../hosting-inventory";
import { hostingInstallation } from "../hosting-discovery";
import { refreshWordPressWeb } from "./wordpress-web-check";
import { wordpressMaintenanceCheck, recordWordPressManualUpdates, wordpressCompletionMessage } from "./wordpress-maintenance";

export async function executeLocalWordPress(run: UpdateRun, target: UpdateTarget, result: UpdateResult, inventory: SiteInventory, progress: (stage: UpdateStage, message: string) => Promise<void>) {
  return withLocalWordPressAgent(target, async (operation, settings) => {
    await progress("checking", "L’agent local prépare le plan WordPress sans connexion SSH.");
    const inspection = await operation(run.id, "inspect");
    const eligibility = z.object({ multisite: z.boolean(), fileModsDisabled: z.boolean(), home: z.string().url() }).parse(inspection.eligibility);
    if (eligibility.multisite || eligibility.fileModsDisabled || new URL(eligibility.home).hostname.replace(/^www\./, "") !== new URL(target.url!).hostname.replace(/^www\./, "")) throw new ApiError("Le site ou sa configuration ne correspond pas au parcours de maintenance.");
    const proposed = agentPlan(inspection.plan);
    if (proposed.php !== inventory.php?.version) throw new ApiError("Le PHP de l’agent local diffère du PHP web. Aucun site n’a été modifié.");
    const scan = freeWordPressScanner();
    const plan = await scan.prepare(proposed);
    checkWordPressRequirements(plan);
    const baseline = await scan(plan, false);
    result.checks = [securityCheck("WPVulnerability", "before", "WordPress, extensions et thèmes publics identifiables", baseline)];
    const candidateFindings = await scan(plan, true);
    recordWordPressManualUpdates(result, plan, inventory, candidateFindings);
    const candidate = wordpressMaintenanceCheck(plan, "candidate", "Versions proposées et composants conservés de WordPress", candidateFindings);
    result.warnings.push(...scan.warnings, "PHP est affiché et conservé ; sa gestion reste chez l’hébergeur. Les thèmes sont conservés.");
    result.checks.push(candidate); requireSecurityPass(candidate);
    if (scan.warnings.length && candidate.status === "passed") { candidate.status = "warning"; candidate.message += " Certains composants sont conservés et hors couverture ; détails dans le suivi."; }
    if (plan.wordpress.current === plan.wordpress.target && plan.plugins.every(item => item.current === item.target)) {
      result.stage = "completed"; result.message = wordpressCompletionMessage(result, false); return;
    }
    await progress("checking", "Sauvegarde privée des fichiers et de la base par l’agent local.");
    const saved = await operation(run.id, "backup", { webPhp: inventory.php!.version });
    const expectedBackup = `${settings.directory}/backups/${run.id}`;
    if (saved.backup !== expectedBackup) throw new ApiError("La sauvegarde locale n’a pas pu être confirmée.");
    result.backup = expectedBackup;
    result.stage = "publishing";
    await progress("publishing", "L’agent local met à jour WordPress et les extensions compatibles. PHP et thèmes sont conservés.");
    const installed = agentPlan((await operation(run.id, "update", { plan, webPhp: inventory.php!.version })).plan);
    result.stage = "verifying";
    await progress("verifying", "Contrôle du site et des versions installées par l’agent local.");
    if (installed.wordpress.current !== plan.wordpress.target || ["plugins", "themes"].some(kind => {
      const key = kind as "plugins" | "themes";
      return installed[key].length !== plan[key].length || plan[key].some(item => installed[key].find(next => next.slug === item.slug)?.current !== item.target);
    })) throw new ApiError("Les versions installées ne correspondent pas au plan vérifié.");
    // A cached public page can still answer while the actual WordPress is broken.
    const checkedAt = Date.now();
    await refreshWordPressWeb(target, "postflight");
    const web = (await hostingInstallation(target.remoteId)).inventory;
    if (!web || web.source !== "wordpress-observer" || web.collectionMode === "early" || web.error || !web.observedAt || Date.parse(web.observedAt) < checkedAt - 5000 || web.wordpress?.version !== installed.wordpress.current || web.php?.version !== installed.php || installed.plugins.some(item => (web.plugins.find(plugin => !plugin.mustUse && plugin.slug === item.slug)?.version || "") !== item.current) || installed.themes.some(item => (web.themes.find(theme => theme.slug === item.slug)?.version || "") !== item.current)) throw new ApiError("Le WordPress chargé côté web ne confirme pas les versions installées. Les sauvegardes sont conservées.");
    const final = wordpressMaintenanceCheck(plan, "after", "WordPress, extensions et thèmes réellement installés", await scan(installed, false));
    result.checks.push(final); requireSecurityPass(final);
    result.stage = "completed";
    result.message = wordpressCompletionMessage(result, true);
    result.warnings.push("La sauvegarde reste privée sur l’hébergement. Une restauration de base nécessite une décision explicite sur les données nouvelles ; les flux premium et les tests métier restent à qualifier.");
  });
}
