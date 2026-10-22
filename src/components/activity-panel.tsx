"use client";

import type { Activity } from "@/lib/types";
import {
  Activity as ActivityIcon,
  ArrowLeft,
  ArrowRight,
  Search,
  X,
} from "lucide-react";
import { useState } from "react";
import { RecordLink } from "./record-link";
import { EmptyState, formatDate } from "./ui";

function category(action: string) {
  if (/creat|ajout|cré|import/.test(action.toLowerCase())) return "Ajouts";
  if (/review|relu|revue/.test(action.toLowerCase())) return "Revues";
  if (/connect|synch|relev|collect|rattach|invent/.test(action.toLowerCase()))
    return "Connexions & relevés";
  return "Modifications";
}
const dayKey = (value: string) =>
  new Intl.DateTimeFormat("fr-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
const pageSize = 25;

export function ActivityPanel({
  items,
  onProject,
  scoped = false,
}: {
  items: Activity[];
  onProject: (id: string) => void;
  scoped?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [project, setProject] = useState("");
  const [kind, setKind] = useState("");
  const [since, setSince] = useState("");
  const [page, setPage] = useState(0);
  const projects = [
    ...new Map(
      items
        .filter((i) => i.projectId)
        .map((i) => [i.projectId!, i.projectName]),
    ).entries(),
  ].sort((a, b) => a[1].localeCompare(b[1], "fr"));
  const filtered = items
    .filter(
      (item) =>
        (!project || item.projectId === project) &&
        (!kind || category(item.action) === kind) &&
        (!since || dayKey(item.createdAt) >= since) &&
        `${item.projectName} ${item.detail} ${item.actorName || ""} ${item.action}`
          .toLocaleLowerCase("fr")
          .includes(query.trim().toLocaleLowerCase("fr")),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(filtered.length / pageSize) - 1),
  );
  const visible = filtered.slice(
    currentPage * pageSize,
    (currentPage + 1) * pageSize,
  );
  const hasFilters = !!(query || project || kind || since);
  function reset() {
    setQuery("");
    setProject("");
    setKind("");
    setSince("");
    setPage(0);
  }

  return (
    <section className="panel activity-panel">
      <div className="activity-tools">
        <label className="activity-search">
          <Search size={17} />
          <input
            aria-label="Rechercher dans l’activité"
            placeholder="Rechercher un projet, une action, une personne…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
          />
          {query && (
            <button
              className="icon-button"
              aria-label="Effacer la recherche d’activité"
              onClick={() => {
                setQuery("");
                setPage(0);
              }}
            >
              <X size={15} />
            </button>
          )}
        </label>
        <div className="activity-filters">
          {!scoped && (
            <label>
              Projet
              <select
                aria-label="Projet"
                value={project}
                onChange={(e) => {
                  setProject(e.target.value);
                  setPage(0);
                }}
              >
                <option value="">Tous les projets</option>
                {projects.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Type d’action
            <select
              aria-label="Type d’action"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                setPage(0);
              }}
            >
              <option value="">Toutes les actions</option>
              {[
                "Ajouts",
                "Modifications",
                "Revues",
                "Connexions & relevés",
              ].map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
          <label>
            Depuis le
            <input
              type="date"
              value={since}
              onChange={(e) => {
                setSince(e.target.value);
                setPage(0);
              }}
            />
          </label>
          {hasFilters && (
            <button className="text-button" onClick={reset}>
              Réinitialiser <X size={13} />
            </button>
          )}
        </div>
      </div>
      <div className="activity-results" role="status">
        {filtered.length} action{filtered.length > 1 ? "s" : ""}
        {hasFilters
          ? ` sur ${items.length}`
          : " enregistrée" + (items.length > 1 ? "s" : "")}
        {items.length >= 100 && (
          <span className="activity-limit">
            Recherche parmi les {items.length} dernières actions chargées.
          </span>
        )}
      </div>
      {!visible.length ? (
        <EmptyState
          icon={ActivityIcon}
          title={
            hasFilters
              ? "Aucune action ne correspond"
              : "Aucune activité pour le moment"
          }
          description={
            hasFilters
              ? "Modifiez la recherche ou réinitialisez les filtres."
              : "Les prochaines modifications apparaîtront ici."
          }
          action={
            hasFilters ? (
              <button className="button secondary" onClick={reset}>
                Réinitialiser les filtres
              </button>
            ) : undefined
          }
        />
      ) : (
        <ol className="activity-timeline">
          {visible.map((item, index) => (
            <li key={item.id}>
              {(index === 0 ||
                dayKey(visible[index - 1].createdAt) !==
                  dayKey(item.createdAt)) && (
                <h3 className="activity-day">
                  {new Intl.DateTimeFormat("fr-FR", {
                    dateStyle: "full",
                    timeZone: "Europe/Paris",
                  }).format(new Date(item.createdAt))}
                </h3>
              )}
              <article className="activity-event">
                <span className="activity-event-icon">
                  <ActivityIcon size={16} />
                </span>
                <div className="activity-event-body">
                  <div className="activity-event-title">
                    {item.projectId ? (
                      <RecordLink
                        className="text-button"
                        href={`/?project=${encodeURIComponent(item.projectId)}`}
                        onNavigate={() => onProject(item.projectId!)}
                      >
                        {item.projectName}
                      </RecordLink>
                    ) : (
                      <strong>{item.projectName || "Parc web"}</strong>
                    )}
                    <span className="badge neutral">
                      {category(item.action)}
                    </span>
                  </div>
                  <p>{item.detail}</p>
                  <span className="activity-event-author">
                    {item.actorName || "Système"}
                  </span>
                </div>
                <time
                  dateTime={item.createdAt}
                  title={formatDate(item.createdAt)}
                >
                  {new Intl.DateTimeFormat("fr-FR", {
                    hour: "2-digit",
                    minute: "2-digit",
                    timeZone: "Europe/Paris",
                  }).format(new Date(item.createdAt))}
                </time>
              </article>
            </li>
          ))}
        </ol>
      )}
      {filtered.length > pageSize && (
        <div className="activity-pagination">
          <span>
            {currentPage * pageSize + 1}–
            {Math.min((currentPage + 1) * pageSize, filtered.length)} sur{" "}
            {filtered.length}
          </span>
          <div>
            <button
              className="button secondary"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              <ArrowLeft size={14} />
              Précédent
            </button>
            <span>
              Page {currentPage + 1} / {Math.ceil(filtered.length / pageSize)}
            </span>
            <button
              className="button secondary"
              disabled={(currentPage + 1) * pageSize >= filtered.length}
              onClick={() => setPage(currentPage + 1)}
            >
              Suivant
              <ArrowRight size={14} />
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
