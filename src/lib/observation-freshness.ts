import type { HostingInstallationView, ProjectDetail, UpdateInfo } from "./types";

export const deploymentObservationLifetime = 15 * 60_000;
export const wordpressObservationLifetime = 60 * 60_000;
export const wordpressCatalogLifetime = 24 * 60 * 60_000;
export const expiredWordPressCatalogWarning = "Certaines vérifications de mises à jour ont plus de 24 heures.";

export function observationIsFresh(at: string | null | undefined, lifetime: number, now = Date.now()) {
  const age = now - Date.parse(at || "");
  return Number.isFinite(age) && age >= -30_000 && age < lifetime;
}

export function wordpressUpdateIsFresh(value: UpdateInfo, now = Date.now()) {
  return observationIsFresh(value.updateCheckedAt, wordpressCatalogLifetime, now);
}

export function wordpressInventoryIsFresh(site: HostingInstallationView, now = Date.now()) {
  return !site.ignored && !site.missingSince && !site.inventory?.error && observationIsFresh(site.inventory?.observedAt, wordpressObservationLifetime, now);
}

function deploymentStatus(item: { observedAt: string; connectionError: string | null; missingSince: string | null; configured: boolean }, now: number) {
  if (item.connectionError) return "error";
  if (item.missingSince) return "missing";
  if (!item.configured) return "unverified";
  return observationIsFresh(item.observedAt, deploymentObservationLifetime, now) ? "fresh" : "stale";
}

export function deploymentObservationNeedsRefresh(item: { observedAt: string; connectionError: string | null }, now = Date.now()) {
  return !!item.connectionError || !observationIsFresh(item.observedAt, deploymentObservationLifetime - 5 * 60_000, now);
}

export function wordpressObservationNeedsRefresh(site: HostingInstallationView, now = Date.now()) {
  if (site.ignored || site.missingSince || !site.observerConfigured || site.kind !== "wordpress") return false;
  const inventory = site.inventory;
  return !inventory || !!inventory.error || !observationIsFresh(inventory.observedAt, wordpressObservationLifetime - 10 * 60_000, now);
}

export function projectObservations(detail: ProjectDetail, now = Date.now()) {
  const deployment = (provider: string, item: { id: string; connectionId: string; name: string; observedAt: string; connectionError: string | null; missingSince: string | null; configured: boolean }) => ({
    id: `${provider}:${item.connectionId}:${item.id}`, label: `${provider} · ${item.name}`, at: item.observedAt,
    status: deploymentStatus(item, now),
    refreshable: item.configured,
    due: item.configured && deploymentObservationNeedsRefresh(item, now),
    lifetime: deploymentObservationLifetime,
    expiredCatalogs: 0,
  } as const);
  return [
    ...(detail.vercel || []).filter(item => !item.excluded).map(item => deployment("Vercel", item)),
    ...(detail.railway || []).map(item => deployment("Railway", item)),
    ...(detail.hosting || []).filter(item => !item.ignored).map(site => {
      const wordpress = site.kind === "wordpress";
      const inventory = site.inventory;
      const at = wordpress ? inventory?.observedAt : site.observedAt;
      const expiredCatalogs = wordpress && inventory
        ? [inventory.wordpress, ...inventory.plugins, ...inventory.themes].filter(item => item?.updateCheckedAt && !wordpressUpdateIsFresh(item, now)).length
        : 0;
      const status = site.missingSince ? "missing" : (wordpress ? inventory?.error : site.inspectionError) ? "error"
        : !at ? "unverified" : !observationIsFresh(at, wordpressObservationLifetime, now) ? "stale"
          : wordpress && (inventory?.collectionMode === "early" || inventory?.source !== "wordpress-observer") ? "partial" : "fresh";
      return {
        id: `o2switch:${site.id}`, label: `${wordpress ? "WordPress" : "o2switch"} · ${site.domains[0] || site.connectionName}`,
        at, status, expiredCatalogs, refreshable: wordpress && site.observerConfigured && !site.missingSince,
        lifetime: wordpressObservationLifetime,
        due: wordpressObservationNeedsRefresh(site, now),
      } as const;
    }),
  ];
}
