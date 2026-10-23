"use client";
import { useState } from "react";
import { Wrench } from "lucide-react";
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
  const [expanded, setExpanded] = useState(false);
  const editorId = `project-maintenance-${projectId}`;
  return (
    <section
      className="project-maintenance"
      aria-label={`Mises à jour de ${projectName}`}
    >
      <div className="panel project-section-title project-maintenance-heading">
        <div>
          <h2>Mises à jour</h2>
          <p>Node, frameworks et dépendances npm/pnpm de ce projet.</p>
          <p>
            Choisissez les versions et confirmez la préparation d’une PR.
            Aucun déploiement direct en production.
          </p>
        </div>
        <button
          type="button"
          className={`button ${expanded ? "secondary" : "primary"}`}
          aria-expanded={expanded}
          aria-controls={editorId}
          onClick={() => setExpanded((previous) => !previous)}
        >
          <Wrench size={16} />
          {expanded ? "Masquer les options" : "Mettre à jour"}
        </button>
      </div>
      <div id={editorId} hidden={!expanded}>
        {expanded && (
          <MaintenancePanel
            key={projectId}
            projectId={projectId}
            request={request}
            embedded
          />
        )}
      </div>
    </section>
  );
}
