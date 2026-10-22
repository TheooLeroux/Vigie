"use client";
import { useState, type FormEvent } from "react";
import {
  Upload,
  Plus,
  Trash2,
  FileJson,
  Check,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { Field, Modal } from "./ui";
import type {
  Project,
  ProjectDetail,
  Resource,
  WorkspaceData,
  Service,
  Client,
} from "@/lib/types";

const technologies = [
  "WordPress",
  "Next.js",
  "React",
  "Node.js",
  "PHP",
  "Laravel",
  "Symfony",
  "HTML / CSS",
  "Astro",
  "Nuxt",
  "Vue.js",
  "Python",
  "Autre",
];
const providers = ["o2switch", "Vercel", "Railway", "Autre"];
type Submit = (data: Record<string, unknown>) => Promise<void>;
function values(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  return Object.fromEntries(new FormData(event.currentTarget));
}
function Actions({
  onClose,
  busy,
  label = "Enregistrer",
}: {
  onClose: () => void;
  busy: boolean;
  label?: string;
}) {
  return (
    <div className="modal-actions">
      <button
        type="button"
        className="button secondary"
        onClick={onClose}
        disabled={busy}
      >
        Annuler
      </button>
      <button className="button primary" type="submit" disabled={busy}>
        {busy ? <Loader2 className="spin" size={16} /> : <Check size={16} />}{" "}
        {label}
      </button>
    </div>
  );
}
function FormError({ error }: { error: string }) {
  return error ? (
    <p className="form-error" role="alert">
      <AlertCircle size={16} />
      {error}
    </p>
  ) : null;
}
export function ProjectForm({
  project,
  clients,
  defaultClientId,
  onCreateClient,
  onSubmit,
  onClose,
  onBack,
}: {
  project?: Project;
  clients: Client[];
  defaultClientId?: string;
  onCreateClient: (input: Record<string, unknown>) => Promise<Client>;
  onSubmit: Submit;
  onClose: () => void;
  onBack?: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [clientId, setClientId] = useState(
    project?.clientId || defaultClientId || "",
  );
  const [newClientName, setNewClientName] = useState("");
  const [localClients, setLocalClients] = useState<Client[]>([]);
  async function addClient() {
    setBusy(true);
    setError("");
    try {
      const client = await onCreateClient({ name: newClientName });
      setLocalClients((previous) => [...previous, client]);
      setClientId(client.id);
      setNewClientName("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    const v = values(e);
    if (clientId === "__new") {
      setError("Créez le client avant d’enregistrer le projet.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onSubmit({
        ...v,
        clientId: clientId || null,
        tags: String(v.tags || "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={project ? "Modifier le projet" : "Créer un projet de zéro"}
      description={
        project
          ? "Mettez à jour les informations de référence du projet."
          : "Créez sa fiche dans Vigie. Vous pourrez ensuite rattacher son hébergement depuis Connexions."
      }
      onClose={() => !busy && onClose()}
      wide
    >
      <form onSubmit={submit}>
        {onBack && (
          <button
            type="button"
            className="text-button project-form-back"
            disabled={busy}
            onClick={onBack}
          >
            ← Changer de méthode
          </button>
        )}
        <div className="form-grid">
          <Field label="Nom du projet *">
            <input
              name="name"
              autoFocus
              required
              maxLength={200}
              placeholder="Ex. Site de l’agence"
              defaultValue={project?.name}
            />
          </Field>
          <Field label="URL principale">
            <input
              name="url"
              type="url"
              placeholder="https://exemple.fr"
              defaultValue={project?.url}
            />
          </Field>
          <Field label="Client ou organisation">
            <select
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            >
              <option value="">À rattacher</option>
              {[
                ...clients,
                ...localClients.filter(
                  (c) => !clients.some((existing) => existing.id === c.id),
                ),
              ]
                .sort((a, b) => a.name.localeCompare(b.name, "fr"))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              <option value="__new">+ Créer un client</option>
            </select>
          </Field>
          {clientId === "__new" && (
            <div className="field span-2">
              <label htmlFor="new-client-name">Nom du nouveau client</label>
              <div className="inline-client-create">
                <input
                  id="new-client-name"
                  value={newClientName}
                  onChange={(e) => setNewClientName(e.target.value)}
                  maxLength={200}
                />
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy || !newClientName.trim()}
                  onClick={addClient}
                >
                  Créer le client
                </button>
              </div>
            </div>
          )}
          <Field label="Criticité">
            <select
              name="criticality"
              defaultValue={project?.criticality || "standard"}
            >
              <option value="standard">Standard</option>
              <option value="important">Important</option>
              <option value="critical">Critique</option>
            </select>
          </Field>
          <Field
            label="Étiquettes"
            hint="Séparez les étiquettes par une virgule."
          >
            <input
              name="tags"
              placeholder="Vitrine, E-commerce…"
              defaultValue={project?.tags.join(", ")}
            />
          </Field>
          {!project && (
            <>
              <div className="form-divider span-2">
                <span>Premier service · Production</span>
              </div>
              <Field label="Technologie">
                <select name="technology" defaultValue="">
                  <option value="">À identifier</option>
                  {technologies.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </Field>
              <Field label="Hébergeur">
                <select name="provider" defaultValue="">
                  <option value="">À renseigner</option>
                  {providers.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </Field>
              <Field label="Runtime déclaré">
                <input name="runtime" placeholder="PHP, Node.js…" />
              </Field>
              <Field
                label="Version déclarée"
                hint="Une déclaration ne confirme pas la version en production."
              >
                <input name="version" placeholder="Ex. 24.14.0" />
              </Field>
              <Field label="Dépôt Git" span>
                <input
                  name="repository"
                  type="url"
                  placeholder="https://github.com/organisation/projet"
                />
              </Field>
            </>
          )}
          <Field
            label="Description et notes"
            span
            hint="Conservez les mots de passe et clés dans votre coffre habituel."
          >
            <textarea
              name="description"
              rows={3}
              maxLength={10000}
              placeholder="Rôle du site, particularités, informations utiles…"
              defaultValue={project?.description}
            />
          </Field>
        </div>
        <FormError error={error} />
        <Actions
          onClose={onClose}
          busy={busy}
          label={project ? "Enregistrer les modifications" : "Créer le projet"}
        />
      </form>
    </Modal>
  );
}
export function LinkClientProjectForm({
  client,
  projects,
  onSubmit,
  onClose,
}: {
  client: Client;
  projects: Project[];
  onSubmit: Submit;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const available = projects
    .filter((p) => p.clientId !== client.id)
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));
  return (
    <Modal
      title={`Rattacher un site à ${client.name}`}
      onClose={() => !busy && onClose()}
    >
      <form
        onSubmit={async (e) => {
          const input = values(e);
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
          <Field
            label="Site existant *"
            hint="Si un autre client est indiqué, ce rattachement sera remplacé."
            span
          >
            <select required name="projectId" defaultValue="">
              <option value="" disabled>
                Choisir un site
              </option>
              {available.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.client || "À rattacher"}
                </option>
              ))}
            </select>
          </Field>
          {!available.length && (
            <p className="span-2 subtle">
              Tous les sites du parc sont déjà rattachés à ce client.
            </p>
          )}
        </div>
        <FormError error={error} />
        <Actions onClose={onClose} busy={busy} label="Rattacher le site" />
      </form>
    </Modal>
  );
}
export function ClientForm({
  client,
  onSubmit,
  onClose,
}: {
  client?: Client;
  onSubmit: Submit;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal
      title={client ? "Modifier le client" : "Ajouter un client"}
      description="Une fiche client peut regrouper plusieurs sites et applications."
      onClose={() => !busy && onClose()}
      wide
    >
      <form
        onSubmit={async (e) => {
          const input = values(e);
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
          <Field label="Nom du client *" span>
            <input
              autoFocus
              required
              name="name"
              maxLength={200}
              defaultValue={client?.name}
            />
          </Field>
          <Field label="Contact principal">
            <input
              name="contactName"
              maxLength={200}
              defaultValue={client?.contactName}
            />
          </Field>
          <Field label="Adresse email">
            <input
              name="email"
              type="email"
              maxLength={320}
              defaultValue={client?.email}
            />
          </Field>
          <Field label="Téléphone">
            <input
              name="phone"
              type="tel"
              maxLength={80}
              defaultValue={client?.phone}
            />
          </Field>
          <Field label="Site du client">
            <input
              name="website"
              type="url"
              placeholder="https://"
              defaultValue={client?.website}
            />
          </Field>
          <Field label="Notes" span>
            <textarea
              name="notes"
              rows={4}
              maxLength={10000}
              defaultValue={client?.notes}
            />
          </Field>
        </div>
        <FormError error={error} />
        <Actions
          onClose={onClose}
          busy={busy}
          label={client ? "Enregistrer" : "Créer le client"}
        />
      </form>
    </Modal>
  );
}
export function EnvironmentForm({
  onSubmit,
  onClose,
}: {
  onSubmit: Submit;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal
      title="Ajouter un environnement"
      description="Séparez les informations de production, préproduction et développement."
      onClose={() => !busy && onClose()}
    >
      <form
        onSubmit={async (e) => {
          const v = values(e);
          setBusy(true);
          try {
            await onSubmit(v);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-grid">
          <Field label="Nom *" span>
            <input
              autoFocus
              name="name"
              required
              placeholder="Ex. Préproduction"
            />
          </Field>
          <Field label="Type" span>
            <select name="kind">
              <option value="staging">Préproduction</option>
              <option value="production">Production</option>
              <option value="development">Développement</option>
            </select>
          </Field>
          <Field label="URL" span>
            <input
              name="url"
              type="url"
              placeholder="https://staging.exemple.fr"
            />
          </Field>
        </div>
        <FormError error={error} />
        <Actions onClose={onClose} busy={busy} />
      </form>
    </Modal>
  );
}
export function ServiceForm({
  detail,
  service,
  onSubmit,
  onClose,
}: {
  detail: ProjectDetail;
  service?: Service;
  onSubmit: Submit;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal
      title={service ? "Modifier le service" : "Ajouter un service"}
      description="Un frontend, une API ou un traitement appartient à un environnement précis."
      onClose={() => !busy && onClose()}
      wide
    >
      <form
        onSubmit={async (e) => {
          const v = values(e);
          setBusy(true);
          try {
            await onSubmit(v);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-grid">
          <Field label="Nom du service *">
            <input
              autoFocus
              name="name"
              required
              defaultValue={service?.name}
              placeholder="Ex. API métier"
            />
          </Field>
          <Field label="Environnement">
            <select name="environmentId" defaultValue={service?.environmentId}>
              {detail.environments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Type">
            <select name="kind" defaultValue={service?.kind || "web"}>
              <option value="web">Site / Frontend</option>
              <option value="api">API</option>
              <option value="worker">Traitement / Worker</option>
              <option value="database">Base de données</option>
            </select>
          </Field>
          <Field label="Technologie">
            <input
              name="technology"
              list="technologies"
              defaultValue={service?.technology}
              placeholder="Choisir ou saisir…"
            />
            <datalist id="technologies">
              {technologies.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </datalist>
          </Field>
          <Field label="Hébergeur">
            <input
              name="provider"
              list="providers"
              defaultValue={service?.provider}
              placeholder="Choisir ou saisir…"
            />
            <datalist id="providers">
              {[...providers, "Neon", "Supabase"].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </datalist>
          </Field>
          <Field label="URL du service">
            <input
              name="url"
              type="url"
              defaultValue={service?.url}
              placeholder="https://api.exemple.fr"
            />
          </Field>
          <Field label="Runtime déclaré">
            <input
              name="runtime"
              defaultValue={service?.runtime}
              placeholder="Node.js, PHP…"
            />
          </Field>
          <Field label="Version déclarée">
            <input
              name="version"
              defaultValue={service?.version}
              placeholder="Ex. 8.3.12"
            />
          </Field>
          <Field label="Dépôt Git" span>
            <input
              name="repository"
              type="url"
              defaultValue={service?.repository}
              placeholder="https://github.com/…"
            />
          </Field>
        </div>
        <FormError error={error} />
        <Actions onClose={onClose} busy={busy} />
      </form>
    </Modal>
  );
}
export function AccessForm({
  onSubmit,
  onClose,
}: {
  onSubmit: Submit;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal
      title="Référencer un accès"
      description="Un point d’entrée et une référence à votre coffre, sans stocker de secret ici."
      onClose={() => !busy && onClose()}
      wide
    >
      <form
        onSubmit={async (e) => {
          const v = values(e);
          setBusy(true);
          try {
            await onSubmit(v);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-grid">
          <Field label="Libellé *">
            <input
              autoFocus
              name="label"
              required
              placeholder="Administration WordPress"
            />
          </Field>
          <Field label="Catégorie">
            <select name="kind">
              <option value="admin">Administration</option>
              <option value="hosting">Hébergement</option>
              <option value="git">Dépôt Git</option>
              <option value="database">Base de données</option>
              <option value="vault">Coffre</option>
              <option value="other">Autre</option>
            </select>
          </Field>
          <Field label="URL d’accès" span>
            <input
              name="url"
              type="url"
              placeholder="https://exemple.fr/wp-admin"
            />
          </Field>
          <Field label="Compte à utiliser">
            <input
              name="account"
              placeholder="Ex. Compte agence / adresse e-mail"
            />
          </Field>
          <Field label="Référence au coffre">
            <input
              name="vaultRef"
              placeholder="Coffre équipe / Client / Entrée"
            />
          </Field>
          <Field
            label="Notes"
            span
            hint="N’inscrivez ni mot de passe, ni token, ni chaîne de connexion."
          >
            <textarea
              name="notes"
              rows={3}
              maxLength={3000}
              placeholder="Personne habilitée, procédure d’accès…"
            />
          </Field>
        </div>
        <FormError error={error} />
        <Actions onClose={onClose} busy={busy} />
      </form>
    </Modal>
  );
}
export function ResourceForm({
  projects,
  resource,
  onSubmit,
  onClose,
}: {
  projects: Project[];
  resource?: Resource;
  onSubmit: Submit;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal
      title={resource ? "Modifier la ressource" : "Ajouter une ressource"}
      description="Une base, un stockage ou un service peut être partagé entre plusieurs projets."
      onClose={() => !busy && onClose()}
      wide
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const v = {
            ...Object.fromEntries(f),
            projectIds: f.getAll("projectIds"),
          };
          setBusy(true);
          try {
            await onSubmit(v);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-grid">
          <Field label="Nom *">
            <input
              autoFocus
              required
              name="name"
              defaultValue={resource?.name}
              placeholder="Ex. Base métier"
            />
          </Field>
          <Field label="Type">
            <select name="kind" defaultValue={resource?.kind || "database"}>
              <option value="database">Base de données</option>
              <option value="storage">Stockage</option>
              <option value="email">E-mail</option>
              <option value="other">Autre</option>
            </select>
          </Field>
          <Field label="Fournisseur">
            <input
              name="provider"
              defaultValue={resource?.provider}
              placeholder="Neon, Supabase…"
            />
          </Field>
          <Field label="Identifiant ou référence">
            <input
              name="reference"
              defaultValue={resource?.reference}
              placeholder="ID projet, région, branche…"
            />
          </Field>
          <Field label="Lien vers la console" span>
            <input
              name="url"
              type="url"
              defaultValue={resource?.url}
              placeholder="https://…"
            />
          </Field>
          <fieldset className="checkbox-field span-2">
            <legend>Projets associés</legend>
            <div className="checkbox-list">
              {projects.length ? (
                projects.map((p) => (
                  <label key={p.id}>
                    <input
                      type="checkbox"
                      name="projectIds"
                      value={p.id}
                      defaultChecked={resource?.projectIds.includes(p.id)}
                    />
                    <span>{p.name}</span>
                  </label>
                ))
              ) : (
                <p>Vous pourrez associer un projet après sa création.</p>
              )}
            </div>
          </fieldset>
          <Field label="Notes" span>
            <textarea
              name="notes"
              rows={3}
              defaultValue={resource?.notes}
              placeholder="Informations techniques, sans données de connexion sensibles."
            />
          </Field>
        </div>
        <FormError error={error} />
        <Actions onClose={onClose} busy={busy} />
      </form>
    </Modal>
  );
}
export function InventoryForm({
  detail,
  manual,
  onSubmit,
  onClose,
}: {
  detail: ProjectDetail;
  manual?: boolean;
  onSubmit: Submit;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [file, setFile] = useState<{ filename: string; content: string } | null>(
      null,
    );
  const [rows, setRows] = useState([
    {
      name: "",
      version: "",
      ecosystem: "WordPress",
      scope: "production",
      direct: true,
    },
  ]);
  return (
    <Modal
      title={manual ? "Déclarer un inventaire" : "Importer les dépendances"}
      description={
        manual
          ? "Déclarez les composants connus d’un service. L’inventaire précédent reste dans l’historique."
          : "Analyse locale du fichier, sans installation ni exécution du code du projet."
      }
      onClose={() => !busy && onClose()}
      wide
    >
      <form
        onSubmit={async (e) => {
          const v = values(e);
          setBusy(true);
          setError("");
          try {
            if (manual) await onSubmit({ ...v, components: rows });
            else {
              if (!file)
                throw new Error("Sélectionnez un fichier de verrouillage.");
              await onSubmit({ ...v, ...file });
            }
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-grid">
          <Field label="Service concerné" span>
            <select name="serviceId">
              {detail.services.map((s) => (
                <option value={s.id} key={s.id}>
                  {s.name} ·{" "}
                  {
                    detail.environments.find((e) => e.id === s.environmentId)
                      ?.name
                  }
                </option>
              ))}
            </select>
          </Field>
          {manual ? (
            <div className="span-2 manual-rows">
              {rows.map((row, i) => (
                <div className="manual-row" key={i}>
                  <input
                    aria-label={`Composant ${i + 1}`}
                    required
                    placeholder="Composant"
                    value={row.name}
                    onChange={(e) =>
                      setRows(
                        rows.map((r, n) =>
                          n === i ? { ...r, name: e.target.value } : r,
                        ),
                      )
                    }
                  />
                  <input
                    aria-label={`Version ${i + 1}`}
                    required
                    placeholder="Version"
                    value={row.version}
                    onChange={(e) =>
                      setRows(
                        rows.map((r, n) =>
                          n === i ? { ...r, version: e.target.value } : r,
                        ),
                      )
                    }
                  />
                  <select
                    aria-label={`Écosystème ${i + 1}`}
                    value={row.ecosystem}
                    onChange={(e) =>
                      setRows(
                        rows.map((r, n) =>
                          n === i ? { ...r, ecosystem: e.target.value } : r,
                        ),
                      )
                    }
                  >
                    {[
                      "WordPress",
                      "WordPress plugin",
                      "WordPress theme",
                      "Runtime",
                      "npm",
                      "Packagist",
                      "Autre",
                    ].map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                  {rows.length > 1 && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Retirer le composant ${i + 1}`}
                      onClick={() => setRows(rows.filter((_, n) => n !== i))}
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              ))}
              <button
                className="button secondary small"
                type="button"
                onClick={() =>
                  setRows([
                    ...rows,
                    {
                      name: "",
                      version: "",
                      ecosystem: "WordPress plugin",
                      scope: "production",
                      direct: true,
                    },
                  ])
                }
              >
                <Plus size={14} />
                Ajouter un composant
              </button>
            </div>
          ) : (
            <>
              <label className="file-drop span-2">
                <input
                  type="file"
                  accept=".json,.lock"
                  onChange={async (e) => {
                    setError("");
                    const f = e.target.files?.[0];
                    if (!f) return;
                    if (f.size > 5_000_000) {
                      setError("Le fichier dépasse 5 Mo.");
                      return;
                    }
                    setFile({ filename: f.name, content: await f.text() });
                  }}
                />
                <span className="file-drop-icon">
                  {file ? <FileJson size={27} /> : <Upload size={27} />}
                </span>
                <strong>
                  {file ? file.filename : "Choisir un fichier de verrouillage"}
                </strong>
                <span>
                  package-lock.json, npm-shrinkwrap.json ou composer.lock · 5 Mo
                  max.
                </span>
              </label>
              <Field
                label="Commit associé (facultatif)"
                span
                hint="Le commit aide à relier cet inventaire au build. Il ne prouve pas à lui seul un déploiement."
              >
                <input
                  name="commitRef"
                  placeholder="SHA du commit"
                  maxLength={120}
                />
              </Field>
            </>
          )}
          <div className="notice span-2">
            {manual
              ? "Cet inventaire sera marqué « Déclaré ». Il remplacera la vue courante de ce service, sans supprimer l’historique."
              : "Les versions seront marquées « Résolues dans le fichier ». La version réellement en production reste à confirmer. L’import remplace la vue courante du service et conserve les inventaires précédents."}
          </div>
        </div>
        <FormError error={error} />
        <Actions
          onClose={onClose}
          busy={busy}
          label={manual ? "Enregistrer l’inventaire" : "Importer l’inventaire"}
        />
      </form>
    </Modal>
  );
}
export function ImportProjectsForm({
  request,
  onDone,
  onClose,
}: {
  request: (path: string, data: unknown) => Promise<any>;
  onDone: () => Promise<void>;
  onClose: () => void;
}) {
  const [file, setFile] = useState<{
      filename: string;
      content: string;
    } | null>(null),
    [preview, setPreview] = useState<{
      count: number;
      skipped: number;
      projects: Record<string, string>[];
    } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function previewFile() {
    setBusy(true);
    setError("");
    try {
      if (!file) throw new Error("Sélectionnez un fichier.");
      setPreview(await request("import/preview", file));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Importer des projets"
      description="Ajoutez votre parc depuis un CSV ou un export d’inventaire Vigie. Aucun projet existant n’est écrasé."
      onClose={() => !busy && onClose()}
      wide
    >
      <div className="import-body">
        {!preview ? (
          <>
            <label className="file-drop">
              <input
                type="file"
                accept=".csv,.json"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  setError("");
                  if (!f) return;
                  if (f.size > 5_000_000) {
                    setError("Le fichier dépasse 5 Mo.");
                    return;
                  }
                  setFile({ filename: f.name, content: await f.text() });
                }}
              />
              <span className="file-drop-icon">
                <Upload size={28} />
              </span>
              <strong>
                {file?.filename || "Choisir un fichier CSV ou JSON"}
              </strong>
              <span>Jusqu’à 1 000 projets · 5 Mo max.</span>
            </label>
            <div className="import-help">
              <strong>Format CSV</strong>
              <p>
                Colonne obligatoire : <code>name</code> ou <code>nom</code>.
                Colonnes facultatives : <code>url</code>, <code>client</code>,{" "}
                <code>technology</code>, <code>provider</code>,{" "}
                <code>runtime</code>, <code>version</code>,{" "}
                <code>repository</code>, <code>description</code>.
              </p>
              <a href="/modele-import.csv" download>
                Télécharger le modèle CSV
              </a>
            </div>
          </>
        ) : (
          <>
            <div className="import-summary">
              <Check size={24} />
              <div>
                <strong>
                  {preview.count} projet{preview.count > 1 ? "s" : ""} à ajouter
                </strong>
                <p>
                  {preview.skipped
                    ? `${preview.skipped} doublon(s) ignoré(s).`
                    : "Le fichier est valide. Vérifiez l’aperçu avant de confirmer."}
                </p>
              </div>
            </div>
            <div className="preview-list">
              {preview.projects.slice(0, 20).map((p, i) => (
                <div key={i}>
                  <strong>{p.name}</strong>
                  <span>{p.url || "Sans URL"}</span>
                </div>
              ))}
              {preview.projects.length > 20 && (
                <p>Et {preview.projects.length - 20} autres projets.</p>
              )}
            </div>
            <button className="text-button" onClick={() => setPreview(null)}>
              Choisir un autre fichier
            </button>
          </>
        )}
        <FormError error={error} />
      </div>
      <div className="modal-actions">
        <button className="button secondary" onClick={onClose} disabled={busy}>
          Annuler
        </button>
        {preview ? (
          <button
            className="button primary"
            disabled={busy || !preview.count}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await request("import/confirm", file);
                await onDone();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? (
              <Loader2 size={15} className="spin" />
            ) : (
              <Check size={15} />
            )}
            Confirmer l’import
          </button>
        ) : (
          <button
            className="button primary"
            disabled={busy || !file}
            onClick={previewFile}
          >
            {busy ? (
              <Loader2 size={15} className="spin" />
            ) : (
              <Upload size={15} />
            )}
            Vérifier le fichier
          </button>
        )}
      </div>
    </Modal>
  );
}
