import { list } from "./db";
import { updateStorage } from "./updates/storage";
import type { Project } from "./types";
import type { UpdateRun } from "./updates/types";
export async function recordedBackups(offset = 0) {
  const db = await updateStorage();
  const rows = await db.prepare("SELECT data FROM update_runs WHERE (data LIKE ? OR data LIKE ? OR data LIKE ?) ORDER BY json_extract(data,'$.createdAt') DESC,id DESC LIMIT ? OFFSET ?").all('%"backup":%', '%"previousCommit":%', '%"previousDeploymentId":%', 26, offset) as { data: string }[];
  const projects = new Map((await list<Project>("projects", "live")).map(project => [project.id, project]));
  const items = rows.slice(0, 25).flatMap(row => {
    const run = JSON.parse(row.data) as UpdateRun;
    const project = projects.get(run.projectId);
    if (!project) return [];
    return run.results.flatMap(result => {
      const target = run.targets.find(target => target.id === result.targetId);
      if (!target || !result.backup && !result.previousCommit && !result.previousDeploymentId) return [];
      return [{ id: run.id + ":" + target.id, runId: run.id, projectId: project.id, projectName: project.name, targetName: target.name, createdAt: run.createdAt, stage: result.stage, provider: target.provider, kind: result.backup ? "wordpress" as const : "reference" as const, path: result.backup || null, commit: result.previousCommit || null, deploymentId: result.previousDeploymentId || null }];
    });
  });
  return { items, nextOffset: rows.length > 25 ? offset + 25 : null };
}
export type RecordedBackups = Awaited<ReturnType<typeof recordedBackups>>;
