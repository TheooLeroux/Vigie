"use client";
import { useState } from "react";
import {
  AlertCircle,
  Check,
  Download,
  Loader2,
  RefreshCw,
  Search,
} from "lucide-react";
import type {
  HostingInstallationView,
  WordPressComponent,
  UpdateInfo,
} from "@/lib/types";
import { formatDate, Modal } from "./ui";
type Request = (
  path: string,
  method?: string,
  payload?: unknown,
) => Promise<any>;
export function UpdateBadge({ value }: { value: UpdateInfo }) {
  const stale =
    value.updateCheckedAt &&
    Date.now() - Date.parse(value.updateCheckedAt) > 24 * 3600_000;
  return (
    <span
      className={`badge ${stale ? "neutral" : value.updateState === "available" ? "warning" : value.updateState === "current" ? "sage" : "neutral"}`}
      title={
        value.updateCheckedAt
          ? `Vérifié le ${formatDate(value.updateCheckedAt)}${value.updateSource === "wordpress.org" ? " dans l’annuaire WordPress.org" : " par WordPress"}`
          : "Aucun flux de mise à jour vérifié"
      }
    >
      {stale
        ? "Relevé ancien"
        : value.updateState === "available"
          ? `Mise à jour · ${value.latestVersion}`
          : value.updateState === "current"
            ? "À jour"
            : value.updateState === "ahead"
              ? "Version plus récente"
              : "Non vérifiable"}
    </span>
  );
}
function ComponentsTable({
  items,
  kind,
  php,
  wordpress,
}: {
  items: WordPressComponent[];
  kind: "plugins" | "themes";
  php?: string;
  wordpress?: string;
}) {
  const [query, setQuery] = useState(""),
    [updatesOnly, setUpdatesOnly] = useState(false);
  const filtered = items
    .filter(
      (i) =>
        (i.name + " " + i.slug).toLowerCase().includes(query.toLowerCase()) &&
        (!updatesOnly || i.updateState === "available"),
    )
    .sort(
      (a, b) =>
        Number(b.updateState === "available") -
          Number(a.updateState === "available") ||
        a.name.localeCompare(b.name, "fr"),
    );
  function tooOld(current: string | undefined, required: string | null) {
    if (
      !current ||
      !required ||
      !/^\d+(\.\d+)*$/.test(current) ||
      !/^\d+(\.\d+)*$/.test(required)
    )
      return false;
    const a = current.split(".").map(Number),
      b = required.split(".").map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0);
    }
    return false;
  }
  return (
    <div className="wp-components">
      <div className="wp-component-tools">
        <label>
          <Search size={15} />
          <input
            aria-label={
              kind === "plugins"
                ? "Rechercher une extension"
                : "Rechercher un thème"
            }
            placeholder="Rechercher…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <label className="wp-update-filter">
          <input
            type="checkbox"
            checked={updatesOnly}
            onChange={(e) => setUpdatesOnly(e.target.checked)}
          />
          Mises à jour disponibles
        </label>
      </div>
      <div className="wp-table-scroll">
        <table className="wp-table">
          <thead>
            <tr>
              <th>{kind === "plugins" ? "Extension" : "Thème"}</th>
              <th>Version</th>
              <th>Activité</th>
              <th>Mise à jour</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((item) => (
              <tr key={item.file}>
                <td>
                  <strong>{item.name || item.slug}</strong>
                  <small>
                    {item.slug}
                    {item.mustUse && " · Obligatoire"}
                    {item.template && ` · Parent : ${item.template}`}
                  </small>
                  {(tooOld(php, item.requiresPhp) ||
                    tooOld(wordpress, item.requiresWordPress)) && (
                    <small className="wp-warning">
                      Prérequis non respectés :{" "}
                      {item.requiresPhp && `PHP ≥ ${item.requiresPhp}`}{" "}
                      {item.requiresWordPress &&
                        `WordPress ≥ ${item.requiresWordPress}`}
                    </small>
                  )}
                  {item.autoUpdate === true && (
                    <small>Mises à jour automatiques activées</small>
                  )}
                </td>
                <td>{item.version || "Inconnue"}</td>
                <td>
                  {item.active === null ? (
                    <span
                      className="subtle"
                      title="Installer le connecteur pour lire l’activité réelle"
                    >
                      Non vérifiée
                    </span>
                  ) : item.active ? (
                    <span className="wp-active">Actif</span>
                  ) : (
                    <span className="subtle">Inactif</span>
                  )}
                </td>
                <td>
                  <UpdateBadge value={item} />
                  {item.requiresPhp && <small>PHP ≥ {item.requiresPhp}</small>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!filtered.length && (
          <p className="wp-table-empty">
            {items.length
              ? "Aucun résultat pour ce filtre."
              : "Aucun élément relevé. Consultez les éventuels avertissements de collecte."}
          </p>
        )}
      </div>
    </div>
  );
}
export function WordPressInventoryPanel({
  installation,
  request,
  onRefresh,
}: {
  installation: HostingInstallationView;
  request: Request;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [plan, setPlan] = useState<any>(null);
  const inventory = installation.inventory;
  async function collect() {
    setBusy(true);
    setError("");
    try {
      await request(`installations/${installation.id}/inventory`, "POST", {});
      await onRefresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function prepare() {
    setBusy(true);
    setError("");
    try {
      setPlan(await request(`installations/${installation.id}/observer-plan`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const components = inventory
      ? [...inventory.plugins, ...inventory.themes]
      : [],
    updates = components.filter((i) => i.updateState === "available").length;
  return (
    <section className="panel wordpress-inventory">
      <div className="panel-heading">
        <div>
          <h2>WordPress · {installation.domains[0]}</h2>
          <p>
            {inventory?.observedAt
              ? `Relevé du ${formatDate(inventory.observedAt)} · ${inventory.source === "wordpress-observer" ? "Depuis WordPress" : "Depuis les fichiers o2switch"}`
              : "Informations de ce site"}
          </p>
        </div>
        <button
          className="button secondary small"
          onClick={collect}
          disabled={busy || Boolean(installation.missingSince)}
        >
          {busy ? (
            <Loader2 size={14} className="spin" />
          ) : (
            <RefreshCw size={14} />
          )}
          Actualiser
        </button>
      </div>
      <div className="wp-inventory-body">
        {inventory?.collectionMode === "early" && (
          <p className="wp-warning">
            <AlertCircle size={15} />
            Le site rencontre une erreur WordPress. Relevé de secours : les flux
            de mises à jour n’ont pas été rafraîchis.
          </p>
        )}
        {(error || inventory?.error) && (
          <p className="wp-warning" role="alert">
            <AlertCircle size={15} />
            {error || inventory?.error}
            {inventory?.error &&
              inventory.observedAt &&
              " Le dernier relevé est conservé."}
          </p>
        )}
        {!inventory?.observedAt ? (
          <p className="subtle">
            Actualisez pour relever les versions, extensions et thèmes de ce
            site.
          </p>
        ) : (
          <>
            <div className="wp-facts">
              <div>
                <small>WordPress</small>
                <strong>{inventory.wordpress?.version || "Non relevé"}</strong>
                {inventory.wordpress && (
                  <UpdateBadge value={inventory.wordpress} />
                )}
              </div>
              <div>
                <small>PHP web</small>
                <strong>{inventory.php?.version || "À connecter"}</strong>
                <span>
                  {inventory.php?.sapi || "Version réelle non vérifiée"}
                </span>
              </div>
              <div>
                <small>Extensions installées</small>
                <strong>{inventory.plugins.length}</strong>
                <span>
                  {inventory.source === "wordpress-observer"
                    ? `${inventory.plugins.filter((p) => p.active).length} actives`
                    : "Activité non vérifiée"}
                </span>
              </div>
              <div>
                <small>Mises à jour extensions et thèmes</small>
                <strong>{updates}</strong>
                <span>
                  {components.filter((i) => i.updateState === "unknown").length}{" "}
                  non vérifiables
                </span>
              </div>
            </div>
            {inventory.php?.release && (
              <div className="wp-php-release">
                {inventory.php.release.updateAvailable && (
                  <span className="badge warning">
                    {inventory.php.release.securityRelease
                      ? "Correctif de sécurité PHP publié"
                      : "Version PHP publiée"}{" "}
                    · {inventory.php.release.latestVersion}
                  </span>
                )}
                {inventory.php.release.upstreamSupported === false && (
                  <span className="badge warning">
                    Hors support PHP standard
                  </span>
                )}
                <p>
                  Référence :{" "}
                  <a
                    href="https://www.php.net/supported-versions.php"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    PHP.net
                  </a>
                  , vérifiée le {formatDate(inventory.php.release.checkedAt)}.
                  Les correctifs installés ou rétroportés par o2switch restent à
                  confirmer auprès de l’hébergeur.
                </p>
              </div>
            )}
            {inventory.source === "cpanel-files" && (
              <p className="wp-inventory-note">
                Les versions disponibles sont comparées à WordPress.org. Les
                extensions payantes ou privées nécessitent leurs flux de mises à
                jour WordPress.
              </p>
            )}
            <details className="wp-inventory-section">
              <summary>
                Extensions <span>{inventory.plugins.length}</span>
              </summary>
              <ComponentsTable
                items={inventory.plugins}
                kind="plugins"
                php={inventory.php?.version}
                wordpress={inventory.wordpress?.version}
              />
            </details>
            <details className="wp-inventory-section">
              <summary>
                Thèmes <span>{inventory.themes.length}</span>
              </summary>
              <ComponentsTable
                items={inventory.themes}
                kind="themes"
                php={inventory.php?.version}
                wordpress={inventory.wordpress?.version}
              />
            </details>
            {(inventory.php || inventory.site) && (
              <details className="wp-inventory-section">
                <summary>Configuration et environnement</summary>
                <dl className="wp-settings">
                  {inventory.site && (
                    <>
                      <div>
                        <dt>Nom du site</dt>
                        <dd>{inventory.site.name}</dd>
                      </div>
                      <div>
                        <dt>Langue / fuseau</dt>
                        <dd>
                          {inventory.site.locale} · {inventory.site.timezone}
                        </dd>
                      </div>
                      <div>
                        <dt>Indexation moteurs</dt>
                        <dd>
                          {inventory.site.searchEnginesVisible
                            ? "Autorisée"
                            : "Découragée par WordPress"}
                        </dd>
                      </div>
                      <div>
                        <dt>Multisite</dt>
                        <dd>{inventory.site.multisite ? "Oui" : "Non"}</dd>
                      </div>
                    </>
                  )}
                  {inventory.database && (
                    <div>
                      <dt>Version base de données</dt>
                      <dd>{inventory.database.version}</dd>
                    </div>
                  )}
                  {inventory.configuration && (
                    <>
                      <div>
                        <dt>Debug</dt>
                        <dd>
                          {inventory.configuration.debug
                            ? "Activé"
                            : "Désactivé"}
                        </dd>
                      </div>
                      <div>
                        <dt>Cron WordPress</dt>
                        <dd>
                          {inventory.configuration.cronDisabled
                            ? "Désactivé · tâche serveur à vérifier"
                            : "Activé"}
                        </dd>
                      </div>
                      <div>
                        <dt>Cache de pages / objet</dt>
                        <dd>
                          {inventory.configuration.pageCache
                            ? "Activé"
                            : "Non déclaré"}{" "}
                          /{" "}
                          {inventory.configuration.objectCache
                            ? "Actif"
                            : "Non actif"}
                        </dd>
                      </div>
                      <div>
                        <dt>Édition de fichiers dans WordPress</dt>
                        <dd>
                          {inventory.configuration.fileEditDisabled ||
                          inventory.configuration.fileModsDisabled
                            ? "Bloquée"
                            : "Autorisée"}
                        </dd>
                      </div>
                    </>
                  )}
                  {inventory.php &&
                    Object.entries(inventory.php.limits).map(
                      ([name, value]) => (
                        <div key={name}>
                          <dt>
                            {(
                              {
                                memory_limit: "Mémoire PHP",
                                max_execution_time: "Durée maximale (secondes)",
                                max_input_vars: "Variables d’entrée",
                                upload_max_filesize:
                                  "Taille maximale d’un fichier",
                                post_max_size: "Taille maximale d’un envoi",
                                display_errors: "Affichage des erreurs PHP",
                              } as Record<string, string>
                            )[name] || name}
                          </dt>
                          <dd>{value || "Non défini"}</dd>
                        </div>
                      ),
                    )}
                  {inventory.php && (
                    <div className="wp-settings-wide">
                      <dt>Extensions PHP</dt>
                      <dd>{inventory.php.extensions.join(", ")}</dd>
                    </div>
                  )}
                </dl>
              </details>
            )}
            {!!inventory.warnings.length && (
              <details className="wp-inventory-section">
                <summary>
                  Points à vérifier <span>{inventory.warnings.length}</span>
                </summary>
                <ul className="wp-warnings">
                  {inventory.warnings.map((warning, i) => (
                    <li key={i}>{warning}</li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
        {(!installation.observerConfigured || inventory?.error) &&
          !installation.missingSince && (
            <div className="wp-connect-prompt">
              <div>
                <strong>Compléter les informations automatiquement</strong>
                <p>
                  Le connecteur de lecture vérifie PHP, les extensions actives
                  et les mises à jour annoncées par WordPress.
                </p>
              </div>
              <button
                className="button secondary"
                onClick={prepare}
                disabled={busy}
              >
                <Download size={14} />
                Configurer
              </button>
            </div>
          )}
      </div>
      {plan && (
        <Modal
          title={
            plan.installed
              ? "Vérifier le connecteur WordPress"
              : "Installer le connecteur WordPress"
          }
          description={plan.domain}
          onClose={() => !busy && setPlan(null)}
        >
          <div className="observer-confirm">
            <p>Vigie ajoutera son connecteur de lecture dans ce fichier :</p>
            <code>{plan.path}</code>
            <p>
              Une clé propre à ce site protège la collecte. Le connecteur lit
              l’inventaire et peut rafraîchir les caches de vérification des
              mises à jour. Il n’installe aucune mise à jour et ne change aucun
              réglage du site.
            </p>
            <details>
              <summary>
                Voir le code qui sera installé · version {plan.version}
              </summary>
              <pre>{plan.source}</pre>
            </details>
            {error && <p className="form-error">{error}</p>}
          </div>
          <div className="modal-actions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setPlan(null)}
            >
              Annuler
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await request(
                    `installations/${installation.id}/observer`,
                    "POST",
                    { confirm: true },
                  );
                  setPlan(null);
                  await onRefresh();
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
              Installer et collecter
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
