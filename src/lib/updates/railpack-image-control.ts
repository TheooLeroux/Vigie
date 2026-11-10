import { controlRenewalInterval } from "../automatic-control-state";
import { hostingStorage, readCatalogReports } from "../hosting-storage";
import type { UpdateCheck, UpdateRun, UpdateTarget } from "./types";
import { railpackImageReport, sameRailpackImage, type RailpackImageIdentity, type RailpackImageReport } from "./railpack-image-report";
import { scanRailpackImage, type RailpackInventory } from "./railpack-image-scan";
import { readRailpackImageReports } from "./storage";

type Scan = RailpackImageIdentity & {
  attemptedAt: string;
  attemptRevision?: string;
  report?: RailpackImageReport;
  error?: string;
};
type Inventory = RailpackImageIdentity & { inventory: RailpackInventory };
type CaddyRefusal = { digest: string; reason: string; checkedAt: string };

async function read<T>(key: string): Promise<T | undefined> {
  const row = await (await hostingStorage()).prepare("SELECT data FROM wordpress_catalog WHERE cache_key=?").get(key) as { data: string } | undefined;
  return row ? JSON.parse(row.data) as T : undefined;
}

async function write(key: string, value: Scan | Inventory | CaddyRefusal) {
  await (await hostingStorage()).prepare("INSERT INTO wordpress_catalog(cache_key,data,expires_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at")
    .run(key, JSON.stringify(value), "9999-12-31T00:00:00.000Z");
}

const scanKey = (id: string) => `railpack:scan:1:${id}`;
const caddyRefusalKey = (id: string) => `static:caddy-refusal:1:${id}`;
export async function readRecentCaddyRefusal(id: string, digest: string, now = Date.now()) {
  const previous = await read<CaddyRefusal>(caddyRefusalKey(id));
  const age = previous ? now - Date.parse(previous.checkedAt) : NaN;
  return previous && previous.digest === digest && age >= 0 && age < controlRenewalInterval ? previous : undefined;
}
export async function saveCaddyRefusal(id: string, digest: string, reason: string) {
  await write(caddyRefusalKey(id), { digest, reason, checkedAt: new Date().toISOString() });
}
export async function saveMinimalStaticScan(identity: RailpackImageIdentity, check: UpdateCheck) {
  await write(scanKey(identity.targetId), { ...identity, attemptedAt: check.checkedAt, report: { ...identity, check } });
}
const inventoryKey = (id: string) => `railpack:inventory:1:${id}`;
export const readRailpackScan = (id: string) => read<Scan>(scanKey(id));
export async function readRailpackScans(ids: string[]) {
  const keys = new Map(ids.map(id => [scanKey(id), id]));
  const reports = await readCatalogReports<Scan>(keys.keys());
  return new Map([...reports].map(([key, report]) => [keys.get(key)!, report]));
}
export async function projectRailpackReports(projectId: string, identities: RailpackImageIdentity[], runs: UpdateRun[], scans?: ReadonlyMap<string, Scan>) {
  const cached = scans ?? await readRailpackScans(identities.map(identity => identity.targetId));
  const imageScans = identities.map(identity => {
    const scan = cached.get(identity.targetId);
    return scan && sameRailpackImage(scan, identity) ? scan : undefined;
  });
  const missing = identities.filter((identity, index) => !imageScans[index]?.report && !runs.some(run => railpackImageReport(run, identity)));
  const archived = await readRailpackImageReports(projectId, missing);
  return identities.flatMap((identity, index) => {
    const scan = imageScans[index];
    if (scan?.report) return [{ ...scan.report, ...(scan.error ? { error: scan.error } : {}) }];
    const fallback = archived.find(report => sameRailpackImage(report, identity));
    if (fallback || scan?.error) {
      const report = fallback || runs.map(run => railpackImageReport(run, identity)).find(item => item !== null);
      if (report) return [{ ...report, ...(scan?.error ? { error: scan.error } : {}) }];
    }
    return [];
  });
}
export async function cachedRailpackInventory(identity: RailpackImageIdentity) {
  const cached = await read<Inventory>(inventoryKey(identity.targetId));
  return cached && sameRailpackImage(cached, identity) ? cached.inventory : undefined;
}

export function railpackScanDue(identity: RailpackImageIdentity, previous: Scan | undefined, now = Date.now(), force = false, revision?: string) {
  if (!previous || !sameRailpackImage(previous, identity) || force && (!revision || previous.attemptRevision !== revision)) return true;
  const age = now - Date.parse(previous.attemptedAt);
  return !Number.isFinite(age) || age < 0 || age >= (previous.error ? 5 * 60_000 : controlRenewalInterval);
}

export async function refreshRailpackImage(target: UpdateTarget, identity: RailpackImageIdentity, force?: boolean, revision?: string, scan = scanRailpackImage) {
  const previous = await readRailpackScan(target.id);
  if (!railpackScanDue(identity, previous, Date.now(), force, revision)) return null;
  const attempt = { ...identity, attemptedAt: new Date().toISOString(), attemptRevision: revision };
  const cached = await cachedRailpackInventory(identity);
  try {
    if (identity.caddy === "minimal-static") {
      const { scanMinimalStaticImage } = await import("./minimal-static");
      const { readRailwayInstance } = await import("./providers");
      const { deploymentEvidence } = await import("../connectors/railway-evidence");
      const { normalizeImageDigest } = await import("../image-reference");
      const { securityCheck } = await import("./security");
      const { findings } = await scanMinimalStaticImage(target, identity.deploymentId);
      const { serviceInstance } = await readRailwayInstance(target);
      const [active] = serviceInstance.activeDeployments || [];
      if (serviceInstance.activeDeployments?.length !== 1 || active.id !== identity.deploymentId ||
        normalizeImageDigest(deploymentEvidence(active.meta)?.imageDigest) !== identity.imageDigest) throw Error("Image active modifiée pendant le scan.");
      const check = securityCheck("Trivy", "after", "Image statique minimale déployée sur Railway", findings);
      await write(scanKey(target.id), { ...attempt, report: { ...identity, check } });
      return "checked" as const;
    }
    const { check, inventory: scanned } = await scan(target, identity, cached);
    if (!cached) await write(inventoryKey(target.id), { ...identity, inventory: scanned });
    await write(scanKey(target.id), { ...attempt, report: { ...identity, check } });
    return "checked" as const;
  } catch {
    const report = previous && sameRailpackImage(previous, identity) ? previous.report : undefined;
    await write(scanKey(target.id), { ...attempt, report, error: "Le scan de l’image active n’a pas pu être renouvelé. Un nouveau contrôle est prévu." });
    return "failed" as const;
  }
}
