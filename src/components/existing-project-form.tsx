"use client";

import type { RailwayState } from "@/lib/railway-types";
import type { HostingDiscovery } from "@/lib/types";
import type { VercelState } from "@/lib/vercel-types";
import { ArrowLeft, Link2, Loader2, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { EmptyState, Modal, ProviderBadge } from "./ui";

type Candidate = {
  key: string;
  name: string;
  description: string;
  provider: string;
  path: string;
  projectId?: string;
};
export function ExistingProjectForm({
  request,
  onAdded,
  onBack,
  onClose,
  onConnections,
}: {
  request: (path: string, method?: string, payload?: unknown) => Promise<any>;
  onAdded: (id: string, alreadyFollowed: boolean) => Promise<void>;
  onBack: () => void;
  onClose: () => void;
  onConnections: () => void;
}) {
  const [items, setItems] = useState<Candidate[]>([]);
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("");
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [failures, setFailures] = useState<string[]>([]);
  const [createdId, setCreatedId] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.allSettled([
      request("connections"),
      request("vercel"),
      request("railway"),
    ]).then((results) => {
      if (!alive) return;
      const candidates: Candidate[] = [];
      const [hosting, vercel, railway] = results;
      if (hosting.status === "fulfilled") {
        const discoveries = hosting.value.discoveries as Record<
          string,
          HostingDiscovery
        >;
        for (const discovery of Object.values(discoveries))
          for (const item of discovery.installations) {
            if (
              item.ignored ||
              item.missingSince ||
              !item.domains.length ||
              item.inspectionError ||
              ![
                "wordpress",
                "dolibarr",
                "next-static",
                "static",
                "php",
              ].includes(item.kind) ||
              (!item.project && item.candidates.length)
            )
              continue;
            candidates.push({
              key: `hosting:${item.id}`,
              name: item.project?.name || item.domains[0],
              description: item.domains.join(", "),
              provider: "o2switch",
              path: `installations/${item.id}/create`,
              projectId: item.project?.id,
            });
          }
      }
      if (vercel.status === "fulfilled")
        for (const item of (vercel.value as VercelState).projects) {
          if (item.excluded || item.missingSince) continue;
          candidates.push({
            key: `vercel:${item.connectionId}:${item.id}`,
            name: item.name,
            description:
              item.domains.map((d) => d.name).join(", ") || item.teamName,
            provider: "Vercel",
            path: `vercel/${item.connectionId}/projects/${item.id}/create`,
            projectId: item.projectId || undefined,
          });
        }
      if (railway.status === "fulfilled")
        for (const item of (railway.value as RailwayState).projects) {
          if (item.missingSince) continue;
          candidates.push({
            key: `railway:${item.connectionId}:${item.id}`,
            name: item.name,
            description:
              item.services.flatMap((s) => s.domains).join(", ") ||
              item.workspaceName,
            provider: "Railway",
            path: `railway/${item.connectionId}/projects/${item.id}/create`,
            projectId: item.projectId || undefined,
          });
        }
      setItems(
        candidates.sort(
          (a, b) =>
            Number(!!a.projectId) - Number(!!b.projectId) ||
            a.name.localeCompare(b.name, "fr"),
        ),
      );
      setFailures(
        results.flatMap((r, i) =>
          r.status === "rejected" ? [["o2switch", "Vercel", "Railway"][i]] : [],
        ),
      );
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [request]);
  const filtered = items.filter(
    (i) =>
      (!provider || i.provider === provider) &&
      `${i.name} ${i.description}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const choice = items.find((i) => i.key === selected);
  async function submit() {
    if (!choice || busy) return;
    setBusy(true);
    setError("");
    try {
      const id =
        createdId ||
        choice.projectId ||
        (await request(choice.path, "POST", {})).projectId;
      setCreatedId(id);
      await onAdded(id, !!choice.projectId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Lier un projet existant"
      description="Choisissez un site détecté chez vos hébergeurs. Les projets déjà suivis ouvrent leur fiche."
      onClose={() => !busy && onClose()}
      wide
    >
      <div className="existing-project-body">
        <div className="existing-project-tools">
          <label className="activity-search">
            <Search size={17} />
            <input
              autoFocus
              aria-label="Rechercher un projet hébergé"
              placeholder="Nom ou domaine…"
              value={query}
              disabled={busy || !!createdId}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelected("");
              }}
            />
          </label>
          <select
            aria-label="Hébergeur du projet existant"
            value={provider}
            disabled={busy || !!createdId}
            onChange={(e) => {
              setProvider(e.target.value);
              setSelected("");
            }}
          >
            <option value="">Tous les hébergeurs</option>
            {["o2switch", "Vercel", "Railway"].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </div>
        {failures.length > 0 && (
          <p className="connection-error" role="alert">
            Impossible de charger {failures.join(", ")}. Retrouvez ces comptes
            dans Connexions pour réessayer.
          </p>
        )}
        {loading ? (
          <div className="loading">
            <Loader2 className="spin" size={18} />
            Chargement des sites détectés…
          </div>
        ) : !filtered.length ? (
          <EmptyState
            icon={Link2}
            title="Aucun projet disponible"
            description={
              query || provider
                ? "Essayez une autre recherche ou un autre hébergeur."
                : "Connectez votre hébergeur ou synchronisez ses sites depuis Connexions."
            }
          />
        ) : (
          <fieldset
            className="existing-project-list"
            disabled={busy || !!createdId}
          >
            <legend className="sr-only">Projet à lier</legend>
            {filtered.map((item) => (
              <label key={item.key}>
                <input
                  type="radio"
                  name="existing-project"
                  checked={selected === item.key}
                  onChange={() => setSelected(item.key)}
                />
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.description}</small>
                  {item.projectId && <small>Déjà suivi dans votre parc</small>}
                </span>
                <ProviderBadge name={item.provider} />
              </label>
            ))}
          </fieldset>
        )}
        <p className="existing-project-hint">
          Un site manque ou nécessite un rattachement manuel ?{" "}
          <button
            className="text-button"
            disabled={busy}
            onClick={onConnections}
          >
            Ouvrir les connexions
          </button>
        </p>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button className="button secondary" disabled={busy} onClick={onBack}>
          <ArrowLeft size={15} />
          Retour
        </button>
        <button
          className="button primary"
          disabled={!choice || busy || loading}
          onClick={submit}
        >
          {busy ? <Loader2 size={15} className="spin" /> : <Link2 size={15} />}
          {choice?.projectId ? "Ouvrir la fiche" : "Lier et ajouter au parc"}
        </button>
      </div>
    </Modal>
  );
}
