"use client";
import { useState } from "react";
import {
  ArrowLeft,
  Building2,
  Link2,
  Pencil,
  Plus,
  Search,
} from "lucide-react";
import type { Client, WorkspaceData } from "@/lib/types";
import { domain, EmptyState, OutLink, ProviderBadge } from "./ui";
import { RecordLink } from "./record-link";

export function ClientsPanel({
  data,
  selectedId,
  onSelect,
  onCreate,
  onEdit,
  onProject,
  onAddProject,
  onLinkProject,
}: {
  data: WorkspaceData;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: () => void;
  onEdit: (client: Client) => void;
  onProject: (id: string) => void;
  onAddProject: () => void;
  onLinkProject: () => void;
}) {
  const [query, setQuery] = useState("");
  const client = data.clients.find((c) => c.id === selectedId);
  if (client) {
    const sites = data.projects
      .filter((p) => p.clientId === client.id)
      .sort((a, b) => a.name.localeCompare(b.name, "fr"));
    return (
      <>
        <button className="back-link" onClick={() => onSelect(null)}>
          <ArrowLeft size={15} />
          Tous les clients
        </button>
        <section className="panel client-summary">
          <div className="panel-heading">
            <div>
              <h2>{client.name}</h2>
              <p>
                {sites.length} site{sites.length > 1 ? "s" : ""} rattaché
                {sites.length > 1 ? "s" : ""}
              </p>
            </div>
            <button className="button secondary" onClick={() => onEdit(client)}>
              <Pencil size={15} />
              Modifier
            </button>
          </div>
          <dl className="client-contact">
            <div>
              <dt>Contact</dt>
              <dd>{client.contactName || "Non renseigné"}</dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd>
                {client.email ? (
                  <a href={`mailto:${client.email}`}>{client.email}</a>
                ) : (
                  "Non renseigné"
                )}
              </dd>
            </div>
            <div>
              <dt>Téléphone</dt>
              <dd>{client.phone || "Non renseigné"}</dd>
            </div>
            <div>
              <dt>Site</dt>
              <dd>
                {client.website ? (
                  <OutLink href={client.website}>
                    {domain(client.website)}
                  </OutLink>
                ) : (
                  "Non renseigné"
                )}
              </dd>
            </div>
          </dl>
          {client.notes && <p className="client-notes">{client.notes}</p>}
        </section>
        <section className="panel">
          <div className="panel-heading">
            <h2>Sites & applications</h2>
            <div className="heading-actions">
              <button className="button secondary" onClick={onLinkProject}>
                <Link2 size={15} />
                Rattacher un site
              </button>
              <button className="button primary" onClick={onAddProject}>
                <Plus size={15} />
                Ajouter un site
              </button>
            </div>
          </div>
          {!sites.length ? (
            <EmptyState
              title="Aucun site rattaché"
              description="Rattachez un site du parc ou ajoutez-en un pour ce client."
            />
          ) : (
            <div className="table-scroll">
              <table className="project-table">
                <thead>
                  <tr>
                    <th>Site</th>
                    <th>Hébergement</th>
                  </tr>
                </thead>
                <tbody>
                  {sites.map((p) => (
                    <tr key={p.id} className="record-row">
                      <td>
                        <RecordLink
                          className="project-name-cell"
                          href={`/?project=${encodeURIComponent(p.id)}`}
                          onNavigate={() => onProject(p.id)}
                          stretch
                        >
                          <span>
                            <strong>{p.name}</strong>
                            <small>{domain(p.url)}</small>
                          </span>
                        </RecordLink>
                      </td>
                      <td>
                        <ProviderBadge
                          name={
                            data.services.find((s) => s.projectId === p.id)
                              ?.provider || ""
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </>
    );
  }
  const clients = data.clients.filter((c) =>
    [
      c.name,
      c.contactName,
      c.email,
      ...data.projects.filter((p) => p.clientId === c.id).map((p) => p.name),
    ]
      .join(" ")
      .toLocaleLowerCase("fr")
      .includes(query.toLocaleLowerCase("fr")),
  );
  const unassigned = data.projects.filter((p) => !p.clientId);
  return (
    <section className="panel">
      <div className="filter-toolbar">
        <div className="search-input">
          <Search size={17} />
          <input
            aria-label="Rechercher un client"
            placeholder="Rechercher un client, un contact, un site…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <span className="subtle">
          {unassigned.length} site{unassigned.length > 1 ? "s" : ""} à rattacher
        </span>
      </div>
      {!clients.length ? (
        <EmptyState
          icon={Building2}
          title={
            query ? "Aucun client ne correspond" : "Aucun client enregistré"
          }
          description={
            query
              ? "Essayez un autre nom ou un nom de site."
              : "Créez une fiche client, puis rattachez ses sites depuis le parc."
          }
          action={
            !query && (
              <button className="button primary" onClick={onCreate}>
                <Plus size={15} />
                Ajouter un client
              </button>
            )
          }
        />
      ) : (
        <div className="table-scroll">
          <table className="project-table client-table">
            <thead>
              <tr>
                <th>Client</th>
                <th>Contact</th>
                <th>Sites</th>
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.id} className="record-row">
                  <td>
                    <RecordLink
                      className="project-name-cell"
                      href={`/?client=${encodeURIComponent(c.id)}`}
                      onNavigate={() => onSelect(c.id)}
                      stretch
                    >
                      <span className="client-avatar">
                        <Building2 size={18} />
                      </span>
                      <strong>{c.name}</strong>
                    </RecordLink>
                  </td>
                  <td>
                    <span>{c.contactName || "Non renseigné"}</span>
                    {c.email && (
                      <small className="client-email">{c.email}</small>
                    )}
                  </td>
                  <td>
                    {data.projects.filter((p) => p.clientId === c.id).length}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
