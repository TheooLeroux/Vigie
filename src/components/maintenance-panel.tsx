"use client";
import { useEffect, useState } from "react";
import {
  AlertCircle,
  GitPullRequest,
  Loader2,
  RefreshCw,
  Wrench,
} from "lucide-react";
import type {
  MaintenanceInspection,
  MaintenanceJob,
  MaintenanceState,
} from "@/lib/maintenance-contract";
import { Field, formatDate, Modal, OutLink } from "./ui";

type RequestApi = (
  path: string,
  method?: string,
  payload?: unknown,
) => Promise<any>;
const labels: Record<MaintenanceJob["status"], string> = {
  planned: "Plan à approuver",
  dispatching: "Envoi à vérifier",
  queued: "Préparation en cours",
  pull_request: "PR à vérifier",
  merging: "Fusion à confirmer",
  merged: "Fusionnée",
  closed: "Fermée",
  failed: "Préparation échouée",
};
export function MaintenancePanel({
  request,
  projectId,
}: {
  request: RequestApi;
  projectId?: string;
}) {
  const [state, setState] = useState<MaintenanceState | null>(null);
  const [inspection, setInspection] = useState<MaintenanceInspection | null>(
    null,
  );
  const [targetId, setTargetId] = useState("");
  const [kind, setKind] = useState<"node" | "dependencies">("node");
  const [version, setVersion] = useState("");
  const [packageName, setPackageName] = useState("");
  const [updates, setUpdates] = useState<{ name: string; version: string }[]>(
    [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState<{
    action: "approve" | "merge" | "close" | "rollback";
    job: MaintenanceJob;
  } | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [returnReviewed, setReturnReviewed] = useState(false);
  async function reload() {
    setState(await request("maintenance"));
  }
  useEffect(() => {
    let cancelled = false;
    request("maintenance")
      .then((data) => {
        if (!cancelled) setState(data);
      })
      .catch((error) => {
        if (!cancelled) setError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [request]);
  async function act(run: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await run();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Opération impossible.",
      );
    } finally {
      setBusy(false);
    }
  }
  function confirm(
    action: "approve" | "merge" | "close" | "rollback",
    job: MaintenanceJob,
  ) {
    setReviewed(false);
    setReturnReviewed(false);
    setConfirmation({ action, job });
  }
  async function inspect() {
    const result = await request("maintenance/inspect", "POST", { targetId });
    setInspection(result);
    setVersion(result.nodeVersions[0] || "");
    setUpdates([]);
    setPackageName("");
  }
  async function addPackage() {
    if (!inspection || !packageName) return;
    const release = await request("maintenance/package", "POST", {
      targetId: inspection.target.id,
      name: packageName,
    });
    setUpdates((previous) => [
      ...previous.filter((update) => update.name !== release.name),
      { name: release.name, version: release.version },
    ]);
  }
  async function prepare() {
    if (!inspection) return;
    const job = await request("maintenance/plans", "POST", {
      targetId: inspection.target.id,
      operation: kind === "node" ? { kind, version } : { kind, updates },
    });
    await reload();
    confirm("approve", job);
  }
  async function confirmed() {
    if (!confirmation) return;
    const { job, action } = confirmation;
    if (action === "rollback") {
      const next = await request("maintenance/plans", "POST", {
        targetId: job.targetId,
        operation: { kind: "rollback", pullNumber: job.pullNumber },
        rollbackJobId: job.id,
      });
      await reload();
      confirm("approve", next);
      return;
    }
    await request(
      `maintenance/${job.id}/${action}`,
      "POST",
      action === "approve"
        ? { approved: true }
        : action === "merge"
          ? {
              confirmed: true,
              previewReviewed: reviewed,
              returnReviewed,
              expectedHead: job.headSha,
            }
          : { confirmed: true },
    );
    setConfirmation(null);
    await reload();
  }
  const targets =
    state?.targets.filter(
      (target) => !projectId || target.projectId === projectId,
    ) || [];
  const jobs =
    state?.jobs.filter((job) => !projectId || job.projectId === projectId) ||
    [];
  return (
    <section className="maintenance-panel">
      <div className="panel maintenance-intro">
        <div>
          <Wrench size={20} />
          <h2>Mises à jour contrôlées</h2>
        </div>
        <p>
          Node et dépendances npm/pnpm : proposition, PR, contrôles puis
          confirmation de fusion. Les frameworks et bibliothèques sont traités
          comme des dépendances. Aucun changement direct sur la branche de
          production.
        </p>
        <p>
          WordPress, PHP, images externes et bases de données ne sont pas mis à
          jour par ce parcours. Une PR de retour restaure le code uniquement,
          jamais les données ni les secrets.
        </p>
      </div>
      {error && (
        <p className="maintenance-error" role="alert">
          <AlertCircle size={16} />
          {error}
        </p>
      )}
      {!state && !error && (
        <p role="status">
          <Loader2 size={16} /> Chargement de la maintenance…
        </p>
      )}
      {state && !state.configured && (
        <section className="panel maintenance-setup">
          <h3>Activer l’exécuteur GitHub</h3>
          <ul>
            {state.configurationIssues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
          <p>
            Configurer les variables serveur <code>VIGIE_MAINTENANCE_*</code>,
            le workflow dédié, son secret et sa liste de dépôts autorisés.
            L’installation Vercel → GitHub ne donne pas ces droits à Vigie.
            Aucun jeton n’est transmis au navigateur.
          </p>
        </section>
      )}
      {state && (
        <section className="panel maintenance-editor">
          <h3>Préparer une mise à jour</h3>
          <Field label="Application ou service">
            <select
              value={targetId}
              disabled={busy}
              onChange={(event) => {
                setTargetId(event.target.value);
                setInspection(null);
              }}
            >
              <option value="">Sélectionner une cible</option>
              {targets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.provider} · {target.name}
                  {target.blocked ? " · À qualifier" : ""}
                </option>
              ))}
            </select>
          </Field>
          {targets.find((target) => target.id === targetId)?.blocked && (
            <p className="maintenance-warning">
              {targets.find((target) => target.id === targetId)?.blocked}
            </p>
          )}
          <button
            className="button secondary"
            disabled={
              busy ||
              !targetId ||
              !state.configured ||
              !!targets.find((target) => target.id === targetId)?.blocked
            }
            onClick={() => act(inspect)}
          >
            {busy ? <Loader2 size={15} /> : <RefreshCw size={15} />} Analyser la
            source GitHub
          </button>
          {!targets.length && (
            <p>
              Aucune cible Git exploitable dans ce périmètre. Les installations
              WordPress et les images externes nécessitent un autre parcours.
            </p>
          )}
          {inspection && (
            <>
              <div className="maintenance-source">
                <strong>{inspection.target.repository}</strong>
                <span>
                  {inspection.baseBranch} · {inspection.baseSha.slice(0, 12)} ·{" "}
                  {inspection.target.directory || "/"} · {inspection.manager}
                </span>
                <small>
                  Déploiement observé : {inspection.target.commit?.slice(0, 12)}{" "}
                  — {formatDate(inspection.target.observedAt)}
                </small>
              </div>
              <ul className="maintenance-warnings">
                {inspection.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
              <Field label="Élément à mettre à jour">
                <select
                  value={kind}
                  onChange={(event) =>
                    setKind(event.target.value as "node" | "dependencies")
                  }
                  disabled={busy}
                >
                  <option value="node">Node — branche LTS supportée</option>
                  <option value="dependencies">
                    Framework et dépendances applicatives
                  </option>
                </select>
              </Field>
              {kind === "node" ? (
                <Field
                  label="Version cible Node"
                  hint="Vercel choisit les correctifs de la branche majeure ; Railway dépend aussi des priorités Railpack."
                >
                  <select
                    value={version}
                    onChange={(event) => setVersion(event.target.value)}
                    disabled={busy}
                  >
                    {inspection.nodeVersions.map((version) => (
                      <option key={version} value={version}>
                        {version}
                      </option>
                    ))}
                  </select>
                  {!inspection.nodeVersions.length && (
                    <small>
                      Aucune cible supportée proposée par le catalogue.
                    </small>
                  )}
                </Field>
              ) : (
                <>
                  {inspection.dependencyBlocker && (
                    <p className="maintenance-warning">
                      {inspection.dependencyBlocker}
                    </p>
                  )}
                  <Field
                    label="Dépendance déclarée"
                    hint="Les contraintes ci-dessous sont déclarées dans package.json, pas des versions d’exécution attestées."
                  >
                    <select
                      value={packageName}
                      onChange={(event) => setPackageName(event.target.value)}
                      disabled={busy || !!inspection.dependencyBlocker}
                    >
                      <option value="">Sélectionner un composant</option>
                      {inspection.dependencies.map((dependency) => (
                        <option
                          key={`${dependency.scope}:${dependency.name}`}
                          value={dependency.name}
                        >
                          {dependency.name} · {dependency.declared} ·{" "}
                          {dependency.scope}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <button
                    className="button secondary"
                    disabled={
                      busy ||
                      !packageName ||
                      updates.length >= 12 ||
                      !!inspection.dependencyBlocker
                    }
                    onClick={() => act(addPackage)}
                  >
                    Proposer la dernière version stable publique
                  </button>
                  <ul className="maintenance-updates">
                    {updates.map((update) => (
                      <li key={update.name}>
                        <span>
                          {update.name} → <strong>{update.version}</strong>
                        </span>
                        <button
                          className="text-button"
                          disabled={busy}
                          onClick={() =>
                            setUpdates((previous) =>
                              previous.filter(
                                (item) => item.name !== update.name,
                              ),
                            )
                          }
                        >
                          Retirer du plan
                        </button>
                      </li>
                    ))}
                  </ul>
                  <p>
                    Les majeures peuvent nécessiter des changements de code.
                    Ajouter ensemble les composants liés ; la préparation échoue
                    plutôt que de forcer des incompatibilités.
                  </p>
                </>
              )}
              <button
                className="button primary"
                disabled={
                  busy ||
                  (kind === "node"
                    ? !version
                    : !updates.length || !!inspection.dependencyBlocker)
                }
                onClick={() => act(prepare)}
              >
                <GitPullRequest size={15} /> Préparer le plan
              </button>
            </>
          )}
        </section>
      )}
      <section className="panel maintenance-jobs">
        <div className="maintenance-heading">
          <h3>Suivi des mises à jour</h3>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => act(reload)}
          >
            Recharger la liste
          </button>
        </div>
        {!jobs.length && (
          <p>
            Aucun plan préparé. Les vérifications et écritures externes ne
            démarrent qu’après vos actions explicites.
          </p>
        )}
        {jobs.map((job) => (
          <article key={job.id} className="maintenance-job">
            <div className="maintenance-heading">
              <strong>{job.targetName}</strong>
              <span className="badge neutral">{labels[job.status]}</span>
            </div>
            <p>
              {job.payload.operation.kind === "node"
                ? `Node → ${job.payload.operation.version}`
                : job.payload.operation.kind === "rollback"
                  ? `Retour code de la PR #${job.payload.operation.pullNumber}`
                  : job.payload.operation.updates
                      .map((update) => `${update.name} → ${update.version}`)
                      .join(" · ")}
            </p>
            <small>
              {formatDate(job.createdAt)} · {job.actor} ·{" "}
              {job.payload.repository}
            </small>
            <details>
              <summary>Plan et portée</summary>
              <ul>
                {job.files.map((file) => (
                  <li key={file}>
                    <code>{file}</code>
                  </li>
                ))}
              </ul>
              <ul>
                {job.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
              {job.status === "planned" && (
                <p>Approbation avant le {formatDate(job.expiresAt)}.</p>
              )}
            </details>
            {job.error && <p className="maintenance-warning">{job.error}</p>}
            {job.mergeBlocker && job.status === "pull_request" && (
              <p>{job.mergeBlocker}</p>
            )}
            {job.checks && (
              <ul className="maintenance-checks">
                {job.checks.map((check, index) => (
                  <li key={`${check.name}:${index}`}>
                    {check.name} : <strong>{check.state}</strong>
                  </li>
                ))}
              </ul>
            )}
            {job.status === "merged" && (
              <p className="maintenance-warning">
                {job.deployment === "observed"
                  ? "Commit de fusion observé dans le dernier inventaire du déploiement ; le bon fonctionnement métier reste à vérifier."
                  : "Fusion confirmée, déploiement non vérifié. Synchroniser l’hébergeur puis actualiser le suivi ; ne pas confondre fusion et mise à jour appliquée."}
              </p>
            )}
            <div className="maintenance-actions">
              {job.pullUrl && <OutLink href={job.pullUrl}>Voir la PR</OutLink>}
              {job.runUrl && (
                <OutLink href={job.runUrl}>Voir la préparation</OutLink>
              )}
              {job.status === "planned" && (
                <button
                  className="button primary"
                  disabled={busy || job.expiresAt <= new Date().toISOString()}
                  onClick={() => confirm("approve", job)}
                >
                  Approuver la création de PR
                </button>
              )}
              {job.status !== "planned" && (
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      await request(
                        `maintenance/${job.id}/refresh`,
                        "POST",
                        {},
                      );
                      await reload();
                    })
                  }
                >
                  Actualiser le suivi
                </button>
              )}
              {job.status === "pull_request" && (
                <button
                  className="button primary"
                  disabled={busy || !job.canMerge}
                  onClick={() => confirm("merge", job)}
                >
                  Fusionner et déclencher le déploiement
                </button>
              )}
              {!["merged", "closed", "merging"].includes(job.status) && (
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => confirm("close", job)}
                >
                  Arrêter / fermer
                </button>
              )}
              {job.status === "merged" &&
                job.payload.operation.kind !== "rollback" && (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => confirm("rollback", job)}
                  >
                    Préparer un retour code
                  </button>
                )}
            </div>
          </article>
        ))}
      </section>
      {confirmation && (
        <Modal
          title={
            confirmation.action === "merge"
              ? "Confirmer la publication"
              : confirmation.action === "approve"
                ? "Autoriser la préparation"
                : confirmation.action === "rollback"
                  ? "Préparer un retour du code"
                  : "Arrêter cette préparation"
          }
          onClose={() => {
            if (!busy) setConfirmation(null);
          }}
        >
          <div className="maintenance-confirm">
            <strong>{confirmation.job.targetName}</strong>
            <p>
              {confirmation.action === "merge"
                ? "Cette fusion sur la branche source peut déployer immédiatement en production. Les contrôles GitHub seront revérifiés pour le commit exact. Aucun retour des données n’est automatique."
                : confirmation.action === "approve"
                  ? "L’exécuteur va lire les fichiers de la cible, résoudre les dépendances sans scripts applicatifs si nécessaire, puis créer une branche et une PR. Les workflows de push/PR et previews du dépôt peuvent démarrer : vérifier qu’ils ne publient pas cette branche en production. Aucune fusion n’est demandée à cette étape."
                  : confirmation.action === "rollback"
                    ? "Une nouvelle PR proposera de rétablir les fichiers de code antérieurs. Si un fichier a changé depuis, la préparation est refusée. Ce n’est pas une restauration de base ni l’annulation des effets externes. Ne pas réintroduire de secret révoqué ou de version vulnérable."
                    : "Le plan sera fermé, ou un arrêt sera demandé à l’exécuteur. Actualiser ensuite pour confirmer sa fin. Une fusion déjà réalisée n’est pas annulée et les branches ne sont pas supprimées."}
            </p>
            {confirmation.action === "merge" && (
              <>
                <label>
                  <input
                    type="checkbox"
                    checked={reviewed}
                    onChange={(event) => setReviewed(event.target.checked)}
                  />{" "}
                  J’ai contrôlé la PR, la prévisualisation et les parcours
                  métier concernés.
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={returnReviewed}
                    onChange={(event) =>
                      setReturnReviewed(event.target.checked)
                    }
                  />{" "}
                  J’ai vérifié le retour code, la compatibilité des données et
                  les secrets valides.
                </label>
              </>
            )}
            {error && (
              <p role="alert" className="maintenance-error">
                {error}
              </p>
            )}
            <button
              className="button primary"
              disabled={
                busy ||
                (confirmation.action === "merge" &&
                  (!reviewed || !returnReviewed))
              }
              onClick={() => act(confirmed)}
            >
              {busy ? "Traitement…" : "Confirmer"}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
