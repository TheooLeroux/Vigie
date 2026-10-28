"use client";
import { authClient } from "@/lib/auth-client";
import type {
  Client,
  Project,
  ProjectDetail,
  Service,
  Workspace,
  WorkspaceData,
} from "@/lib/types";
import {
  Activity as ActivityIcon,
  ArrowLeft,
  Building2,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Database,
  Globe2,
  LayoutGrid,
  Link2,
  List,
  Loader2,
  LogOut,
  Menu,
  Pencil,
  Plus,
  Search,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityPanel } from "./activity-panel";
import { ClientsPanel } from "./clients-panel";
import { ConnectionsPanel } from "./connections-panel";
import { ExistingProjectForm } from "./existing-project-form";
import {
  ClientForm,
  EnvironmentForm,
  LinkClientProjectForm,
  ProjectForm,
  ServiceForm,
} from "./forms";
import { installationLabels } from "./hosting-discovery-panel";
import { RailwayInventoryPanel } from "./railway-panel";
import { RecordLink } from "./record-link";
import { ThemeToggle } from "./theme-toggle";
import {
  domain,
  EmptyState,
  formatDate,
  Modal,
  OutLink,
  ProviderBadge,
  TechIcon,
} from "./ui";
import { VercelInventoryPanel } from "./vercel-panel";
import { WordPressInventoryPanel } from "./wordpress-inventory-panel";
import { ProjectUpdates } from "./project-updates";
import { ProjectHealthSummary } from "./project-health-summary";
import type { UpdateState } from "@/lib/updates/types";

type View = "sites" | "clients" | "connections" | "backup" | "activity";
type Dialog =
  | "project"
  | "manualProject"
  | "existingProject"
  | "editProject"
  | "client"
  | "editClient"
  | "linkClientProject"
  | "service"
  | "editService"
  | "environment"
  | null;
const navigation = [
  { id: "sites", label: "Sites & projets", icon: Globe2 },
  { id: "clients", label: "Clients", icon: Building2 },
  { id: "connections", label: "Connexions", icon: Link2 },
  { id: "backup", label: "Backup", icon: Database },
  { id: "activity", label: "Activité", icon: ActivityIcon },
] as const;
const titles: Record<
  View,
  { title: string; description: string; kicker: string }
