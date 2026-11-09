"use client";

import { RefreshCw, ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createRefreshQueue } from "@/lib/project-realtime";
import { severityLabels, type SecurityWatch, type SecurityWatchSnapshot, type WatchItem } from "@/lib/security-watch";
import { useProjectRealtime } from "./project-realtime";
import { formatDate, OutLink } from "./ui";
import "./security-watch.css";

const visibleFindings = 10;
export const securityWatchCacheKey = "vigie.security-watch.v1";
const watchRefreshInterval = 15 * 60_000;
type WatchSnapshot = SecurityWatchSnapshot & { sessionId: string };

function readWatchSnapshot(sessionId: string): WatchSnapshot | null {
  try {
    const snapshot = JSON.parse(sessionStorage.getItem(securityWatchCacheKey) || "null") as WatchSnapshot | null;
    if (snapshot?.sessionId === sessionId && Number.isFinite(Date.parse(snapshot.savedAt)) &&
      Array.isArray(snapshot.watch?.detected) && Array.isArray(snapshot.watch?.recent)) return snapshot;
    sessionStorage.removeItem(securityWatchCacheKey);
  } catch { /* Storage may be disabled. */ }
  return null;
}

function AffectedProjects({ affected, onProject }: { affected: WatchItem["affected"]; onProject: (id: string) => void }) {
  return <div className="watch-affected">
    {[false, true].map(historical => {
      const projects = affected.filter(item => item.historical === historical);
      if (!projects.length) return null;
      return <div key={String(historical)}>
        <strong>{historical ? "Anciens relevés · contrôle automatique en attente" : "Projets concernés"}</strong>
        <ul>{projects.map(({ project }) => <li key={project.id}>
          <a href={`/?project=${encodeURIComponent(project.id)}`} onClick={event => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            onProject(project.id);
          }}>{project.name}</a>
        </li>)}</ul>
      </div>;
    })}
  </div>;
}

function AdvisoryList({ items, onProject }: { items: WatchItem[]; onProject: (id: string) => void }) {
  return <ul className="watch-list">
    {items.map(item => <li className="watch-advisory" key={item.id}>
      <div className="watch-row">
        <div>
          <p className="watch-meta">{[item.id, ...item.aliases].join(" · ")}</p>
          <h3>{item.title}</h3>
          {item.packages.length > 0 && <p>{item.packages.join(" · ")}</p>}
          {item.publishedAt && <p className="watch-meta">Publié le <time dateTime={item.publishedAt}>{formatDate(item.publishedAt)}</time></p>}
        </div>
        <span className={`security-severity ${item.severity}`}>{severityLabels[item.severity]}</span>
      </div>
      {item.affected.length > 0 && <AffectedProjects affected={item.affected} onProject={onProject} />}
      {item.url && <OutLink href={item.url} className="watch-link">Consulter l’avis<span className="sr-only"> {item.id}</span></OutLink>}
    </li>)}
  </ul>;
}

