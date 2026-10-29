"use client";
import { useEffect, useState } from "react";
import type { RecordedBackups } from "@/lib/backups";
import { RecordLink } from "./record-link";
import { formatDate } from "./ui";
import { updateStageLabels } from "./project-updates";
export function BackupsPanel({ request, onProject }: { request: (path: string) => Promise<any>; onProject: (id: string) => void }) {
  const [data, setData] = useState<RecordedBackups | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => { let alive = true; setData(null); setError(""); request("backups").then(value => { if (alive) setData(value); }).catch(error => { if (alive) setError(error.message); }); return () => { alive = false; }; }, [request, attempt]);
  return <section className="panel"><h2>Sauvegardes et références de reprise</h2>
    <p>Sauvegardes WordPress et références de code consignées pendant les maintenances. Leur présence actuelle chez l’hébergeur n’est pas vérifiée par cette liste.</p>
    <p>Une référence Git ou un ancien déploiement couvre le code, sans sauvegarder la base ni les fichiers envoyés par les utilisateurs. Les restaurations restent manuelles : conservez d’abord les données actuelles et vérifiez la compatibilité de la sauvegarde.</p>
    {error && <p role="alert">{error} <button className="text-button" disabled={busy} onClick={() => setAttempt(value => value + 1)}>Réessayer</button></p>}
    {!data && !error && <p role="status">Chargement des sauvegardes…</p>}
    {data && !data.items.length && <p>Aucune sauvegarde ou référence de reprise enregistrée. Les sauvegardes réalisées directement chez l’hébergeur ne sont pas inventoriées ici.</p>}
    {data?.items.map(item => <article className="updates-target" key={item.id}><h3><RecordLink href={`/?project=${item.projectId}`} onNavigate={() => onProject(item.projectId)}>{item.projectName}</RecordLink> · {item.targetName}</h3><p>{item.kind === "wordpress" ? "Sauvegarde WordPress · fichiers et base de données" : "Références de reprise du code"} · {formatDate(item.createdAt)} · {item.provider}</p>{item.path && <p>Emplacement privé chez l’hébergeur : <code>{item.path}</code>. Vérifiez les fichiers, la base et leurs empreintes avant toute restauration.</p>}{item.commit && <p>Commit précédent : <code>{item.commit}</code></p>}{item.deploymentId && <p>Déploiement précédent : <code>{item.deploymentId}</code></p>}<p>Identifiant de maintenance : <code>{item.runId}</code> · État consigné : {updateStageLabels[item.stage]}.</p></article>)}
    {data?.nextOffset !== null && data && <button className="button secondary" disabled={busy} onClick={async () => { setBusy(true); setError(""); try { const next: RecordedBackups = await request(`backups?offset=${data.nextOffset}`); setData({ items: [...data.items, ...next.items], nextOffset: next.nextOffset }); } catch (error) { setError(error instanceof Error ? error.message : "Chargement interrompu."); } finally { setBusy(false); } }}>{busy ? "Chargement…" : "Charger les références plus anciennes"}</button>}
  </section>;
}
