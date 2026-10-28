import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ApiError } from "../http";

export const vercelRuntimePath = "/api/maintenance/runtime";
export const runtimeChallengeSchema = z.object({ projectId: z.string().regex(/^prj_[\w]+$/), deploymentId: z.string().regex(/^dpl_[\w]+$/), nonce: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const runtimeProofSchema = runtimeChallengeSchema.extend({ protocol: z.literal("vigie-vercel-runtime-v1"), node: z.string().regex(/^\d+\.\d+\.\d+$/), commit: z.string().regex(/^[a-f0-9]{40}$/).nullable(), repository: z.string().max(200).nullable(), branch: z.string().max(200).nullable(), environment: z.literal("production"), region: z.string().min(1).max(50), time: z.number().int() }).strict();
export type VercelRuntimeProof = z.infer<typeof runtimeProofSchema>;

function key(projectId: string) {
  // Other applications may receive only their derived project key, never the
  // connector encryption key used by Vigie and its existing worker.
  const dedicated = process.env.VIGIE_RUNTIME_PROBE_KEY;
  if (dedicated !== undefined) {
    if (!/^[a-f0-9]{64}$/i.test(dedicated)) throw new ApiError("Clé dédiée de la sonde Vercel invalide.", 503);
    return Buffer.from(dedicated, "hex");
  }
  const secret = process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(secret)) throw new ApiError("Clé de la sonde Vercel indisponible.", 503);
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "hex"), Buffer.alloc(0), `vigie:vercel-runtime:v1:${projectId}`, 32));
}
export function runtimeSignature(projectId: string, purpose: "request" | "response", raw: string, timestamp: string) {
  return createHmac("sha256", key(projectId)).update(`${purpose}\n${vercelRuntimePath}\n${timestamp}\n${raw}`).digest("hex");
}
export function verifyRuntimeSignature(projectId: string, purpose: "request" | "response", raw: string, timestamp: string, signature: string) {
  if (Buffer.byteLength(raw) > 8192 || !/^\d{10}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 90 || !/^[a-f0-9]{64}$/.test(signature)) throw new ApiError("Preuve Vercel non autorisée ou expirée.", 401);
  if (!timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(runtimeSignature(projectId, purpose, raw, timestamp), "hex"))) throw new ApiError("Signature de la preuve Vercel invalide.", 401);
}

// Deliberately no environment dump: measure this Node function and its deployment.
export function answerRuntimeChallenge(raw: string, timestamp: string, signature: string) {
  const env = process.env, projectId = env.VERCEL_PROJECT_ID || "";
  if (env.VERCEL !== "1" || env.VERCEL_ENV !== "production" || !projectId) throw new ApiError("Sonde disponible uniquement sur un déploiement Vercel de production.", 503);
  verifyRuntimeSignature(projectId, "request", raw, timestamp, signature);
  const challenge = runtimeChallengeSchema.parse(JSON.parse(raw));
  if (challenge.projectId !== projectId || challenge.deploymentId !== env.VERCEL_DEPLOYMENT_ID) throw new ApiError("Le déploiement servi ne correspond pas à la demande.", 409);
  const payload = runtimeProofSchema.parse({ ...challenge, protocol: "vigie-vercel-runtime-v1", node: process.versions.node, commit: env.VERCEL_GIT_COMMIT_SHA || null, repository: env.VERCEL_GIT_REPO_OWNER && env.VERCEL_GIT_REPO_SLUG ? `${env.VERCEL_GIT_REPO_OWNER}/${env.VERCEL_GIT_REPO_SLUG}` : null, branch: env.VERCEL_GIT_COMMIT_REF || null, environment: env.VERCEL_ENV, region: env.VERCEL_REGION, time: Math.floor(Date.now() / 1000) });
  const time = String(payload.time);
  return { payload, timestamp: time, signature: runtimeSignature(projectId, "response", JSON.stringify(payload), time) };
}
