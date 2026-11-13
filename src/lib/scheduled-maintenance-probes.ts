import { createHash } from "node:crypto";
import { readAutomaticControl } from "./automatic-control-storage";
import { cpanelReadClient } from "./connectors/cpanel-read";
import { collectO2switchInstallations, type DiscoveredInstallation } from "./connectors/o2switch-discovery";
import { readRailwayInventory } from "./connectors/railway";
import { readVercelProductionPointers } from "./connectors/vercel";
import { collectObserver } from "./connectors/wordpress-observer";
import { hostingConnections, withHostingCredentials } from "./hosting-connections";
import { hostingDiscovery } from "./hosting-discovery";
import { withWordPressObserver } from "./hosting-inventory";
import { railwayState, withRailwayCredentials } from "./railway";
import type { RailwayDeployment, RailwayProject } from "./railway-types";
import type { HostingConnection, HostingInstallationView } from "./types";
import { vercelState, withVercelCredentials } from "./vercel";
import { hostingSourcesDigest, readHostingSources } from "./updates/hosting-source-monitor";
import { mapConcurrent } from "./updates/planning";
import { readUpdateSource } from "./updates/storage";
import { cpanelAgentFiles, type LocalAgentSettings } from "./updates/wordpress-agent";
import { agentControlHealthy, eligible } from "./updates/wordpress-agent-setup";
import { wordpressAgentPackageVersion } from "./updates/wordpress-agent-package";
import { wordpressSecurityVersions } from "./updates/wordpress-security-key";
import { deploymentObservationLifetime, observationIsFresh, wordpressObservationLifetime } from "./observation-freshness";
import type { MaintenancePlan } from "./maintenance-plan";
import { vercelExcluded } from "./vercel-client-mapping";

type WordPressProbe = {
  id: string;
  projectId: string;
  site: Pick<HostingInstallationView, "documentRoot" | "suggestedEnvironment" | "domains" | "aliases">;
  url: string;
  secret: string;
  agent: Pick<LocalAgentSettings, "directory" | "environment" | "secret"> | null;
  versions: string;
  inventoryAt: string;
  agentDueAt: number;
};
type HostingCredentials = Pick<HostingConnection, "id" | "name" | "endpoint" | "username" | "authMode"> & { secret: string };
type WordPressScope = Pick<WordPressProbe, "id" | "projectId">;

export type MaintenanceProbes = {
  vercel: ({ teamId: string; token: string; digest: string; observedAt: string | null; error: boolean } | null)[];
  railway: ({ workspaceId: string; token: string; digest: string; observedAt: string | null; error: boolean } | null)[];
  hosting: ({
    credentials: HostingCredentials;
    digest: string;
    observedAt: string | null;
    wordpress: (WordPressProbe | WordPressScope)[];
    sources: { projectId: string; root: string; digest: string | null }[];
  } | null)[];
};

function digest(rows: unknown[][]) {
  return createHash("sha256").update(JSON.stringify(rows.map(row => JSON.stringify(row)).sort())).digest("hex");
}

function railwayDigest(projects: RailwayProject[]) {
  function deployment(value: RailwayDeployment | null) {
    if (!value) return null;
    const evidence = value.evidence;
    return [value.id, value.status, value.updatedAt, evidence?.commit, evidence?.imageDigest,
      evidence?.repository, evidence?.rootDirectory];
  }
  return digest(projects.map(project => [project.id, project.name,
    digest(project.environments.map(item => [item.id, item.name, item.ephemeral])),
    digest(project.services.map(service => [service.id, service.name, service.environmentId,
      service.repository, service.image, service.rootDirectory, service.builder,
      service.domains.slice().sort(), deployment(service.latestDeployment),
      digest(service.activeDeployments.map(item => deployment(item)!))])),
  ]));
}

function hostingDigest(installations: DiscoveredInstallation[]) {
  return digest(installations.map(site => [site.documentRoot, site.kind, site.version,
    site.domains.slice().sort(), site.aliases.slice().sort(), site.inspectionError, site.suggestedEnvironment]));
}

