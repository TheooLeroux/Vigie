import {
  hostingConnections,
  discoverHostingConnection,
} from "../src/lib/hosting-connections";
import { withAuditActor } from "../src/lib/audit-context";

void withAuditActor({ name: "Découverte o2switch", email: "" }, async () => {
  for (const connection of hostingConnections().filter((c) => c.configured)) {
    try {
      const { discovery } = await discoverHostingConnection(connection.id);
      console.log(
        JSON.stringify(
          {
            account: connection.name,
            ...discovery.summary,
            installations: discovery.installations
              .filter(
                (i) =>
                  i.project ||
                  [
                    "wordpress",
                    "wordpress-incomplete",
                    "dolibarr",
                    "next-static",
                    "static",
                    "php",
                  ].includes(i.kind) ||
                  i.inspectionError,
              )
              .map((i) => ({
                domains: i.domains,
                kind: i.kind,
                version: i.version,
                project: i.project?.name || null,
                error: i.inspectionError,
              })),
          },
          null,
          2,
        ),
      );
    } catch (error) {
      console.error(
        connection.name,
        error instanceof Error ? error.message : "Recherche impossible.",
      );
      process.exitCode = 1;
    }
  }
}).catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Recherche impossible.",
  );
  process.exitCode = 1;
});
