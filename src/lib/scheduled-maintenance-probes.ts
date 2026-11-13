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
import { wordpressObservationNeedsRefresh } from "./observation-freshness";
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

type WordPressProbe = {
  site: Pick<HostingInstallationView, "documentRoot" | "suggestedEnvironment" | "domains" | "aliases">;
  url: string;
  secret: string;
  agent: Pick<LocalAgentSettings, "directory" | "environment" | "secret"> | null;
  versions: string;
};
type HostingCredentials = Pick<HostingConnection, "id" | "name" | "endpoint" | "username" | "authMode"> & { secret: string };

export type MaintenanceProbes = {
  vercel: { teamId: string; token: string; digest: string }[];
  railway: { workspaceId: string; token: string; digest: string }[];
  hosting: {
    credentials: HostingCredentials;
    digest: string;
    wordpress: WordPressProbe[];
    sources: { root: string; digest: string }[];
  }[];
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

async function wordpressProbe(site: HostingInstallationView, until: number): Promise<WordPressProbe | null> {
  const current = site.inventory;
  if (!current || current.source !== "wordpress-observer" || current.collectionMode === "early" || current.error ||
      wordpressObservationNeedsRefresh(site, until)) return null;
  const state = (await readUpdateSource(`wordpress:${site.id}`))?.settings;
  const agent = state?.localAgent;
  const verifiedAt = Date.parse(agent?.lastVerifiedAt ?? "");
  const setup = state?.agentInstallation;
  // A failed installation is already waiting for its persisted retry time.
  // Keep checking WordPress versions while respecting that backoff.
  const waitingForRetry = setup?.state === "failed" && !agent?.ready && Date.parse(setup.nextAttemptAt ?? "") > until;
  if (!waitingForRetry && (!agent?.ready || agent.bundleVersion !== wordpressAgentPackageVersion || state?.agentReportedFailure ||
      (state?.agentInstallation && state.agentInstallation.state !== "ready") ||
      !Number.isFinite(verifiedAt) || verifiedAt > Date.now() || until - verifiedAt >= 15 * 60_000)) return null;
  return withWordPressObserver(site, (url, secret) => ({
    site: { documentRoot: site.documentRoot, suggestedEnvironment: site.suggestedEnvironment, domains: site.domains, aliases: site.aliases },
    url, secret, agent: waitingForRetry || !agent ? null : { directory: agent.directory, environment: agent.environment, secret: agent.secret },
    versions: wordpressSecurityVersions(current),
  }));
}

export async function readMaintenanceProbes(until: number): Promise<MaintenanceProbes | null> {
  const [vercel, railway, hosting] = await Promise.all([
    vercelState({ includeDisplayLabels: false }),
    railwayState({ includeDisplayLabels: false }),
    hostingConnections(),
  ]);
  if (vercel.connections.some(item => item.error) || railway.connections.some(item => item.error) ||
      hosting.some(item => item.configured && item.status !== "connected")) return null;
  const [vercelProbes, railwayProbes, hostingProbes] = await Promise.all([
    Promise.all(vercel.connections.filter(item => item.configured).map(item =>
      withVercelCredentials(item.id, async (token, teamId) => ({
        teamId, token, digest: digest(vercel.projects.filter(project => project.connectionId === item.id && !project.missingSince)
          .map(project => [project.id, project.name, project.production?.id ?? null])),
      })))),
    Promise.all(railway.connections.filter(item => item.configured).map(item =>
      withRailwayCredentials(item.id, async (token, workspaceId) => ({
        workspaceId, token, digest: railwayDigest(railway.projects.filter(project => project.connectionId === item.id && !project.missingSince)),
      })))),
    Promise.all(hosting.filter(item => item.configured).map(async item => {
      const discovery = await hostingDiscovery(item.id);
      if (discovery.error || !discovery.lastSuccessAt) return null;
      const sites = discovery.installations.filter(site => !site.missingSince);
      const linked = sites.filter(site => !site.ignored && site.project?.lifecycle === "active");
      const [wordpress, sources] = await Promise.all([
        mapConcurrent(linked.filter(eligible), 4, site => wordpressProbe(site, until)),
        mapConcurrent(linked.filter(site => site.kind !== "wordpress"), 4, async site => {
          const report = await readAutomaticControl(`hosting:${site.id}`);
          return report?.sourceDigest ? { root: site.documentRoot, digest: report.sourceDigest } : null;
        }),
      ]);
      if (wordpress.some(item => !item) || sources.some(item => !item)) return null;
      return withHostingCredentials(item.id, async ({ id, name, endpoint, username, authMode, secret }) => ({
        credentials: { id, name, endpoint, username, authMode, secret },
        digest: hostingDigest(sites), wordpress: wordpress.filter(item => item !== null),
        sources: sources.filter(item => item !== null),
      }));
    })),
  ]);
  if (hostingProbes.some(item => !item)) return null;
  return { vercel: vercelProbes, railway: railwayProbes, hosting: hostingProbes.filter(item => item !== null) };
}

export async function maintenanceProbesUnchanged(probes: MaintenanceProbes) {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(40_000)]);
  const transport: typeof fetch = (url, options) => fetch(url, {
    ...options, signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
  });
  const compare = (unchanged: boolean) => {
    if (!unchanged) controller.abort();
    return unchanged;
  };
  try {
    const checks = await Promise.all([
      ...probes.vercel.map(async item => compare(digest((await readVercelProductionPointers(item.teamId, item.token, transport))
        .map(project => [project.projectId, project.name, project.deploymentId])) === item.digest)),
      ...probes.railway.map(async item => compare(railwayDigest(await readRailwayInventory(item.workspaceId, item.token, transport, signal)) === item.digest)),
      ...probes.hosting.map(async item => {
        const current = await collectO2switchInstallations(item.credentials, transport);
        if (!compare(hostingDigest(current.installations) === item.digest)) return false;
        const client = cpanelReadClient(item.credentials, transport);
        const [wordpress, sources] = await Promise.all([
          mapConcurrent(item.wordpress, 4, async proof => {
            const inventory = await collectObserver(proof.url, proof.site.documentRoot, proof.secret, undefined, undefined, false, { refresh: false, signal });
            if (!compare(inventory.collectionMode === "normal" && wordpressSecurityVersions(inventory) === proof.versions)) return false;
            if (!proof.agent) return true;
            return compare(await agentControlHealthy({ ...proof.site, inventory }, proof.agent, cpanelAgentFiles(item.credentials, proof.agent.directory, transport)));
          }),
          mapConcurrent(item.sources, 2, async source => {
            const current = await readHostingSources(source.root, client, signal);
            return compare(!current.limitations.length && hostingSourcesDigest(current.files) === source.digest);
          }),
        ]);
        return wordpress.every(Boolean) && sources.every(Boolean);
      }),
    ]);
    return !signal.aborted && checks.every(Boolean);
  } catch {
    controller.abort();
    return false;
  }
}