async function wordpressProbe(site: HostingInstallationView): Promise<WordPressProbe | WordPressScope> {
  const scope = { id: site.id, projectId: site.project!.id };
  const current = site.inventory;
  if (!current?.observedAt || current.source !== "wordpress-observer" || current.collectionMode === "early" || current.error) return scope;
  const state = (await readUpdateSource(`wordpress:${site.id}`))?.settings;
  const agent = state?.localAgent;
  const verifiedAt = Date.parse(agent?.lastVerifiedAt ?? "");
  const setup = state?.agentInstallation;
  // A failed installation is already waiting for its persisted retry time.
  // Keep checking WordPress versions while respecting that backoff.
  const retryAt = setup?.state === "failed" && !agent?.ready ? Date.parse(setup.nextAttemptAt ?? "") : NaN;
  const healthy = agent?.ready && agent.bundleVersion === wordpressAgentPackageVersion && !state?.agentReportedFailure &&
      (!setup || setup.state === "ready") && Number.isFinite(verifiedAt) && verifiedAt <= Date.now();
  return await withWordPressObserver(site, (url, secret) => ({
    ...scope,
    site: { documentRoot: site.documentRoot, suggestedEnvironment: site.suggestedEnvironment, domains: site.domains, aliases: site.aliases },
    url, secret, agent: healthy ? { directory: agent.directory, environment: agent.environment, secret: agent.secret } : null,
    agentDueAt: healthy ? verifiedAt + 10 * 60_000 : Number.isFinite(retryAt) ? retryAt : 0,
    inventoryAt: current.observedAt!,
    versions: wordpressSecurityVersions(current),
  })) ?? scope;
}

export async function readMaintenanceProbes(): Promise<MaintenanceProbes> {
  const [vercel, railway, hosting] = await Promise.all([
    vercelState({ includeDisplayLabels: false }),
    railwayState({ includeDisplayLabels: false }),
    hostingConnections(),
  ]);
  const [vercelProbes, railwayProbes, hostingProbes] = await Promise.all([
    Promise.all(vercel.connections.filter(item => item.configured).map(item =>
      withVercelCredentials(item.id, async (token, teamId) => ({
        teamId, token, observedAt: item.lastSuccessAt, error: !!item.error,
        digest: digest(vercel.projects.filter(project => project.connectionId === item.id && !project.missingSince && !project.excluded)
          .map(project => [project.id, project.name, project.production?.id ?? null])),
      })).catch(() => null))),
    Promise.all(railway.connections.filter(item => item.configured).map(item =>
      withRailwayCredentials(item.id, async (token, workspaceId) => ({
        workspaceId, token, observedAt: item.lastSuccessAt, error: !!item.error,
        digest: railwayDigest(railway.projects.filter(project => project.connectionId === item.id && !project.missingSince)),
      })).catch(() => null))),
    Promise.all(hosting.filter(item => item.configured).map(async item => {
      const discovery = await hostingDiscovery(item.id);
      if (discovery.error || item.status !== "connected") return null;
      const sites = discovery.installations.filter(site => !site.missingSince);
      const linked = sites.filter(site => !site.ignored && site.project?.lifecycle === "active");
      const [wordpress, sources] = await Promise.all([
        mapConcurrent(linked.filter(eligible), 4, site => wordpressProbe(site).catch(() => ({ id: site.id, projectId: site.project!.id }))),
        mapConcurrent(linked.filter(site => site.kind !== "wordpress"), 4, async site => {
          const report = await readAutomaticControl(`hosting:${site.id}`);
          return { projectId: site.project!.id, root: site.documentRoot, digest: report?.sourceDigest ?? null };
        }),
      ]);
      return withHostingCredentials(item.id, async ({ id, name, endpoint, username, authMode, secret }) => ({
        credentials: { id, name, endpoint, username, authMode, secret },
        digest: hostingDigest(sites), observedAt: discovery.lastSuccessAt, wordpress, sources,
      }));
    }).map(probe => probe.catch(() => null))),
  ]);
  return { vercel: vercelProbes, railway: railwayProbes, hosting: hostingProbes };
}

