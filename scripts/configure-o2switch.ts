import { readFileSync } from "node:fs";
import { withAuditActor } from "../src/lib/audit-context";
import {
  hostingConnections,
  saveHostingConnection,
} from "../src/lib/hosting-connections";

const file = process.argv[2];
if (!file) throw new Error("Indiquez le chemin de site.txt.");
const lines = readFileSync(file, "utf8")
  .replace(/^\uFEFF/, "")
  .split(/\r?\n/);
withAuditActor({ name: "Configuration o2switch", email: "" }, () => {
  let name = "";
  for (let index = 0; index < lines.length; index++) {
    const section = lines[index].trim().match(/^o2switch\s*(\d+)\s*:/i);
    if (section) {
      name = `o2switch ${section[1]}`;
      continue;
    }
    const endpoint = lines[index].trim();
    if (!/^https:\/\/[a-z0-9-]+\.o2switch\.net:2083\/?$/.test(endpoint))
      continue;
    const username = lines[index + 1]?.trim();
    if (
      !hostingConnections().some(
        (c) =>
          c.endpoint === endpoint.replace(/\/$/, "") && c.username === username,
      )
    )
      saveHostingConnection({ name, endpoint, username, authMode: "token" });
  }
});
console.log(
  JSON.stringify(
    hostingConnections().map((c) => ({
      id: c.id,
      name: c.name,
      endpoint: c.endpoint,
      configured: c.configured,
      status: c.status,
    })),
    null,
    2,
  ),
);
