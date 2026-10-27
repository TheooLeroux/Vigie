import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError } from "../http";
import { log, transaction } from "../db";
import { isPostgres } from "../storage";
import { hostingDiscovery, hostingInstallation } from "../hosting-discovery";
import { hostingConnections, withHostingCredentials } from "../hosting-connections";
import { agentBundle, provisionLocalAgent, cpanelAgentFiles, openAgentPayload, type LocalAgentSettings } from "./wordpress-agent";
import { githubRequest, updateRunner } from "./github";
import { readUpdateSource, updateStorage, writeUpdateSource } from "./storage";
import type { SourceSettings, UpdateTarget } from "./types";
import type { HostingInstallationView } from "../types";

type Installation = NonNullable<SourceSettings["agentInstallation"]>;
async function lockSource(targetId: string, projectId: string) {
  if (isPostgres()) {
    const db = await updateStorage();
    // Keep the same lock order as configuration and update execution; also covers first insertion.
    await db.prepare("SELECT id FROM projects WHERE id=? FOR UPDATE").get(projectId);
    await db.prepare("SELECT target_id FROM update_sources WHERE target_id=? FOR UPDATE").get(targetId);
  }
}
function eligible(site: HostingInstallationView) {
  return site.kind === "wordpress" && !!site.project && site.project.lifecycle === "active" && !site.ignored && !site.missingSince;
}
function activeLease(setup?: Installation) {
  return setup?.state === "installing" && !!setup.leaseUntil && Date.parse(setup.leaseUntil) > Date.now();
}
export async function dispatchAgentInstallation(installationId: string, requestId: string) {
  const runner = updateRunner();
  if (!runner) throw new ApiError("Le service d’installation automatique n’est pas encore configuré.", 503);
  await githubRequest(`/repos/${runner.repository}/actions/workflows/vigie-wordpress-agents.yml/dispatches`, runner.token, "POST", { ref: runner.ref, inputs: { installation_id: installationId, request_id: requestId } });
}
export async function requestAgentInstallation(id: string, dispatch = dispatchAgentInstallation, retry = false) {
  z.string().uuid().parse(id);
  const site = await hostingInstallation(id);
  if (!eligible(site)) return { queued: false };
  const targetId = `wordpress:${id}`;
  const prepared = await transaction(async () => {
    await lockSource(targetId, site.project!.id);
    if (await (await updateStorage()).prepare("SELECT scope FROM update_locks WHERE scope=?").get(`o2switch:${site.connectionId}:${site.id}:`)) return null;
    const current = await readUpdateSource(targetId), setup = current?.settings.agentInstallation;
    if (!retry && current?.settings.localAgent?.ready && (!setup || setup.state === "ready")) return null;
    if (activeLease(setup)) return null;
    if (!retry && setup?.nextAttemptAt && Date.parse(setup.nextAttemptAt) > Date.now()) return null;
    if (!retry && setup?.state === "queued" && setup.dispatchedAt && Date.now() - Date.parse(setup.dispatchedAt) < 5 * 60_000) return null;
    const now = new Date().toISOString();
    const job: Installation = { requestId: setup?.state === "queued" ? setup.requestId : randomUUID(), root: site.documentRoot, connectionId: site.connectionId, state: "queued", attempts: setup?.attempts || 0, requestedAt: setup?.requestedAt || now, dispatchedAt: now };
    await writeUpdateSource(targetId, site.project!.id, { ...current?.settings, agentInstallation: job });
    await log("live", "hosting.agent_queued", `Installation automatique de l’agent demandée sur ${site.domains[0]}.`, site.project!.id);
    return job;
  });
  if (!prepared) return { queued: false };
  try { await dispatch(id, prepared.requestId); }
  catch (error) {
    await transaction(async () => {
      await lockSource(targetId, site.project!.id);
      const current = await readUpdateSource(targetId);
      if (current?.settings.agentInstallation?.requestId !== prepared.requestId || current.settings.agentInstallation.state !== "queued") return;
      const message = "Le lancement de l’installation n’a pas été confirmé. La prochaine synchronisation ou le contrôle automatique réessaiera.";
      await writeUpdateSource(targetId, site.project!.id, { ...current.settings, agentInstallation: { ...current.settings.agentInstallation, error: message } });
      await log("live", "hosting.agent_dispatch_pending", message, site.project!.id);
    });
  }
  return { queued: true };
}
async function prepareSite(id: string) {
  let site = await hostingInstallation(id);
  const { provisionLinkedObserver, collectHostingInventories } = await import("../hosting-inventory");
  if (!site.observerConfigured) { await provisionLinkedObserver(id); site = await hostingInstallation(id); }
  if (!site.inventory?.observedAt || Date.now() - Date.parse(site.inventory.observedAt) > 5 * 60_000 || site.inventory.error) {
    await collectHostingInventories(site.connectionId, fetch, fetch, id);
    site = await hostingInstallation(id);
  }
  if (!site.inventory?.php || site.inventory.source !== "wordpress-observer" || !site.inventory.observedAt || Date.now() - Date.parse(site.inventory.observedAt) > 5 * 60_000) throw new ApiError("L’agent attend un inventaire WordPress récent avec le PHP web.");
  return site;
}
export async function processAgentInstallation(id: string, requestId?: string, dependencies: { prepare?: typeof prepareSite; provision?: typeof provisionLocalAgent } = {}) {
  z.string().uuid().parse(id); if (requestId) z.string().uuid().parse(requestId);
  const site = await hostingInstallation(id);
  if (!eligible(site)) return false;
  const targetId = `wordpress:${id}`;
  const claimed = await transaction(async () => {
    await lockSource(targetId, site.project!.id);
    const current = await readUpdateSource(targetId), setup = current?.settings.agentInstallation;
    if (!current || !setup || setup.state === "ready" || activeLease(setup) || (requestId && setup.requestId !== requestId) || (setup.nextAttemptAt && Date.parse(setup.nextAttemptAt) > Date.now())) return null;
    if (setup.root !== site.documentRoot || setup.connectionId !== site.connectionId) throw new ApiError("Le rattachement de l’agent a changé.", 409);
    const scope = `o2switch:${site.connectionId}:${site.id}:`;
    if (await (await updateStorage()).prepare("SELECT scope FROM update_locks WHERE scope=?").get(scope)) return null;
    const job: Installation = { ...setup, state: "installing", attempts: setup.attempts + 1, leaseUntil: new Date(Date.now() + 20 * 60_000).toISOString(), error: undefined, nextAttemptAt: undefined };
    await writeUpdateSource(targetId, site.project!.id, { ...current.settings, agentInstallation: job });
    return job;
  });
  if (!claimed) return false;
  try {
    const fresh = await (dependencies.prepare || prepareSite)(id);
    if (!eligible(fresh) || fresh.documentRoot !== claimed.root || fresh.connectionId !== claimed.connectionId || fresh.project?.id !== site.project?.id) throw new ApiError("Le rattachement WordPress a changé pendant l’installation.", 409);
    const webPhp = fresh.inventory!.php!.version;
    const previous = await readUpdateSource(targetId);
    const bundle = await withHostingCredentials(site.connectionId, connection => agentBundle(site.documentRoot, connection.username, webPhp, site.suggestedEnvironment, previous?.settings.localAgent));
    await transaction(async () => {
      await lockSource(targetId, site.project!.id);
      const current = await readUpdateSource(targetId);
      if (current?.settings.agentInstallation?.requestId !== claimed.requestId || current.settings.agentInstallation.state !== "installing") throw new ApiError("L’installation a changé de propriétaire.", 409);
      await writeUpdateSource(targetId, site.project!.id, { ...current.settings, localAgent: bundle.settings });
    });
    let url = fresh.domains[0] ? `https://${fresh.domains[0]}/` : null;
    try { const home = new URL(fresh.inventory?.site?.home || ""); if (home.protocol === "https:" && !home.username && !home.password && [...fresh.domains, ...fresh.aliases].includes(home.hostname)) url = home.href; } catch {}
    if (!url) throw new ApiError("Le domaine WordPress n’est pas défini.");
    const target: UpdateTarget = { id: targetId, projectId: site.project!.id, name: site.domains[0], provider: "o2switch", connectionId: site.connectionId, remoteId: id, environmentId: null, repository: null, branch: null, root: site.documentRoot, url, mode: "wordpress", configured: false, unavailable: null };
    await (dependencies.provision || provisionLocalAgent)(target, bundle.settings, webPhp);
    const latest = await hostingInstallation(id);
    if (!eligible(latest) || latest.documentRoot !== claimed.root || latest.connectionId !== claimed.connectionId || latest.project?.id !== site.project?.id || latest.suggestedEnvironment !== bundle.settings.environment) throw new ApiError("Le rattachement WordPress a changé pendant l’installation.", 409);
    await transaction(async () => {
      await lockSource(targetId, site.project!.id);
      const current = await readUpdateSource(targetId);
      if (current?.settings.agentInstallation?.requestId !== claimed.requestId || current.settings.localAgent?.secret !== bundle.settings.secret) throw new ApiError("La configuration de l’agent vient de changer.", 409);
      await writeUpdateSource(targetId, site.project!.id, { ...current.settings, localAgent: { ...bundle.settings, ready: true }, agentInstallation: { ...claimed, state: "ready", leaseUntil: undefined } });
      await log("live", "hosting.agent_installed", `Agent local installé et vérifié sur ${site.domains[0]}, sans mise à jour du site.`, site.project!.id);
    });
    return true;
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "L’installation de l’agent n’a pas pu être confirmée. Une reprise automatique est prévue.";
    await transaction(async () => {
      await lockSource(targetId, site.project!.id);
      const current = await readUpdateSource(targetId);
      if (current?.settings.agentInstallation?.requestId !== claimed.requestId) return;
      await writeUpdateSource(targetId, site.project!.id, { ...current.settings, ...(current.settings.localAgent ? { localAgent: { ...current.settings.localAgent, ready: false } } : {}), agentInstallation: { ...claimed, state: "failed", leaseUntil: undefined, nextAttemptAt: new Date(Date.now() + Math.min(60, 5 * 2 ** Math.min(claimed.attempts - 1, 4)) * 60_000).toISOString(), error: message } });
      await log("live", "hosting.agent_failed", `Agent sur ${site.domains[0]} : ${message}`, site.project!.id);
    });
    return false;
  }
}
export async function requestLinkedAgents(connectionId: string, dispatch = dispatchAgentInstallation) {
  const sites = (await hostingDiscovery(connectionId)).installations.filter(eligible);
  let queued = 0;
  for (const site of sites) if ((await requestAgentInstallation(site.id, dispatch)).queued) queued++;
  return { queued };
}
async function agentHeartbeatHealthy(site: HostingInstallationView, settings: LocalAgentSettings) {
  try {
    return await withHostingCredentials(site.connectionId, async connection => {
      const raw = await cpanelAgentFiles(connection, settings.directory).read("heartbeat.json");
      if (!raw) return false;
      const value = z.object({ protocol: z.literal("vigie-local-v1"), root: z.string(), php: z.string(), time: z.number().int() }).parse(openAgentPayload(JSON.parse(raw), settings.secret));
      return value.root === site.documentRoot && Math.abs(Date.now() / 1000 - value.time) <= 180;
    });
  } catch { return false; }
}
export async function reconcileAgentInstallations(dependencies: { healthy?: typeof agentHeartbeatHealthy; prepare?: typeof prepareSite; provision?: typeof provisionLocalAgent } = {}) {
  let ready = 0, failed = 0;
  for (const connection of (await hostingConnections()).filter(connection => connection.configured)) {
    const sites = (await hostingDiscovery(connection.id)).installations.filter(eligible);
    for (const site of sites) {
      try {
        const previous = (await readUpdateSource(`wordpress:${site.id}`))?.settings;
        if (previous?.localAgent?.ready && (!previous.agentInstallation || previous.agentInstallation.state === "ready")) {
          if (await (dependencies.healthy || agentHeartbeatHealthy)(site, previous.localAgent)) { ready++; continue; }
          await requestAgentInstallation(site.id, async () => {}, true);
        }
        await requestAgentInstallation(site.id, async () => {});
        const settings = (await readUpdateSource(`wordpress:${site.id}`))?.settings;
        if (settings?.localAgent?.ready && (!settings.agentInstallation || settings.agentInstallation.state === "ready")) { ready++; continue; }
        if (await processAgentInstallation(site.id, undefined, dependencies)) ready++; else if ((await readUpdateSource(`wordpress:${site.id}`))?.settings.agentInstallation?.state === "failed") failed++;
      } catch {
        failed++;
        await log("live", "hosting.agent_failed", `La préparation de l’agent sur ${site.domains[0]} sera réessayée au prochain contrôle.`, site.project!.id);
      }
    }
  }
  return { ready, failed };
}
