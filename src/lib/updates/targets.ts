import { vercelState } from "../vercel";
import { railwayState } from "../railway";
import { projectHostingInstallations } from "../hosting-discovery";
import { requireProject } from "../db";
import { ApiError } from "../http";
import { githubUpdateToken, repositoryAllowed } from "./github";
import { readUpdateSource, updateStorage } from "./storage";
import type { UpdateTarget } from "./types";

export function sourceRoot(value: string | null) {
  const root = (value || "").replace(/^\/+|\/+$/g, "");
  if (root && (root.split("/").some(part => !part || part === "." || part === ".." || part.startsWith("-")) || /[\\\x00-\x1f]/.test(root))) throw new ApiError("Le répertoire source n’est pas valide.");
  return root;
}
export function updateScope(target: UpdateTarget) {
  return target.mode === "git" ? `git:${target.repository!.toLowerCase()}` : `${target.provider}:${target.connectionId}:${target.remoteId}:${target.environmentId || ""}`;
}
export async function updateTargets(projectId: string): Promise<UpdateTarget[]> {
  const project = await requireProject(projectId, "live");
  const [vercel, railway, hosting] = await Promise.all([vercelState(), railwayState(), projectHostingInstallations(projectId)]);
  const configured = new Set((await (await updateStorage()).prepare("SELECT target_id FROM update_sources WHERE project_id=?").all(projectId) as { target_id: string }[]).map(row => row.target_id));
  const targets: UpdateTarget[] = [];
  for (const item of vercel.projects.filter(item => item.projectId === projectId && !item.excluded)) {
    targets.push({ id: `vercel:${item.connectionId}:${item.id}`, projectId, name: item.name, provider: "vercel", connectionId: item.connectionId, remoteId: item.id, environmentId: null, repository: item.repository, branch: item.productionBranch || item.production?.branch || null, root: sourceRoot(item.rootDirectory), url: item.domains.find(domain => domain.environment === "production" && !domain.redirect)?.name ? `https://${item.domains.find(domain => domain.environment === "production" && !domain.redirect)!.name}/` : project.url || null, mode: item.repository ? "git" : "archive", configured: item.configured, unavailable: item.missingSince ? "Projet non retrouvé chez Vercel." : null });
  }
  for (const item of railway.projects.filter(item => item.projectId === projectId)) {
    for (const service of item.services.filter(service => service.environmentName.toLowerCase() === "production")) {
      const evidence = service.activeDeployments[0]?.evidence;
      targets.push({ id: `railway:${item.connectionId}:${service.id}:${service.environmentId}`, projectId, name: service.name, provider: "railway", builder: service.builder, connectionId: item.connectionId, remoteId: service.id, environmentId: service.environmentId, repository: service.repository, branch: evidence?.branch || null, root: sourceRoot(service.rootDirectory), url: service.domains[0] ? `https://${service.domains[0]}${service.healthcheckPath || "/"}` : null, mode: service.repository ? "git" : "archive", configured: item.configured, unavailable: item.missingSince ? "Projet non retrouvé chez Railway." : service.image ? "Image externe : hors du périmètre Node et dépendances." : !["RAILPACK", "DOCKERFILE"].includes(service.builder) ? "Construction personnalisée : une adaptation est nécessaire." : null });
    }
  }
  for (const item of hosting.filter(item => item.kind === "wordpress")) {
    const source = await readUpdateSource(`wordpress:${item.id}`);
    const agent = source?.settings.localAgent;
    const setup = source?.settings.agentInstallation;
    const setupMessage = setup?.state === "queued" ? setup.error || "L’installation automatique de l’agent est en attente." : setup?.state === "installing" ? "L’agent local s’installe automatiquement. Son démarrage est en cours de vérification." : setup?.state === "failed" ? setup.error || "L’installation automatique de l’agent sera réessayée." : null;
    let url = item.domains[0] ? `https://${item.domains[0]}/` : null;
    try {
      const home = new URL(item.inventory?.site?.home || "");
      if (home.protocol === "https:" && !home.username && !home.password && [...item.domains, ...item.aliases].includes(home.hostname)) url = home.href;
    } catch {}
    targets.push({ id: `wordpress:${item.id}`, projectId, name: item.domains[0] || project.name, provider: "o2switch", connectionId: item.connectionId, remoteId: item.id, environmentId: null, repository: null, branch: null, root: item.documentRoot, url, mode: "wordpress", configured: setup ? setup.state === "ready" && !!agent?.ready : agent ? agent.ready : configured.has(`wordpress:${item.id}`), unavailable: item.missingSince ? "Installation non retrouvée." : setupMessage || (agent?.environment === "production" && process.env.VIGIE_WORDPRESS_AGENT_PRODUCTION_ENABLED !== "1" ? "Agent installé. Les mises à jour de production attendent la validation du pilote." : item.inventory?.site?.multisite ? "WordPress multisite : intervention spécifique nécessaire." : item.inventory?.configuration?.fileModsDisabled ? "Les mises à jour sont désactivées dans WordPress." : !source ? "L’agent local sera installé automatiquement à la prochaine synchronisation." : null) });
  }
  return targets.map(target => ({ ...target, unavailable: project.lifecycle !== "active" ? "Projet archivé." : target.unavailable || (!target.url ? "Renseignez une URL pour vérifier le site après publication." : !target.configured ? "Configurez l’accès de mise à jour une première fois." : target.mode === "git" ? !target.branch ? "Synchronisez l’hébergement pour identifier la branche de production." : !repositoryAllowed(target.repository!) || !githubUpdateToken(target.repository!) ? "Autorisez ce dépôt dans les accès de mise à jour GitHub." : null : target.mode === "archive" && !configured.has(target.id) ? "Ajoutez les sources du projet une première fois." : null) }));
}
