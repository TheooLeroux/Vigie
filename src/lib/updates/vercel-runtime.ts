import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { z } from "zod";
import { ApiError } from "../http";
import { publicAddress } from "../connectors/wordpress-observer";
import { vercelUpdateRequest } from "./providers";
import { runtimeChallengeSchema, runtimeProofSchema, runtimeSignature, verifyRuntimeSignature, vercelRuntimePath } from "./vercel-runtime-protocol";
import type { UpdateTarget } from "./types";

type Reference = { deploymentId: string; commit?: string };
type Dependencies = { vercel?: typeof vercelUpdateRequest; transport?: typeof fetch; resolve?: typeof lookup };

async function requestProbe(url: URL, body: string, headers: Record<string, string>, address: { address: string; family: number }) {
  return new Promise<Response>((resolve, reject) => {
    const request = httpsRequest({ hostname: address.address, family: address.family, servername: url.hostname, port: 443, path: vercelRuntimePath, method: "POST", headers: { ...headers, Host: url.hostname, "Content-Length": String(Buffer.byteLength(body)) }, signal: AbortSignal.timeout(20_000) }, response => {
      if (response.statusCode !== 200) { response.resume(); resolve(new Response(null, { status: response.statusCode || 502 })); return; }
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", chunk => { size += chunk.length; if (size > 8192) { response.destroy(); reject(new ApiError("Preuve Vercel trop volumineuse.", 422)); } else chunks.push(chunk); });
      response.on("error", () => reject(new ApiError("Lecture de la preuve Vercel interrompue.", 502)));
      response.on("end", () => resolve(new Response(Buffer.concat(chunks))));
    });
    request.on("error", () => reject(new ApiError("La sonde Vercel ne répond pas au contrôle HTTPS.", 502)));
    request.end(body);
  });
}

function projectMatches(project: any, target: UpdateTarget, reference: Reference) {
  const root = (project.rootDirectory || "").replace(/^\/+|\/+$/g, "");
  const repository = project.link?.type === "github" ? `${project.link.org}/${project.link.repo}` : null;
  return project.id === target.remoteId && project.targets?.production?.id === reference.deploymentId && root === target.root && (target.mode === "git" ? repository?.toLowerCase() === target.repository?.toLowerCase() && (!project.link.productionBranch || project.link.productionBranch === target.branch) : repository === null);
}
export async function readVercelRuntime(target: UpdateTarget, reference: Reference, dependencies: Dependencies = {}) {
  const read = dependencies.vercel || vercelUpdateRequest;
  const project = await read(target, `/v9/projects/${target.remoteId}`);
  if (!projectMatches(project, target, reference)) throw new ApiError("Le projet, la source ou le déploiement Vercel actif a changé.", 422);
  const deployment = await read(target, `/v13/deployments/${reference.deploymentId}`);
  if (deployment.id !== reference.deploymentId || deployment.projectId !== target.remoteId || deployment.readyState !== "READY" || deployment.target !== "production" || reference.commit && deployment.meta?.githubCommitSha !== reference.commit) throw new ApiError("Le déploiement Vercel ne correspond pas au commit de production attendu.", 422);
  const url = new URL(target.url || "");
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443") throw new ApiError("Adresse de la sonde Vercel invalide.", 422);
  const addresses = await (dependencies.resolve || lookup)(url.hostname, { all: true });
  if (!addresses.length || addresses.some(address => !publicAddress(address.address))) throw new ApiError("La sonde Vercel doit utiliser une adresse publique.", 422);
  const challenge = runtimeChallengeSchema.parse({ projectId: target.remoteId, deploymentId: reference.deploymentId, nonce: randomBytes(32).toString("hex") });
  const body = JSON.stringify(challenge), timestamp = String(Math.floor(Date.now() / 1000));
  const headers = { "Content-Type": "application/json", "X-Vigie-Time": timestamp, "X-Vigie-Signature": runtimeSignature(target.remoteId, "request", body, timestamp) };
  const response = dependencies.transport ? await dependencies.transport(new URL(vercelRuntimePath, url), { method: "POST", headers, body, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20_000) }) : await requestProbe(url, body, headers, addresses[0]);
  if (!response.ok) throw new ApiError(`Sonde Vercel indisponible (${response.status}) : installez et qualifiez la sonde du projet avant sa maintenance.`, 422);
  const reader = response.body?.getReader(); if (!reader) throw new ApiError("Preuve Vercel vide.", 422);
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 8192) { await reader.cancel(); throw new ApiError("Preuve Vercel trop volumineuse.", 422); } chunks.push(next.value); }
  const envelope = z.object({ payload: runtimeProofSchema, timestamp: z.string(), signature: z.string() }).strict().parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  const proof = envelope.payload;
  verifyRuntimeSignature(target.remoteId, "response", JSON.stringify(proof), envelope.timestamp, envelope.signature);
  if (proof.nonce !== challenge.nonce || proof.projectId !== target.remoteId || proof.deploymentId !== reference.deploymentId || proof.time !== Number(envelope.timestamp) || proof.commit !== (reference.commit || deployment.meta?.githubCommitSha || null) || target.mode === "git" && (proof.repository?.toLowerCase() !== target.repository?.toLowerCase() || proof.branch !== target.branch)) throw new ApiError("La preuve Vercel ne correspond pas à cette demande, ce commit ou cette source.", 422);
  if (!projectMatches(await read(target, `/v9/projects/${target.remoteId}`), target, reference)) throw new ApiError("Le déploiement Vercel actif a changé pendant la mesure.", 422);
  return proof;
}
