import { readFileSync, unlinkSync } from "node:fs";
import { createDecipheriv } from "node:crypto";
import {
  railwayState,
  saveRailwayConnection,
  synchronizeRailway,
} from "../src/lib/railway";
import { withAuditActor } from "../src/lib/audit-context";

// Consumes the encrypted one-time transfer from the approved browser setup.
void withAuditActor(
  { name: "Configuration Railway autorisée", email: "" },
  async () => {
    let connection = (await railwayState()).connections.find(
      (c) => c.workspaceId === "f0298460-12bd-4488-88e7-3b4a62683335",
    );
    if (!process.argv.includes("--sync-only")) {
      const path = ".data/railway-token-transfer.json",
        transfer = JSON.parse(readFileSync(path, "utf8"));
      const key = process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY || "";
      if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error("Clé locale absente.");
      const cipher = createDecipheriv(
        "aes-256-gcm",
        Buffer.from(key, "hex"),
        Buffer.from(transfer.iv, "base64"),
      );
      cipher.setAAD(Buffer.from("vigie:railway-transfer:v1"));
      cipher.setAuthTag(Buffer.from(transfer.tag, "base64"));
      const secret = Buffer.concat([
        cipher.update(Buffer.from(transfer.value, "base64")),
        cipher.final(),
      ]).toString("utf8");
      connection = (await saveRailwayConnection(
        {
          name: "Railway · Janssen",
          workspaceId: "f0298460-12bd-4488-88e7-3b4a62683335",
          secret,
        },
        connection?.id,
      ));
      unlinkSync(path);
    }
    if (!connection) throw new Error("Connexion absente.");
    const state = await synchronizeRailway(connection.id);
    console.log(
      JSON.stringify(
        {
          connections: state.connections,
          projects: state.projects.map((p) => ({
            name: p.name,
            linked: p.projectName,
            environments: p.environments.map((e) => e.name),
            services: p.services.map((s) => ({
              name: s.name,
              environment: s.environmentName,
              domains: s.domains,
              builder: s.builder,
              repository: s.repository,
              image: s.image,
              latest: s.latestDeployment?.status,
              active: s.activeDeployments.map((d) => d.status),
            })),
          })),
        },
        null,
        2,
      ),
    );
  },
).catch((e) => {
  console.error(
    e instanceof Error ? e.message : "Configuration Railway échouée.",
  );
  process.exitCode = 1;
});
