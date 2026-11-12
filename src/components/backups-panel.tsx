"use client";

import { useEffect, useState } from "react";
import type { BackupGroup } from "@/lib/backups";
import type { Project } from "@/lib/types";
import { formatDate } from "./ui";
import "./backups-panel.css";

const attemptLabels: Record<BackupGroup["latestAttempt"]["state"], string> = {
  ready: "Dernière copie disponible",
  failed: "Dernière collecte en échec",
  running: "Collecte en cours",
  interrupted: "Collecte interrompue",
  unavailable: "Dernière copie indisponible",
  unverified: "Disponibilité de la dernière copie à vérifier",
};
const slotFormat = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeZone: "UTC" });

export function BackupsPanel({ request, projects, onProject }: {
  request: (path: string) => Promise<BackupGroup[]>;
  projects: Project[];
  onProject: (id: string) => void;
}) {
  const [groups, setGroups] = useState<BackupGroup[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    request("backups").then(value => {
      if (active) {
        setGroups(value);
        setError("");
      }
    }).catch(error => {
      if (active) setError(error.message);
    });
    return () => { active = false; };
  }, [request]);

  const projectsWithCopy = new Set(groups?.flatMap(group => group.projectId && group.backups.length ? [group.projectId] : []));
  const withoutCopy = groups ? projects.filter(project => project.lifecycle === "active" && !projectsWithCopy.has(project.id)) : [];
  return (
    <section className="panel project-updates">
      <div className="panel-heading"><h2>Sauvegardes</h2></div>
      {error && <p role="alert">{error}</p>}
      {!groups && !error && <p role="status">Chargement des sauvegardes…</p>}
      {groups?.length === 0 && <p>Aucune tentative de sauvegarde enregistrée.</p>}
      {withoutCopy.length > 0 && <details className="updates-details">
        <summary>{withoutCopy.length} projet{withoutCopy.length > 1 ? "s" : ""} sans copie rattachée au catalogue</summary>
        <ul>{withoutCopy.map(project => <li key={project.id}>
          <button className="text-button" onClick={() => onProject(project.id)}>{project.name}</button>
        </li>)}</ul>
      </details>}
      {groups?.map(group => (
        <section className="updates-target" key={group.id}>
          <h3>{group.projectName}</h3>
          <p>{attemptLabels[group.latestAttempt.state]} · Créneau du <time dateTime={group.latestAttempt.slot}>{slotFormat.format(new Date(group.latestAttempt.slot))}</time></p>
          {group.backups.length === 0 && <p>Aucune copie proposée au téléchargement.</p>}
          <ul className="backup-downloads">
            {group.backups.map(backup => (
              <li key={backup.id}>
                <time dateTime={backup.createdAt}>{formatDate(backup.createdAt)}</time>
                <a className="button secondary" href={`/api/backups/${backup.id}/download`}>
                  Télécharger
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}
