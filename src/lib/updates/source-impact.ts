import { ApiError } from "../http";
import { vercelState } from "../vercel";
import { railwayState } from "../railway";
import type { UpdateTarget } from "./types";

export type SourceConsumer = { id: string; name: string; repository: string; branch: string | null; root: string };
const normalize = (value: string) => value.replace(/^\/+|\/+$/g, "");
export function sourceImpact(targets: UpdateTarget[], files: string[], consumers: SourceConsumer[]) {
  const first = targets[0];
  if (!first?.repository) return [];
  return consumers.filter(consumer => consumer.repository.toLowerCase() === first.repository!.toLowerCase() && (!consumer.branch || consumer.branch === first.branch) && !targets.some(target => target.id === consumer.id) && files.some(file => {
    const root = normalize(consumer.root), directory = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
    return !root || file.startsWith(root + "/") || !directory || root === directory || root.startsWith(directory + "/");
  }));
}
export async function assertSourceImpact(targets: UpdateTarget[], files: string[], readers = { vercel: vercelState, railway: railwayState }) {
  if (targets[0]?.mode !== "git") return;
  const [vercel, railway] = await Promise.all([readers.vercel(), readers.railway()]);
  const consumers: SourceConsumer[] = [
    ...vercel.projects.flatMap(project => project.repository ? [{ id: `vercel:${project.connectionId}:${project.id}`, name: project.name, repository: project.repository, branch: project.productionBranch || project.production?.branch || null, root: project.rootDirectory || "" }] : []),
    ...railway.projects.flatMap(project => project.services.flatMap(service => service.repository ? [{ id: `railway:${project.connectionId}:${service.id}:${service.environmentId}`, name: `${project.name} / ${service.name}`, repository: service.repository, branch: service.activeDeployments[0]?.evidence?.branch || null, root: service.rootDirectory || "" }] : [])),
  ];
  const affected = sourceImpact(targets, files, consumers);
  if (affected.length) throw new ApiError(`Des fichiers communs affectent aussi des services non sélectionnés : ${affected.map(item => item.name).join(", ")}. Qualifiez leur maintenance ensemble avant de publier ; aucun changement publié.`, 409);
}
