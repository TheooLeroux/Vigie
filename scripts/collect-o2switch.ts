import { hostingConnections } from "../src/lib/hosting-connections";
import { hostingDiscovery } from "../src/lib/hosting-discovery";
import {
  collectHostingInventories,
  installObserver,
} from "../src/lib/hosting-inventory";
import { withAuditActor } from "../src/lib/audit-context";
void withAuditActor({ name: "Inventaire o2switch", email: "" }, async () => {
  for (const connection of hostingConnections().filter((c) => c.configured)) {
    if (process.argv.includes("--install-observers-confirmed"))
      for (const site of hostingDiscovery(connection.id).installations.filter(
        (i) =>
          i.project &&
          i.kind === "wordpress" &&
          !i.missingSince &&
          !i.ignored &&
          (!process.argv.includes("--pilot") ||
            i.domains.includes("antipunaiselit.fr")) &&
          (!process.argv.some((a) => a.startsWith("--site=")) ||
            i.domains.includes(
              process.argv.find((a) => a.startsWith("--site="))!.slice(7),
            )),
      )) {
        try {
          const { installation } = await installObserver(site.id, true);
          console.log(
            JSON.stringify({
              account: connection.name,
              project: site.project!.name,
              observer: "verified",
              php: installation.inventory?.php?.version,
              plugins: installation.inventory?.plugins.length,
            }),
          );
        } catch (e) {
          console.error(
            JSON.stringify({
              project: site.project!.name,
              error:
                e instanceof Error ? e.message : "Installation impossible.",
            }),
          );
          process.exitCode = 1;
        }
      }
    else
      try {
        const result = await collectHostingInventories(connection.id);
        console.log(
          JSON.stringify(
            {
              account: connection.name,
              success: result.success,
              failed: result.failed,
              sites: result.discovery.installations
                .filter((i) => i.inventory)
                .map((i) => ({
                  domain: i.domains[0],
                  source: i.inventory!.source,
                  php: i.inventory!.php?.version || null,
                  wordpress: i.inventory!.wordpress?.version || null,
                  plugins: i.inventory!.plugins.length,
                  themes: i.inventory!.themes.length,
                  updates: i.inventory!.plugins.filter(
                    (p) => p.updateState === "available",
                  ).length,
                  unknown: i.inventory!.plugins.filter(
                    (p) => p.updateState === "unknown",
                  ).length,
                  error: i.inventory!.error,
                })),
            },
            null,
            2,
          ),
        );
      } catch (e) {
        console.error(
          connection.name,
          e instanceof Error ? e.message : "Collecte impossible.",
        );
        process.exitCode = 1;
      }
  }
}).catch((e) => {
  console.error(e instanceof Error ? e.message : "Collecte impossible.");
  process.exitCode = 1;
});
