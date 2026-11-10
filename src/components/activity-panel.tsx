"use client";

import type { Activity } from "@/lib/types";
import {
  Activity as ActivityIcon,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  CircleAlert,
  ClipboardList,
  PackagePlus,
  Search,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { RecordLink } from "./record-link";
import { useProjectRealtime } from "./project-realtime";
import { EmptyState, formatDate } from "./ui";

import {
  activityCategory as category,
  activityDay,
  activityEntries,
  activityKinds,
  activityOutcome,
  activityTitle,
  automaticControlActivity,
  type ActivityView,
} from "@/lib/activity-model";
const dayFormat = new Intl.DateTimeFormat("fr-FR", {
  dateStyle: "full",
  timeZone: "Europe/Paris",
});
const timeFormat = new Intl.DateTimeFormat("fr-FR", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Paris",
});
const countFormat = new Intl.NumberFormat("fr-FR");
const pageSize = 25;

function ActivityTime({ date }: { date: string }) {
  return (
    <time dateTime={date} title={formatDate(date)}>
      {timeFormat.format(new Date(date))}
    </time>
  );
}

function ActivityEvent({ item, onProject }: { item: Activity; onProject: (id: string) => void }) {
  const itemCategory = category(item.action);
  const outcome = activityOutcome(item);
  const title = outcome === "failure" && item.action === automaticControlActivity
    ? "Échec lors d’un contrôle automatique"
    : activityTitle(item.action);
  const routine = itemCategory === "Connexions & relevés" || item.action === "hosting.discovered";
  const tone = outcome || (routine ? "routine" : "default");
  const Icon = outcome === "failure" ? CircleAlert : outcome === "change" ? PackagePlus : routine ? ClipboardList : ActivityIcon;
  return (
    <article className={`activity-event activity-event--${tone}`}>
      <ActivityTime date={item.createdAt} />
      <span className="activity-event-icon" aria-hidden="true"><Icon size={16} /></span>
      <div className="activity-event-body">
        <div className="activity-event-title">
          <strong>{title || item.detail || itemCategory}</strong>
          {outcome && <span className="activity-event-tag">{outcome === "failure" ? "Échec" : "Changement détecté"}</span>}
        </div>
        {title && item.detail && <p>{item.detail}</p>}
        <div className="activity-event-meta">
          {item.projectId ? (
            <RecordLink
              href={`/?project=${encodeURIComponent(item.projectId)}`}
              onNavigate={() => onProject(item.projectId!)}
            >
              {item.projectName}
            </RecordLink>
          ) : item.projectName && item.projectName !== "Espace de travail" ? <span>{item.projectName}</span> : null}
          {item.actorName && <span>{item.actorName}</span>}
        </div>
      </div>
    </article>
  );
}

function ActivityGroup({ events, view, expanded, onProject }: {
  events: Activity[];
  view: ActivityView;
  expanded: boolean;
  onProject: (id: string) => void;
}) {
  const latest = events[0];
  const incident = view === "focus";
  const automatic = latest.action === automaticControlActivity;
  const Icon = incident ? CircleAlert : ClipboardList;
  const count = countFormat.format(events.length);
  const title = automatic
    ? "Échecs lors des contrôles automatiques"
    : activityTitle(latest.action);
  return (
    <details className="activity-collection" open={expanded || undefined}>
      <summary className={`activity-event activity-event--${incident ? "failure" : "routine"}`}>
        <ActivityTime date={latest.createdAt} />
        <span className="activity-event-icon" aria-hidden="true"><Icon size={16} /></span>
        <span className="activity-event-body">
          <span className="activity-collection-label">
            <span className="activity-event-title">
              <strong>{incident ? title : `${count} inventaires WordPress relevés`}</strong>
              {incident && <span className="activity-event-tag">{count} {automatic ? "passages" : "tentatives"}</span>}
            </span>
            <ChevronDown size={15} aria-hidden="true" />
          </span>
          {incident && !automatic && <span className="activity-event-description">{latest.detail}</span>}
          {incident && latest.projectId && <span className="activity-event-meta">{latest.projectName}</span>}
        </span>
      </summary>
      <ul className="activity-collection-items">
        {events.map(item => <li key={item.id}><ActivityEvent item={item} onProject={onProject} /></li>)}
      </ul>
    </details>
  );
}

