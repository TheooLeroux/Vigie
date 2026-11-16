import { createHmac } from "node:crypto";
import { getCache } from "@vercel/functions";
import { z } from "zod";
import { withHostingCredentials } from "../hosting-connections";
import { observationIsFresh } from "../observation-freshness";
import type { HostingInstallationView } from "../types";
import { cpanelAgentFiles, openAgentPayload, type AgentFiles, type LocalAgentSettings } from "./wordpress-agent";

type HealthSite = Pick<HostingInstallationView, "suggestedEnvironment" | "inventory" | "documentRoot" | "domains" | "aliases">;
type AgentIdentity = Pick<LocalAgentSettings, "secret" | "directory" | "environment" | "bundleVersion">;
type HealthCache = Pick<ReturnType<typeof getCache>, "get" | "set">;
const healthLifetime = 15 * 60_000;
const production = () => process.env.VERCEL === "1" && process.env.VERCEL_ENV === "production";

function runtimeHealthCache(): HealthCache | undefined {
  if (!production()) return;
  try { return getCache({ namespace: "vigie-wordpress-agent-health", keyHashFunction: key => key }); }
  catch { return undefined; }
}

export function agentHealthKey(site: Pick<HostingInstallationView, "id" | "connectionId" | "documentRoot" | "project" | "suggestedEnvironment" | "domains" | "aliases">, agent: AgentIdentity, stateChangedAt?: string, requestId?: string) {
  return createHmac("sha256", agent.secret).update(JSON.stringify([
    "vigie:agent-health:v1", site.id, site.project?.id, site.connectionId, site.documentRoot,
    site.suggestedEnvironment, [...site.domains].sort(), [...site.aliases].sort(),
    agent.directory, agent.environment, agent.bundleVersion, stateChangedAt, requestId,
  ])).digest("hex");
}

export async function readAgentHealth(key: string, cache = runtimeHealthCache()): Promise<boolean | null> {
  if (!cache) return null;
  try {
    const entry = await cache.get(key) as { healthy?: unknown; at?: unknown } | null;
    return typeof entry?.healthy === "boolean" && typeof entry.at === "number" &&
      Date.now() >= entry.at && Date.now() - entry.at < healthLifetime ? entry.healthy : null;
  } catch { return null; }
}

export async function recordAgentHealth(key: string, healthy: boolean, cache = runtimeHealthCache()) {
  if (!cache) return;
  try {
    await cache.set(key, { healthy, at: Date.now() }, { ttl: healthLifetime / 1000, name: "Vigie · contrôle agent WordPress" });
  } catch { /* The next probe repeats the check and readers can verify directly. */ }
}

// Both proofs are signed: a ticking cron alone does not prove WordPress still loads.
export async function agentControlHealthy(site: HealthSite, settings: Pick<LocalAgentSettings, "environment" | "secret">, files: Pick<AgentFiles, "read">) {
  try {
    if (settings.environment !== site.suggestedEnvironment || !site.inventory?.php || site.inventory.error || site.inventory.collectionMode === "early") return false;
    const heartbeat = await files.read("heartbeat.json"), readiness = await files.read("readiness.json");
    if (!heartbeat || !readiness) return false;
    const proof = z.object({ protocol: z.literal("vigie-local-v1"), root: z.string(), php: z.string(), time: z.number().int() });
    const tick = proof.parse(openAgentPayload(JSON.parse(heartbeat), settings.secret));
    const probe = proof.extend({ ready: z.boolean(), eligibility: z.object({ multisite: z.boolean(), fileModsDisabled: z.boolean(), home: z.string().url() }).optional() }).parse(openAgentPayload(JSON.parse(readiness), settings.secret));
    const valid = (value: z.infer<typeof proof>, maxAge: number) => value.root === site.documentRoot && value.php === site.inventory!.php!.version && Date.now() / 1000 - value.time >= -30 && Date.now() / 1000 - value.time <= maxAge;
    const expected = new URL(site.inventory.site?.home || `https://${site.domains[0]}`).hostname.replace(/^www\./, "");
    if (![...site.domains, ...site.aliases].some(domain => domain.replace(/^www\./, "") === expected)) return false;
    return valid(tick, 180) && valid(probe, 600) && probe.ready && !!probe.eligibility && !probe.eligibility.multisite && !probe.eligibility.fileModsDisabled && new URL(probe.eligibility.home).hostname.replace(/^www\./, "") === expected;
  } catch { return false; }
}

export async function agentHeartbeatHealthy(site: HostingInstallationView, settings: LocalAgentSettings) {
  try {
    return await withHostingCredentials(site.connectionId, connection => agentControlHealthy(site, settings, cpanelAgentFiles(connection, settings.directory)));
  } catch { return false; }
}

export async function agentHealthCurrent(site: HostingInstallationView, agent: LocalAgentSettings, options: { stateChangedAt?: string; requestId?: string; installedAt?: string; verifyOnMiss: boolean }) {
  const { stateChangedAt, requestId, installedAt, verifyOnMiss } = options;
  const key = agentHealthKey(site, agent, stateChangedAt, requestId);
  const cached = await readAgentHealth(key);
  if (cached !== null) return cached;
  // Legacy rows still carry a durable timestamp from the previous verifier.
  if (observationIsFresh(agent.lastVerifiedAt ?? stateChangedAt ?? installedAt, healthLifetime)) return true;
  if (!verifyOnMiss) return false;
  const healthy = await agentHeartbeatHealthy(site, agent);
  await recordAgentHealth(key, healthy);
  return healthy;
}
