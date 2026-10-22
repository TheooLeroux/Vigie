"use client";
import "./vercel.css";
import { useEffect, useState } from "react";
import {
  Plus,
  RefreshCw,
  Loader2,
  Pencil,
  Unplug,
  Triangle,
  Search,
} from "lucide-react";
import type { Project } from "@/lib/types";
import type {
  VercelConnection,
  VercelProjectView,
  VercelState,
  VercelDeployment,
} from "@/lib/vercel-types";
import { RecordLink } from "./record-link";
import { Modal, Field, formatDate, OutLink } from "./ui";
type RequestApi = (
  path: string,
  method?: string,
  payload?: unknown,
) => Promise<any>;
const initial: VercelState = { connections: [], projects: [] };
const labels: Record<string, string> = {
  READY: "Prêt",
  ERROR: "Échec",
  CANCELED: "Annulé",
  BUILDING: "Construction",
  QUEUED: "En attente",
  INITIALIZING: "Initialisation",
};
const tone = (state: string) =>
  state === "READY" ? "sage" : state === "ERROR" ? "warning" : "neutral";
export function VercelConnectionsPanel({
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
    [busy, setBusy] = useState(""),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all");
  const [edit, setEdit] = useState<VercelConnection | "new" | null>(null),
    [inspect, setInspect] = useState<VercelProjectView | null>(null),
    [link, setLink] = useState<VercelProjectView | null>(null),
    [disconnect, setDisconnect] = useState<VercelConnection | null>(null);
  useEffect(() => {
    let alive = true;
    request("vercel")
      .then((data) => {
        if (alive) setState(data);
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
      setState(await request(`vercel/${id}/sync`, "POST", {}));
      await onRefresh();
    } catch (e) {
      setError((e as Error).message);
      setState(await request("vercel").catch(() => state));
    } finally {
      setBusy("");
    }
  }
  async function add(p: VercelProjectView) {
    setBusy(p.id);
    setError("");
    try {
      const result = await request(
        `vercel/${p.connectionId}/projects/${p.id}/create`,
        "POST",
        {},
      );
      setState(await request("vercel"));
      setInspect(null);
      await onRefresh();
      onProject(result.projectId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <section className="vercel-section">
      <div className="connections-intro">
        <div>
          <h2 className="provider-heading">
            <Triangle size={18} />
            Vercel
          </h2>
          <p>
            Découvrez les projets, puis choisissez ceux à ajouter au parc. Le
            client est associé automatiquement quand il est connu.
          </p>
        </div>
        <button className="button secondary" onClick={() => setEdit("new")}>
          <Plus size={16} />
          Connecter Vercel
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p className="subtle">Chargement de Vercel…</p>
      ) : !state.connections.length ? (
        <section className="panel">
          <div className="connection-body">
            <p>
              Connectez une équipe Vercel pour lire ses projets et ses
              déploiements.
            </p>
          </div>
        </section>
      ) : (
        state.connections.map((c) => {
          const all = state.projects.filter((p) => p.connectionId === c.id),
            visible = all
              .filter((p) =>
                filter === "all" || filter === "excluded"
                  ? filter === "all" || p.excluded
                  : filter === "linked"
                    ? !!p.projectId
                    : !p.projectId && !p.excluded,
              )
              .filter((p) =>
                `${p.name} ${p.clientName || p.clientSuggestion || ""} ${p.domains.map((d) => d.name).join(" ")}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              );
          return (
            <section className="panel connection-card" key={c.id}>
              <div className="panel-heading">
                <div>
                  <h2>{c.name}</h2>
                  <p>
                    {all.length} découverts ·{" "}
                    {all.filter((p) => p.projectId).length} dans le parc ·{" "}
                    {all.filter((p) => p.excluded).length} exclus
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
                <div className="vercel-tools">
                  <label className="vercel-search">
                    <Search size={15} />
                    <input
                      aria-label="Rechercher un projet Vercel"
                      placeholder="Projet, client ou domaine…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </label>
                  <select
                    aria-label="Filtrer les projets Vercel"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  >
                    <option value="all">Tous ({all.length})</option>
                    <option value="new">
                      À ajouter (
                      {all.filter((p) => !p.projectId && !p.excluded).length})
                    </option>
                    <option value="linked">
                      Dans le parc ({all.filter((p) => p.projectId).length})
                    </option>
                    <option value="excluded">
                      Exclus ({all.filter((p) => p.excluded).length})
                    </option>
                  </select>
                </div>
                <div className="vercel-projects">
                  {visible.map((p) => (
                    <div
                      className={`vercel-project record-row ${p.excluded ? "is-excluded" : ""}`}
                      key={p.id}
                    >
                      <div className="vercel-project-text">
                        {p.projectId ? (
                          <RecordLink
                            stretch
                            href={`/?workspace=live&project=${p.projectId}`}
                            onNavigate={() => onProject(p.projectId!)}
                          >
                            <strong>{p.projectName}</strong>
                          </RecordLink>
                        ) : p.excluded ? (
                          <strong>{p.name}</strong>
                        ) : (
                          <button
                            className="record-link vercel-name"
                            onClick={() => setInspect(p)}
                          >
                            <strong>{p.name}</strong>
                          </button>
                        )}
                        {p.projectName && p.projectName !== p.name && (
                          <small>Vercel : {p.name}</small>
                        )}
                        <p>
                          {p.excluded
                            ? "À virer — exclu du suivi, aucune action sur Vercel"
                            : p.clientName
                              ? `Client : ${p.clientName}`
                              : p.clientSuggestion
                                ? `Client prévu : ${p.clientSuggestion}`
                                : "Client à préciser"}
                        </p>
                        {!p.excluded && (
                          <>
                            <small>
                              {p.domains
                                .filter((d) => d.environment === "production")
                                .map((d) => d.name)
                                .join(" · ") ||
                                "Aucun domaine de production renseigné"}
                            </small>
                            <div className="vercel-badges">
                              <span
                                className={`badge ${p.projectId ? "sage" : "neutral"}`}
                              >
                                {p.projectId ? "Dans le parc" : "À ajouter"}
                              </span>
                              {p.missingSince ? (
                                <span className="badge warning">
                                  Absent du dernier relevé
                                </span>
                              ) : (
                                <>
                                  <span
                                    className={`badge ${p.production ? tone(p.production.state) : "neutral"}`}
                                  >
                                    {p.production
                                      ? `Production : ${labels[p.production.state] || p.production.state}`
                                      : "Sans déploiement de production"}
                                  </span>
                                  {p.production?.nodeBranch && (
                                    <span
                                      className={`badge ${p.production.nodeRelease?.supported === false ? "warning" : "neutral"}`}
                                    >
                                      Node {p.production.nodeBranch}
                                      {p.production.nodeRelease?.supported ===
                                      false
                                        ? " · fin de support"
                                        : ""}
                                    </span>
                                  )}
                                  {p.production?.analysis?.technologies
                                    .filter((t) => t.usage === "framework")
                                    .map((t) => (
                                      <span
                                        className="badge neutral"
                                        key={`${t.name}:${t.version}`}
                                      >
                                        {t.name} {t.version}
                                      </span>
                                    ))}
                                  {!!p.production?.analysis?.technologies.some(
                                    (t) => t.update === "available",
                                  ) && (
                                    <span className="badge warning">
                                      Versions à examiner
                                    </span>
                                  )}
                                </>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                      {!p.projectId && !p.excluded && !p.missingSince && (
                        <div className="vercel-row-actions record-secondary">
                          <button
                            className="button primary"
                            disabled={!!busy}
                            onClick={() => add(p)}
                          >
                            {busy === p.id ? (
                              <Loader2 className="spin" size={14} />
                            ) : (
                              <Plus size={14} />
                            )}
                            Ajouter au parc
                          </button>
                          <button
                            className="button secondary"
                            disabled={!!busy}
                            onClick={() => setLink(p)}
                          >
                            Rattacher à une fiche
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                  {!visible.length && (
                    <p className="vercel-empty">
                      Aucun projet ne correspond à ces filtres.
                    </p>
                  )}
                </div>
                <div className="connection-actions">
                  <button
                    className="button primary"
                    disabled={!!busy || !c.configured}
                    onClick={() => sync(c.id)}
                  >
                    {busy === c.id ? (
                      <Loader2 className="spin" size={15} />
                    ) : (
                      <RefreshCw size={15} />
                    )}
                    Synchroniser Vercel
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
        })
      )}
      {edit && (
        <VercelForm
          connection={edit === "new" ? undefined : edit}
          onClose={() => setEdit(null)}
          onSubmit={async (input) => {
            const c = await request(
              edit === "new" ? "vercel" : `vercel/${edit.id}`,
              edit === "new" ? "POST" : "PATCH",
              input,
            );
            setState(await request("vercel"));
            setEdit(null);
            await sync(c.id);
          }}
        />
      )}
      {inspect && (
        <Modal
          wide
          title={inspect.name}
          description={`Relevé du ${formatDate(inspect.observedAt)}`}
          onClose={() => !busy && setInspect(null)}
        >
          <VercelFacts item={inspect} />
          <p className="vercel-client-preview">
            {inspect.clientSuggestion
              ? `L’ajout créera la fiche et l’associera au client ${inspect.clientSuggestion}.`
              : "Le projet sera ajouté sans client ; vous pourrez le renseigner dans sa fiche."}
          </p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button
              className="button secondary"
              disabled={!!busy}
              onClick={() => setInspect(null)}
            >
              Fermer
            </button>
            <button
              className="button primary"
              disabled={!!busy || !!inspect.missingSince}
              onClick={() => add(inspect)}
            >
              Ajouter au parc
            </button>
          </div>
        </Modal>
      )}
      {link && (
        <VercelLinkForm
          item={link}
          projects={projects}
          onClose={() => setLink(null)}
          onSubmit={async (projectId) => {
            setState(
              await request(
                `vercel/${link.connectionId}/projects/${link.id}/link`,
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
          title="Déconnecter Vercel de Vigie"
          description="Le secret sera retiré de Vigie, les relevés conservés. Le jeton restera actif chez Vercel jusqu’à son expiration ou sa révocation dans les paramètres Vercel."
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
                    await request(`vercel/${disconnect.id}/token`, "DELETE"),
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
function VercelForm({
  connection,
  onClose,
  onSubmit,
}: {
  connection?: VercelConnection;
  onClose: () => void;
  onSubmit: (value: unknown) => Promise<void>;
}) {
  const [name, setName] = useState(connection?.name || "Vercel"),
    [teamId, setTeam] = useState(connection?.teamId || ""),
    [secret, setSecret] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal
      title={connection ? "Accès Vercel" : "Connecter une équipe Vercel"}
      description="Vigie lit les projets et déploiements. L’ajout au parc reste votre choix."
      onClose={() => !busy && onClose()}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await onSubmit({ name, teamId, secret: secret || undefined });
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
            label="Identifiant de l’équipe"
            hint="Team ID dans Vercel → paramètres de l’équipe → General."
          >
            <input
              required
              readOnly={!!connection}
              value={teamId}
              onChange={(e) => setTeam(e.target.value)}
              placeholder="team_…"
            />
          </Field>
          <Field
            label="Jeton Vercel"
            span
            hint={
              connection?.configured
                ? "Laissez vide pour conserver le jeton actuel."
                : "Utilisez un jeton limité à l’équipe. Il sera chiffré sur le serveur de Vigie."
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
          Le jeton permet aussi des écritures ; le connecteur utilise uniquement
          des lectures.{" "}
          <OutLink href="https://vercel.com/account/settings/tokens">
            Gérer les jetons Vercel
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
            {busy ? "Connexion…" : "Enregistrer et découvrir"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function VercelLinkForm({
  item,
  projects,
  onClose,
  onSubmit,
}: {
  item: VercelProjectView;
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
      description={
        item.clientSuggestion
          ? `Client prévu : ${item.clientSuggestion}. Un client déjà renseigné sur la fiche sera conservé.`
          : "Le client déjà renseigné sur la fiche sera conservé."
      }
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
            disabled={busy}
            onClick={onClose}
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
function Deployment({
  value,
  production = false,
}: {
  value: VercelDeployment;
  production?: boolean;
}) {
  const source = value.repository
    ? `https://github.com/${value.repository}${value.commit ? `/tree/${value.commit}` : ""}`
    : null;
  return (
    <div className="vercel-deployment">
      <div className="vercel-deployment-heading">
        <strong>
          {production
            ? "Production désignée par Vercel"
            : "Dernier déploiement"}
        </strong>
        <span className={`badge ${tone(value.state)}`}>
          {labels[value.state] || value.state}
        </span>
      </div>
      <p>
        {formatDate(value.createdAt)} · {value.target || "preview"} ·{" "}
        {value.id.slice(0, 16)}
      </p>
      {value.url && (
        <OutLink href={value.url}>{new URL(value.url).hostname}</OutLink>
      )}
      <dl className="vercel-facts">
        <div>
          <dt>Code de ce déploiement</dt>
          <dd>
            {source ? (
              <OutLink href={source}>{value.repository}</OutLink>
            ) : (
              "Dépôt non communiqué"
            )}
            {value.branch && <small>Branche : {value.branch}</small>}
            {value.commit && (
              <code title={value.commit}>{value.commit.slice(0, 10)}</code>
            )}
          </dd>
        </div>
        <div>
          <dt>Framework du déploiement</dt>
          <dd>{value.framework || "Non communiqué"}</dd>
        </div>
        <div>
          <dt>Branche Node du déploiement</dt>
          <dd>
            {value.nodeBranch || "Non communiquée"}
            {value.nodeBranch && (
              <span
                className={`badge ${value.nodeRelease?.supported === false ? "warning" : "neutral"}`}
              >
                {value.nodeRelease?.supported === false
                  ? "Fin de support officiel"
                  : value.nodeRelease?.supported === true
                    ? "Branche supportée"
                    : "Support à vérifier"}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>Régions</dt>
          <dd>{value.regions.join(", ") || "Non communiquées"}</dd>
        </div>
        {value.rootDirectory && (
          <div>
            <dt>Répertoire déployé</dt>
            <dd>{value.rootDirectory}</dd>
          </div>
        )}
      </dl>
      {value.nodeRelease?.latestLts && (
        <p className="subtle">
          Dernière LTS Node publiée : {value.nodeRelease.latestLts} · fin du
          support de cette branche :{" "}
          {value.nodeRelease.supportEndsAt || "inconnue"}.
        </p>
      )}
      {value.nodeRelease?.supported === false && (
        <p className="vercel-notice">
          Support Node terminé le {value.nodeRelease.supportEndsAt}.{" "}
          {value.nodeRelease.latestLts &&
            `Dernière LTS : ${value.nodeRelease.latestLts}.`}
        </p>
      )}
      {production && <BuildAnalysis value={value} />}
    </div>
  );
}
function BuildAnalysis({ value }: { value: VercelDeployment }) {
  const a = value.analysis;
  return (
    <div className="vercel-analysis">
      <h3>Technologies et versions</h3>
      {!a ? (
        <p className="subtle">
          Synchronisez Vercel pour analyser ce déploiement.
        </p>
      ) : (
        <>
          <dl className="vercel-facts">
            <div>
              <dt>Langages</dt>
              <dd>
                {a.languages.join(" · ") || "Non déterminés"}
                <small>
                  Identification à partir des fonctions et du build ; le code
                  source complet n’est pas analysé.
                </small>
              </dd>
            </div>
            <div>
              <dt>Exécution des fonctions</dt>
              <dd>
                {a.runtimes.length
                  ? a.runtimes.map((r) => (
                      <div key={r.name}>
                        {r.name} · {r.functions} fonction
                        {r.functions > 1 ? "s" : ""}
                      </div>
                    ))
                  : "Aucun moteur communiqué par Vercel"}
              </dd>
            </div>
          </dl>
          {(a.status === "unavailable" || a.refreshFailed) && (
            <p className="vercel-notice">
              Journaux de build indisponibles.
              {a.refreshFailed
                ? ` Dernière analyse conservée du ${formatDate(a.checkedAt)}.`
                : " Les versions du build ne peuvent pas être confirmées."}
            </p>
          )}
          {!!a.technologies.length && (
            <div className="vercel-table-wrap">
              <table className="vercel-technologies">
                <thead>
                  <tr>
                    <th>Composant</th>
                    <th>Version observée</th>
                    <th>Dernière stable</th>
                    <th>Comparaison</th>
                  </tr>
                </thead>
                <tbody>
                  {a.technologies.map((t) => (
                    <tr key={`${t.name}:${t.version}`}>
                      <td>
                        <strong>{t.name}</strong>
                        <small>
                          {t.usage === "framework"
                            ? "Framework"
                            : t.usage === "tool"
                              ? "Outil de build"
                              : t.usage === "build"
                                ? "Compilation"
                                : "Dépendance"}
                        </small>
                      </td>
                      <td>
                        <code>{t.version}</code>
                      </td>
                      <td>
                        {t.latestVersion ? (
                          <OutLink
                            href={`https://www.npmjs.com/package/${t.name}/v/${t.latestVersion}`}
                          >
                            {t.latestVersion}
                          </OutLink>
                        ) : (
                          "Non vérifiée"
                        )}
                      </td>
                      <td>
                        <span
                          className={`badge ${t.update === "available" ? "warning" : "neutral"}`}
                        >
                          {t.update === "available"
                            ? t.version.split(".")[0] !==
                              t.latestVersion?.split(".")[0]
                              ? "Nouvelle majeure"
                              : "Version plus récente"
                            : t.update === "current"
                              ? "Dernière stable"
                              : t.update === "ahead"
                                ? "Version supérieure au catalogue"
                                : "À vérifier"}
                        </span>
                        {t.checkedAt && (
                          <small>Vérifié le {formatDate(t.checkedAt)}</small>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {a.status === "observed" && !a.technologies.length && (
            <p className="subtle">
              Aucune version reconnue dans les journaux disponibles.
            </p>
          )}
          {a.truncated && (
            <p className="vercel-notice">
              Analyse limitée aux 1 000 premiers événements du build.
            </p>
          )}
          <p className="connection-footnote">
            Versions observées dans le build de ce déploiement, sans inventaire
            exhaustif des dépendances ni preuve du correctif Node exécuté. Une
            nouvelle version stable peut nécessiter une migration ; ce statut ne
            constitue pas un audit de vulnérabilités.
          </p>
        </>
      )}
    </div>
  );
}
function VercelFacts({ item }: { item: VercelProjectView }) {
  return (
    <div className="vercel-details">
      <dl className="vercel-facts">
        <div>
          <dt>Équipe</dt>
          <dd>
            <OutLink href={`https://vercel.com/${item.teamSlug}/${item.name}`}>
              {item.teamName} / {item.name}
            </OutLink>
          </dd>
        </div>
        <div>
          <dt>Configuration des prochains déploiements</dt>
          <dd>
            {item.framework || "Framework non renseigné"}
            {item.nodeBranch && ` · Node ${item.nodeBranch}`}
            {item.rootDirectory && (
              <small>Répertoire : {item.rootDirectory}</small>
            )}
          </dd>
        </div>
        <div>
          <dt>Dépôt configuré</dt>
          <dd>
            {item.repository ? (
              <OutLink href={`https://github.com/${item.repository}`}>
                {item.repository}
              </OutLink>
            ) : (
              "Aucun dépôt communiqué"
            )}
            {item.productionBranch && (
              <small>Branche de production : {item.productionBranch}</small>
            )}
          </dd>
        </div>
        <div>
          <dt>Domaines</dt>
          <dd>
            {item.domains.length
              ? item.domains.map((d) => (
                  <div key={d.name}>
                    <OutLink href={`https://${d.name}`}>{d.name}</OutLink>
                    <small>
                      {d.environment}
                      {!d.verified ? " · non vérifié" : ""}
                      {d.redirect ? ` · redirection vers ${d.redirect}` : ""}
                    </small>
                  </div>
                ))
              : "Aucun domaine renseigné"}
          </dd>
        </div>
      </dl>
      {item.production ? (
        <>
          {((item.repository &&
            item.production.repository &&
            item.repository !== item.production.repository) ||
            (item.nodeBranch &&
              item.production.nodeBranch &&
              item.nodeBranch !== item.production.nodeBranch)) && (
            <p className="vercel-notice">
              La configuration actuelle diffère de la production : dépôt ou
              branche Node modifiés depuis ce déploiement.
            </p>
          )}
          <Deployment value={item.production} production />
        </>
      ) : (
        <p className="vercel-notice">
          Aucun déploiement de production désigné par Vercel. Un aperçu prêt ne
          suffit pas à confirmer une production.
        </p>
      )}
      {item.latest && item.latest.id !== item.production?.id && (
        <Deployment value={item.latest} />
      )}
      <p className="connection-footnote">
        Vercel expose la branche Node et gère ses correctifs mineurs. Le numéro
        de correctif exécuté et l’inventaire complet des dépendances ne sont pas confirmés par ce
        relevé. « Branche supportée » ne signifie pas « correctif vérifié ».{" "}
        <OutLink href="https://vercel.com/docs/functions/runtimes/node-js/node-js-versions">
          Politique Node de Vercel
        </OutLink>
      </p>
    </div>
  );
}
export function VercelInventoryPanel({
  item,
  request,
  onRefresh,
}: {
  item: VercelProjectView;
  request: RequestApi;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    stale = Date.now() - Date.parse(item.observedAt) > 24 * 3600_000;
  return (
    <section className="panel vercel-inventory">
      <div className="panel-heading">
        <div>
          <h2>Vercel · {item.name}</h2>
          <p>Relevé du {formatDate(item.observedAt)}</p>
        </div>
        <button
          className="button secondary"
          disabled={busy || !item.configured}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await request(`vercel/${item.connectionId}/sync`, "POST", {});
            } catch (e) {
              setError((e as Error).message);
            } finally {
              await onRefresh().catch(() => {});
              setBusy(false);
            }
          }}
        >
          {busy ? (
            <Loader2 className="spin" size={14} />
          ) : (
            <RefreshCw size={14} />
          )}
          Actualiser
        </button>
      </div>
      <div className="connection-body">
        {(error || item.connectionError) && (
          <p className="form-error" role="alert">
            {error || item.connectionError}
          </p>
        )}
        {!item.configured && (
          <p className="vercel-notice">
            Connexion déconnectée, relevé non actualisé.
          </p>
        )}
        {item.missingSince && (
          <p className="vercel-notice">
            Projet absent du dernier relevé depuis le{" "}
            {formatDate(item.missingSince)}. Les informations précédentes sont
            conservées.
          </p>
        )}
        {stale && (
          <p className="vercel-notice">
            Ce relevé a plus de 24 heures. Actualisez-le pour vérifier la
            situation.
          </p>
        )}
        <VercelFacts item={item} />
      </div>
    </section>
  );
}
