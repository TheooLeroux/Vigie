import { Client } from "pg";
import type { PlatformBackupTarget } from "./platform-backup-targets";

export async function assertPlatformBackupLink(target: PlatformBackupTarget & { connectionId?: string }) {
  const connectionString = process.env.VIGIE_BACKUP_INVENTORY_DATABASE_URL;
  if (!connectionString) throw new Error("Accès de lecture à l’inventaire des sauvegardes manquant.");
  const client = new Client({ connectionString, connectionTimeoutMillis: 10_000, statement_timeout: 10_000 });
  try {
    await client.connect();
    const { rows } = await client.query<{ eligible: boolean }>(`
      SELECT project_id = $3 AND active AND NOT connection_error AND
        ($4::text IS NULL OR connection_id = $4) AND
        (provider = 'railway' OR COALESCE(remote->>'excluded', 'false') = 'false') AS eligible
      FROM backup_platform_inventory
      WHERE provider = $1 AND remote_id = $2 AND missing_since IS NULL AND configured
    `, [target.provider, target.remoteId, target.projectId, target.connectionId ?? null]);
    if (rows.length === 1 && rows[0].eligible) return;
  } catch {
    throw new Error("La vérification du lien de production a échoué.");
  } finally {
    await client.end();
  }
  throw new Error("Le lien de production a été retiré, désactivé ou modifié.");
}
