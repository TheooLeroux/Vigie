"use client";
import type { RailwayService, RailwayPackage } from "@/lib/railway-types";
import { OutLink, formatDate } from "./ui";
import { railwayRuntimeDeployments } from "@/lib/railway-status";
function PackageVersion({ pkg }: { pkg: RailwayPackage }) {
  const r = pkg.release;
  const label =
    r?.supported === false
      ? "Fin de support"
      : r?.state === "available"
        ? "Mise à jour disponible"
        : r?.state === "current"
          ? "À jour dans sa branche"
          : r?.state === "ahead"
            ? "Supérieur au catalogue"
            : "État inconnu";
  const warning = r?.supported === false || r?.state === "available";
  return (
    <div className="railway-package">
      <div>
        <strong>
          {pkg.name === "node"
            ? "Node.js"
            : pkg.name === "caddy"
              ? "Caddy"
              : pkg.name}
        </strong>
        <code>{pkg.version}</code>
        <small>
          {pkg.usage === "build"
            ? "Construction"
            : pkg.usage === "runtime"
              ? "Exécution selon la construction"
              : "Outil de construction"}
        </small>
      </div>
      <div>
        <span
          className={`badge ${warning ? "warning" : r?.state === "current" ? "sage" : "neutral"}`}
        >
          {label}
        </span>
        {r?.latestVersion && (
          <small>
            Dernière version{" "}
            {pkg.name === "node" ? `${pkg.version.split(".")[0]}.x` : "stable"}{" "}
            : <strong>{r.latestVersion}</strong>
          </small>
        )}
        {r?.supported === false && (
          <small>
            Support terminé le {r.supportEndsAt}.{" "}
            {r.latestLts && `Dernière LTS : ${r.latestLts}.`}
          </small>
        )}
        {r?.securityUpdate && (
          <small className="railway-security-note">
            Une publication de sécurité manque à cette version.
          </small>
        )}
        {r?.source ? (
          <OutLink
            className="record-secondary railway-release-source"
            href={r.source}
          >
            {r.checkedAt
              ? `Catalogue vérifié le ${formatDate(r.checkedAt)}`
              : "Catalogue officiel indisponible"}
          </OutLink>
        ) : (
          <small>Comparaison automatique non disponible pour cet outil.</small>
        )}
      </div>
    </div>
  );
}
export function RailwayBuildDetails({ service }: { service: RailwayService }) {
  const deployed = railwayRuntimeDeployments(service),
    active = deployed.length > 0,
    deployments = active
      ? deployed
      : service.latestDeployment
        ? [service.latestDeployment]
        : [];
  if (!deployments.length)
    return <p className="railway-build-empty">Aucun déploiement à analyser.</p>;
  return (
    <div className="railway-build-details">
      <h4>
        {active
          ? "Code et versions du déploiement actif"
          : "Dernière tentative — aucune version active confirmée"}
      </h4>
      {deployments.map((d) => {
        const e = d.evidence;
        const source =
          e?.repository && e.commit
            ? `https://github.com/${e.repository}/tree/${e.commit}${e.rootDirectory && e.rootDirectory !== "/" ? "/" + e.rootDirectory.replace(/^\//, "").split("/").map(encodeURIComponent).join("/") : ""}`
            : e?.repository
              ? `https://github.com/${e.repository}`
              : null;
        return (
          <div className="railway-build" key={d.id}>
            <p className="railway-code-source">
              {source ? (
                <OutLink className="record-secondary" href={source}>
                  {e!.repository}
                </OutLink>
              ) : (
                <span>Dépôt non communiqué pour ce déploiement</span>
              )}
              {e?.branch && <span> · {e.branch}</span>}
              {e?.commit && (
                <code title={e.commit}>{e.commit.slice(0, 10)}</code>
              )}
            </p>
            {e?.framework && (
              <p className="railway-framework">
                {e.framework}
                {e.staticSite ? " · frontend statique servi par Caddy" : ""}
                {e.railpackVersion ? ` · Railpack ${e.railpackVersion}` : ""}
              </p>
            )}
            {e?.packages.length ? (
              <div className="railway-packages">
                {e.packages.map((pkg) => (
                  <PackageVersion key={pkg.name} pkg={pkg} />
                ))}
              </div>
            ) : (
              <p className="railway-build-empty">
                Version exacte non fournie par la construction. Une lecture du
                conteneur serait nécessaire pour la confirmer.
              </p>
            )}
            <small className="railway-deployment-id">
              Déploiement {d.id.slice(0, 8)} · {formatDate(d.createdAt)}
            </small>
          </div>
        );
      })}
    </div>
  );
}
