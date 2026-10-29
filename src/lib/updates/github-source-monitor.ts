import { createHash } from "node:crypto";
import { ApiError } from "../http";
import { githubRequest, githubUpdateToken } from "./github";
import { inspectableSource, scanSourceSnapshot, type SourceFile } from "./source-snapshot";
import type { UpdateTarget } from "./types";

export async function scanGitHubSources(target: UpdateTarget, commit: string | null, dependencies = { github: githubRequest, scan: scanSourceSnapshot }) {
  if (!target.repository || !/^[\w.-]+\/[\w.-]+$/.test(target.repository) || !commit || !/^[a-f0-9]{40}$/.test(commit)) throw new ApiError("Sources GitHub non liées au commit déployé.");
  const token = githubUpdateToken(target.repository);
  if (!token) throw new ApiError("Accès en lecture au dépôt indisponible.");
  const tree = await dependencies.github(`/repos/${target.repository}/git/trees/${commit}?recursive=1`, token);
  if (tree.truncated || !Array.isArray(tree.tree)) throw new ApiError("Arborescence GitHub incomplète.");
  const prefix = target.root ? target.root + "/" : "";
  const entries = tree.tree.filter((entry: any) => entry.type === "blob" && entry.mode !== "120000" && typeof entry.path === "string" && entry.path.startsWith(prefix) && inspectableSource(entry.path.slice(prefix.length)));
  const files: SourceFile[] = [], limitations: string[] = [];
  if (entries.length > 500) limitations.push("Seuls les 500 premiers fichiers pertinents ont été lus ; couverture partielle.");
  let total = 0; const deadline = Date.now() + 180_000;
  for (const entry of entries.slice(0, 500)) {
    if (Date.now() > deadline) { limitations.push("Délai de collecte dépassé ; inventaire partiel."); break; }
    if (!/^[a-f0-9]{40}$/.test(entry.sha) || !Number.isInteger(entry.size) || entry.size < 0 || entry.size > 6_000_000 || total + entry.size > 20_000_000) { limitations.push("Certains fichiers dépassent le budget de lecture ou n’ont pas d’empreinte vérifiable."); continue; }
    const blob = await dependencies.github(`/repos/${target.repository}/git/blobs/${entry.sha}`, token);
    if (blob.sha !== entry.sha || blob.encoding !== "base64" || typeof blob.content !== "string") throw new ApiError("Fichier GitHub non vérifiable.");
    const bytes = Buffer.from(blob.content, "base64");
    if (bytes.length !== entry.size || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== entry.sha) throw new ApiError("Empreinte GitHub incohérente.");
    total += bytes.length; files.push({ path: entry.path.slice(prefix.length), content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) });
  }
  return dependencies.scan(files, { source: "github", limitations });
}
