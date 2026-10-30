import { z } from "zod";
import { ApiError } from "../http";
import { readRailwayProbe } from "./docker-node";
import type { UpdateTarget } from "./types";

export type TailscaleProof = { version: string; device: string; addresses: string[]; onlinePeers: string[] };
export const tailnetIPv4 = (value: string) => /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.(?:\d{1,3})\.(?:\d{1,3})$/.test(value) && value.split(".").every(part => Number(part) <= 255);
export function tailscaleProbeCommand(nonce: string, port: number, peer?: string) {
  if (!z.uuid().safeParse(nonce).success || !Number.isInteger(port) || port < 1 || port > 65535 || peer && !tailnetIPv4(peer)) throw new ApiError("Paramètres de sonde réseau invalides.", 422);
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  const script = `set -eu\nawk 'NR>1 && $2 ~ /:${hex}$/ && $4=="0A" {found=1} END {exit !found}' /proc/net/tcp /proc/net/tcp6\n${peer ? `tailscale ping --c=1 --timeout=5s ${peer} >/dev/null 2>&1\n` : ""}printf '%s\\n' 'VIGIE:${nonce}' "$RAILWAY_DEPLOYMENT_ID" "$RAILWAY_SERVICE_ID" "$RAILWAY_ENVIRONMENT_ID"\nuname -m\nexec tailscale status --json`;
  return "env -u ENV -u BASH_ENV /bin/sh -c '" + script.replace(/'/g, "'\\''") + "'";
}
export function parseTailscaleProbe(output: string, nonce: string, target: UpdateTarget, deployment: string): TailscaleProof {
  if (Buffer.byteLength(output) > 256_000) throw new ApiError("Réponse Tailscale trop volumineuse.", 422);
  const lines = output.trim().split(/\r?\n/);
  if (lines[0] !== `VIGIE:${nonce}` || lines[1] !== deployment || lines[2] !== target.remoteId || lines[3] !== target.environmentId) throw new ApiError("La sonde Tailscale ne correspond pas au déploiement attendu.", 422);
  if (lines[4] !== "x86_64") throw new ApiError("La plateforme du proxy Tailscale doit être qualifiée avant sa maintenance.", 422);
  let raw: unknown; try { raw = JSON.parse(lines.slice(5).join("\n")); } catch { throw new ApiError("État Tailscale non vérifiable.", 422); }
  const schema = z.object({ Version: z.string().max(200), BackendState: z.literal("Running"), Self: z.object({ ID: z.string().min(1).max(150), Online: z.literal(true), TailscaleIPs: z.array(z.string().max(100)).min(1).max(10) }), Peer: z.record(z.string(), z.object({ Online: z.boolean(), TailscaleIPs: z.array(z.string().max(100)).max(10) })).optional() });
  const parsed = schema.safeParse(raw), version = parsed.success && parsed.data.Version.match(/^\d+\.\d+\.\d+(?=-|$)/)?.[0];
  if (!parsed.success || !version) throw new ApiError("Le client Tailscale n’est pas connecté ou sa version n’est pas attestée.", 422);
  return { version, device: parsed.data.Self.ID, addresses: parsed.data.Self.TailscaleIPs, onlinePeers: [...new Set(Object.values(parsed.data.Peer || {}).filter(peer => peer.Online).flatMap(peer => peer.TailscaleIPs).filter(tailnetIPv4))].sort() };
}
export async function readTailscale(target: UpdateTarget, deployment: string, port: number, peer?: string): Promise<TailscaleProof> {
  const results = await readRailwayProbe(target, deployment, { command: nonce => tailscaleProbeCommand(nonce, port, peer), parse: (output, nonce) => parseTailscaleProbe(output, nonce, target, deployment) });
  if (results.length !== 1) throw new ApiError("Le proxy Tailscale doit avoir une seule instance active.", 422);
  return results[0];
}
