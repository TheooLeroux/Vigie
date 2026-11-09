"use client";
import { useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Building2,
  Link2,
  Pencil,
  Plus,
  Search,
} from "lucide-react";
import type { Client, Project, WorkspaceData } from "@/lib/types";
import { domain, EmptyState, OutLink } from "./ui";
import { RecordLink } from "./record-link";

export const unassignedClientFilter = "unassigned";
export const unassignedProjectsHref = `/?view=sites&clientFilter=${unassignedClientFilter}`;
export function isActiveUnassignedProject(project: Project) {
  return project.lifecycle === "active" && !project.clientId;
}

export function ClientsPanel({
  data,
  client,
  onSelect,
  onCreate,
  onEdit,
  onProject,
  onAddProject,
  onLinkProject,
  onUnassignedProjects,
  renderProviders,
}: {
  data: WorkspaceData;
  client?: Client;
  onSelect: (id: string | null) => void;
  onCreate: () => void;
  onEdit: (client: Client) => void;
  onProject: (id: string) => void;
  onAddProject: () => void;
  onLinkProject: () => void;
  onUnassignedProjects: () => void;
  renderProviders: (projectId: string) => ReactNode;
}) {
  const [query, setQuery] = useState("");
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
        <header className="client-detail-header">
          <div className="page-heading">
            <h1>{client.name}</h1>
            <button className="button secondary" onClick={() => onEdit(client)}>
              <Pencil size={15} />
              Modifier
            </button>
          </div>
          {(client.contactName || client.email || client.phone || client.website) && (
            <dl className="client-contact">
              {client.contactName && <div><dt>Contact</dt><dd>{client.contactName}</dd></div>}
              {client.email && <div><dt>Email</dt><dd><a href={`mailto:${client.email}`}>{client.email}</a></dd></div>}
              {client.phone && <div><dt>Téléphone</dt><dd>{client.phone}</dd></div>}
              {client.website && <div><dt>Site</dt><dd><OutLink href={client.website}>{domain(client.website)}</OutLink></dd></div>}
            </dl>
          )}
          {client.notes && <p className="client-notes">{client.notes}</p>}
        </header>
        <section className="panel client-projects">
          <div className="panel-heading">
            <div className="panel-title-line"><h2>Sites & applications</h2><span className="badge neutral">{sites.length}</span></div>
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
                      <td>{renderProviders(p.id)}</td>
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
  const unassigned = data.projects.filter(isActiveUnassignedProject).length;
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
        <RecordLink className="client-unassigned" href={unassignedProjectsHref} onNavigate={onUnassignedProjects}>
          {unassigned} projet{unassigned === 1 ? "" : "s"} à rattacher
        </RecordLink>
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
