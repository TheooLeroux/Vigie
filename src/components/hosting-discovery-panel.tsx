"use client";
import { useState } from "react";
import { AlertCircle, Check, Loader2, Plus, Search, X } from "lucide-react";
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
  const linked = visible.filter((i) => i.project),
    suggested = visible.filter(
      (i) =>
        !i.project &&
        ["wordpress", "dolibarr", "next-static", "static", "php"].includes(
          i.kind,
        ) &&
        !i.inspectionError &&
        !i.candidates.length,
    );
  const review = visible.filter(
    (i) =>
      !i.project &&
      (i.inspectionError ||
        i.kind === "wordpress-incomplete" ||
        i.candidates.length),
  );
  const other = visible.filter(
    (i) => !linked.includes(i) && !suggested.includes(i) && !review.includes(i),
  );
  const hidden =
      discovery?.installations.filter((i) => i.ignored && !i.missingSince) ||
      [],
    missing = discovery?.installations.filter((i) => i.missingSince) || [];
  async function act(
    item: HostingInstallationView,
    action: "create" | "ignore",
    payload: unknown = {},
  ) {
    setBusy(item.id);
    setError("");
    try {
      const result = await request(
        `installations/${item.id}/${action}`,
        "POST",
        payload,
      );
      await onChanged(action === "create" ? result.discovery : result);
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
        {item.inventory?.error && (
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
    mode: "linked" | "new" | "review",
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
              {item.inspectionError && (
                <small className="discovery-warning">
                  {item.inspectionError} Dernier relevé conservé :{" "}
                  {formatDate(item.observedAt)}.
                </small>
              )}
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
              {item.inspectionError && (
                <small className="discovery-warning">
                  {item.inspectionError}
                </small>
              )}
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
            <>
              {mode === "new" && (
                <button
                  className="button secondary"
                  onClick={() => act(item, "create")}
                  disabled={disabled || busy !== null}
                >
                  {busy === item.id ? (
                    <Loader2 className="spin" size={14} />
                  ) : (
                    <Plus size={14} />
                  )}
                  Ajouter au parc
                </button>
              )}
              <button
                className="text-button"
                onClick={() => setLinking(item)}
                disabled={disabled || busy !== null}
              >
                {item.candidates.length ? "Choisir la fiche" : "Rattacher"}
              </button>
              <button
                className="icon-button"
                title="Masquer cette installation"
                aria-label={`Masquer ${item.domains[0]}`}
                onClick={() => act(item, "ignore", { ignored: true })}
                disabled={disabled || busy !== null}
              >
                <X size={14} />
              </button>
            </>
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
      {discovery?.error && (
        <p className="discovery-error" role="alert">
          <AlertCircle size={15} />
          {discovery.error}
        </p>
      )}
      {!discovery?.lastSuccessAt ? (
        <p className="subtle discovery-start">
          Lancez la recherche pour retrouver les sites de ce compte et les
          rattacher aux fiches existantes.
        </p>
      ) : (
        <>
          <div className="discovery-summary">
            <span>
              <strong>{linked.length}</strong> site
              {linked.length > 1 ? "s" : ""} rattaché
              {linked.length > 1 ? "s" : ""}
            </span>
            <span>
              <strong>{suggested.length}</strong> à ajouter
            </span>
            {review.length > 0 && (
              <span>
                <strong>{review.length}</strong> à vérifier
              </span>
            )}
            <small>Relevé du {formatDate(discovery.lastSuccessAt)}</small>
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
          {!!suggested.length && (
            <section className="discovery-group">
              <h3>Nouveaux sites</h3>
              <p>
                Vigie a trouvé ces installations. Ajoutez celles que vous
                souhaitez suivre.
              </p>
              <ul className="discovery-list">
                {suggested.map((i) => row(i, "new"))}
              </ul>
            </section>
          )}
          {!!review.length && (
            <section className="discovery-group">
              <h3>À vérifier</h3>
              <ul className="discovery-list">
                {review.map((i) => row(i, "review"))}
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
                      onClick={() => act(i, "ignore", { ignored: false })}
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
  onClose,
}: {
  installation: HostingInstallationView;
  projects: Project[];
  onSubmit: (id: string) => Promise<void>;
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
  return (
    <Modal
      title="Rattacher à une fiche"
      description={installation.domains[0]}
      onClose={() => !busy && onClose()}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!selected) return;
          setBusy(true);
          setError("");
          try {
            await onSubmit(selected);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="installation-picker">
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
          <button className="button primary" disabled={busy || !selected}>
            {busy ? (
              <Loader2 className="spin" size={15} />
            ) : (
              <Check size={15} />
            )}
            Rattacher
          </button>
        </div>
      </form>
    </Modal>
  );
}