export async function probeMaintenance(probes: MaintenanceProbes, plan: MaintenancePlan) {
  const now = Date.now();
  const signal = AbortSignal.timeout(40_000);
  const transport: typeof fetch = (url, options) => fetch(url, {
    ...options, signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal, cache: "no-store",
  });
  // Start the full collection one tick before persisted observations expire.
  const refreshAfter = deploymentObservationLifetime - 5 * 60_000;
  const current = (at: string | null) => observationIsFresh(at, refreshAfter, now);
  const add = (scope: MaintenancePlan["agents"], id: string) => {
    if (scope !== "all" && !scope.includes(id)) scope.push(id);
  };
  const [vercel, railway, hosting] = await Promise.all([
    Promise.all(probes.vercel.map(async item => {
      if (!item || item.error) return { unchanged: false, fresh: false };
      const pointers = (await readVercelProductionPointers(item.teamId, item.token, transport))
        .filter(project => !vercelExcluded(item.teamId, project.name));
      return {
        unchanged: digest(pointers.map(project => [project.projectId, project.name, project.deploymentId])) === item.digest,
        fresh: current(item.observedAt),
      };
    })).catch(() => [{ unchanged: false, fresh: false }]),
    Promise.all(probes.railway.map(async item => {
      if (!item || item.error) return { unchanged: false, fresh: false };
      const projects = await readRailwayInventory(item.workspaceId, item.token, transport, signal);
      return { unchanged: railwayDigest(projects) === item.digest, fresh: current(item.observedAt) };
    })).catch(() => [{ unchanged: false, fresh: false }]),
    Promise.all(probes.hosting.map(async item => {
      if (!item) return { unchanged: false, unknown: true };
      try {
        const discovery = await collectO2switchInstallations(item.credentials, transport);
        if (hostingDigest(discovery.installations) !== item.digest) return { unchanged: false, unknown: true };
        const client = cpanelReadClient(item.credentials, transport);
        await Promise.all([
          mapConcurrent(item.wordpress, 4, async proof => {
            if (!("url" in proof)) {
              add(plan.wordpress, proof.id);
              add(plan.agents, proof.id);
              add(plan.security.o2switch, proof.projectId);
              return;
            }
            const inventory = await collectObserver(proof.url, proof.site.documentRoot, proof.secret, undefined, undefined, false, { refresh: false, signal }).catch(() => null);
            const changed = !inventory || inventory.collectionMode !== "normal" || wordpressSecurityVersions(inventory) !== proof.versions;
            if (changed || !observationIsFresh(proof.inventoryAt, wordpressObservationLifetime - 10 * 60_000, now)) add(plan.wordpress, proof.id);
            if (changed) add(plan.security.o2switch, proof.projectId);
            if (now >= proof.agentDueAt || (proof.agent && (changed || !inventory ||
                !await agentControlHealthy({ ...proof.site, inventory }, proof.agent, cpanelAgentFiles(item.credentials, proof.agent.directory, transport))))) {
              add(plan.agents, proof.id);
            }
          }),
          mapConcurrent(item.sources, 2, async source => {
            const files = source.digest && await readHostingSources(source.root, client, signal).catch(() => null);
            if (!current(item.observedAt) || !files || files.limitations.length || hostingSourcesDigest(files.files) !== source.digest) {
              add(plan.security.o2switch, source.projectId);
              return false;
            }
            return true;
          }),
        ]);
        return { unchanged: current(item.observedAt), unknown: false };
      } catch { return { unchanged: false, unknown: true }; }
    })),
  ]);
  plan.observations.vercel = vercel.some(item => !item.unchanged || !item.fresh);
  plan.observations.railway = railway.some(item => !item.unchanged || !item.fresh);
  plan.observations.o2switch = hosting.some(item => !item.unchanged);
  // A provider inventory can reveal a new project or a relinking. Check its
  // complete scope once the collector has persisted the new observation.
  if (vercel.some(item => !item.unchanged)) plan.security.vercel = "all";
  if (railway.some(item => !item.unchanged)) plan.security.railway = "all";
  if (hosting.some(item => item.unknown)) {
    plan.security.o2switch = "all";
    plan.wordpress = "all";
    plan.agents = "all";
  }
}
