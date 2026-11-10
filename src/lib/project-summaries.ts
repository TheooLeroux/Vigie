import { list } from "./db";
import { readProjectObservationBatch } from "./project-observation-batch";
import { summarizeProject, type ProjectSummary } from "./project-summary";
import type { Project } from "./types";

export async function projectSummaries(ids: string[], signal?: AbortSignal) {
  const summaries: Record<string, ProjectSummary> = {};
  if (signal?.aborted || !ids.length) return summaries;
  const requested = new Set(ids);
  const workspaceProjects = await list<Project>("projects", "live");
  const projects = workspaceProjects.filter(project => requested.has(project.id));
  if (signal?.aborted || !projects.length) return summaries;

  const batch = await readProjectObservationBatch(projects, workspaceProjects, signal);
  for (const project of projects) {
    const observation = batch.get(project.id);
    const detail = observation?.detail ?? null;
    try { summaries[project.id] = summarizeProject(project, detail, observation?.updates ?? null); }
    catch { summaries[project.id] = summarizeProject(project, detail, null); }
  }
  return summaries;
}
