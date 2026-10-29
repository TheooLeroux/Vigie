export type ProjectRevision = { key: string; project_id: string | null; kind: string; revision: string };
export type ProjectChange = { projects: string[]; all: boolean; workspace: boolean; activity: boolean; activityProjects: string[] };
export const emptyProjectChange = (): ProjectChange => ({ projects: [], all: false, workspace: false, activity: false, activityProjects: [] });
export function mergeProjectChanges(a: ProjectChange, b: ProjectChange): ProjectChange {
  return { projects: [...new Set([...a.projects, ...b.projects])], all: a.all || b.all, workspace: a.workspace || b.workspace, activity: a.activity || b.activity, activityProjects: [...new Set([...a.activityProjects, ...b.activityProjects])] };
}
export function changedProjects(previous: readonly ProjectRevision[] | undefined, rows: readonly ProjectRevision[]): ProjectChange {
  // Initial catch-up closes the gap between the initial HTTP read and subscribing.
  if (!previous) return { ...emptyProjectChange(), all: true, workspace: true, activity: true };
  let result = emptyProjectChange();
  const before = new Map(previous.map(row => [row.key, row]));
  const after = new Map(rows.map(row => [row.key, row]));
  const add = (row: ProjectRevision) => {
    const change = emptyProjectChange();
    if (row.kind === "activity") { change.activity = row.project_id === null; change.activityProjects = row.project_id ? [row.project_id] : []; }
    else if (row.kind !== "auth") {
      change.projects = row.project_id ? [row.project_id] : [];
      change.all = row.kind === "all";
      change.workspace = ["workspace", "project", "all"].includes(row.kind);
    }
    result = mergeProjectChanges(result, change);
  };
  for (const [key, row] of after) {
    const old = before.get(key);
    if (!old || old.revision !== row.revision || old.project_id !== row.project_id || old.kind !== row.kind) {
      if (old) add(old); // Relinking invalidates both the former and new project.
      add(row);
    }
  }
  for (const [key, row] of before) if (!after.has(key)) add(row);
  return result;
}
export const hasProjectChanges = (change: ProjectChange) => change.all || change.workspace || change.activity || !!change.projects.length || !!change.activityProjects.length;

// Debounce bursts and retain changes that arrive during an HTTP read. There is
// no periodic wake-up: another request requires another invalidation.
export function createRefreshQueue(refresh: (keys: string[]) => Promise<void>, onError: (error: unknown) => void = () => {}, delay = 250) {
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined, running = false, disposed = false;
  function schedule() { if (!disposed && !running && !timer && pending.size) timer = setTimeout(drain, delay); }
  async function drain() {
    timer = undefined;
    if (disposed || running || !pending.size) return;
    const keys = [...pending]; pending.clear(); running = true;
    try { await refresh(keys); } catch (error) { if (!disposed) onError(error); }
    finally { running = false; schedule(); }
  }
  return {
    invalidate(keys: string[]) { if (disposed) return; keys.forEach(key => pending.add(key)); schedule(); },
    dispose() { disposed = true; clearTimeout(timer); pending.clear(); },
  };
}
