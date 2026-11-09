"use client";

import { RefreshCw, ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createRefreshQueue } from "@/lib/project-realtime";
import { severityLabels, type SecurityWatch, type WatchItem } from "@/lib/security-watch";
import { useProjectRealtime } from "./project-realtime";
import { formatDate, OutLink } from "./ui";
import "./security-watch.css";

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
      {item.affected.length > 0 && <ul className="watch-affected">
        {item.affected.map(({ project, finding }) => <li key={JSON.stringify([project.id, finding.key])}>
          <a className="text-button" href={`/?project=${encodeURIComponent(project.id)}`} onClick={event => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            onProject(project.id);
          }}>{project.name}</a>
          <span>{finding.service} · {finding.package} {finding.version}</span>
          {!!finding.fixedVersions?.length && <span>Correctifs référencés {finding.fixedVersions.join(", ")}</span>}
          <time dateTime={finding.checkedAt}>Contrôlé le {formatDate(finding.checkedAt)}</time>
        </li>)}
      </ul>}
      {item.url && <OutLink href={item.url} className="watch-link">Consulter l’avis<span className="sr-only"> {item.id}</span></OutLink>}
    </li>)}
  </ul>;
}

export function SecurityWatchPanel({ request, onProject }: {
  request: (path: string, method?: string, payload?: unknown, options?: { signal?: AbortSignal }) => Promise<SecurityWatch>;
  onProject: (id: string) => void;
}) {
  const { subscribe } = useProjectRealtime();
  const [watch, setWatch] = useState<SecurityWatch | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(false);
  const refresh = useRef<() => void>(() => {});

  useEffect(() => {
    const controller = new AbortController();
    const queue = createRefreshQueue(async () => {
      setBusy(true);
      setError(false);
      try {
        const result = await request("security-watch", "GET", undefined, { signal: controller.signal });
        if (!controller.signal.aborted) setWatch(result);
      } catch {
        if (!controller.signal.aborted) { setWatch(null); setError(true); }
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    });
    refresh.current = () => queue.invalidate(["watch"]);
    refresh.current();
    const unsubscribe = subscribe(change => {
      if (change.all || change.workspace || change.projects.length) refresh.current();
    });
    const timer = setInterval(refresh.current, 15 * 60_000);
    return () => { controller.abort(); queue.dispose(); unsubscribe(); clearInterval(timer); };
  }, [request, subscribe]);

  return <div className="security-watch">
    <div className="watch-toolbar">
      <p aria-live="polite">{watch?.feedCheckedAt ? <>Flux consulté le <time dateTime={watch.feedCheckedAt}>{formatDate(watch.feedCheckedAt)}</time></> : busy ? "Chargement de la veille…" : "Veille des vulnérabilités"}</p>
      <button type="button" className="button secondary" disabled={busy} onClick={() => refresh.current()}>
        <RefreshCw size={15} className={busy ? "spin" : undefined} aria-hidden="true" /> Actualiser
      </button>
    </div>
    {error && <p className="error-banner" role="alert">La veille est indisponible. Utilisez « Actualiser » pour réessayer.</p>}
    {watch && <>
      <section className="panel watch-panel" aria-labelledby="watch-detected">
        <header>
          <h2 id="watch-detected"><ShieldAlert size={19} aria-hidden="true" /> Détectées sur votre parc {watch.coverage && <span className="count-pill">{watch.detected.length}</span>}</h2>
          {watch.coverage ? <p>
            {watch.coverage.projects === 0 ? "Aucun projet actif à surveiller." : `${watch.coverage.fullyCovered} sur ${watch.coverage.projects} projets actifs disposent d’un contrôle récent couvrant tous leurs services suivis.`}
          </p> : <p role="status">Les contrôles du parc sont indisponibles.</p>}
        </header>
        {watch.detected.length > 0
          ? <AdvisoryList items={watch.detected} onProject={onProject} />
          : !!watch.coverage?.projects && <p className="watch-empty">Aucune faille dans les contrôles récents disponibles.</p>}
      </section>
      <section className="panel watch-panel" aria-labelledby="watch-recent">
        <header>
          <h2 id="watch-recent">Derniers avis publics</h2>
          <p>Les avis récents de <OutLink href="https://github.com/advisories">GitHub Advisory Database</OutLink> sans correspondance dans les contrôles récents du parc.</p>
        </header>
        {watch.recent.length > 0
          ? <AdvisoryList items={watch.recent} onProject={onProject} />
          : <p className="watch-empty" role="status">{watch.feedCheckedAt ? "Aucun autre avis dans les résultats du flux." : "Le flux public est indisponible pour le moment."}</p>}
      </section>
    </>}
  </div>;
}
