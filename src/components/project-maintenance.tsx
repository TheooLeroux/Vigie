"use client";
import { MaintenancePanel } from "./maintenance-panel";

export function ProjectMaintenance({
  projectId,
  projectName,
  request,
}: {
  projectId: string;
  projectName: string;
  request: (path: string, method?: string, payload?: unknown) => Promise<any>;
}) {
  return (
    <section
      className="project-maintenance"
      aria-label={`Mises à jour de ${projectName}`}
    >
      <div className="panel project-section-title project-maintenance-heading">
        <div>
          <h2>Mises à jour</h2>
          <p>
            Node et dépendances : dernières versions stables.
          </p>
        </div>
      </div>
      <MaintenancePanel
        key={projectId}
        projectId={projectId}
        request={request}
        embedded
      />
    </section>
  );
}
