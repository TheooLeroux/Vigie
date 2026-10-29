import { requireProject } from "./db";
import { observedProjectDetail } from "./project-observations";
import { projectUpdates } from "./updates/service";
import { summarizeProject, type ProjectSummary } from "./project-summary";
import { mapConcurrent } from "./updates/planning";
export async function projectSummaries(ids: string[], signal?: AbortSignal) {
  const summaries: Record<string, ProjectSummary> = {};
  await mapConcurrent([...new Set(ids)], 4, async id => {
    if (signal?.aborted) return;
    try {
      const project = await requireProject(id, "live");
      const [detail, updates] = await Promise.allSettled([observedProjectDetail(id, "live"), projectUpdates(id)]);
      summaries[id] = summarizeProject(project, detail.status === "fulfilled" ? detail.value : null, updates.status === "fulfilled" ? updates.value : null);
    } catch { /* A deleted project or failed detail must not discard other summaries. */ }
  });
  return summaries;
}
