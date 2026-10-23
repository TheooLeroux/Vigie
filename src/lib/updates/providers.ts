import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { ApiError } from "../http";
import { withVercelCredentials } from "../vercel";
import { withRailwayCredentials } from "../railway";
import { publicAddress } from "../connectors/wordpress-observer";
import { githubRepository, deploymentEvidence } from "../connectors/railway-evidence";
import { sourceRoot } from "./targets";
import { runCommand } from "./process";
import type { UpdateTarget } from "./types";

export async function vercelUpdateRequest(target: UpdateTarget, path: string, method = "GET", input?: unknown, transport: typeof fetch = fetch) {
  return withVercelCredentials(target.connectionId, async (token, teamId) => {
    const url = new URL(`https://api.vercel.com${path}`);
    url.searchParams.set("teamId", teamId);
    const response = await transport(url, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(input ? { body: JSON.stringify(input) } : {}), redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new ApiError(`Vercel refuse l’opération (${response.status}). Vérifiez l’accès au projet.`, 502);
    return response.json();
  });
}
export async function railwayUpdateRequest(target: UpdateTarget, query: string, variables: unknown, transport: typeof fetch = fetch) {
  return withRailwayCredentials(target.connectionId, async token => {
    const response = await transport("https://backboard.railway.com/graphql/v2", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }), redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new ApiError(`Railway refuse l’opération (${response.status}). Vérifiez l’accès au service.`, 502);
    const data = await response.json();
    if (data.errors || !data.data) throw new ApiError("Railway n’a pas confirmé l’opération demandée.", 502);
    return data.data;
  });
}
const railwayInstanceQuery = `query UpdateInstance($serviceId:String!,$environmentId:String!){service(id:$serviceId){projectId} serviceInstance(serviceId:$serviceId,environmentId:$environmentId){rootDirectory builder source{repo image} latestDeployment{id status meta} activeDeployments{id status meta}}}`;
export async function readRailwayInstance(target: UpdateTarget) {
  return railwayUpdateRequest(target, railwayInstanceQuery, { serviceId: target.remoteId, environmentId: target.environmentId });
}
export async function currentSourceDeployment(target: UpdateTarget): Promise<string | null> {
  if (target.provider === "vercel") {
    const project = await vercelUpdateRequest(target, `/v9/projects/${target.remoteId}`);
    if (project.link || sourceRoot(project.rootDirectory) !== target.root) throw new ApiError("La source du projet Vercel a changé. Synchronisez sa fiche.");
    return project.targets?.production?.id || null;
  }
  const instance = (await readRailwayInstance(target)).serviceInstance;
  if (instance.source?.repo || instance.source?.image || sourceRoot(instance.rootDirectory) !== target.root) throw new ApiError("La source du service Railway a changé. Synchronisez sa fiche.");
  return instance.activeDeployments?.[0]?.id || null;
}
export async function providerPreflight(target: UpdateTarget, nodeVersion: string) {
  if (target.provider === "vercel") {
    const remote = await vercelUpdateRequest(target, `/v9/projects/${target.remoteId}`);
    if (remote.latestDeployments?.some((deployment: any) => deployment.target === "production" && ["QUEUED", "INITIALIZING", "BUILDING"].includes(deployment.readyState || deployment.state))) throw new ApiError("Vercel déploie déjà ce projet. Attendez la fin de son déploiement.");
    const repository = remote.link?.type === "github" ? `${remote.link.org}/${remote.link.repo}` : null;
    if (repository !== target.repository || sourceRoot(remote.rootDirectory) !== target.root || (target.repository && remote.link?.productionBranch && remote.link.productionBranch !== target.branch)) throw new ApiError("La source Vercel a changé. Synchronisez le projet avant de recommencer.");
    if (remote.commandForIgnoringBuildStep || remote.installCommand || remote.buildCommand) throw new ApiError("Les commandes de construction personnalisées demandent une validation dédiée.");
    return remote.targets?.production?.id as string | undefined;
  }
  const data = await readRailwayInstance(target), instance = data.serviceInstance;
  if (target.builder && target.builder !== instance.builder) throw new ApiError("Le mode de construction Railway a changé. Synchronisez sa fiche.");
  if (instance.latestDeployment && ["INITIALIZING", "QUEUED", "BUILDING", "DEPLOYING", "WAITING"].includes(instance.latestDeployment.status)) throw new ApiError("Railway déploie déjà ce service. Attendez la fin de son déploiement.");
  if (githubRepository(instance.source?.repo) !== target.repository || instance.source?.image || sourceRoot(instance.rootDirectory) !== target.root || !["RAILPACK", "DOCKERFILE"].includes(instance.builder)) throw new ApiError("La source Railway a changé. Synchronisez le projet avant de recommencer.");
  const evidence = deploymentEvidence(instance.activeDeployments?.[0]?.meta);
  if (target.mode === "git" && evidence?.branch !== target.branch) throw new ApiError("La branche Railway n’est pas confirmée. Synchronisez le projet avant de recommencer.");
  const variables = await railwayUpdateRequest(target, `query UpdateVariables($projectId:String!,$serviceId:String!,$environmentId:String!){variables(projectId:$projectId,serviceId:$serviceId,environmentId:$environmentId)}`, { projectId: data.service.projectId, serviceId: target.remoteId, environmentId: target.environmentId });
  if (Object.keys(variables.variables).some(name => /^(RAILPACK_.*COMMAND|NIXPACKS_|RAILPACK_PACKAGES)/.test(name))) throw new ApiError("Railway utilise une construction personnalisée qui doit être vérifiée.");
  if (variables.variables.RAILWAY_DOCKERFILE_PATH && variables.variables.RAILWAY_DOCKERFILE_PATH !== "Dockerfile") throw new ApiError("Le chemin Dockerfile personnalisé de Railway nécessite une validation dédiée.");
  if (variables.variables.RAILPACK_NODE_VERSION && ![nodeVersion, `${nodeVersion.split(".")[0]}.x`, nodeVersion.split(".")[0]].includes(variables.variables.RAILPACK_NODE_VERSION)) throw new ApiError("Une variable Railway impose une autre version de Node. Retirez ce forçage pour utiliser la version des sources.");
  return instance.activeDeployments?.[0]?.id as string | undefined;
}
export async function deployVercelArchive(target: UpdateTarget, folder: string, names: string[], nodeVersion: string, runId: string) {
  const files = [];
  for (const name of names) {
    const data = await readFile(join(folder, name)), sha = createHash("sha1").update(data).digest("hex");
    await withVercelCredentials(target.connectionId, async (token, teamId) => {
      const response = await fetch(`https://api.vercel.com/v2/files?teamId=${encodeURIComponent(teamId)}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream", "Content-Length": String(data.length), "x-vercel-digest": sha }, body: data, redirect: "error", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new ApiError("Vercel n’a pas accepté les sources actualisées.", 502);
    });
    files.push({ file: name, sha, size: data.length });
  }
  const result = await vercelUpdateRequest(target, "/v13/deployments", "POST", { project: target.remoteId, name: target.name, files, target: "production", projectSettings: { nodeVersion: `${nodeVersion.split(".")[0]}.x`, rootDirectory: target.root || null }, meta: { vigieUpdate: runId } });
  return result.id as string;
}
export async function deployRailwayArchive(target: UpdateTarget, folder: string, runId: string) {
  const data = await readRailwayInstance(target);
  return withRailwayCredentials(target.connectionId, async token => {
    const output = await runCommand("railway", ["up", folder, "--path-as-root", "--no-gitignore", "--project", data.service.projectId, "--environment", target.environmentId!, "--service", target.remoteId, "--detach", "--message", `vigie-update-${runId}`, "--json"], { cwd: folder, env: { NODE_ENV: "production", PATH: process.env.PATH, HOME: process.env.HOME, RAILWAY_API_TOKEN: token, CI: "true" }, timeout: 180_000 });
    const result = output.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return {}; } }).find(item => /^[a-f0-9-]{36}$/.test(item.deploymentId));
    if (!result) throw new ApiError("Railway n’a pas renvoyé l’identifiant du nouveau déploiement.", 502);
    return result.deploymentId as string;
  });
}
export async function waitForDeployment(target: UpdateTarget, reference: { commit?: string; deploymentId?: string; runId: string; previousDeploymentId?: string }, update: (id: string) => Promise<void>, pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (target.provider === "vercel") {
      const data = await vercelUpdateRequest(target, `/v6/deployments?projectId=${encodeURIComponent(target.remoteId)}&limit=30`);
      const deployment = data.deployments.find((item: any) => item.target === "production" && (reference.deploymentId ? item.uid === reference.deploymentId || item.id === reference.deploymentId : reference.commit && item.meta?.githubCommitSha === reference.commit));
      if (deployment) {
        const id = deployment.uid || deployment.id;
        await update(id);
        if (["ERROR", "CANCELED"].includes(deployment.state)) throw new ApiError("La construction Vercel a échoué. Le précédent déploiement reste consultable.");
        if (deployment.state === "READY") {
          const project = await vercelUpdateRequest(target, `/v9/projects/${target.remoteId}`);
          if (project.targets?.production?.id === id) return id as string;
        }
      }
    } else {
      const instance = (await readRailwayInstance(target)).serviceInstance;
      const candidates = [instance.latestDeployment, ...(instance.activeDeployments || [])].filter(Boolean);
      const deployment = candidates.find((item: any) => reference.deploymentId ? item.id === reference.deploymentId : reference.commit && deploymentEvidence(item.meta)?.commit === reference.commit);
      if (deployment) {
        await update(deployment.id);
        if (["FAILED", "CRASHED", "REMOVED", "SKIPPED"].includes(deployment.status)) throw new ApiError("Le nouveau déploiement Railway n’est pas opérationnel.");
        if (deployment.status === "SUCCESS" && instance.activeDeployments.some((item: any) => item.id === deployment.id)) return deployment.id as string;
      }
    }
    await pause(15_000);
  }
  throw new ApiError("Le déploiement n’est pas confirmé dans le délai prévu. Vérifiez son état chez l’hébergeur avant de relancer.", 504);
}
export async function checkPublicSite(value: string, depth = 0): Promise<void> {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || url.hash || depth > 3) throw new ApiError("Le contrôle du site exige une URL HTTPS publique.");
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new ApiError("Le contrôle du site refuse les adresses privées.");
  const result = await new Promise<{ status: number; location?: string; content: string }>((resolveResult, reject) => {
    const address = addresses[0];
    const request = httpsRequest({ hostname: address.address, family: address.family, servername: url.hostname, port: 443, path: url.pathname + url.search, method: "GET", headers: { Host: url.hostname, "User-Agent": "Vigie-update-check/1.0", "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(30_000) }, response => {
      let content = "", size = 0;
      response.on("data", chunk => { size += chunk.length; if (size < 300_000) content += chunk.toString(); });
      response.on("error", reject);
      response.on("end", () => resolveResult({ status: response.statusCode || 502, location: response.headers.location, content }));
    });
    request.on("error", () => reject(new ApiError("Le site ne répond pas correctement au contrôle HTTPS.", 502)));
    request.end();
  });
  if ([301, 302, 303, 307, 308].includes(result.status) && result.location) return checkPublicSite(new URL(result.location, url).href, depth + 1);
  if (result.status !== 200 || /There has been a critical error|Il y a eu une erreur critique|Fatal error:/.test(result.content)) throw new ApiError(`Le contrôle du site échoue (HTTP ${result.status}). Une vérification est nécessaire.`, 502);
}
