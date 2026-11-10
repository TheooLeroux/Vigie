"use client";

import { useEffect, useState } from "react";
import type { BackupGroup } from "@/lib/backups";
import { formatDate } from "./ui";
import "./backups-panel.css";

export function BackupsPanel({ request }: { request: (path: string) => Promise<BackupGroup[]> }) {
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

  return (
    <section className="panel project-updates">
      <div className="panel-heading"><h2>Sauvegardes</h2></div>
      {error && <p role="alert">{error}</p>}
      {!groups && !error && <p role="status">Chargement des sauvegardes…</p>}
      {groups?.length === 0 && <p>Aucune sauvegarde disponible.</p>}
      {groups?.map(group => (
        <section className="updates-target" key={group.id}>
          <h3>{group.projectName}</h3>
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
