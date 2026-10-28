import { list, log } from "./db";
import { observedProjectDetail } from "./project-observations";
import type { Project } from "./types";
import { ApiError } from "./http";
import { updateTargets } from "./updates/targets";
import { currentWordPressSecurity } from "./updates/wordpress-current-security";
import { scanCurrentNode } from "./updates/node-monitor";
import { automaticControlDue, controlSource } from "./automatic-control-state";
import type { UpdateTarget } from "./updates/types";
import { readAutomaticControl, writeAutomaticControl, claimAutomaticControl } from "./automatic-control-storage";
export { readAutomaticControl, writeAutomaticControl, claimAutomaticControl } from "./automatic-control-storage";

export async function automaticControlsNeeded(provider: UpdateTarget["provider"], force = false) {
  for (const project of (await list<Project>("projects", "live")).filter(project => project.lifecycle === "active")) {
    const detail = await observedProjectDetail(project.id, "live");
    for (const target of (await updateTargets(project.id)).filter(target => target.provider === provider)) {
      if (automaticControlDue(await readAutomaticControl(target.id), controlSource(target, detail)?.identity || "unavailable", Date.now(), force)) return true;
    }
  }
  return false;
}

async function scan(target: UpdateTarget, source: NonNullable<ReturnType<typeof controlSource>>) {
  if (target.mode !== "wordpress") return scanCurrentNode(target, source.commit);
  const observation = await currentWordPressSecurity(target, { fresh: true });
  if (observation.error || !observation.check) throw new ApiError(observation.error || "Inventaire ou contrôle de sécurité WordPress indisponible.");
  return { checks: [observation.check], updates: [], warnings: observation.warnings };
}

export async function reconcileAutomaticControls(options: { force?: boolean; provider?: UpdateTarget["provider"] } = {}, dependencies = { projects: () => list<Project>("projects", "live"), detail: observedProjectDetail, targets: updateTargets, scan, read: readAutomaticControl, write: writeAutomaticControl, claim: claimAutomaticControl, log }) {
  const result = { checked: 0, failed: 0, deferred: 0 };
  for (const project of (await dependencies.projects()).filter(project => project.lifecycle === "active")) {
    try {
      const detail = await dependencies.detail(project.id, "live");
      for (const target of (await dependencies.targets(project.id)).filter(target => !options.provider || target.provider === options.provider)) {
        const release = await dependencies.claim(target.id);
        if (!release) { result.deferred++; continue; }
        try {
          const source = controlSource(target, detail);
          const identity = source?.identity || "unavailable";
          const previous = await dependencies.read(target.id);
          if (!automaticControlDue(previous, identity, Date.now(), options.force)) continue;
          const attemptedAt = new Date().toISOString();
          try {
            if (!source) throw new ApiError("Le relevé de l’hébergeur ou l’inventaire actuel est manquant, périmé ou non vérifiable.");
            const observation = await dependencies.scan(target, source);
            // A deployment or inventory may change while the scanner is running.
            const fresh = await dependencies.detail(project.id, "live");
            const currentTargets = await dependencies.targets(project.id);
            const current = currentTargets.find(item => item.id === target.id);
            if (fresh.project.lifecycle !== "active" || !current || controlSource(current, fresh)?.identity !== identity) throw new ApiError("Le déploiement a changé pendant le contrôle. Une reprise automatique est prévue.");
            await dependencies.write({ targetId: target.id, identity, attemptedAt, checkedAt: new Date().toISOString(), ...observation });
            result.checked++;
          } catch (error) {
            const message = error instanceof ApiError ? error.message : "Le contrôle automatique n’a pas abouti. Nouvelle tentative au prochain passage ; consultez les accès et l’inventaire du projet.";
            await dependencies.write({ ...(previous?.identity === identity ? previous : { checks: [], updates: [], warnings: [] }), targetId: target.id, identity, attemptedAt, error: message });
            result.failed++;
          }
        } finally { await release(); }
      }
    } catch { result.failed++; }
  }
  if (result.checked || result.failed) await dependencies.log("live", "hosting.automatic_control", `Contrôle automatique : ${result.checked} service(s) vérifié(s), ${result.failed} échec(s), ${result.deferred} différé(s).`);
  return result;
}
