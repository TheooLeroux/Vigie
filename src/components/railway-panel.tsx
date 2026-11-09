"use client";
import { deploymentObservationLifetime, observationIsFresh } from "@/lib/observation-freshness";
import "./railway.css";
import { useEffect, useState } from "react";
import {
  TrainFront,
  Plus,
  RefreshCw,
  Loader2,
  Pencil,
  Unplug,
} from "lucide-react";
import type { Project } from "@/lib/types";
import type {
  RailwayConnection,
  RailwayProjectView,
  RailwayState,
} from "@/lib/railway-types";
import {
  railwayAttention,
  railwayServiceState,
  railwayRuntimeDeployments,
  railwayVersionAttention,
  deploymentLabel,
  deploymentTone,
} from "@/lib/railway-status";
import { RecordLink } from "./record-link";
import { RailwayBuildDetails, railwayVersionPreview } from "./railway-build-details";
import { Modal, Field, formatDate, OutLink } from "./ui";
type RequestApi = (
  path: string,
  method?: string,
  payload?: unknown,
) => Promise<any>;
const initial: RailwayState = { connections: [], projects: [] };
export function RailwayConnectionsPanel({
  request,
  projects,
  onProject,
  onRefresh,
}: {
  request: RequestApi;
  projects: Project[];
  onProject: (id: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const [state, setState] = useState(initial),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [busy, setBusy] = useState("");
  const [edit, setEdit] = useState<RailwayConnection | "new" | null>(null),
    [link, setLink] = useState<RailwayProjectView | null>(null),
    [disconnect, setDisconnect] = useState<RailwayConnection | null>(null);
  useEffect(() => {
    let alive = true;
    request("railway")
      .then((s) => {
        if (alive) setState(s);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [request]);
  async function sync(id: string) {
    setBusy(id);
    setError("");
    try {
      setState(await request(`railway/${id}/sync`, "POST", {}));
      await onRefresh();
    } catch (e) {
      setError((e as Error).message);
      setState(await request("railway").catch(() => state));
    } finally {
      setBusy("");
    }
  }
  return (
    <section className="railway-section">
      <div className="connections-intro">
        <div>
          <h2 className="provider-heading">
            <TrainFront size={19} />
            Railway
          </h2>
          <p>
            Les projets reconnus sont rattachés à leurs fiches. Synchronisation
            en lecture seule.
          </p>
        </div>
        <button className="button secondary" onClick={() => setEdit("new")}>
          <Plus size={16} />
          Connecter Railway
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p className="subtle">Chargement de Railway…</p>
      ) : !state.connections.length ? (
        <section className="panel">
          <div className="connection-body">
            <p>
              Connectez un workspace Railway pour retrouver ses projets et
              services.
            </p>
          </div>
        </section>
      ) : (
        <div className="connections-list">
          {state.connections.map((c) => {
            const items = state.projects.filter((p) => p.connectionId === c.id);
            return (
              <section className="panel connection-card" key={c.id}>
                <div className="panel-heading">
                  <div>
                    <h2>{c.name}</h2>
                    <p>
                      {items.length} projets ·{" "}
                      {items.filter((p) => p.projectId).length} rattachés
                    </p>
                  </div>
                  <span
                    className={`badge ${!c.configured ? "neutral" : c.error ? "warning" : c.lastSuccessAt ? "sage" : "neutral"}`}
                  >
                    {!c.configured
                      ? "Déconnecté"
                      : c.error
                        ? "Relevé en échec"
                        : c.lastSuccessAt
                          ? "Connecté"
                          : "À synchroniser"}
                  </span>
                </div>
                <div className="connection-body">
                  {c.error && (
                    <p className="connection-error" role="alert">
                      {c.error}
                    </p>
                  )}
                  <p className="subtle">
                    Dernier relevé réussi : {formatDate(c.lastSuccessAt)}
                    {c.lastAttemptAt !== c.lastSuccessAt &&
                      c.lastAttemptAt &&
                      ` · Dernière tentative : ${formatDate(c.lastAttemptAt)}`}
                  </p>
                  <div className="railway-projects">
                    {items.map((p) => (
                      <div className="railway-project record-row" key={p.id}>
                        <div>
                          {p.projectId ? (
                            <RecordLink
                              stretch
                              href={`/?workspace=live&project=${p.projectId}`}
                              onNavigate={() => onProject(p.projectId!)}
                            >
                              <strong>{p.projectName}</strong>
                            </RecordLink>
                          ) : (
                            <strong>{p.name}</strong>
                          )}
                          {p.projectId && p.projectName !== p.name && (
                            <small>Railway : {p.name}</small>
                          )}
                          <p>
                            {p.environments.length} environnement
                            {p.environments.length > 1 ? "s" : ""} ·{" "}
                            {p.services.length} service
                            {p.services.length > 1 ? "s" : ""}
                          </p>
                          <div className="railway-badges">
                            {p.missingSince ? (
                              <span className="badge warning">
                                Absent du dernier relevé
                              </span>
                            ) : (
                              <>
                                <span
                                  className={`badge ${p.projectId ? "sage" : "neutral"}`}
                                >
                                  {p.projectId ? "Rattaché" : "À rattacher"}
                                </span>
                                {p.services.some(railwayAttention) && (
                                  <span className="badge warning">
                                    {p.services.filter(railwayAttention).length}{" "}
                                    service(s) à vérifier
                                  </span>
                                )}
                              </>
                            )}
                          </div>
                        </div>
                        <div className="railway-row-actions record-secondary">
                          {!p.projectId && !p.missingSince && (
                            <>
                              <button
                                className="button secondary"
                                disabled={!!busy}
                                onClick={() => setLink(p)}
                              >
                                Rattacher
                              </button>
                              <button
                                className="button secondary"
                                disabled={!!busy}
                                onClick={async () => {
                                  setBusy(p.id);
                                  setError("");
                                  try {
                                    const created = await request(
                                      `railway/${c.id}/projects/${p.id}/create`,
                                      "POST",
                                      {},
                                    );
                                    setState(await request("railway"));
                                    await onRefresh();
                                    onProject(created.projectId);
                                  } catch (e) {
                                    setError((e as Error).message);
                                  } finally {
                                    setBusy("");
                                  }
                                }}
                              >
                                Ajouter une fiche
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="connection-actions">
                    <button
                      className="button primary"
                      disabled={!!busy || !c.configured}
                      onClick={() => sync(c.id)}
                    >
                      {busy === c.id ? (
                        <Loader2 size={15} className="spin" />
                      ) : (
                        <RefreshCw size={15} />
                      )}
                      Synchroniser Railway
                    </button>
                    <button
                      className="button secondary"
                      disabled={!!busy}
                      onClick={() => setEdit(c)}
                    >
                      <Pencil size={14} />
                      Modifier l’accès
                    </button>
                    {c.configured && (
                      <button
                        className="button secondary"
                        disabled={!!busy}
                        onClick={() => setDisconnect(c)}
                      >
                        <Unplug size={14} />
                        Déconnecter
                      </button>
                    )}
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}
      {edit && (
        <RailwayForm
          connection={edit === "new" ? undefined : edit}
          onClose={() => setEdit(null)}
          onSubmit={async (input) => {
            const c = await request(
              edit === "new" ? "railway" : `railway/${edit.id}`,
              edit === "new" ? "POST" : "PATCH",
              input,
            );
            setState(await request("railway"));
            setEdit(null);
            await sync(c.id);
          }}
        />
      )}
      {link && (
        <RailwayLinkForm
          item={link}
          projects={projects}
          onClose={() => setLink(null)}
          onSubmit={async (projectId) => {
            setState(
              await request(
                `railway/${link.connectionId}/projects/${link.id}/link`,
                "POST",
                { projectId },
              ),
            );
            setLink(null);
            await onRefresh();
          }}
        />
      )}
      {disconnect && (
        <Modal
          title="Déconnecter Railway de Vigie"
          description="Le jeton sera retiré de Vigie. Les relevés seront conservés. Pour révoquer aussi le jeton chez Railway, retirez-le depuis les paramètres du compte Railway."
          onClose={() => !busy && setDisconnect(null)}
        >
          <div className="modal-actions">
            <button
              className="button secondary"
              disabled={!!busy}
              onClick={() => setDisconnect(null)}
            >
              Annuler
            </button>
            <button
              className="button primary"
              disabled={!!busy}
              onClick={async () => {
                setBusy(disconnect.id);
                try {
                  setState(
                    await request(`railway/${disconnect.id}/token`, "DELETE"),
                  );
                  setDisconnect(null);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy("");
                }
              }}
            >
              Retirer le jeton de Vigie
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
function RailwayForm({
  connection,
  onClose,
  onSubmit,
}: {
  connection?: RailwayConnection;
  onClose: () => void;
  onSubmit: (input: unknown) => Promise<void>;
}) {
  const [name, setName] = useState(connection?.name || "Railway"),
    [workspaceId, setWorkspace] = useState(connection?.workspaceId || ""),
    [secret, setSecret] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal
      title={connection ? "Accès Railway" : "Connecter un workspace Railway"}
      onClose={() => !busy && onClose()}
      description="Le connecteur lit les projets et déploiements. Il n’installe rien dans vos applications."
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await onSubmit({ name, workspaceId, secret: secret || undefined });
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-grid">
          <Field label="Nom du compte">
            <input
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field
            label="Identifiant du workspace"
            hint="UUID du workspace Railway. Utilisez un jeton limité à ce workspace."
          >
            <input
              required
              readOnly={!!connection}
              value={workspaceId}
              onChange={(e) => setWorkspace(e.target.value)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            />
          </Field>
          <Field
            label="Jeton API Railway"
            span
            hint={
              connection?.configured
                ? "Laisser vide pour conserver le jeton actuel."
                : "Le jeton est chiffré sur le serveur de Vigie."
            }
          >
            <input
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              required={!connection?.configured}
              maxLength={2000}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </Field>
        </div>
        <p className="subtle">
          Le jeton Railway autorise aussi des écritures. Vigie utilise
          uniquement des requêtes de lecture.{" "}
          <OutLink href="https://railway.com/account/tokens">
            Gérer les jetons Railway
          </OutLink>
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={onClose}
          >
            Annuler
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? "Connexion…" : "Enregistrer et synchroniser"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function RailwayLinkForm({
  item,
  projects,
  onClose,
  onSubmit,
}: {
  item: RailwayProjectView;
  projects: Project[];
  onClose: () => void;
  onSubmit: (id: string) => Promise<void>;
}) {
  const [search, setSearch] = useState(""),
    [selected, setSelected] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal
      title={`Rattacher ${item.name}`}
      description="Choisissez la fiche Vigie correspondante. Cette action ne modifie pas Railway."
      onClose={() => !busy && onClose()}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onSubmit(selected);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Rechercher une fiche">
          <input value={search} onChange={(e) => setSearch(e.target.value)} />
        </Field>
        <Field label="Fiche Vigie">
          <select
            required
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">Choisir un projet</option>
            {projects
              .filter(
                (p) =>
                  p.lifecycle === "active" &&
                  `${p.name} ${p.url} ${p.client}`
                    .toLowerCase()
                    .includes(search.toLowerCase()),
              )
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.client ? ` · ${p.client}` : ""}
                </option>
              ))}
          </select>
        </Field>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="button secondary"
            onClick={onClose}
            disabled={busy}
          >
            Annuler
          </button>
          <button className="button primary" disabled={busy || !selected}>
            Rattacher
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function RailwayInventoryPanel({
  item,
  request,
  onRefresh,
}: {
  item: RailwayProjectView;
  request: RequestApi;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [observationTime, setObservationTime] = useState(Date.now);
  const stale = !observationIsFresh(item.observedAt, deploymentObservationLifetime, observationTime);
  const showRefresh = item.configured && (stale || Boolean(error || item.connectionError));

  useEffect(() => {
    const now = Date.now();
    setObservationTime(now);
    if (!observationIsFresh(item.observedAt, deploymentObservationLifetime, now)) return;
    const expiresAt = Date.parse(item.observedAt) + deploymentObservationLifetime;
    const timer = window.setTimeout(() => setObservationTime(expiresAt), expiresAt - now);
    return () => window.clearTimeout(timer);
  }, [item.observedAt]);

  async function refreshObservations() {
    setBusy(true);
    try {
      await request(`railway/${item.connectionId}/sync`, "POST", {});
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      await onRefresh().catch(() => {});
      setBusy(false);
    }
  }

  const refreshButton = <button
    className="button secondary"
    disabled={busy || !item.configured}
    onClick={() => void refreshObservations()}
  >
    {busy ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
    Actualiser les relevés
  </button>;
  return (
    <section className="panel railway-inventory">
      <div className="panel-heading">
        <div>
          <h2>Railway · {item.name}</h2>
          {showRefresh || !item.configured ? <p>Relevé du {formatDate(item.observedAt)}</p> : (
            <details className="railway-observation-details">
              <summary>Relevé du {formatDate(item.observedAt)}</summary>
              {refreshButton}
            </details>
          )}
        </div>
        {showRefresh && refreshButton}
      </div>
      <div className="connection-body">
        {(error || item.connectionError) && (
          <p className="form-error" role="alert">
            {error || item.connectionError}
          </p>
        )}
        {!item.configured && (
          <p className="notice">
            Connexion déconnectée. Ce relevé n’est plus actualisé.
          </p>
        )}
        {item.missingSince && (
          <p className="notice">
            Projet absent du dernier relevé depuis le{" "}
            {formatDate(item.missingSince)}. Les dernières informations connues
            sont conservées.
          </p>
        )}
        {stale && (
          <p className="notice">
            Le relevé a expiré. Les informations affichées datent de la dernière collecte réussie.
          </p>
        )}
        {item.environments.map((env) => (
          <div className="railway-environment" key={env.id}>
            <h3>
              {env.name}
              {env.ephemeral ? " · temporaire" : ""}
            </h3>
            {!item.services.some((s) => s.environmentId === env.id) && (
              <p className="subtle">Aucun service dans cet environnement.</p>
            )}
            <div className="railway-services">
              {item.services
                .filter((s) => s.environmentId === env.id)
                .map((s) => {
                  const status = railwayServiceState(s);
                  const active = railwayRuntimeDeployments(s);
                  const primary = active.find(deployment => deployment.status === "SUCCESS") || active[0];
                  const versions = railwayVersionPreview(s);
                  const failed = ["FAILED", "CRASHED"].includes(s.latestDeployment?.status || "") &&
                    !active.some(deployment => deployment.id === s.latestDeployment?.id);
                  return (
                    <details className="railway-service-card technical-disclosure" key={s.id}>
                      <summary>
                        <span className="technical-disclosure-copy">
                          <strong>{s.name}</strong>
                          {(primary || versions) && <small>
                            {primary && <>Déploiement du {formatDate(primary.createdAt)}{active.length > 1 && ` (+${active.length - 1})`}</>}
                            {primary && versions && " · "}
                            {versions}
                          </small>}
                        </span>
                        <span className="technical-disclosure-badges">
                          {failed && <span className="badge warning">Dernière tentative en échec</span>}
                          {railwayVersionAttention(s) && <span className="badge warning">Versions à vérifier</span>}
                          <span className={`badge ${status.tone}`}>{status.label}</span>
                        </span>
                      </summary>
                      <div className="railway-service-title">
                        <OutLink
                          className="record-secondary"
                          href={`https://railway.com/project/${item.id}/service/${s.id}?environmentId=${env.id}`}
                        >
                          Ouvrir dans Railway
                        </OutLink>
                      </div>
                      <p>
                        {s.domains.length
                          ? s.domains.join(" · ")
                          : "Aucun domaine public"}
                      </p>
                      {s.activeDeployments.map((d) => (
                        <small className="railway-deployment-id" key={d.id}>
                          Déploiement actif : {d.id.slice(0, 8)} ·{" "}
                          {deploymentLabel(d.status)} ·{" "}
                          {formatDate(d.createdAt)}
                        </small>
                      ))}
                      <dl className="railway-facts">
                        <div>
                          <dt>Source configurée</dt>
                          <dd>
                            {s.repository ||
                              s.image ||
                              "Non renseignée par Railway"}
                          </dd>
                        </div>
                        <div>
                          <dt>Construction</dt>
                          <dd>{s.builder}</dd>
                        </div>
                        <div>
                          <dt>Région / réplicas</dt>
                          <dd>
                            {s.region || "Non renseignée"} / {s.replicas ?? "—"}
                          </dd>
                        </div>
                        {s.rootDirectory && (
                          <div>
                            <dt>Répertoire</dt>
                            <dd>{s.rootDirectory}</dd>
                          </div>
                        )}
                        {s.healthcheckPath && (
                          <div>
                            <dt>Contrôle de santé configuré</dt>
                            <dd>{s.healthcheckPath}</dd>
                          </div>
                        )}
                        {s.cronSchedule && (
                          <div>
                            <dt>Planification</dt>
                            <dd>{s.cronSchedule}</dd>
                          </div>
                        )}
                      </dl>
                      <RailwayBuildDetails service={s} />
                      <div className="railway-deployment">
                        <span>Dernière tentative</span>
                        {s.latestDeployment ? (
                          <>
                            <span
                              className={`badge ${deploymentTone(s.latestDeployment.status)}`}
                            >
                              {deploymentLabel(s.latestDeployment.status)}
                            </span>
                            <small>
                              {formatDate(s.latestDeployment.createdAt)}
                            </small>
                          </>
                        ) : (
                          <small>Aucune</small>
                        )}
                      </div>
                    </details>
                  );
                })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