export function SecurityWatchPanel({ sessionId, initialWatch, request, onProject }: {
  sessionId: string;
  initialWatch: SecurityWatchSnapshot | null;
  request: (path: string, method?: string, payload?: unknown, options?: { signal?: AbortSignal }) => Promise<SecurityWatch>;
  onProject: (id: string) => void;
}) {
  const { subscribe } = useProjectRealtime();
  const [snapshot, setSnapshot] = useState(() => {
    const local = readWatchSnapshot(sessionId);
    return local && (!initialWatch || local.savedAt >= initialWatch.savedAt) ? local : initialWatch;
  });
  const watch = snapshot?.watch;
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(false);
  const [showAllFindings, setShowAllFindings] = useState(false);
  const refresh = useRef<() => void>(() => {});

  useEffect(() => {
    const controller = new AbortController();
    const queue = createRefreshQueue(async () => {
      setBusy(true);
      setError(false);
      try {
        const result = await request("security-watch", "GET", undefined, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!result.coverage) {
          setError(true);
          return;
        }
        const next = { sessionId, savedAt: new Date().toISOString(), watch: result };
        setSnapshot(next);
        try {
          sessionStorage.setItem(securityWatchCacheKey, JSON.stringify(next));
        } catch { /* The live view remains available if storage is disabled or full. */ }
      } catch (error) {
        if (controller.signal.aborted) return;
        const status = (error as { status?: number } | null)?.status;
        if (status === 401 || status === 403) {
          setSnapshot(null);
          try { sessionStorage.removeItem(securityWatchCacheKey); } catch { /* Storage may be disabled. */ }
        }
        setError(true);
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    });
    refresh.current = () => queue.invalidate(["watch"]);
    refresh.current();
    const unsubscribe = subscribe(change => {
      if (change.all || change.workspace || change.projects.length) refresh.current();
    });
    const timer = setInterval(refresh.current, watchRefreshInterval);
    return () => { controller.abort(); queue.dispose(); unsubscribe(); clearInterval(timer); };
  }, [request, sessionId, subscribe]);

  return <div className="security-watch">
    <div className="watch-toolbar">
      <p aria-live="polite">{snapshot ? <>Relevé affiché du <time dateTime={snapshot.savedAt}>{formatDate(snapshot.savedAt)}</time></> : busy ? "Chargement de la veille…" : "Veille des vulnérabilités"}</p>
      <button type="button" className="button secondary" disabled={busy} onClick={() => refresh.current()}>
        <RefreshCw size={15} className={busy ? "spin" : undefined} aria-hidden="true" /> Actualiser
      </button>
    </div>
    {error && <p className="error-banner" role="alert">{watch ? "Actualisation indisponible. Le dernier relevé reste affiché." : "La veille est indisponible. Utilisez « Actualiser » pour réessayer."}</p>}
    {watch && <>
      <section className="panel watch-panel" aria-labelledby="watch-detected">
        <header>
          <h2 id="watch-detected"><ShieldAlert size={19} aria-hidden="true" /> Failles relevées sur votre parc {(watch.detected.length > 0 || !!watch.coverage?.fullyCovered) && <span className="count-pill">{watch.detected.length}</span>}</h2>
          {watch.coverage ? <p>
            {watch.coverage.projects === 0 ? "Aucun projet actif à surveiller." : `${watch.coverage.fullyCovered} sur ${watch.coverage.projects} projets actifs disposent d’un contrôle récent couvrant tous leurs services suivis.`}
          </p> : <p role="status">Les contrôles du parc sont indisponibles.</p>}
        </header>
        {watch.detected.length > 0
          ? <>
            <AdvisoryList items={showAllFindings ? watch.detected : watch.detected.slice(0, visibleFindings)} onProject={onProject} />
            {watch.detected.length > visibleFindings && <div className="watch-list-footer">
              <button type="button" className="button secondary" aria-expanded={showAllFindings} onClick={() => setShowAllFindings(!showAllFindings)}>
                {showAllFindings ? "Afficher les dix premières failles" : `Afficher toutes les failles (${watch.detected.length})`}
              </button>
            </div>}
          </>
          : !!watch.coverage?.projects && <p className="watch-empty">{watch.coverage.fullyCovered === watch.coverage.projects
            ? "Aucune faille relevée dans les contrôles récents."
            : "Les relevés disponibles ne permettent pas d’établir le nombre de failles sur tout le parc."}</p>}
      </section>
      <section className="panel watch-panel" aria-labelledby="watch-recent">
        <header>
          <h2 id="watch-recent">Derniers avis publics</h2>
          <p>Les avis récents de <OutLink href="https://github.com/advisories">GitHub Advisory Database</OutLink> sans correspondance dans les relevés affichés ci-dessus.</p>
        </header>
        {watch.recent.length > 0
          ? <AdvisoryList items={watch.recent} onProject={onProject} />
          : <p className="watch-empty" role="status">{watch.feedCheckedAt ? "Aucun autre avis dans les résultats du flux." : "Le flux public est indisponible pour le moment."}</p>}
      </section>
    </>}
  </div>;
}
