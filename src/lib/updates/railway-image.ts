import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gte } from "semver";
import { z } from "zod";
import { ApiError } from "../http";
import { deployedImageReference, normalizeImageDigest } from "../image-reference";
import { deploymentEvidence } from "../connectors/railway-evidence";
import { railwayUpdateRequest } from "./providers";
import { runCommand } from "./process";
import { scanDeployedImage } from "./image-monitor";
import { resolveTailscaleImage, type ResolvedImage } from "./image-registry";
import { imageSecurityCheck, requireImageTarget, tailscaleImage } from "./image-policy";
import { readTailscale } from "./tailscale-probe";
import { verifyTailscaleAuthorization } from "./tailscale-auth";
import { saveUpdateSnapshot } from "./storage";
import type { SecurityFinding, UpdateResult, UpdateRun, UpdateStage, UpdateTarget } from "./types";

type Progress = (stage: UpdateStage, message: string) => Promise<void>;
const deployment = z.object({ id: z.uuid(), status: z.string(), meta: z.unknown() });
const configSchema = z.object({ service: z.object({ projectId: z.uuid() }), serviceInstance: z.object({ source: z.object({ image: z.string(), repo: z.null() }), startCommand: z.string().nullable(), preDeployCommand: z.unknown(), numReplicas: z.number().nullable(), latestDeployment: deployment.nullable(), activeDeployments: z.array(deployment).max(10) }), environment: z.object({ volumeInstances: z.object({ edges: z.array(z.object({ node: z.object({ id: z.string(), serviceId: z.string().nullable(), volumeId: z.string(), mountPath: z.string() }) })).max(100), pageInfo: z.object({ hasNextPage: z.boolean() }) }) }) });
const configurationQuery = `query ImageConfiguration($serviceId:String!,$environmentId:String!){service(id:$serviceId){projectId} serviceInstance(serviceId:$serviceId,environmentId:$environmentId){source{image repo} startCommand preDeployCommand numReplicas latestDeployment{id status meta} activeDeployments{id status meta}} environment(id:$environmentId){volumeInstances(first:100){edges{node{id serviceId volumeId mountPath}} pageInfo{hasNextPage}}}}`;
const variablesQuery = `query ImageVariables($projectId:String!,$serviceId:String!,$environmentId:String!){variables(projectId:$projectId,serviceId:$serviceId,environmentId:$environmentId)}`;
const sourceUpdate = `mutation ImageSource($serviceId:String!,$environmentId:String!,$input:ServiceInstanceUpdateInput!){serviceInstanceUpdate(serviceId:$serviceId,environmentId:$environmentId,input:$input)}`;
const deploy = `mutation ImageDeploy($serviceId:String!,$environmentId:String!){serviceInstanceDeployV2(serviceId:$serviceId,environmentId:$environmentId)}`;
type Configuration = z.infer<typeof configSchema> & { variables: Record<string, string>; fingerprint: string; port: number };
type Dependencies = { request: typeof railwayUpdateRequest; resolve: () => Promise<ResolvedImage>; scan: (reference: string) => Promise<SecurityFinding[]>; probe: typeof readTailscale; authorization: typeof verifyTailscaleAuthorization; version: (reference: string) => Promise<string>; snapshot: typeof saveUpdateSnapshot; pause: (ms: number) => Promise<void> };

