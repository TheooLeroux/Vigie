import { withHostingCredentials } from "../hosting-connections";
import { cpanelReadClient } from "../connectors/cpanel-read";
import { inspectableSource, scanSourceSnapshot, type SourceFile } from "./source-snapshot";
import type { UpdateTarget } from "./types";

export async function scanHostingSources(target: UpdateTarget, dependencies = { credentials: withHostingCredentials, client: cpanelReadClient, scan: scanSourceSnapshot }) {
  return dependencies.credentials(target.connectionId, async credentials => {
    const client = dependencies.client(credentials), files: SourceFile[] = [], limitations: string[] = [];
    const queue = [""]; let directories = 0, bytes = 0;
    while (queue.length && directories++ < 50 && files.length < 500) {
      const relative = queue.shift()!;
      try {
        for (const entry of await client.list(target.root + (relative ? "/" + relative : ""))) {
          const path = (relative ? relative + "/" : "") + entry.file;
          if (entry.type === "dir" && !entry.file.startsWith(".") && !["node_modules", "vendor", "uploads", "wp-content", "wp-includes", "wp-admin"].includes(entry.file) && path.split("/").length < 10) queue.push(path);
          if (entry.type !== "file" || !inspectableSource(path)) continue;
          if (files.length >= 500 || entry.size > 1_500_000 || bytes + entry.size > 15_000_000) { limitations.push("Certains fichiers dépassent le budget de lecture ; inventaire partiel."); continue; }
          try { const content = await client.readSource(target.root, path); bytes += Buffer.byteLength(content); files.push({ path, content }); }
          catch { limitations.push(`${path} : source non lisible sur l’hébergement.`); }
        }
      } catch { limitations.push(`${relative || "racine"} : répertoire non lisible sur l’hébergement.`); }
    }
    if (queue.length) limitations.push("L’arborescence dépasse le budget de lecture ; inventaire partiel.");
    limitations.push("Lecture des fichiers actuels du site ; les modifications intervenant pendant la collecte et les composants serveur non inventoriés restent à vérifier.");
    return dependencies.scan(files, { source: "hosting", limitations });
  });
}
