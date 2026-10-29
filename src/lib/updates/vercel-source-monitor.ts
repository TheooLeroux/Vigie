import { createHash } from "node:crypto";
import { ApiError } from "../http";
import { withVercelCredentials } from "../vercel";
import type { UpdateTarget } from "./types";
import { inspectableSource, scanSourceSnapshot, type SourceFile } from "./source-snapshot";
import { boundedSourceJson } from "./source-http";

export async function readVercelSources(target: UpdateTarget, deploymentId: string, dependencies = { credentials: withVercelCredentials, transport: fetch }) {
  if (target.provider !== "vercel" || !/^dpl_[a-zA-Z0-9]+$/.test(deploymentId)) throw new ApiError("Déploiement Vercel non identifié.");
  return dependencies.credentials(target.connectionId, async (token, teamId) => {
    const deadline = AbortSignal.timeout(180_000);
    async function get(path: string) {
      const url = new URL(`https://api.vercel.com${path}`); url.searchParams.set("teamId", teamId);
      const response = await dependencies.transport(url, { headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.any([deadline, AbortSignal.timeout(30_000)]) });
      if (!response.ok) throw new ApiError(`Lecture des sources Vercel refusée (${response.status}). Vérifier l’accès au déploiement.`, 502);
      return boundedSourceJson(response);
    }
    const deployed = await get(`/v13/deployments/${deploymentId}`);
    if ((deployed.projectId || deployed.project?.id) !== target.remoteId || (deployed.readyState || deployed.state) !== "READY" || (deployed.id || deployed.uid) !== deploymentId) throw new ApiError("Les fichiers ne correspondent pas au déploiement actif du projet.");
    const tree = await get(`/v6/deployments/${deploymentId}/files`);
    if (!Array.isArray(tree)) throw new ApiError("Arborescence des sources Vercel indisponible.");
    const files: { path: string; uid: string }[] = [], limitations: string[] = [];
    let visited = 0;
    function walk(nodes: any[], prefix = "", depth = 0) {
      if (depth > 30) throw new ApiError("Arborescence Vercel trop profonde.");
      for (const entry of nodes) {
        if (++visited > 20000 || !entry || typeof entry.name !== "string" || !entry.name || entry.name.length > 500 || /[\/\\\x00-\x1f]/.test(entry.name) || [".", ".."].includes(entry.name)) throw new ApiError("Arborescence Vercel invalide ou trop volumineuse.");
        const path = prefix + entry.name;
        if (entry.type === "directory" || Array.isArray(entry.children)) { if (Array.isArray(entry.children)) walk(entry.children, path + "/", depth + 1); else limitations.push(`${path} : répertoire non lisible.`); }
        else if (entry.type === "file" && inspectableSource(path)) {
          if (typeof entry.uid !== "string" || !/^[a-f0-9]{40}$/.test(entry.uid)) { limitations.push(`${path} : empreinte du fichier indisponible.`); continue; }
          files.push({ path, uid: entry.uid });
        }
      }
    }
    // src/out are provider wrappers, not repository directories.
    const source = tree.find(entry => entry.name === "src" && Array.isArray(entry.children));
    if (source) walk(source.children);
    else if (tree.some(entry => entry.name === "out" && Array.isArray(entry.children))) throw new ApiError("Vercel expose uniquement la sortie compilée ; les sources originales ne sont pas accessibles.");
    else walk(tree);
    if (new Set(files.map(file => file.path)).size !== files.length) throw new ApiError("Chemins de sources ambigus.");
    const root = target.root.replace(/^\/+|\/+$/g, "");
    let selected = files;
    if (root) {
      const nested = files.filter(file => file.path.startsWith(root + "/"));
      if (nested.length) selected = nested.map(file => ({ ...file, path: file.path.slice(root.length + 1) }));
      else limitations.push("Le répertoire configuré n’est pas présent dans les sources Vercel ; le périmètre exact reste à confirmer.");
    }
    if (selected.length > 500) { selected = selected.slice(0, 500); limitations.push("Inventaire limité aux 500 premiers fichiers pertinents ; analyse partielle."); }
    const snapshot: SourceFile[] = []; let total = 0;
    for (const file of selected) {
      if (deadline.aborted) { limitations.push("Le délai de collecte des sources a été dépassé ; inventaire partiel."); break; }
      try {
        const body = await get(`/v8/deployments/${deploymentId}/files/${file.uid}`);
        if (typeof body.data !== "string" || !/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(body.data)) throw new ApiError("Contenu de source invalide.");
        const bytes = Buffer.from(body.data, "base64");
        if (bytes.length > 6_000_000 || total + bytes.length > 20_000_000) { limitations.push(`${file.path} : budget de lecture dépassé.`); continue; }
        if (createHash("sha1").update(bytes).digest("hex") !== file.uid) throw new ApiError("Empreinte du fichier différente de celle du déploiement.");
        total += bytes.length; snapshot.push({ path: file.path, content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) });
      } catch (error) { limitations.push(`${file.path} : ${error instanceof ApiError ? error.message : "fichier non lisible."}`); }
    }
    return { files: snapshot, limitations };
  });
}
export async function scanVercelSources(target: UpdateTarget, deploymentId: string, dependencies = { read: readVercelSources, scan: scanSourceSnapshot }) {
  const snapshot = await dependencies.read(target, deploymentId);
  return dependencies.scan(snapshot.files, { source: "vercel", deploymentId, limitations: snapshot.limitations });
}
