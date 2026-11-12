import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { database, get } from "./db";
import { ApiError } from "./http";
import { authDatabase, isPostgres } from "./storage";
import { backupDirectory, backupLeaseMs, backupStores, hashBackupStream, type BackupStore } from "./backup-store";
import type { Project } from "./types";

type BackupRow = {
  id: string;
  project_id: string | null;
  source_id: string;
  source_name: string | null;
  slot: string;
  owner: string;
  created_at: string;
  bytes: number | string;
  storage_id: string;
  sha256: string | null;
};

export type BackupGroup = {
  id: string;
  projectId: string | null;
  projectName: string;
  latestAttempt: { slot: string; state: "ready" | "failed" | "running" | "interrupted" | "unavailable" | "unverified" };
  backups: { id: string; createdAt: string }[];
};
type SiteBackup = { installationId: string; projectId: string | null; domain: string };
export type LinkedPlatformBackup = { provider: "railway" | "vercel"; remoteId: string; projectId: string };

const backupSchema = `CREATE TABLE IF NOT EXISTS project_backups (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  source_id TEXT NOT NULL,
  source_name TEXT,
  slot TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('running','failed','ready','expired')),
  owner TEXT NOT NULL,
  next_attempt_at TEXT NOT NULL,
  created_at TEXT,
  bytes BIGINT,
  storage_id TEXT NOT NULL DEFAULT 'local',
  sha256 TEXT,
  UNIQUE(source_id, slot)
);
CREATE INDEX IF NOT EXISTS project_backups_state ON project_backups(source_id, state, created_at);
CREATE TABLE IF NOT EXISTS backup_pending_uploads (
  owner TEXT PRIMARY KEY,
  storage_id TEXT NOT NULL,
  discard_after TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS backup_pending_uploads_due ON backup_pending_uploads(storage_id, discard_after);
CREATE TABLE IF NOT EXISTS backup_account_leases (
  account_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at TEXT NOT NULL
);`;

function backupDatabase() {
  const db = database();
  if (isPostgres()) return db;
  const sqlite = authDatabase() as import("node:sqlite").DatabaseSync;
  const columns = () => sqlite.prepare("PRAGMA table_info(project_backups)").all().map(column => column.name);
  const before = columns();
  if (before.length && !before.includes("storage_id")) {
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      const current = columns();
      if (!current.includes("source_id")) {
        sqlite.exec(`ALTER TABLE project_backups RENAME TO project_backups_legacy;
          DROP INDEX IF EXISTS project_backups_state;
          ${backupSchema}
          INSERT INTO project_backups (id,project_id,source_id,slot,state,owner,next_attempt_at,created_at,bytes)
          SELECT id,project_id,'project:' || project_id,slot,state,owner,next_attempt_at,created_at,bytes FROM project_backups_legacy;
          DROP TABLE project_backups_legacy;`);
      } else if (!current.includes("storage_id")) {
        sqlite.exec(`ALTER TABLE project_backups ADD COLUMN storage_id TEXT NOT NULL DEFAULT 'local';
          ALTER TABLE project_backups ADD COLUMN sha256 TEXT;
          ${backupSchema}`);
      }
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  } else {
    sqlite.exec(backupSchema);
  }
  return db;
}

const paris = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

export async function claimBackupAccount(accountId: string) {
  const db = backupDatabase();
  const owner = randomUUID();
  const now = new Date();
  const claim = await db.prepare(`INSERT INTO backup_account_leases(account_id,owner,expires_at) VALUES(?,?,?)
    ON CONFLICT(account_id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
    WHERE backup_account_leases.expires_at<=?`)
    .run(accountId, owner, new Date(now.getTime() + backupLeaseMs).toISOString(), now.toISOString());
  if (!claim.changes) return null;
  return async () => { await db.prepare("DELETE FROM backup_account_leases WHERE account_id=? AND owner=?").run(accountId, owner); };
}

function parisParts(date: Date) {
  return Object.fromEntries(paris.formatToParts(date).map(part => [part.type, part.value]));
}

export function dueBackupSlot(now: Date) {
  const { year, month, day, hour, minute } = parisParts(now);
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  const beforeMondaySlot = daysSinceMonday === 0 && hour + minute < "0313";
  date.setUTCDate(date.getUTCDate() - daysSinceMonday - (beforeMondaySlot ? 7 : 0));
  return date.toISOString().slice(0, 10);
}

