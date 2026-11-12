import { ApiError } from "./http";
import { hostingConnections, discoverHostingConnection } from "./hosting-connections";
import { vercelState, synchronizeVercel } from "./vercel";
import { railwayState, synchronizeRailway } from "./railway";
import { deploymentObservationLifetime, observationIsFresh } from "./observation-freshness";

export type ControlProvider = "o2switch" | "vercel" | "railway";
type ControlConnection = { id: string; configured: boolean };
type Dependencies = {
  connections: () => Promise<ControlConnection[]>;
  synchronize: (id: string) => Promise<unknown>;
};
const providers: Record<ControlProvider, Dependencies> = {
  o2switch: { connections: hostingConnections, synchronize: discoverHostingConnection },
  vercel: { connections: async () => (await vercelState({ projectIds: [] })).connections, synchronize: synchronizeVercel },
  railway: { connections: async () => (await railwayState({ projectIds: [] })).connections, synchronize: synchronizeRailway },
};
// Refresh provider control independently of site deployments. A failed account must
// not prevent other accounts from being checked; existing observations stay dated.
export async function reconcileHostingConnections(provider: ControlProvider, dependencies = providers[provider]) {
  const result = { checked: 0, failed: 0, deferred: 0 };
  for (const connection of (await dependencies.connections()).filter(item => item.configured)) {
    try { await dependencies.synchronize(connection.id); result.checked++; }
    catch (error) {
      if (error instanceof ApiError && [409, 429].includes(error.status)) result.deferred++;
      else result.failed++;
    }
  }
  return result;
}

export function hostingControlIssue(provider: string, observation: { connectionError: string | null; observedAt: string; configured?: boolean }, now = Date.now()) {
  if (observation.connectionError || observation.configured === false) return `Le contrôle ${provider} est indisponible. Vérifiez la connexion ; une reprise automatique est prévue.`;
  if (!observationIsFresh(observation.observedAt, deploymentObservationLifetime, now)) return `Le contrôle ${provider} a expiré. La synchronisation automatique est attendue.`;
  return null;
}