export function ActivityPanel({
  items,
  onProject,
  scoped = false,
  request,
  projectId,
  allProjects,
}: {
  items: Activity[];
  onProject: (id: string) => void;
  scoped?: boolean;
  request?: (path: string, method?: string, payload?: unknown, options?: { signal?: AbortSignal }) => Promise<any>;
  projectId?: string;
  allProjects?: { id: string; name: string }[];
}) {
  const [view, setView] = useState<ActivityView>("focus");
  const [query, setQuery] = useState("");
  const [project, setProject] = useState("");
  const [kind, setKind] = useState("");
  const [since, setSince] = useState("");
  const [page, setPage] = useState(0);
  const projects = (allProjects ? allProjects.map(item => [item.id, item.name]) : [
    ...new Map(
      items
        .filter((i) => i.projectId)
        .map((i) => [i.projectId!, i.projectName]),
    ).entries(),
  ]).sort((a, b) => a[1].localeCompare(b[1], "fr"));
  const filtered = request ? [] : items
    .filter(
      (item) =>
        (view === "complete" || activityOutcome(item)) &&
        (!(projectId || project) || item.projectId === (projectId || project)) &&
        (!kind || category(item.action) === kind) &&
        (!since || activityDay(item.createdAt) >= since) &&
        `${item.projectName} ${item.detail} ${item.actorName || ""} ${item.action}`
          .toLocaleLowerCase("fr")
          .includes(query.trim().toLocaleLowerCase("fr")),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const params = new URLSearchParams({ query, page: String(page), view });
  if (projectId || project) params.set("projectId", projectId || project);
  if (kind) params.set("kind", kind);
  if (since) params.set("since", since);
  const queryKey = params.toString();
  const [result, setResult] = useState<{ key: string; items: Activity[]; total: number; page: number } | null>(null);
  const remote = result?.key === queryKey ? result : null;
  const [loading, setLoading] = useState(!!request), [error, setError] = useState(""), [attempt, setAttempt] = useState(0);
  const { subscribe } = useProjectRealtime();
  useEffect(() => subscribe(change => {
    const selectedProject = projectId || project;
    if (change.activity || (selectedProject ? change.activityProjects.includes(selectedProject) : change.activityProjects.length > 0)) setAttempt(value => value + 1);
  }), [subscribe, projectId, project]);
  useEffect(() => {
    if (!request) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const timer = setTimeout(() => {
      request("activity?" + queryKey, "GET", undefined, { signal: controller.signal })
        .then(data => { if (!controller.signal.aborted) setResult({ ...data, key: queryKey }); })
        .catch(error => { if (!controller.signal.aborted) setError(error.message); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [request, queryKey, attempt]);
  const localEntries = activityEntries(filtered, view);
  const total = request ? remote?.total || 0 : localEntries.length;
  const currentPage = request ? remote?.page ?? page : Math.min(page, Math.max(0, Math.ceil(total / pageSize) - 1));
  const visible = request ? activityEntries(remote?.items || [], view) : localEntries.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const pending = !!request && (loading || (!remote && !error));
  const resultLabel = total === 1 ? "entrée" : "entrées";
  const hasFilters = !!(query || project || kind || since);
  function reset() {
    setQuery("");
    setProject("");
    setKind("");
    setSince("");
    setPage(0);
  }
  function selectView(next: ActivityView) {
    setView(next);
    setPage(0);
  }

  return (
    <section className="panel activity-panel">
      <div className="activity-view-header">
        <div className="activity-view-switch" role="group" aria-label="Vue du journal">
          <button type="button" aria-pressed={view === "focus"} onClick={() => selectView("focus")}>À suivre</button>
          <button type="button" aria-pressed={view === "complete"} onClick={() => selectView("complete")}>Journal complet</button>
        </div>
        <p>
          {view === "focus"
            ? "Échecs et nouveaux changements détectés."
            : "Tous les événements, avec les relevés d’une même collecte regroupés."}
        </p>
      </div>
      <div className="activity-tools">
        <div className="activity-search">
          <Search size={17} aria-hidden="true" />
          <input
            aria-label="Rechercher dans l’activité"
            placeholder="Projet, action ou personne…"
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
        </div>
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
              {activityKinds.map((k) => (
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
        {pending && !remote ? "Recherche dans l’historique…" : !error || remote ? `${countFormat.format(total)} ${resultLabel}` : null}
        {loading && remote && <span className="activity-limit">Actualisation…</span>}
      </div>
      {error && <p className="activity-error" role="alert">{error} <button className="text-button" onClick={() => setAttempt(value => value + 1)}>Réessayer</button></p>}
      {(pending || error) && !remote ? null : !visible.length ? (
        <EmptyState
          icon={ActivityIcon}
          title={
            hasFilters
              ? "Aucun événement ne correspond"
              : view === "focus" ? "Aucun événement à suivre" : "Aucune activité pour le moment"
          }
          description={
            hasFilters
              ? "Modifiez la recherche ou réinitialisez les filtres."
              : view === "focus"
                ? "Les prochains échecs et changements détectés apparaîtront ici."
                : "Les prochaines modifications apparaîtront ici."
          }
          action={
            hasFilters ? (
              <button className="button secondary" onClick={reset}>
                Réinitialiser les filtres
              </button>
            ) : view === "focus" ? (
              <button className="button secondary" onClick={() => selectView("complete")}>Ouvrir le journal complet</button>
            ) : undefined
          }
        />
      ) : (
        <ol className="activity-timeline">
          {visible.map(({ key, events, latest }, index) => (
            <li key={key}>
              {(index === 0 || activityDay(visible[index - 1].latest.createdAt) !== activityDay(latest.createdAt)) && (
                <h2 className="activity-day">{dayFormat.format(new Date(latest.createdAt))}</h2>
              )}
              {events.length === 1 ? (
                <ActivityEvent item={latest} onProject={onProject} />
              ) : (
                <ActivityGroup events={events} view={view} expanded={!!query.trim()} onProject={onProject} />
              )}
            </li>
          ))}
        </ol>
      )}
      {total > pageSize && (
        <div className="activity-pagination">
          <span>
            {countFormat.format(currentPage * pageSize + 1)}–
            {countFormat.format(Math.min((currentPage + 1) * pageSize, total))} sur{" "}
            {countFormat.format(total)}
          </span>
          <div>
            <button
              className="button secondary"
              disabled={pending || currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              <ArrowLeft size={14} />
              Précédent
            </button>
            <span>
              Page {currentPage + 1} / {Math.ceil(total / pageSize)}
            </span>
            <button
              className="button secondary"
              disabled={pending || (currentPage + 1) * pageSize >= total}
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