export function expiredBackupIds(rows: { id: string; created_at: string; slot: string }[], now: Date) {
  const { year, month } = parisParts(now);
  const cutoff = Number(year) * 12 + Number(month) - 11;
  const months = new Set<number>();
  return [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.slot.localeCompare(a.slot))
    .flatMap((row, index) => {
      const local = parisParts(new Date(row.created_at));
      const monthIndex = Number(local.year) * 12 + Number(local.month);
      const monthly = monthIndex >= cutoff && !months.has(monthIndex);
      if (monthly) months.add(monthIndex);
      return index < 5 || monthly ? [] : [row.id];
    });
}

function archiveFilename(name: string, createdAt: string) {
  const slug = name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").slice(0, 80).replace(/^-|-$/g, "") || "site";
  return `${slug}-${createdAt.slice(0, 10)}.zip`;
}

const readyBackups = `
  SELECT b.*, COALESCE(b.source_name,json_extract(p.data,'$.name')) AS project_name
  FROM project_backups b LEFT JOIN projects p ON p.id=b.project_id AND p.workspace='live'
  WHERE b.state='ready' AND (b.source_name IS NOT NULL OR p.id IS NOT NULL)
`;
type DownloadableBackup = BackupRow & { project_name: string };

type BackupListingRow = DownloadableBackup & {
  state: "ready" | "failed" | "running" | "expired";
  next_attempt_at: string;
  latest: boolean;
};

export async function listBackups(now = new Date()): Promise<BackupGroup[]> {
  const { byId } = backupStores();
  const rows = await backupDatabase().prepare(`
    WITH attempts AS (
      SELECT b.*, COALESCE(b.source_name,json_extract(p.data,'$.name')) AS project_name,
        ROW_NUMBER() OVER (PARTITION BY b.source_id ORDER BY b.slot DESC)=1 AS latest
      FROM project_backups b LEFT JOIN projects p ON p.id=b.project_id AND p.workspace='live'
      WHERE b.source_name IS NOT NULL OR p.id IS NOT NULL
    )
    SELECT * FROM attempts WHERE latest OR state='ready'
    ORDER BY source_id, latest DESC, created_at DESC, slot DESC
  `).all() as BackupListingRow[];
  const remoteChecks = new Map<string, boolean | undefined>();
  const latestRemoteCopies = rows.filter(row => row.latest && row.state === "ready" && row.storage_id !== "local" && byId.has(row.storage_id));
  for (let offset = 0; offset < latestRemoteCopies.length; offset += 6) {
    await Promise.all(latestRemoteCopies.slice(offset, offset + 6).map(async row => {
      const exists = await byId.get(row.storage_id)!.exists(row).catch(() => undefined);
      remoteChecks.set(row.id, exists);
    }));
  }
  const groups = new Map<string, BackupGroup>();
  for (const row of rows) {
    const store = byId.get(row.storage_id);
    const downloadable = row.state === "ready" && store && (store.id === "local" ? await store.exists(row) : remoteChecks.get(row.id) !== false);
    if (row.latest) {
      const remoteUnverified = remoteChecks.has(row.id) && remoteChecks.get(row.id) === undefined;
      const state = downloadable ? (remoteUnverified ? "unverified" : "ready") : row.state === "failed" ? "failed" : row.state === "running"
        ? Date.parse(row.next_attempt_at) > now.getTime() ? "running" : "interrupted"
        : "unavailable";
      groups.set(row.source_id, { id: row.source_id, projectId: row.project_id, projectName: row.project_name,
        latestAttempt: { slot: row.slot, state }, backups: [] });
    }
    if (downloadable) groups.get(row.source_id)!.backups.push({ id: row.id, createdAt: row.created_at });
  }
  return [...groups.values()].sort((left, right) => left.projectName.localeCompare(right.projectName, "fr"));
}

export async function downloadBackup(id: string) {
  const { byId } = backupStores();
  const missing = () => new ApiError("Sauvegarde introuvable.", 404);
  if (!byId.size) throw missing();
  const row = await backupDatabase().prepare(readyBackups + " AND b.id=?").get(id) as DownloadableBackup | undefined;
  if (!row) throw missing();
  const response = await byId.get(row.storage_id)?.download(row, archiveFilename(row.project_name, row.created_at));
  if (!response) throw missing();
  return response;
}