> = {
  connections: {
    title: "Connexions",
    description: "Comptes d’hébergement et accès vérifiés.",
    kicker: "HÉBERGEMENTS",
  },
  clients: {
    title: "Clients",
    description: "Coordonnées et sites rattachés à chaque client.",
    kicker: "VOS CLIENTS",
  },
  sites: {
    title: "Sites & projets",
    description: "Sites, versions connues et hébergements.",
    kicker: "VOTRE PARC WEB",
  },
  backup: { title: "Backup", description: "", kicker: "SAUVEGARDES" },
  activity: {
    title: "Activité",
    description:
      "Retrouvez les changements et les derniers relevés de votre parc.",
    kicker: "JOURNAL D’ACTIVITÉ",
  },
};
function Logo() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <svg viewBox="0 0 40 40" aria-hidden="true">
          <path d="M8 12l12 19 12-19M14 12l6 10 6-10" />
        </svg>
      </span>
      <span>
        vigie<span className="brand-dot">.</span>
      </span>
    </div>
  );
}
function initial(name: string) {
  return name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
function needsInfo(p: Project, services: Service[]) {
  const s = services.filter((s) => s.projectId === p.id);
  return (
    !p.url ||
    !s.length ||
    s.some((s) => !s.technology || !s.provider || (!!s.runtime && !s.version))
  );
}
function Status({ project, data }: { project: Project; data: WorkspaceData }) {
  const serviceIds = new Set(
    data.services.filter((s) => s.projectId === project.id).map((s) => s.id),
  );
  const inventories = data.inventories.filter((i) =>
    serviceIds.has(i.serviceId),
  );
  if (needsInfo(project, data.services))
    return (
      <span className="badge warning">
        <span className="status-dot" />À compléter
      </span>
    );
  if (inventories.length)
    return (
      <span className="badge sage">
        <span className="status-dot" />
        Déclaré
      </span>
    );
  return (
    <span className="badge neutral">
      <span className="status-dot" />
      Non inventorié
    </span>
  );
}
export function WorkspaceApp({
  user,
}: {
  user: { name: string; email: string };
}) {
  const workspace: Workspace = "live";
  const [ready, setReady] = useState(false),
    [data, setData] = useState<WorkspaceData | null>(null),
    [error, setError] = useState("");
  const [view, setView] = useState<View>("sites"),
    [query, setQuery] = useState(""),
    [provider, setProvider] = useState(""),
    [clientFilter, setClientFilter] = useState(""),
    [selectedClient, setSelectedClient] = useState<string | null>(null),
    [editClient, setEditClient] = useState<Client | undefined>(),
    [technology, setTechnology] = useState(""),
    [sort, setSort] = useState("name"),
    [layout, setLayout] = useState<"list" | "grid">("list"),
    [incompleteOnly, setIncompleteOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(null),
    [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null),
    [editService, setEditService] = useState<Service | undefined>(),
    [mobileNav, setMobileNav] = useState(false),
    [toast, setToast] = useState(""),
    [actionBusy, setActionBusy] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [projectUpdateState, setProjectUpdateState] = useState<{ projectId: string; state: UpdateState | null; unavailable: boolean } | null>(null);
  const onProjectUpdateState = useCallback((projectId: string, state: UpdateState | null) => setProjectUpdateState(previous => ({ projectId, state: state || (previous?.projectId === projectId ? previous.state : null), unavailable: state === null })), []);
  function notify(message: string) {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 4500);
  }
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    localStorage.removeItem("vigie.workspace");
    if (params.get("project")) {
      setSelected(params.get("project"));
      setView("sites");
    } else if (params.get("client")) {
      setSelectedClient(params.get("client"));
      setView("clients");
    } else {
      const destination = navigation.find((n) => n.id === params.get("view"));
      if (destination) setView(destination.id);
    }
    setReady(true);
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);
  const api = useCallback(
    async (path: string, method = "GET", payload?: unknown) => {
      const response = await fetch(
        `/api/${path}${path.includes("?") ? "&" : "?"}workspace=${workspace}`,
        {
          method,
          headers: payload ? { "Content-Type": "application/json" } : undefined,
          body: payload ? JSON.stringify(payload) : undefined,
          cache: "no-store",
        },
      );
      let json;
      try {
        json = await response.json();
      } catch {
        throw new Error("Le serveur n’a pas renvoyé une réponse valide.");
      }
      if (!response.ok) throw new Error(json.error || "L’opération a échoué.");
      return json;
    },
    [workspace],
  );
  const refresh = useCallback(async () => {
    const next = await api("workspace");
    setData(next);
    if (selected) {
      const d = await api(`projects/${selected}`);
      setDetail(d);
    }
  }, [api, selected]);
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    setData(null);
    setError("");
    api("workspace")
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [api, ready]);
  useEffect(() => {
    if (!ready || !selected) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setError("");
    api(`projects/${selected}`)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [api, selected, ready]);
  useEffect(() => {
    const keyboard = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (
        e.key === "/" &&
        !/INPUT|TEXTAREA|SELECT/.test(el.tagName) &&
        !document.querySelector("dialog[open]")
      ) {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, []);
  function go(v: View) {
    setView(v);
    setSelected(null);
    setSelectedClient(null);
    setDialog(null);
    setMobileNav(false);
    setQuery("");
    setError("");
    window.history.replaceState({}, "", `/?view=${v}`);
  }
  function openClient(id: string | null) {
    go("clients");
    setSelectedClient(id);
    if (id)
      window.history.replaceState({}, "", `/?client=${encodeURIComponent(id)}`);
  }
  function openProject(id: string) {
    setSelected(id);
    setView("sites");
    setError("");
    window.history.replaceState(
      {},
      "",
      `/?workspace=${workspace}&project=${id}`,
    );
  }
  function resetFilters() {
    setQuery("");
    setProvider("");
    setClientFilter("");
    setTechnology("");
    setIncompleteOnly(false);
  }
  async function mutate(
    path: string,
    method: string,
    payload?: unknown,
    message = "Modifications enregistrées.",
  ) {
    await api(path, method, payload);
    await refresh();
    setDialog(null);
    notify(message);
  }
  const projects = data?.projects || [];
  const providers = Array.from(
    new Set(data?.services.map((s) => s.provider).filter(Boolean)),
  ).sort();
  const technologies = Array.from(
    new Set(data?.services.map((s) => s.technology).filter(Boolean)),
  ).sort();
  const filtered = (data?.projects || [])
    .filter((p) => {
      const services = data?.services.filter((s) => s.projectId === p.id) || [];
      return (
        (!provider || services.some((s) => s.provider === provider)) &&
        (!technology || services.some((s) => s.technology === technology)) &&
        (!clientFilter ||
          (clientFilter === "__none"
            ? !p.clientId
            : p.clientId === clientFilter)) &&
        (!incompleteOnly || needsInfo(p, data!.services)) &&
        [
          p.name,
          p.url,
          p.client,
          p.description,
          ...p.tags,
          ...services.flatMap((s) => [s.provider, s.technology]),
        ]
          .join(" ")
          .toLowerCase()
          .includes(query.toLowerCase())
      );
    })
    .sort((a, b) =>
      sort === "updated"
        ? b.updatedAt.localeCompare(a.updatedAt)
        : a.name.localeCompare(b.name, "fr"),
    );
  const filterCount =
    Number(!!provider) +
    Number(!!technology) +
    Number(!!clientFilter) +
    Number(incompleteOnly);

  function renderProjects(rows: Project[], compact = false) {
    if (!rows.length)
      return (
        <EmptyState
          title={
            data?.projects.length
              ? "Aucun projet ne correspond"
              : "Aucun site enregistré"
          }
          description={
            data?.projects.length
              ? "Essayez d’autres filtres ou une recherche plus large."
              : "Liez un site hébergé ou créez votre premier projet."
          }
          action={
            data?.projects.length ? (
              <button className="button secondary" onClick={resetFilters}>
                Réinitialiser les filtres
              </button>
            ) : (
              <button
                className="button primary"
                onClick={() => setDialog("project")}
              >
                <Plus size={16} />
                Ajouter un projet
              </button>
            )
          }
        />
      );
    if (layout === "grid" && !compact)
      return (
        <div className="project-grid">
          {rows.map((p) => {
            const s = data!.services.find((s) => s.projectId === p.id);
            return (
              <RecordLink
                className="project-card"
                key={p.id}
                href={`/?project=${encodeURIComponent(p.id)}`}
                onNavigate={() => openProject(p.id)}
              >
                <div className="project-card-head">
                  <TechIcon name={s?.technology || ""} />
                  <Status project={p} data={data!} />
                </div>
                <h3>{p.name}</h3>
                <span className="subtle">{domain(p.url)}</span>
                <span className="card-client">
                  {p.client || "Client à rattacher"}
                </span>
                <p>{p.description || "Aucune description renseignée."}</p>
                <div className="project-card-footer">
                  <ProviderBadge name={s?.provider || ""} />
                </div>
              </RecordLink>
            );
          })}
        </div>
      );
    return (
      <div className="table-scroll">
        <table className="project-table">
          <thead>
            <tr>
              <th>
                Projet <ChevronDown size={11} />
              </th>
              <th>Hébergement</th>
              {!compact && <th>Client</th>}
              <th>
                Inventaire <CircleHelp size={12} />
              </th>
              <th>Dernière revue</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const s = data!.services.find((s) => s.projectId === p.id);
              return (
                <tr key={p.id} className="record-row">
                  <td>
                    <RecordLink
                      className="project-name-cell"
                      href={`/?project=${encodeURIComponent(p.id)}`}
                      onNavigate={() => openProject(p.id)}
                      stretch
                    >
                      <TechIcon name={s?.technology || ""} />
                      <span>
                        <strong>
                          {p.name}
                          {p.criticality === "critical" && (
                            <span
                              className="critical-dot"
                              title="Projet critique"
                            />
                          )}
                        </strong>
                        <small>{domain(p.url)}</small>
                      </span>
                    </RecordLink>
                  </td>
                  <td>
                    <ProviderBadge name={s?.provider || ""} />
                  </td>
                  {!compact && (
                    <td>
                      {p.clientId ? (
                        <RecordLink
                          className="text-button record-secondary"
                          href={`/?client=${encodeURIComponent(p.clientId)}`}
                          onNavigate={() => openClient(p.clientId)}
                        >
                          {p.client}
                        </RecordLink>
                      ) : (
                        <span className="subtle">À rattacher</span>
                      )}
                    </td>
                  )}
                  <td>
                    <Status project={p} data={data!} />
                  </td>
                  <td>
                    <span
                      className={`review-date ${p.reviewedAt ? "" : "subtle"}`}
                    >
                      {p.reviewedAt ? (
                        <>
                          <CheckCheck size={13} />
                          {formatDate(p.reviewedAt, true)}
                        </>
                      ) : (
                        <>
                          <span className="small-dash">—</span>À relire
                        </>
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  function renderDetail() {
    if (!detail)
      return error ? (
        <div className="page-error">
          <p>{error}</p>
          <button className="button secondary" onClick={() => go("sites")}>
            <ArrowLeft size={16} />
            Retour au parc
          </button>
        </div>
      ) : (
        <div className="loading">
          <Loader2 className="spin" />
          Ouverture de la fiche…
        </div>
      );
    const p = detail.project;
    const service = detail.services[0];
    const connected = !!(
      detail.hosting?.length ||
      detail.vercel?.length ||
      detail.railway?.length
    );
    return (
      <>
        <button className="back-link" onClick={() => go("sites")}>
          <ArrowLeft size={15} />
          Tous les projets
        </button>
        <div className="detail-heading">
          <div className="detail-identity">
            <TechIcon name={service?.technology || ""} size="large" />
            <div>
              <div className="eyebrow">
                {p.clientId ? (
                  <RecordLink
                    className="text-button"
                    href={`/?client=${encodeURIComponent(p.clientId)}`}
                    onNavigate={() => openClient(p.clientId)}
                  >
                    {p.client}
                  </RecordLink>
                ) : (
                  "CLIENT À RATTACHER"
                )}
              </div>
              <h1>{p.name}</h1>
              <OutLink href={p.url} className="site-url">
                {domain(p.url)}
              </OutLink>
            </div>
          </div>
          <div className="heading-actions">
            <button
              className="button secondary"
              onClick={() => setDialog("editProject")}
            >
              <Pencil size={15} />
              Modifier
            </button>
          </div>
        </div>
        <div className="detail-meta">
          <Status project={p} data={data!} />
          <span>
            <ShieldCheck size={14} />
            {p.criticality === "critical"
              ? "Criticité élevée"
              : p.criticality === "important"
                ? "Projet important"
                : "Criticité standard"}
          </span>
          {p.tags.map((t) => (
            <span className="plain-tag" key={t}>
              {t}
            </span>
          ))}
        </div>
        <div className="project-content">
          <ProjectHealthSummary detail={detail} updates={projectUpdateState?.projectId === p.id ? projectUpdateState.state : undefined} updatesUnavailable={projectUpdateState?.projectId === p.id && projectUpdateState.unavailable} />
          {p.description && <p className="project-intro">{p.description}</p>}
          <ProjectUpdates key={p.id} projectId={p.id} request={api} onComplete={refresh} onState={onProjectUpdateState} />
          <section
            className="project-monitoring"
            id="project-technical"
            aria-label="Suivi technique du projet"
          >
            <div className="project-section-title">
              <div>
                <h2>Suivi technique</h2>
                <p>
                  {connected
                    ? "Versions, déploiements et points à vérifier depuis vos hébergeurs."
                    : "Liez ce projet à son hébergeur pour retrouver ses informations techniques."}
                </p>
              </div>
              <span className={`badge ${connected ? "sage" : "neutral"}`}>
                {connected ? "Hébergement rattaché" : "À connecter"}
              </span>
            </div>
            {!connected && (
              <div className="panel project-connect">
                <Server size={23} />
                <div>
                  <h3>Connecter l’hébergement</h3>
                  <p>
                    Depuis Connexions, sélectionnez le site et rattachez-le à
                    cette fiche.
                  </p>
                </div>
                <button
                  className="button primary"
                  onClick={() => go("connections")}
                >
                  <Link2 size={15} />
                  Ouvrir les connexions
                </button>
              </div>
            )}
            {detail.vercel?.map((item) => (
              <VercelInventoryPanel
                key={`${item.connectionId}:${item.id}`}
                item={item}
                request={api}
                onRefresh={refresh}
              />
            ))}
            {detail.railway?.map((item) => (
              <RailwayInventoryPanel
                key={`${item.connectionId}:${item.id}`}
                item={item}
                request={api}
                onRefresh={refresh}
              />
            ))}
            {detail.hosting
              ?.filter((i) => i.kind === "wordpress")
              .map((installation) => (
                <WordPressInventoryPanel
                  key={installation.id}
                  installation={installation}
                  request={api}
                  onRefresh={refresh}
                />
              ))}
          </section>
          {!!detail.hosting?.length && (
            <details className="panel project-section">
              <summary>
                Hébergement <span>{detail.hosting.length} installation(s)</span>
              </summary>
              <div className="project-hosting-list">
                {detail.hosting.map((installation) => (
                  <div className="project-hosting-item" key={installation.id}>
                    <div>
                      <strong>{installation.connectionName}</strong>
                      <span
                        className={`badge ${installation.missingSince || installation.inspectionError ? "warning" : "sage"}`}
                      >
                        {installation.missingSince
                          ? "Non retrouvée"
                          : installation.inspectionError
                            ? "Lecture à vérifier"
                            : "Rattaché"}
                      </span>
                    </div>
                    <p>{installation.domains.join(", ")}</p>
                    <span>
                      {installationLabels[installation.kind]}
                      {installation.version && ` · ${installation.version}`}
                    </span>
                    <code>{installation.documentRoot}</code>
                    <small>
                      {installation.observedAt
                        ? `Fichiers relevés le ${formatDate(installation.observedAt)}`
                        : "Fichiers non vérifiés"}
                    </small>
                  </div>
                ))}
              </div>
            </details>
          )}
          <details className="panel project-section" open={!connected}>
            <summary>
              Environnements & services{" "}
              <span>{detail.services.length} service(s)</span>
            </summary>
            <div className="panel-heading">
              <div>
                <h2>Environnements & services</h2>
                <p>Les composants qui font fonctionner ce projet.</p>
              </div>
              <button
                className="button secondary small"
                onClick={() => setDialog("environment")}
              >
                <Plus size={14} />
                Environnement
              </button>
            </div>
            {detail.environments.map((env) => (
              <div className="environment-block" key={env.id}>
                <div className="environment-head">
                  <span className={`environment-dot ${env.kind}`} />
                  <strong>{env.name}</strong>
                  <span className="environment-kind">
                    {env.kind === "production"
                      ? "Production"
                      : env.kind === "staging"
                        ? "Préproduction"
                        : "Développement"}
                  </span>
                  {env.url && (
                    <OutLink href={env.url} className="env-url">
                      Ouvrir
                    </OutLink>
                  )}
                </div>
                {detail.services
                  .filter((s) => s.environmentId === env.id)
                  .map((s) => (
                    <div className="service-row" key={s.id}>
                      <TechIcon name={s.technology} size="small" />
                      <div className="service-info">
                        <strong>{s.name}</strong>
                        <span>
                          {s.technology || "Technologie à identifier"}
                          {s.runtime &&
                            ` · ${s.runtime}${s.version ? ` ${s.version}` : ""}`}
                        </span>
                      </div>
                      <ProviderBadge name={s.provider} />
                      <button
                        className="icon-button"
                        aria-label={`Modifier ${s.name}`}
                        onClick={() => {
                          setEditService(s);
                          setDialog("editService");
                        }}
                      >
                        <Pencil size={14} />
                      </button>
                    </div>
                  ))}
                {!detail.services.some((s) => s.environmentId === env.id) && (
                  <p className="subtle environment-empty">
                    Aucun service associé.
                  </p>
                )}
              </div>
            ))}
            <button
              className="add-row"
              onClick={() => {
                setEditService(undefined);
                setDialog("service");
              }}
            >
              <Plus size={15} />
              Ajouter un service
            </button>
          </details>
          <section className="panel project-review">
            <div>
              <h2>Revue de la fiche</h2>
              <p>Validation manuelle des informations du projet.</p>
            </div>
            <div className="review-value">
              <small>Dernière revue manuelle</small>
              <strong>
                {p.reviewedAt ? formatDate(p.reviewedAt) : "Pas encore relue"}
              </strong>
            </div>
            <button
              className="button secondary"
              disabled={actionBusy}
              onClick={async () => {
                setActionBusy(true);
                try {
                  await mutate(
                    `projects/${p.id}/review`,
                    "POST",
                    {},
                    "Revue de la documentation enregistrée.",
                  );
                } catch (e) {
                  notify((e as Error).message);
                } finally {
                  setActionBusy(false);
                }
              }}
            >
              {actionBusy ? (
                <Loader2 size={15} className="spin" />
              ) : (
                <CheckCheck size={15} />
              )}
              Marquer comme relue
            </button>
          </section>
          <details className="project-section project-history">
            <summary>
              Historique du projet{" "}
              <span>{detail.activity.length} action(s)</span>
            </summary>
            <ActivityPanel
              items={detail.activity}
              onProject={openProject}
              scoped
            />
          </details>
        </div>
      </>
    );
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? "mobile-open" : ""}`}>
        <div className="sidebar-brand">
          <Logo />
          <button
            className="icon-button mobile-close"
            aria-label="Fermer le menu"
            onClick={() => setMobileNav(false)}
          >
            <X size={19} />
          </button>
        </div>
        <div className="workspace-switch">
          <span className="workspace-avatar">V</span>
          <div>
            <strong>Parc web</strong>
            <small>Équipe interne</small>
          </div>
          <span className="version-badge">V1</span>
        </div>
        <div className="nav-section-label">ESPACE DE TRAVAIL</div>
        <nav className="main-nav" aria-label="Navigation principale">
          {navigation.map((n) => (
            <button
              key={n.id}
              className={view === n.id ? "active" : ""}
              onClick={() => go(n.id)}
            >
              <n.icon size={18} />
              <span>{n.label}</span>
              {n.id === "sites" && data && (
                <span className="nav-count">{projects.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="nav-section-label provider-label">
          HÉBERGEMENTS <span>{providers.length}</span>
        </div>
        <nav className="provider-nav" aria-label="Filtrer par hébergeur">
          {providers.slice(0, 5).map((p) => (
            <button
              key={p}
              className={view === "sites" && provider === p ? "active" : ""}
              onClick={() => {
                go("sites");
                setProvider(p);
              }}
            >
              <ProviderBadge name={p} />
              <span>
                {
                  projects.filter((a) =>
                    data?.services.some(
                      (s) => s.projectId === a.id && s.provider === p,
                    ),
                  ).length
                }
              </span>
            </button>
          ))}
          {!providers.length && (
            <p className="sidebar-placeholder">
              Vos hébergeurs apparaîtront ici.
            </p>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-profile">
            <span className="profile-avatar">
              <UserRound size={17} />
            </span>
            <div>
              <strong>{user.name || user.email}</strong>
              <span title={user.email}>{user.email}</span>
            </div>
            <button
              className="icon-button"
              title="Se déconnecter"
              aria-label="Se déconnecter"
              onClick={async () => {
                const result = await authClient.signOut();
                if (result.error) {
                  notify("La déconnexion a échoué. Réessayez.");
                  return;
                }
                window.location.assign("/connexion");
              }}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      {mobileNav && (
        <button
          className="sidebar-overlay"
          aria-label="Fermer la navigation"
          onClick={() => setMobileNav(false)}
        />
      )}
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="Ouvrir le menu"
              onClick={() => setMobileNav(true)}
            >
              <Menu size={19} />
            </button>
            <span>Mon espace</span>
            <ChevronRight size={13} />
            <strong>{selected ? "Fiche projet" : titles[view].title}</strong>
          </div>
          <div className="topbar-actions">
            <ThemeToggle />
            <span className="top-avatar" title={user.email}>
              {initial(user.name || user.email)}
            </span>
          </div>
        </header>
        <main className="main-content">
          {error && !selected && (
            <div className="error-banner" role="alert">
              {error}
              <button
                className="text-button"
                onClick={() => refresh().catch((e) => setError(e.message))}
              >
                Réessayer
              </button>
            </div>
          )}
          {!data && !error ? (
            <div className="loading">
              <Loader2 size={23} className="spin" />
              Chargement de votre espace…
            </div>
          ) : (
            data && (
              <>
                {selected ? (
                  renderDetail()
                ) : (
                  <>
                    <div className="page-heading">
                      <div>
                        <div className="eyebrow">{titles[view].kicker}</div>
                        <h1>{titles[view].title}</h1>
                        <p>{titles[view].description}</p>
                      </div>
                      <div className="heading-actions">
                        {view === "clients" && (
                          <button
                            className="button primary"
                            onClick={() => {
                              setEditClient(undefined);
                              setDialog("client");
                            }}
                          >
                            <Plus size={17} />
                            Ajouter un client
                          </button>
                        )}
                        {view === "sites" && (
                          <>
                            <button
                              className="button primary"
                              onClick={() => setDialog("project")}
                            >
                              <Plus size={17} />
                              Ajouter un projet
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    {view === "clients" && (
                      <ClientsPanel
                        data={data}
                        selectedId={selectedClient}
                        onSelect={openClient}
                        onCreate={() => {
                          setEditClient(undefined);
                          setDialog("client");
                        }}
                        onEdit={(client) => {
                          setEditClient(client);
                          setDialog("editClient");
                        }}
                        onProject={openProject}
                        onAddProject={() => setDialog("project")}
                        onLinkProject={() => setDialog("linkClientProject")}
                      />
                    )}
                    {view === "sites" && (
                      <section className="panel sites-panel">
                        <div className="sites-tabs">
                          <span className="sites-list-label">
                            Tous les projets{" "}
                            <span className="badge neutral">
                              {projects.length}
                            </span>
                          </span>
                          <div className="view-toggle">
                            <button
                              className={layout === "list" ? "active" : ""}
                              aria-label="Vue liste"
                              onClick={() => setLayout("list")}
                            >
                              <List size={16} />
                            </button>
                            <button
                              className={layout === "grid" ? "active" : ""}
                              aria-label="Vue cartes"
                              onClick={() => setLayout("grid")}
                            >
                              <LayoutGrid size={16} />
                            </button>
                          </div>
                        </div>
                        <div className="filter-toolbar">
                          <div className="search-input">
                            <Search size={17} />
                            <input
                              ref={searchRef}
                              aria-label="Rechercher dans les projets"
                              placeholder="Rechercher un projet, un client, une URL…"
                              value={query}
                              onChange={(e) => setQuery(e.target.value)}
                            />
                            {query ? (
                              <button
                                className="icon-button"
                                aria-label="Effacer la recherche"
                                onClick={() => setQuery("")}
                              >
                                <X size={13} />
                              </button>
                            ) : (
                              <kbd>/</kbd>
                            )}
                          </div>
                          <select
                            aria-label="Filtrer par hébergeur"
                            value={provider}
                            onChange={(e) => setProvider(e.target.value)}
                          >
                            <option value="">Tous les hébergeurs</option>
                            {providers.map((p) => (
                              <option key={p}>{p}</option>
                            ))}
                          </select>
                          <select
                            aria-label="Filtrer par technologie"
                            value={technology}
                            onChange={(e) => setTechnology(e.target.value)}
                          >
                            <option value="">Toutes les technologies</option>
                            {technologies.map((t) => (
                              <option key={t}>{t}</option>
                            ))}
                          </select>
                          <select
                            aria-label="Filtrer par client"
                            value={clientFilter}
                            onChange={(e) => setClientFilter(e.target.value)}
                          >
                            <option value="">Tous les clients</option>
                            <option value="__none">À rattacher</option>
                            {data.clients.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                          <button
                            className={`filter-toggle ${incompleteOnly ? "selected" : ""}`}
                            title="Afficher les fiches à compléter"
                            aria-label="Fiches à compléter uniquement"
                            aria-pressed={incompleteOnly}
                            onClick={() => setIncompleteOnly(!incompleteOnly)}
                          >
                            <SlidersHorizontal size={16} />
                          </button>
                        </div>
                        {filterCount > 0 && (
                          <div className="active-filters">
                            <span>
                              {filterCount} filtre{filterCount > 1 ? "s" : ""}{" "}
                              actif{filterCount > 1 ? "s" : ""}
                            </span>
                            {incompleteOnly && (
                              <span className="badge warning">
                                Fiches à compléter
                              </span>
                            )}
                            <button
                              className="text-button"
                              onClick={resetFilters}
                            >
                              Réinitialiser
                              <X size={12} />
                            </button>
                          </div>
                        )}
                        {renderProjects(filtered)}
                        <div className="table-footer">
                          <span>
                            {filtered.length} projet
                            {filtered.length > 1 ? "s" : ""} affiché
                            {filtered.length > 1 ? "s" : ""}
                          </span>
                          <label className="sort-select">
                            Trier par
                            <select
                              value={sort}
                              onChange={(e) => setSort(e.target.value)}
                              aria-label="Ordre de tri"
                            >
                              <option value="name">Nom du projet</option>
                              <option value="updated">
                                Dernière modification
                              </option>
                            </select>
                          </label>
                        </div>
                      </section>
                    )}
                    {view === "backup" && (
                      <section className="panel backup-placeholder">
                        <Database size={32} />
                        <h2>Coming soon</h2>
                      </section>
                    )}
                    {view === "activity" && (
                      <ActivityPanel
                        items={data.activity}
                        onProject={openProject}
                      />
                    )}
                    {view === "connections" && (
                      <ConnectionsPanel
                        request={api}
                        projects={data.projects}
                        onProject={openProject}
                        onRefresh={refresh}
                      />
                    )}
                  </>
                )}
              </>
            )
          )}
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
          <button
            className="icon-button"
            aria-label="Fermer la notification"
            onClick={() => setToast("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {dialog === "project" && (
        <Modal
          title="Ajouter un projet"
          description="Comment souhaitez-vous ajouter ce projet au parc ?"
          onClose={() => setDialog(null)}
        >
          <div className="project-choices">
            <button onClick={() => setDialog("existingProject")}>
              <span className="project-choice-icon">
                <Link2 size={23} />
              </span>
              <span>
                <strong>Lier un projet existant</strong>
                <small>
                  Retrouvez un site déjà hébergé sur o2switch, Vercel ou
                  Railway.
                </small>
              </span>
              <ChevronRight size={19} />
            </button>
            <button onClick={() => setDialog("manualProject")}>
              <span className="project-choice-icon">
                <Plus size={23} />
              </span>
              <span>
                <strong>Créer un projet de zéro</strong>
                <small>
                  Créez une fiche pour un nouveau projet, puis complétez ses
                  informations.
                </small>
              </span>
              <ChevronRight size={19} />
            </button>
          </div>
        </Modal>
      )}
      {dialog === "existingProject" && (
        <ExistingProjectForm
          request={api}
          onBack={() => setDialog("project")}
          onClose={() => setDialog(null)}
          onConnections={() => go("connections")}
          onAdded={async (id, alreadyFollowed) => {
            const clientId =
              view === "clients"
                ? selectedClient
                : clientFilter === "__none"
                  ? null
                  : clientFilter;
            if (clientId && !alreadyFollowed)
              await api(`projects/${id}`, "PATCH", { clientId });
            await refresh();
            setDialog(null);
            openProject(id);
            notify("Projet ouvert dans votre parc.");
          }}
        />
      )}
      {dialog === "manualProject" && (
        <ProjectForm
          onBack={() => setDialog("project")}
          clients={data?.clients || []}
          defaultClientId={
            view === "clients"
              ? selectedClient || undefined
              : clientFilter === "__none"
                ? undefined
                : clientFilter || undefined
          }
          onCreateClient={async (input) => {
            const client = await api("clients", "POST", input);
            await refresh();
            return client;
          }}
          onClose={() => setDialog(null)}
          onSubmit={async (input) => {
            const p = await api("projects", "POST", input);
            setDialog(null);
            await refresh();
            openProject(p.id);
            notify("Projet ajouté à votre parc.");
          }}
        />
      )}
      {dialog === "editProject" && detail && (
        <ProjectForm
          project={detail.project}
          clients={data?.clients || []}
          onCreateClient={async (input) => {
            const client = await api("clients", "POST", input);
            await refresh();
            return client;
          }}
          onClose={() => setDialog(null)}
          onSubmit={(input) =>
            mutate(`projects/${detail.project.id}`, "PATCH", input)
          }
        />
      )}
      {(dialog === "client" || dialog === "editClient") && (
        <ClientForm
          client={dialog === "editClient" ? editClient : undefined}
          onClose={() => setDialog(null)}
          onSubmit={async (input) => {
            const client = await api(
              dialog === "editClient" ? `clients/${editClient!.id}` : "clients",
              dialog === "editClient" ? "PATCH" : "POST",
              input,
            );
            await refresh();
            setSelectedClient(client.id);
            setDialog(null);
            notify("Fiche client enregistrée.");
          }}
        />
      )}
      {dialog === "linkClientProject" &&
        data &&
        data.clients.some((c) => c.id === selectedClient) && (
          <LinkClientProjectForm
            client={data.clients.find((c) => c.id === selectedClient)!}
            projects={data.projects}
            onClose={() => setDialog(null)}
            onSubmit={(input) =>
              mutate(
                `projects/${input.projectId}`,
                "PATCH",
                { clientId: selectedClient },
                "Site rattaché au client.",
              )
            }
          />
        )}
      {dialog === "environment" && detail && (
        <EnvironmentForm
          onClose={() => setDialog(null)}
          onSubmit={(input) =>
            mutate(
              `projects/${detail.project.id}/environments`,
              "POST",
              input,
              "Environnement ajouté.",
            )
          }
        />
      )}
      {(dialog === "service" || dialog === "editService") && detail && (
        <ServiceForm
          detail={detail}
          service={dialog === "editService" ? editService : undefined}
          onClose={() => setDialog(null)}
          onSubmit={(input) =>
            mutate(
              dialog === "editService"
                ? `services/${editService!.id}`
                : `projects/${detail.project.id}/services`,
              dialog === "editService" ? "PATCH" : "POST",
              input,
              "Service enregistré.",
            )
          }
        />
      )}
    </div>
  );
}
