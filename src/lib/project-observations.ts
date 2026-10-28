import { projectDetail } from "./db";
import { projectHostingInstallations } from "./hosting-discovery";
import { vercelState } from "./vercel";
import { railwayState } from "./railway";
import type { ProjectDetail, Workspace } from "./types";

// The stored project record contains no provider observations. Both HTTP views
// and background scans must assemble the same complete snapshot.
export async function observedProjectDetail(id: string, workspace: Workspace): Promise<ProjectDetail> {
  const detail = await projectDetail(id, workspace);
  const [hosting, vercel, railway] = await Promise.all([projectHostingInstallations(id), vercelState(), railwayState()]);
  return { ...detail, hosting, vercel: vercel.projects.filter(project => project.projectId === id), railway: railway.projects.filter(project => project.projectId === id) };
}
