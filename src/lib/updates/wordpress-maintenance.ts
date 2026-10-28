import type { SiteInventory } from "../types";
import { manualPluginAction, manualThemeAction } from "../wordpress-component-policy";
import { securityCheck } from "./security";
import type { SecurityFinding, UpdateCheck, UpdateResult, WordPressManualUpdate } from "./types";
import type { WordPressUpdatePlan } from "./wordpress-security";

// Retention applies only to the exact package/version left unchanged by this plan.
// Alerts remain in findings; changed components always face the full security gate.
export function wordpressMaintenanceCheck(plan: WordPressUpdatePlan, phase: "candidate" | "after", scope: string, findings: SecurityFinding[]): UpdateCheck {
  const retained = [
    ...(plan.wordpress.current === plan.wordpress.target ? [{ package: "wordpress/wordpress", version: plan.wordpress.current }] : []),
    ...(["plugins", "themes"] as const).flatMap(kind => plan[kind].filter(item => item.current === item.target).map(item => ({ package: `${kind}/${item.slug}`, version: item.current }))),
  ];
  const blockers = findings.filter(finding => !retained.some(item => item.package === finding.package && item.version === finding.version));
  const check = securityCheck("WPVulnerability", phase, scope, blockers);
  check.findings = findings;
  check.wordpressRetained = retained;
  if (!blockers.length && findings.length) {
    check.status = "warning";
    check.message = `Les composants mis à jour passent le contrôle. ${findings.length} alerte(s) restent sur des composants conservés : intervention manuelle requise. La sécurité complète du site n’est pas validée.`;
  }
  return check;
}

export function recordWordPressManualUpdates(result: UpdateResult, plan: WordPressUpdatePlan, inventory: SiteInventory, findings: SecurityFinding[] = []) {
  const items: WordPressManualUpdate[] = [];
  const add = (item: WordPressManualUpdate) => { if (!items.some(existing => existing.package === item.package)) items.push(item); };
  for (const kind of ["plugins", "themes"] as const) for (const item of plan[kind]) {
    if (item.current !== item.target) continue;
    const observed = inventory[kind].find(observed => observed.slug === item.slug);
    const signals = findings.filter(finding => finding.package === `${kind}/${item.slug}` && finding.version === item.current);
    const vulnerable = signals.length > 0;
    if (kind === "themes" && observed?.updateState === "current" && !vulnerable && !item.template && item.updateOrigin !== "external") continue;
    const reason = item.manualReason || (kind === "themes" ? "Thème conservé : sa mise à jour et ses personnalisations demandent une recette dédiée." : vulnerable ? signals.some(finding => !finding.kind || finding.kind === "vulnerability") ? "Aucun correctif automatique validé pour cette version vulnérable." : "Signal de sécurité à vérifier ; aucun traitement automatique validé." : "");
    if (!reason) continue;
    add({ package: `${kind}/${item.slug}`, version: item.current, ...(observed?.latestVersion && observed.latestVersion !== item.current ? { target: observed.latestVersion } : {}), reason, action: kind === "themes" ? manualThemeAction : manualPluginAction });
  }
  for (const item of inventory.plugins.filter(item => item.mustUse && item.slug !== "vigie-observer")) add({ package: `mu-plugins/${item.slug}`, version: item.version || "inconnue", reason: "Extension obligatoire ou code personnalisé, hors des mises à jour automatiques et du catalogue de sécurité.", action: "Faire vérifier et livrer ce code par son développeur ; conserver une copie des sources et tester les fonctions concernées." });
  if (plan.wordpress.current === plan.wordpress.target && (plan.wordpress.manualReason || plan.warnings.some(warning => warning.startsWith("WordPress ")) || findings.some(finding => finding.package === "wordpress/wordpress"))) add({ package: "wordpress/wordpress", version: plan.wordpress.current, reason: plan.wordpress.manualReason || "Aucune mise à jour automatique du cœur validée ; prérequis ou correctif à vérifier.", action: "Préparer une copie de test et vérifier la compatibilité PHP, WordPress et extensions avant intervention." });
  result.manualUpdates = items;
}

export function wordpressCompletionMessage(result: UpdateResult, changed: boolean) {
  const count = result.manualUpdates?.length || 0;
  return `${changed ? "Mises à jour automatiques terminées et site vérifié." : "Aucune mise à jour automatique applicable."}${count ? ` ${count} composant(s) conservé(s) à traiter manuellement ; consultez la liste des interventions restantes.` : ""}`;
}
