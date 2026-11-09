import { controlRenewalInterval } from "../automatic-control-state";
import { hostingStorage } from "../hosting-storage";
import type { UpdateTarget } from "./types";
import { sameRailpackImage, type RailpackImageIdentity, type RailpackImageReport } from "./railpack-image-report";
import { scanRailpackImage, type RailpackInventory } from "./railpack-image-scan";

type Scan = RailpackImageIdentity & {
  attemptedAt: string;
  attemptRevision?: string;
  report?: RailpackImageReport;
  error?: string;
};
type Inventory = RailpackImageIdentity & { inventory: RailpackInventory };

async function read<T>(key: string): Promise<T | undefined> {
  const row = await (await hostingStorage()).prepare("SELECT data FROM wordpress_catalog WHERE cache_key=?").get(key) as { data: string } | undefined;
  return row ? JSON.parse(row.data) as T : undefined;
}

async function write(key: string, value: Scan | Inventory) {
  await (await hostingStorage()).prepare("INSERT INTO wordpress_catalog(cache_key,data,expires_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at")
    .run(key, JSON.stringify(value), "9999-12-31T00:00:00.000Z");
}

const scanKey = (id: string) => `railpack:scan:1:${id}`;
const inventoryKey = (id: string) => `railpack:inventory:1:${id}`;
export const readRailpackScan = (id: string) => read<Scan>(scanKey(id));

export function railpackScanDue(identity: RailpackImageIdentity, previous: Scan | undefined, now = Date.now(), force = false, revision?: string) {
  if (!previous || !sameRailpackImage(previous, identity) || force && (!revision || previous.attemptRevision !== revision)) return true;
  const age = now - Date.parse(previous.attemptedAt);
  return !Number.isFinite(age) || age < 0 || age >= (previous.error ? 5 * 60_000 : controlRenewalInterval);
}

export async function refreshRailpackImage(target: UpdateTarget, identity: RailpackImageIdentity, force?: boolean, revision?: string, scan = scanRailpackImage) {
  const previous = await readRailpackScan(target.id);
  if (!railpackScanDue(identity, previous, Date.now(), force, revision)) return null;
  const attempt = { ...identity, attemptedAt: new Date().toISOString(), attemptRevision: revision };
  const inventory = await read<Inventory>(inventoryKey(target.id));
  const cached = inventory && sameRailpackImage(inventory, identity) ? inventory.inventory : undefined;
  try {
    const { check, inventory: scanned } = await scan(target, identity, cached);
    if (!cached) await write(inventoryKey(target.id), { ...identity, inventory: scanned });
    await write(scanKey(target.id), { ...attempt, report: { ...identity, check } });
    return "checked" as const;
  } catch {
    const report = previous && sameRailpackImage(previous, identity) ? previous.report : undefined;
    await write(scanKey(target.id), { ...attempt, report, error: "Le scan de l’image Railpack n’a pas pu être renouvelé. Un nouveau contrôle est prévu." });
    return "failed" as const;
  }
}
