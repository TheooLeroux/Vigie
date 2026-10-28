import type { SiteInventory } from "../types";
export function wordpressSecurityVersions(inventory: SiteInventory) {
  return JSON.stringify([inventory.wordpress?.version, inventory.plugins.filter(item => !item.mustUse).map(item => [item.slug, item.version]).sort((a, b) => a[0]!.localeCompare(b[0]!))]);
}
