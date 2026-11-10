import { z } from "zod";
import { ApiError } from "../http";
import { probePath } from "./probe-path";
import type { UpdateTarget } from "./types";

export const publicBuildName = /^VITE_[A-Z][A-Z0-9_]{0,57}$/;

const profileSchema = z.strictObject({
  http: z.array(z.strictObject({
    path: probePath,
    status: z.number().int().min(200).max(499),
    contentType: z.enum(["text/html", "application/json", "text/plain"]).optional(),
    contains: z.string().min(1).max(128).optional(),
  })).max(5).default([]),
  websocket: z.array(probePath).max(2).default([]),
  publicBuild: z.record(z.string().regex(publicBuildName), z.string().max(2048).refine(value => !value.includes("\0")))
    .refine(values => Object.keys(values).length <= 16).default({}),
  upstreamVariables: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,62}_URL$/)).max(4).default([]),
});

export function minimalStaticProfile(target: UpdateTarget, raw = process.env.VIGIE_MINIMAL_STATIC_PROFILES || "{}") {
  const key = [target.projectId, target.environmentId, target.remoteId].join(":");
  let profiles: unknown;
  try { profiles = JSON.parse(raw); } catch { /* Invalid configuration is refused below. */ }
  const map = z.record(z.string(), z.unknown()).safeParse(profiles);
  const parsed = profileSchema.safeParse(map.success && Object.hasOwn(map.data, key) ? map.data[key] : undefined);
  if (!parsed.success) throw new ApiError("Profil statique absent ou invalide pour ce service dans VIGIE_MINIMAL_STATIC_PROFILES.", 422);
  return parsed.data;
}

export type MinimalStaticProfile = z.output<typeof profileSchema>;
