import type { SiteInventory } from "../types";
export function wordpressSecurityVersions(inventory: SiteInventory) {
  return JSON.stringify([inventory.wordpress?.version, ...(["plugins", "themes"] as const).map(kind => inventory[kind].map(item => [item.slug, item.version, item.updateOrigin || "unknown", item.template || "", item.mustUse ? "mu" : "ordinary"]).sort((a, b) => a[0]!.localeCompare(b[0]!)))]);
}
