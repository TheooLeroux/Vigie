import type { MaintenanceState } from "./maintenance-contract";

export function maintenanceScope(
  state: MaintenanceState | null,
  projectId?: string,
) {
  return {
    targets:
      state?.targets.filter(
        (target) => !projectId || target.projectId === projectId,
      ) || [],
    jobs:
      state?.jobs.filter((job) => !projectId || job.projectId === projectId) ||
      [],
  };
}
