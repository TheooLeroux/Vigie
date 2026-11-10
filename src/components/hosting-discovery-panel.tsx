"use client";
import { useState } from "react";
import { AlertCircle, Check, Loader2, Plus, Search } from "lucide-react";
import type {
  HostingDiscovery,
  HostingInstallationView,
  Project,
} from "@/lib/types";
import { formatDate, Modal } from "./ui";
import { RecordLink } from "./record-link";

export const installationLabels: Record<
  HostingInstallationView["kind"],
  string
> = {
  wordpress: "WordPress",
  "wordpress-incomplete": "WordPress à vérifier",
  dolibarr: "Dolibarr",
  "next-static": "Next.js · export",
  static: "Site HTML",
  php: "Application PHP",
  technical: "Répertoire technique",
  empty: "Répertoire vide",
  unknown: "À identifier",
};
function isSiteKind(kind: HostingInstallationView["kind"]) {
  return ["wordpress", "dolibarr", "next-static", "static", "php"].includes(kind);
}
function canCreateProject(item: HostingInstallationView) {
  return isSiteKind(item.kind) && !item.inspectionError && !item.candidates.length;
}

export function HostingDiscoveryPanel({
  discovery,
  projects,
  request,
  onChanged,
  onProject,
  disabled,
}: {
  discovery: HostingDiscovery | undefined;
  projects: Project[];
  request: (path: string, method?: string, payload?: unknown) => Promise<any>;
  onChanged: (next: HostingDiscovery) => Promise<void>;
  onProject: (id: string) => void;
  disabled: boolean;
}) {
  const [linking, setLinking] = useState<HostingInstallationView | null>(null),
    [busy, setBusy] = useState<string | null>(null),
    [error, setError] = useState("");
  const visible =
    discovery?.installations.filter((i) => !i.ignored && !i.missingSince) || [];
  const failedSites = visible.filter((item) => item.inspectionError || item.inventory?.error);
  const linked = visible.filter((item) => item.project);
  const offered = visible.filter((item) => !item.project &&
    (isSiteKind(item.kind) || item.inspectionError || item.kind === "wordpress-incomplete" || item.candidates.length));
  const other = visible.filter((item) => !linked.includes(item) && !offered.includes(item));
  const hidden = discovery?.installations.filter((item) => item.ignored && !item.missingSince) || [];
  const missing = discovery?.installations.filter((item) => item.missingSince) || [];

  async function addToPark(item: HostingInstallationView) {
    setBusy(item.id);
    setError("");
    try {
      const result: { projectId: string | null; discovery: HostingDiscovery } =
        await request(`installations/${item.id}/resolve`, "POST", {});
      if (result.projectId) {
        await onChanged(result.discovery);
      } else {
        const current = result.discovery.installations.find((site) => site.id === item.id);
        if (!current) throw new Error("Cette installation n’apparaît plus dans le relevé.");
        setLinking(current);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function showAgain(item: HostingInstallationView) {
    setBusy(item.id);
    setError("");
    try {
      await onChanged(await request(`installations/${item.id}/ignore`, "POST", { ignored: false }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function facts(item: HostingInstallationView) {
    return (
      <span className="discovery-facts">
        {installationLabels[item.kind]}
        {item.version && ` · ${item.version}`}
        {item.inventory?.php && ` · PHP ${item.inventory.php.version}`}
        {item.inventory?.observedAt &&
          ` · ${item.inventory.plugins.length} extensions`}
        {(item.inspectionError || item.inventory?.error) && (
          <span className="badge warning">Collecte à vérifier</span>
        )}
        {item.suggestedEnvironment === "staging" && (
          <span className="badge neutral">Préproduction</span>
        )}
      </span>
    );
  }
  function row(
    item: HostingInstallationView,
    mode: "linked" | "offered",
  ) {
    return (
      <li
        className={`discovery-item ${mode === "linked" ? "record-row" : ""}`}
        key={item.id}
      >
        {mode === "linked" && item.project ? (
          <RecordLink
            className="discovery-identity"
            href={`/?project=${encodeURIComponent(item.project.id)}`}
            onNavigate={() => onProject(item.project!.id)}
            stretch
          >
            <span className="discovery-icon">
              <Check size={16} />
            </span>
            <span>
              <strong>{item.project.name}</strong>
              <small>{item.domains.join(", ")}</small>
              {facts(item)}
            </span>
          </RecordLink>
        ) : (
          <div className="discovery-identity">
            <span className="discovery-icon">
              <Search size={16} />
            </span>
            <span>
              <strong>{item.domains[0] || item.documentRoot}</strong>
              {facts(item)}
              {item.kind === "wordpress-incomplete" && (
                <small className="discovery-warning">
                  Des fichiers WordPress sont présents, mais l’installation doit
                  être vérifiée.
                </small>
              )}
            </span>
          </div>
        )}
        <div className="discovery-item-actions record-secondary">
          {mode === "linked" ? (
            <>
              <span className="badge sage">
                {item.linkMethod === "automatic"
                  ? "Rattaché automatiquement"
                  : "Rattaché"}
              </span>
              <button
                className="text-button"
                onClick={() => setLinking(item)}
                disabled={disabled || busy !== null}
              >
                Changer
              </button>
            </>
          ) : (
            <button
              className="button secondary"
              onClick={() => void addToPark(item)}
              disabled={disabled || busy !== null}
            >
              {busy === item.id ? <Loader2 className="spin" size={14} /> : <Plus size={14} />}
              Ajouter au parc
            </button>
          )}
        </div>
      </li>
    );
  }
  return (
    <div className="hosting-discovery">
      {error && (
        <p className="discovery-error" role="alert">
          <AlertCircle size={15} />
          {error}
        </p>
      )}
      {failedSites.length > 0 && (
        <section className="discovery-group">
          <h3>Erreurs de collecte des sites ({failedSites.length})</h3>
          <ul className="discovery-list">
            {failedSites.map((item) => (
              <li className="discovery-item" key={item.id}>
                <div className="discovery-identity">
                  <span className="discovery-icon"><AlertCircle size={16} aria-hidden="true" /></span>
                  <span>
                    <strong>{item.domains[0] || item.documentRoot}</strong>
                    {item.inspectionError && (
                      <small className="discovery-warning">
                        Inspection de l’hébergement : {item.inspectionError}
                        {item.observedAt && ` Dernière inspection réussie le ${formatDate(item.observedAt)}.`}
                      </small>
                    )}
                    {item.inventory?.error && (
                      <small className="discovery-warning">
                        Inventaire WordPress : {item.inventory.error}
                        {item.inventory.observedAt && ` Dernier inventaire réussi le ${formatDate(item.inventory.observedAt)}.`}
                      </small>
                    )}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {discovery?.lastSuccessAt && (
        <>
          <div className="discovery-summary">
            <span>
              <strong>{linked.length}</strong> site
              {linked.length > 1 ? "s" : ""} rattaché
              {linked.length > 1 ? "s" : ""}
            </span>
            {!!offered.length && <span><strong>{offered.length}</strong> à ajouter</span>}
          </div>
          {!!linked.length && (
            <details className="discovery-linked">
              <summary>
                Sites déjà rattachés <span>{linked.length}</span>
              </summary>
              <ul className="discovery-list">
                {linked.map((i) => row(i, "linked"))}
              </ul>
            </details>
          )}
          {!!offered.length && (
            <section className="discovery-group">
              <h3>Sites à ajouter au parc</h3>
              <ul className="discovery-list">
                {offered.map((item) => row(item, "offered"))}
              </ul>
            </section>
          )}
          {!!other.length && (
            <details className="discovery-other">
              <summary>{other.length} autres domaines ou répertoires</summary>
              <ul>
                {other.map((i) => (
                  <li key={i.id}>
                    <span>{i.domains.join(", ")}</span>
                    <small>{installationLabels[i.kind]}</small>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {!!hidden.length && (
            <details className="discovery-other">
              <summary>
                {hidden.length} installation{hidden.length > 1 ? "s" : ""}{" "}
                masquée{hidden.length > 1 ? "s" : ""}
              </summary>
              <ul>
                {hidden.map((i) => (
                  <li key={i.id}>
                    <span>{i.domains[0]}</span>
                    <button
                      className="text-button"
                      disabled={disabled || busy !== null}
                      onClick={() => void showAgain(i)}
                    >
                      Réafficher
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {!!missing.length && (
            <details className="discovery-other">
              <summary>
                {missing.length} installation{missing.length > 1 ? "s" : ""} non
                retrouvée{missing.length > 1 ? "s" : ""}
              </summary>
              <p className="subtle">
                Leurs fiches et leurs liens sont conservés. Elles n’ont pas été
                retrouvées lors du dernier relevé.
              </p>
              <ul>
                {missing.map((i) => (
                  <li key={i.id}>
                    <span>{i.domains[0]}</span>
                    <small>
                      Dernière présence : {formatDate(i.lastSeenAt)}
                    </small>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {linking && (
        <InstallationLinkForm
          installation={linking}
          projects={projects}
          onClose={() => setLinking(null)}
          onCreate={!linking.project && canCreateProject(linking) ? async () => {
            const result = await request(`installations/${linking.id}/create`, "POST", {});
            await onChanged(result.discovery);
            setLinking(null);
          } : undefined}
          onSubmit={async (projectId) => {
            const next = await request(
              `installations/${linking.id}/link`,
              "POST",
              { projectId },
            );
            await onChanged(next);
            setLinking(null);
          }}
        />
      )}
    </div>
  );
}
function InstallationLinkForm({
  installation,
  projects,
  onSubmit,
  onCreate,
  onClose,
}: {
  installation: HostingInstallationView;
  projects: Project[];
  onSubmit: (id: string) => Promise<void>;
  onCreate?: () => Promise<void>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(""),
    [selected, setSelected] = useState(
      installation.project?.id ||
        (installation.candidates.length === 1
          ? installation.candidates[0].id
          : ""),
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const ordered = [...projects].sort(
    (a, b) =>
      Number(installation.candidates.some((c) => c.id === b.id)) -
        Number(installation.candidates.some((c) => c.id === a.id)) ||
      a.name.localeCompare(b.name, "fr"),
  );
  const filtered = ordered.filter((p) =>
    [p.name, p.url, p.client]
      .join(" ")
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  async function submit(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={installation.project ? "Changer de fiche" : "Ajouter au parc"}
      description={installation.domains[0]}
      onClose={() => !busy && onClose()}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (selected) await submit(() => onSubmit(selected));
        }}
      >
        <div className="installation-picker">
          {!installation.project && (
            <p className="subtle">
              {installation.candidates.length
                ? "Vigie a trouvé des fiches possibles. Choisis celle qui correspond à ce site."
                : onCreate
                  ? "Choisis une fiche existante ou crée une nouvelle fiche pour ce site."
                  : "Choisis une fiche existante. La création d’une fiche sera disponible après un relevé complet."}
            </p>
          )}
          <div className="search-input">
            <Search size={16} />
            <input
              aria-label="Rechercher une fiche"
              placeholder="Nom du site, client ou URL…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
          </div>
          <div className="installation-choices">
            {filtered.map((p) => (
              <label key={p.id}>
                <input
                  type="radio"
                  name="projectId"
                  value={p.id}
                  checked={selected === p.id}
                  onChange={() => setSelected(p.id)}
                />
                <span>
                  <strong>{p.name}</strong>
                  <small>{p.url || p.client || "Sans URL"}</small>
                  {installation.candidates.find((c) => c.id === p.id) && (
                    <small className="discovery-match">
                      {
                        installation.candidates.find((c) => c.id === p.id)!
                          .reason
                      }
                    </small>
                  )}
                </span>
              </label>
            ))}
            {!filtered.length && (
              <p className="subtle">
                Aucune fiche ne correspond à cette recherche.
              </p>
            )}
          </div>
        </div>
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
          {onCreate && (
            <button type="button" className="button secondary" disabled={busy} onClick={() => void submit(onCreate)}>
              <Plus size={15} /> Créer une fiche
            </button>
          )}
          <button className="button primary" disabled={busy || !selected}>
            {busy ? (
              <Loader2 className="spin" size={15} />
            ) : (
              <Check size={15} />
            )}
            Utiliser cette fiche
          </button>
        </div>
      </form>
    </Modal>
  );
}