async function purgeBackups(db: ReturnType<typeof backupDatabase>, stores: Map<string, BackupStore>, sourceId: string, now: Date) {
  const rows = await db.prepare("SELECT * FROM project_backups WHERE source_id=? AND state='ready'").all(sourceId) as BackupRow[];
  // A missing archive must not evict a good copy from either retention tier.
  const present = [];
  for (const row of rows) if (await stores.get(row.storage_id)?.exists(row)) present.push(row);
  for (const id of expiredBackupIds(present, now)) {
    await db.prepare("UPDATE project_backups SET state='expired' WHERE id=? AND state='ready'").run(id);
  }
  const expired = await db.prepare("SELECT owner,storage_id FROM project_backups WHERE source_id=? AND state='expired' AND bytes IS NOT NULL").all(sourceId) as Pick<BackupRow, "owner" | "storage_id">[];
  for (const row of expired) {
    const store = stores.get(row.storage_id);
    if (!store) continue;
    await store.remove(row.owner);
    await db.prepare("UPDATE project_backups SET bytes=NULL WHERE owner=? AND state='expired'").run(row.owner);
  }
}

export async function cleanupAbandonedBackupUploads(now = new Date()) {
  const { remote } = backupStores();
  if (!remote) return;
  const db = backupDatabase();
  await db.prepare(`DELETE FROM backup_pending_uploads WHERE storage_id=? AND EXISTS (
    SELECT 1 FROM project_backups b WHERE b.owner=backup_pending_uploads.owner AND b.state='ready'
  )`).run(remote.id);
  const candidates = await db.prepare(`SELECT owner FROM backup_pending_uploads
    WHERE storage_id=? AND discard_after<=? AND NOT EXISTS (
      SELECT 1 FROM project_backups b WHERE b.owner=backup_pending_uploads.owner
        AND (b.state='ready' OR (b.state='running' AND b.next_attempt_at>?))
    ) ORDER BY discard_after LIMIT 20
  `).all(remote.id, now.toISOString(), now.toISOString()) as { owner: string }[];
  for (const row of candidates) {
    await remote.remove(row.owner);
    await db.prepare("DELETE FROM backup_pending_uploads WHERE owner=?").run(row.owner);
  }
}

