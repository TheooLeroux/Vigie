import { readFileSync, unlinkSync } from "node:fs";
import { createDecipheriv } from "node:crypto";
import {
  vercelState,
  saveVercelConnection,
  synchronizeVercel,
} from "../src/lib/vercel";
import { withAuditActor } from "../src/lib/audit-context";
import { VERCEL_SOURCE_TEAM } from "../src/lib/vercel-client-mapping";
void withAuditActor(
  { name: "Configuration Vercel autorisée", email: "" },
  async () => {
    let c = (await vercelState()).connections.find(
      (c) => c.teamId === VERCEL_SOURCE_TEAM,
    );
    if (!process.argv.includes("--sync-only")) {
      const file = ".data/vercel-token-transfer.json",
        raw = JSON.parse(readFileSync(file, "utf8")),
        key = process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY || "";
      if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error("Clé locale absente.");
      const cipher = createDecipheriv(
        "aes-256-gcm",
        Buffer.from(key, "hex"),
        Buffer.from(raw.iv, "base64"),
      );
      cipher.setAAD(Buffer.from("vigie:vercel-transfer:v1"));
      cipher.setAuthTag(Buffer.from(raw.tag, "base64"));
      const secret = Buffer.concat([
        cipher.update(Buffer.from(raw.value, "base64")),
        cipher.final(),
      ]).toString("utf8");
      c = (await saveVercelConnection(
        { name: "Vercel · Janssen", teamId: VERCEL_SOURCE_TEAM, secret },
        c?.id,
      ));
      unlinkSync(file);
    }
    if (!c) throw new Error("Connexion Vercel absente.");
    const state = await synchronizeVercel(c.id);
    console.log(
      JSON.stringify(
        {
          connections: state.connections,
          projects: state.projects.map((p) => ({
            id: p.id,
            name: p.name,
            excluded: p.excluded,
            client: p.clientSuggestion,
            linked: p.projectName,
            domains: p.domains.map((d) => d.name),
            framework: p.framework,
            nodeBranch: p.nodeBranch,
            production: p.production
              ? {
                  state: p.production.state,
                  node: p.production.nodeBranch,
                  supported: p.production.nodeRelease?.supported,
                  repository: p.production.repository,
                  commit: p.production.commit,
                  analysis: p.production.analysis,
                }
              : null,
            latest: p.latest?.state,
          })),
        },
        null,
        2,
      ),
    );
  },
).catch((e) => {
  console.error(
    e instanceof Error ? e.message : "Configuration Vercel échouée.",
  );
  process.exitCode = 1;
});
