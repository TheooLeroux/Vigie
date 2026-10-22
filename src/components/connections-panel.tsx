"use client";
import { useEffect, useState } from "react";
import {
  AlertCircle,
  Check,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Unplug,
} from "lucide-react";
import type { HostingConnection, Project, HostingDiscovery } from "@/lib/types";
import { EmptyState, Field, formatDate, Modal, OutLink } from "./ui";
import { HostingDiscoveryPanel } from "./hosting-discovery-panel";
import { RailwayConnectionsPanel } from "./railway-panel";
import { VercelConnectionsPanel } from "./vercel-panel";

type RequestApi = (
  path: string,
  method?: string,
  payload?: unknown,
) => Promise<any>;
const labels = {
  unconfigured: "À configurer",
  untested: "À vérifier",
  connected: "Connecté",
  error: "Échec de connexion",
};
export function ConnectionsPanel({
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
  const [connections, setConnections] = useState<HostingConnection[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [provider, setProvider] = useState("o2switch");
  const [edit, setEdit] = useState<HostingConnection | "new" | null>(null),
    [discoveries, setDiscoveries] = useState<Record<string, HostingDiscovery>>(
      {},
    ),
    [busy, setBusy] = useState<string | null>(null),
    [disconnect, setDisconnect] = useState<HostingConnection | null>(null);
  async function reload() {
    const data = await request("connections");
    setConnections(data.connections);
    setDiscoveries(data.discoveries);
  }
  useEffect(() => {
    let cancelled = false;
    request("connections")
      .then((data) => {
        if (!cancelled) {
          setConnections(data.connections);
          setDiscoveries(data.discoveries);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [request]);
  async function synchronize(connection: HostingConnection) {
    setBusy(connection.id);
    setError("");
    try {
      const updated = await request(
        `connections/${connection.id}/discover`,
        "POST",
        {},
      );
      setConnections((previous) =>
        previous.map((c) =>
          c.id === updated.connection.id ? updated.connection : c,
        ),
      );
      setDiscoveries((previous) => ({
        ...previous,
        [connection.id]: updated.discovery,
      }));
      const inventory = await request(
        `connections/${connection.id}/inventory`,
        "POST",
        {},
      );
      setDiscoveries((previous) => ({
        ...previous,
        [connection.id]: inventory.discovery,
      }));
      await onRefresh();
    } catch (e) {
      setError((e as Error).message);
      await reload().catch(() => {});
    } finally {
      setBusy(null);
    }
  }
  return (
    <>
      <div
        className="connection-providers"
        role="group"
        aria-label="Choisir un hébergeur"
      >
        {[
          { name: "o2switch", description: "Sites & WordPress", mark: "o₂" },
          {
            name: "Vercel",
            description: "Applications & déploiements",
            mark: "▲",
          },
          {
            name: "Railway",
            description: "Services & environnements",
            mark: "R",
          },
        ].map((item) => (
          <button
            key={item.name}
            aria-pressed={provider === item.name}
            className={provider === item.name ? "active" : ""}
            onClick={() => setProvider(item.name)}
          >
            <span className="connection-provider-mark" aria-hidden="true">
              {item.mark}
            </span>
            <span>
              <strong>{item.name}</strong>
              <small>{item.description}</small>
            </span>
          </button>
        ))}
      </div>
      <div hidden={provider !== "Vercel"}>
        <VercelConnectionsPanel
          request={request}
          projects={projects}
          onProject={onProject}
          onRefresh={onRefresh}
        />
      </div>
      <div hidden={provider !== "Railway"}>
        <RailwayConnectionsPanel
          request={request}
          projects={projects}
          onProject={onProject}
          onRefresh={onRefresh}
        />
      </div>
      <div hidden={provider !== "o2switch"}>
        <div className="connections-intro">
          <div>
            <h2 className="provider-heading">o2switch</h2>
            <p>
              Reliez les comptes d’hébergement pour vérifier l’accès et lire
              leurs sites. Les fiches reconnues sont rattachées automatiquement.
            </p>
          </div>
          <button className="button primary" onClick={() => setEdit("new")}>
            <Plus size={16} />
            Ajouter un compte o2switch
          </button>
        </div>
        {error && (
          <p className="form-error" role="alert">
            <AlertCircle size={16} />
            {error}
          </p>
        )}
        {loading ? (
          <div className="loading">
            <Loader2 className="spin" size={20} />
            Chargement des connexions…
          </div>
        ) : !connections.length ? (
          <section className="panel">
            <EmptyState
              icon={Server}
              title="Aucun compte connecté"
              description="Ajoutez l’adresse du cPanel, l’identifiant du compte et un jeton API."
            />
          </section>
        ) : (
          <div className="connections-list">
            {connections.map((connection) => {
              return (
                <section className="panel connection-card" key={connection.id}>
                  <div className="panel-heading">
                    <div className="connection-title">
                      <span className="client-avatar">
                        <Server size={18} />
                      </span>
                      <div>
                        <h2>{connection.name}</h2>
                        <p>
                          {new URL(connection.endpoint).hostname} ·{" "}
                          {connection.username}
                        </p>
                      </div>
                    </div>
                    <span
                      className={`badge ${connection.status === "connected" ? "sage" : connection.status === "error" ? "warning" : "neutral"}`}
                    >
                      {connection.status === "connected" && <Check size={12} />}
                      {labels[connection.status]}
                    </span>
                  </div>
                  <div className="connection-body">
                    {connection.error && (
                      <div className="connection-error" role="alert">
                        <AlertCircle size={17} />
                        <p>
                          {connection.error.message}
                          {connection.error.httpStatus && (
                            <small>
                              Réponse HTTP {connection.error.httpStatus}
                            </small>
                          )}
                        </p>
                      </div>
                    )}
                    {!connection.configured && (
                      <p className="subtle">
                        Renseignez un jeton API cPanel pour ce compte.
                      </p>
                    )}
                    <dl className="connection-meta">
                      <div>
                        <dt>Accès enregistré</dt>
                        <dd>
                          {connection.configured
                            ? connection.authMode === "token"
                              ? "Jeton API chiffré"
                              : "Mot de passe chiffré"
                            : "Aucun secret"}
                        </dd>
                      </div>
                      <div>
                        <dt>Dernière tentative</dt>
                        <dd>
                          {connection.lastCheckedAt
                            ? formatDate(connection.lastCheckedAt)
                            : "Pas encore testée"}
                        </dd>
                      </div>
                      <div>
                        <dt>Dernier accès réussi</dt>
                        <dd>
                          {connection.lastSuccessAt
                            ? formatDate(connection.lastSuccessAt)
                            : "Aucun"}
                        </dd>
                      </div>
                    </dl>
                    <HostingDiscoveryPanel
                      discovery={discoveries[connection.id]}
                      projects={projects}
                      request={request}
                      onProject={onProject}
                      disabled={busy !== null}
                      onChanged={async (next) => {
                        setDiscoveries((previous) => ({
                          ...previous,
                          [connection.id]: next,
                        }));
                        await onRefresh();
                      }}
                    />
                  </div>
                  <div className="connection-actions">
                    <OutLink href={connection.endpoint}>Ouvrir cPanel</OutLink>
                    <div className="heading-actions">
                      {connection.configured && (
                        <button
                          className="icon-button"
                          title="Retirer le secret de Vigie"
                          aria-label={`Déconnecter ${connection.name}`}
                          onClick={() => setDisconnect(connection)}
                          disabled={busy !== null}
                        >
                          <Unplug size={17} />
                        </button>
                      )}
                      <button
                        className="button secondary"
                        onClick={() => setEdit(connection)}
                        disabled={busy !== null}
                      >
                        <Pencil size={14} />
                        {connection.configured
                          ? "Configurer"
                          : "Renseigner le jeton"}
                      </button>
                      <button
                        className="button primary"
                        onClick={() => synchronize(connection)}
                        disabled={!connection.configured || busy !== null}
                      >
                        {busy === connection.id ? (
                          <Loader2 className="spin" size={15} />
                        ) : (
                          <RefreshCw size={15} />
                        )}
                        {busy === connection.id
                          ? "Synchronisation…"
                          : discoveries[connection.id]?.lastSuccessAt
                            ? "Synchroniser les sites"
                            : "Rechercher les sites"}
                      </button>
                    </div>
                  </div>
                </section>
              );
            })}
          </div>
        )}
        <p className="connection-footnote">
          Les sites déjà connus sont rattachés automatiquement. Les nouvelles
          installations sont proposées à l’ajout. Le rattachement d’un WordPress
          installe son connecteur de lecture et lance le premier relevé.
        </p>
      </div>
      {edit && (
        <ConnectionForm
          connection={edit === "new" ? undefined : edit}
          onClose={() => setEdit(null)}
          onSubmit={async (input) => {
            const saved = await request(
              edit === "new" ? "connections" : `connections/${edit.id}`,
              edit === "new" ? "POST" : "PATCH",
              input,
            );
            await reload();
            setEdit(null);
            if (input.secret || edit === "new") await synchronize(saved);
          }}
        />
      )}
      {disconnect && (
        <Modal
          title={`Déconnecter ${disconnect.name}`}
          description="Le secret sera retiré de Vigie. Le jeton restera actif chez o2switch jusqu’à sa révocation dans cPanel."
          onClose={() => !busy && setDisconnect(null)}
        >
          <div className="modal-actions">
            <button
              className="button secondary"
              disabled={busy !== null}
              onClick={() => setDisconnect(null)}
            >
              Annuler
            </button>
            <button
              className="button primary"
              disabled={busy !== null}
              onClick={async () => {
                setBusy(disconnect.id);
                try {
                  await request(`connections/${disconnect.id}`, "DELETE");
                  await reload();
                  setDisconnect(null);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(null);
                }
              }}
            >
              Retirer le secret
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
function ConnectionForm({
  connection,
  onSubmit,
  onClose,
}: {
  connection?: HostingConnection;
  onSubmit: (input: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}) {
  const [mode, setMode] = useState(connection?.authMode || "token"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal
      title={
        connection
          ? `Configurer ${connection.name}`
          : "Ajouter un compte o2switch"
      }
      onClose={() => !busy && onClose()}
      wide
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const input = Object.fromEntries(new FormData(event.currentTarget));
          setBusy(true);
          setError("");
          try {
            await onSubmit(input);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-grid">
          <Field label="Nom du compte *">
            <input
              name="name"
              required
              maxLength={100}
              defaultValue={connection?.name}
              placeholder="o2switch 1"
            />
          </Field>
          <Field label="Adresse du cPanel *">
            <input
              name="endpoint"
              type="url"
              required
              defaultValue={connection?.endpoint}
              placeholder="https://serveur.o2switch.net:2083"
            />
          </Field>
          <Field label="Identifiant cPanel *">
            <input
              name="username"
              autoComplete="off"
              required
              maxLength={32}
              defaultValue={connection?.username}
            />
          </Field>
          <Field label="Méthode">
            <select
              name="authMode"
              value={mode}
              onChange={(e) => setMode(e.target.value as "token" | "password")}
            >
              <option value="token">Jeton API cPanel</option>
              <option value="password">Mot de passe cPanel</option>
            </select>
          </Field>
          <Field
            label={mode === "token" ? "Jeton API" : "Mot de passe"}
            hint={
              connection?.configured
                ? "Laissez vide pour conserver le secret enregistré avec le même compte et la même méthode."
                : "Le secret est chiffré côté serveur et ne sera jamais réaffiché."
            }
            span
          >
            <input
              name="secret"
              type="password"
              autoComplete="new-password"
              required={!connection?.configured || connection.authMode !== mode}
              maxLength={4096}
            />
          </Field>
          {mode === "token" && (
            <div className="connection-guide span-2">
              <KeyRound size={18} />
              <div>
                <strong>Dans cPanel → Sécurité → Manage API Tokens</strong>
                <p>
                  Créez un jeton « vigie-local », puis collez sa valeur ici.
                  Utilisez l’identifiant cPanel affiché dans les informations
                  générales du compte.
                </p>
                <OutLink href="https://faq.o2switch.fr/cpanel/securite/token-api-cpanel/">
                  Voir le guide o2switch
                </OutLink>
              </div>
            </div>
          )}
        </div>
        {error && (
          <p className="form-error" role="alert">
            <AlertCircle size={16} />
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
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? (
              <Loader2 className="spin" size={15} />
            ) : (
              <Check size={15} />
            )}
            Enregistrer
          </button>
        </div>
      </form>
    </Modal>
  );
}