// Fingerprint secrets, never return or log them. Deployment-generated variables
// are excluded; provider user variables, source-independent settings and volumes
// must remain identical before/after every write.
export function qualifyTailscaleConfiguration(raw: unknown, variables: Record<string, string>, target: UpdateTarget): Configuration {
  const data = configSchema.parse(raw), instance = data.serviceInstance;
  const volumes = data.environment.volumeInstances.edges.filter(item => item.node.serviceId === target.remoteId);
  if (data.environment.volumeInstances.pageInfo.hasNextPage || volumes.length || variables.TS_STATE_DIR || variables.TS_KUBE_SECRET || variables.TS_AUTH_ONCE === "true") throw new ApiError("Cette configuration Tailscale persistante exige une stratégie de sauvegarde et de restauration qualifiée. Aucune image remplacée.", 422);
  if (variables.TS_USERSPACE !== "true" || !variables.TS_AUTHKEY || !variables.TS_HOSTNAME || instance.startCommand || instance.preDeployCommand && JSON.stringify(instance.preDeployCommand) !== "[]" || instance.numReplicas !== null && instance.numReplicas !== 1) throw new ApiError("Le parcours image exige un proxy Tailscale SOCKS sortant standard, avec accès de reconnexion et une seule instance.", 422);
  const socks = variables.TS_SOCKS5_SERVER?.match(/^(?:\[::\]|0\.0\.0\.0|127\.0\.0\.1|localhost)?:(\d{1,5})$/), port = Number(socks?.[1]);
  const supported = new Set(["TS_USERSPACE", "TS_AUTHKEY", "TS_HOSTNAME", "TS_EXTRA_ARGS", "TS_SOCKS5_SERVER", "TS_ACCEPT_DNS"]);
  const flags = (variables.TS_EXTRA_ARGS || "").split(/\s+/).filter(Boolean);
  if (!port || port > 65535 || Object.keys(variables).some(key => key.startsWith("TS_") && !supported.has(key)) || flags.some(flag => !/^--(?:advertise-tags=tag:[a-z0-9-]+(?:,tag:[a-z0-9-]+)*|accept-routes(?:=(?:true|false))?|accept-dns=(?:true|false))$/.test(flag))) throw new ApiError("Les options réseau de cette image Tailscale demandent une qualification spécifique.", 422);
  const fixedVariables = Object.entries(variables).filter(([key]) => !/^RAILWAY_/.test(key)).sort(([a], [b]) => a.localeCompare(b));
  const fingerprint = createHash("sha256").update(JSON.stringify({ variables: fixedVariables, start: instance.startCommand, pre: instance.preDeployCommand, replicas: instance.numReplicas, volumes })).digest("hex");
  return { ...data, variables, fingerprint, port };
}
async function readConfiguration(target: UpdateTarget, request: typeof railwayUpdateRequest) {
  const variables = { serviceId: target.remoteId, environmentId: target.environmentId };
  const raw = await request(target, configurationQuery, variables), parsed = configSchema.parse(raw);
  const values = await request(target, variablesQuery, { ...variables, projectId: parsed.service.projectId });
  return qualifyTailscaleConfiguration(parsed, z.record(z.string(), z.string()).parse(values.variables), target);
}
export async function imageClientVersion(reference: string, execute = runCommand) {
  if (!tailscaleImage(reference) || !/@sha256:[a-f0-9]{64}$/.test(reference)) throw new ApiError("La sonde candidate exige l’image officielle Tailscale figée par empreinte.", 422);
  const environment: NodeJS.ProcessEnv = { NODE_ENV: "production", PATH: process.env.PATH, HOME: process.env.HOME, ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}) };
  await execute("docker", ["pull", reference], { env: environment, timeout: 180_000 });
  const raw = await execute("docker", ["run", "--rm", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--memory=128m", "--pids-limit=32", "--entrypoint=tailscale", reference, "version", "--json"], { env: environment, timeout: 30_000 });
  const version = z.object({ short: z.string().regex(/^\d+\.\d+\.\d+$/) }).safeParse(JSON.parse(raw));
  if (!version.success) throw new ApiError("La version du client de l’image candidate n’est pas attestée.", 422);
  return version.data.short;
}
export async function executeRailwayImage(run: UpdateRun, target: UpdateTarget, result: UpdateResult, progress: Progress, supplied: Partial<Dependencies> = {}) {
  requireImageTarget(target);
  const cache = await mkdtemp(join(tmpdir(), "vigie-image-update-"));
  const dependencies: Dependencies = { request: railwayUpdateRequest, resolve: resolveTailscaleImage, scan: async reference => (await scanDeployedImage(reference, runCommand, cache)).checks.flatMap(check => check.findings), probe: readTailscale, authorization: verifyTailscaleAuthorization, version: imageClientVersion, snapshot: saveUpdateSnapshot, pause: ms => new Promise(resolve => setTimeout(resolve, ms)), ...supplied };
  const ids = { serviceId: target.remoteId, environmentId: target.environmentId };
  result.checks ||= [];
  async function record(check: ReturnType<typeof imageSecurityCheck>) { result.checks!.push(check); await progress(check.phase === "after" ? "verifying" : "checking", check.message); if (check.status === "blocked") throw new ApiError(check.message, 422); }
  try {
    const before = await readConfiguration(target, dependencies.request), current = before.serviceInstance;
    if (current.source.image !== target.image || current.activeDeployments.length !== 1 || current.activeDeployments[0].status !== "SUCCESS" || current.latestDeployment?.id !== current.activeDeployments[0].id || current.latestDeployment.status !== "SUCCESS") throw new ApiError("L’image ou le déploiement Railway a changé. Attendez un seul déploiement stable avant de réessayer.", 409);
    const previousDeployment = current.activeDeployments[0], previousDigest = normalizeImageDigest(deploymentEvidence(previousDeployment.meta)?.imageDigest);
    const previous = deployedImageReference(current.source.image, previousDigest);
    if (!previous || !previousDigest) throw new ApiError("L’image active ne possède pas d’empreinte vérifiable.", 422);
    const oldRuntime = await dependencies.probe(target, previousDeployment.id, before.port);
    if (!oldRuntime.onlinePeers.length) throw new ApiError("Aucun pair Tailscale en ligne ne permet de contrôler la connexion après remplacement.", 422);
    const peer = oldRuntime.onlinePeers[0];
    result.previousDeploymentId = previousDeployment.id;
    const baseline = await dependencies.scan(previous);
    await record(imageSecurityCheck("before", previous, baseline));
    const candidate = await dependencies.resolve();
    const same = previousDigest === candidate.digest || previousDigest === candidate.indexDigest;
    const findings = same ? baseline : await dependencies.scan(candidate.reference);
    await record(imageSecurityCheck("candidate", candidate.reference, findings, baseline));
    const version = same ? oldRuntime.version : await dependencies.version(candidate.reference);
    if (!gte(version, oldRuntime.version)) throw new ApiError("L’image stable ferait reculer la version Tailscale. Remplacement refusé.", 422);
    result.imageUpdate = { channel: candidate.channel, previous, candidate: candidate.reference, digest: candidate.digest, remainingFindings: result.checks.at(-1)!.findings.length, state: "ephemeral-socks", previousDevice: oldRuntime.device };
    result.warnings.push("Proxy SOCKS sortant sans volume persistant : reconnexion avec les paramètres existants ; l’identité éphémère du client peut être renouvelée.");
    if (!same) await dependencies.authorization(before.variables);
    const latest = await readConfiguration(target, dependencies.request);
    if (latest.fingerprint !== before.fingerprint || latest.serviceInstance.source.image !== target.image || latest.serviceInstance.activeDeployments.length !== 1 || latest.serviceInstance.activeDeployments[0].id !== previousDeployment.id) throw new ApiError("La configuration a changé pendant l’analyse. Aucune image remplacée.", 409);
    await dependencies.snapshot(run.id, target.id, { previous, source: current.source.image, fingerprint: before.fingerprint, previousDeploymentId: previousDeployment.id, runtime: oldRuntime, candidate, createdAt: new Date().toISOString() });
    async function waitFor(reference: string, expectedDigest: string, expectedDeployment: string) {
      for (let attempt = 0; attempt < 60; attempt++) {
        const state = await readConfiguration(target, dependencies.request);
        if (state.fingerprint !== before.fingerprint || state.serviceInstance.source.image !== reference) throw new ApiError("La configuration réseau a changé pendant le déploiement. Vérification manuelle nécessaire.", 409);
        const active = state.serviceInstance.activeDeployments, deployment = state.serviceInstance.latestDeployment;
        if (deployment?.id === expectedDeployment) {
          if (["FAILED", "CRASHED", "REMOVED", "SKIPPED"].includes(deployment.status)) throw new ApiError("Le nouveau conteneur Tailscale n’est pas opérationnel.", 422);
          if (deployment.status === "SUCCESS" && active.length === 1 && active[0].id === deployment.id && normalizeImageDigest(deploymentEvidence(deployment.meta)?.imageDigest) === expectedDigest) return deployment.id;
        }
        await progress("verifying", "Attente de l’image exacte et d’une seule instance Tailscale active.");
        await dependencies.pause(10_000);
      }
      throw new ApiError("Le remplacement de l’image n’a pas été confirmé dans le délai prévu.", 504);
    }
    let published = false;
    async function ready(deploymentId: string) {
      for (let attempt = 0; ; attempt++) {
        try { return await dependencies.probe(target, deploymentId, before.port, peer); }
        catch (error) {
          if (attempt >= 7 || !(error instanceof ApiError) || !/n’est pas connecté|L’étape ssh a échoué/.test(error.message)) throw error;
          await progress("verifying", "Attente bornée de la connexion Tailscale et du proxy SOCKS après démarrage.");
          await dependencies.pause(5_000);
        }
      }
    }
    try {
      let deploymentId = previousDeployment.id;
      if (!same) {
        result.stage = "publishing"; await progress("publishing", "Remplacement de l’image Tailscale par l’empreinte analysée ; paramètres réseau conservés.");
        published = true; // An API timeout can hide a successful write.
        const changed = await dependencies.request(target, sourceUpdate, { ...ids, input: { source: { image: candidate.reference } } });
        if (changed.serviceInstanceUpdate !== true) throw new ApiError("Railway n’a pas confirmé la nouvelle source image.", 502);
        const deployed = await dependencies.request(target, deploy, ids);
        if (!z.uuid().safeParse(deployed.serviceInstanceDeployV2).success) throw new ApiError("Railway n’a pas confirmé le lancement de l’image.", 502);
        result.stage = "verifying"; await progress("verifying", "Contrôle de l’image active et de la reconnexion Tailscale.");
        deploymentId = await waitFor(candidate.reference, candidate.digest, deployed.serviceInstanceDeployV2);
      }
      if (!same) result.deploymentId = deploymentId;
      const runtime = await ready(deploymentId);
      if (runtime.version !== version) throw new ApiError("La version Tailscale active ne correspond pas à l’image testée.", 422);
      await record(imageSecurityCheck("after", candidate.reference, await dependencies.scan(candidate.reference), baseline));
      const recheck = await readConfiguration(target, dependencies.request);
      if (recheck.fingerprint !== before.fingerprint || recheck.serviceInstance.source.image !== (same ? target.image : candidate.reference) || recheck.serviceInstance.latestDeployment?.id !== deploymentId || recheck.serviceInstance.latestDeployment.status !== "SUCCESS" || recheck.serviceInstance.activeDeployments.length !== 1 || recheck.serviceInstance.activeDeployments[0].id !== deploymentId || recheck.serviceInstance.activeDeployments[0].status !== "SUCCESS" || ![candidate.digest, candidate.indexDigest].includes(normalizeImageDigest(deploymentEvidence(recheck.serviceInstance.activeDeployments[0].meta)?.imageDigest) || "")) throw new ApiError("L’image ou les paramètres ont changé pendant les contrôles finaux.", 422);
      result.imageUpdate.verified = { deploymentId, digest: candidate.digest, version, device: runtime.device };
      result.deploymentId = deploymentId;
      result.imageUpdate.remainingFindings = result.checks.at(-1)!.findings.length;
      result.stage = "completed";
      result.message = `${same ? "Image déjà à jour" : "Image mise à jour"} ; Tailscale ${version}, proxy SOCKS et accès au pair contrôlés.${result.imageUpdate.remainingFindings ? ` ${result.imageUpdate.remainingFindings} signalement(s) non classé(s) antérieur(s) restent à qualifier.` : " Aucun signalement dans l’image analysée."}`;
      await progress("verifying", result.message);
    } catch (error) {
      if (published) {
        result.stage = "attention";
        // Roll back only our image source, never concurrent settings or volumes.
        const state = await readConfiguration(target, dependencies.request).catch(() => null);
        if (state?.fingerprint === before.fingerprint && state.serviceInstance.source.image === candidate.reference) {
          try {
            await progress("verifying", "Contrôle refusé : retour à l’ancienne empreinte Tailscale, sans restauration de données.");
            const restored = await dependencies.request(target, sourceUpdate, { ...ids, input: { source: { image: previous } } });
            if (restored.serviceInstanceUpdate !== true) throw new ApiError("Retour à l’image précédente non confirmé.", 502);
            const restoredDeployment = await dependencies.request(target, deploy, ids);
            if (!z.uuid().safeParse(restoredDeployment.serviceInstanceDeployV2).success) throw new ApiError("Déploiement de récupération non identifié.", 502);
            const rollback = await waitFor(previous, previousDigest, restoredDeployment.serviceInstanceDeployV2);
            if ((await ready(rollback)).version !== oldRuntime.version) throw new ApiError("La version récupérée n’est pas celle de l’image précédente.", 422);
            result.imageUpdate.rollbackDeploymentId = rollback;
            result.warnings.push("Retour à l’ancienne image et connexion réseau vérifiés après refus du nouveau déploiement. Le résultat de maintenance reste à vérifier.");
          } catch { result.warnings.push("Retour à l’image précédente non confirmé : intervention Railway nécessaire. Les références de récupération sont conservées."); }
        }
      }
      throw error;
    }
  } finally { await rm(cache, { recursive: true, force: true }); }
}