export async function verifyBackupRoundtrip(collectVerifiedZip: (folder: string, zip: string) => Promise<void>) {
  const { remote } = backupStores();
  const scratch = backupDirectory("VIGIE_BACKUP_SCRATCH_DIRECTORY");
  if (!remote || !scratch) throw new Error("La vérification R2 exige un espace de travail privé et le stockage distant.");
  const dir = await lstat(scratch);
  if (!dir.isDirectory() || (process.platform !== "win32" && (dir.mode & 0o077))) {
    throw new Error("Le répertoire temporaire doit être privé.");
  }
  const db = backupDatabase();
  const folder = await mkdtemp(join(scratch, ".r2-verify-"));
  const zip = join(folder, "verification.zip");
  const owner = randomUUID();
  try {
    await collectVerifiedZip(folder, zip);
    const info = await lstat(zip);
    if (!info.isFile() || info.size === 0) throw new Error("ZIP de vérification absent ou vide.");
    await db.prepare("INSERT INTO backup_pending_uploads(owner,storage_id,discard_after) VALUES(?,?,?)")
      .run(owner, remote.id, new Date(Date.now() + 2 * backupLeaseMs).toISOString());
    try {
      const sha256 = await remote.publish(zip, owner, info.size, "verification.zip");
      const signed = sha256 && await remote.download({ owner, bytes: info.size, sha256 }, "verification.zip");
      const url = signed && signed.headers.get("Location");
      if (!url) throw new Error("Lien de téléchargement R2 indisponible.");
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10 * 60_000) }).catch(() => null);
      if (!response?.ok || !response.body) throw new Error("Téléchargement R2 de vérification en échec.");
      const check = await hashBackupStream(response.body, info.size).catch(() => {
        throw new Error("Lecture du ZIP R2 de vérification interrompue.");
      });
      if (check.bytes !== info.size || check.digest !== sha256) throw new Error("Empreinte du ZIP téléchargé incohérente.");
      return check.bytes;
    } finally {
      await remote.remove(owner);
      await db.prepare("DELETE FROM backup_pending_uploads WHERE owner=?").run(owner);
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

export async function runBackup(
  source: string | SiteBackup | LinkedPlatformBackup,
  collectVerifiedZip: (folder: string, zip: string) => Promise<void>,
  now = new Date(),
) {
  const { byId, remote, destination, directory } = backupStores();
  if (!destination) throw new Error("Configurez un stockage de sauvegarde pour lancer la collecte.");
  const scratch = remote ? backupDirectory("VIGIE_BACKUP_SCRATCH_DIRECTORY") || join(tmpdir(), "vigie-backup-scratch") : directory!;
  const projectId = typeof source === "string" ? source : source.projectId;
  const sourceId = typeof source === "string" ? "project:" + source :
    "provider" in source ? source.provider + ":" + source.remoteId : "o2switch:" + source.installationId;
  const sourceName = typeof source === "object" && "domain" in source ? source.domain : null;
  const project = projectId ? await get<Project>("projects", projectId, "live") : null;
  if (projectId && project?.lifecycle !== "active") {
    throw new Error("Projet actif introuvable.");
  }
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const dir = await lstat(scratch);
  if (!dir.isDirectory() || (process.platform !== "win32" && (dir.mode & 0o077))) {
    throw new Error("Le dossier de sauvegardes doit être privé et appartenir à l’exécuteur.");
  }
  const db = backupDatabase();
  const slot = dueBackupSlot(now);
  const owner = randomUUID();
  const start = now.toISOString();
  const lease = new Date(now.getTime() + backupLeaseMs).toISOString();
  const claimed = await db.prepare(`
    INSERT INTO project_backups(id,project_id,source_id,source_name,slot,state,owner,next_attempt_at,storage_id)
    VALUES(?,?,?,?,?,'running',?,?,?)
    ON CONFLICT(source_id,slot) DO UPDATE SET state='running',owner=excluded.owner,next_attempt_at=excluded.next_attempt_at,
      project_id=excluded.project_id,source_name=excluded.source_name,storage_id=excluded.storage_id
    WHERE project_backups.state IN ('running','failed') AND project_backups.next_attempt_at<=?
  `).run(randomUUID(), projectId, sourceId, sourceName, slot, owner, lease, destination.id, start);
  if (!claimed.changes) {
    if (await db.prepare("SELECT id FROM project_backups WHERE source_id=? AND slot=? AND state='ready'").get(sourceId, slot)) {
      await purgeBackups(db, byId, sourceId, now);
    }
    return false;
  }

  let folder: string | undefined;
  let publishing = false;
  try {
    folder = await mkdtemp(join(scratch, ".capture-"));
    const zip = join(folder, "backup.zip");
    await collectVerifiedZip(folder, zip);
    const info = await lstat(zip);
    if (!info.isFile() || info.size === 0) throw new Error("ZIP absent ou vide.");
    if (remote) {
      await db.prepare("INSERT INTO backup_pending_uploads(owner,storage_id,discard_after) VALUES(?,?,?)")
        .run(owner, remote.id, new Date(now.getTime() + 2 * backupLeaseMs).toISOString());
    }
    publishing = true;
    const digest = await destination.publish(zip, owner, info.size, archiveFilename(sourceName ?? project?.name ?? "site", start));
    const result = await db.prepare(`
      UPDATE project_backups SET state='ready',created_at=?,bytes=?,sha256=? WHERE owner=? AND state='running'
    `).run(start, info.size, digest, owner);
    if (!result.changes) throw new Error("La sauvegarde a perdu sa réservation.");
  } catch (error) {
    // On a lost connection during publication, the catalogue may already point to this file.
    const failed = await db.prepare(`
      UPDATE project_backups SET state='failed',next_attempt_at=? WHERE owner=? AND state='running'
    `).run(new Date(now.getTime() + 15 * 60_000).toISOString(), owner);
    if (publishing && failed.changes) {
      try {
        await destination.remove(owner);
      } catch {
        console.error("Nettoyage de l’archive interrompue en attente.");
      }
    }
    throw error;
  } finally {
    if (folder) {
      const pathFromStore = relative(
        await realpath(/* turbopackIgnore: true */ scratch),
        await realpath(/* turbopackIgnore: true */ folder),
      );
      if (!/^\.capture-[a-zA-Z0-9]+$/.test(pathFromStore)) throw new Error("Dossier temporaire de sauvegarde inattendu.");
      await rm(folder, { recursive: true, force: true });
    }
  }
  if (remote) await db.prepare("DELETE FROM backup_pending_uploads WHERE owner=?").run(owner);
  await purgeBackups(db, byId, sourceId, now);
  return true;
}
