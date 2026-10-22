import { DatabaseSync, backup } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { postgresPool } from "../src/lib/storage";
import { migratePostgres } from "./migrate-postgres";

async function main() {
  if (!process.argv.includes("--apply")) throw new Error("Arrêter Vigie puis relancer avec --apply. La cible doit être vide.");
  if (!/^[a-f0-9]{64}$/i.test(process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY || ""))
    throw new Error("Conserver la clé de chiffrement d'origine dans VIGIE_CONNECTOR_ENCRYPTION_KEY.");
  const source = new DatabaseSync(resolve(process.env.VIGIE_DB_PATH || ".data/vigie.sqlite"), { readOnly: true });
  const backupPath = resolve(`.data/backups/avant-neon-${Date.now()}.sqlite`);
  mkdirSync(dirname(backupPath), { recursive: true });
  await backup(source, backupPath);
  source.close();
  const snapshot = new DatabaseSync(backupPath, { readOnly: true });
  const integrity = snapshot.prepare("PRAGMA integrity_check").get();
  if (Object.values(integrity!)[0] !== "ok" || snapshot.prepare("PRAGMA foreign_key_check").all().length)
    throw new Error("La sauvegarde SQLite ne passe pas les contrôles d'intégrité.");
  await migratePostgres();
  const client = await postgresPool().connect();
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SELECT pg_advisory_xact_lock(736452091)");
    const tables = ["clients", "projects", "metadata", "migrations", "environments", "services", "accesses", "resources", "inventories", "components", "activity", "user", "session", "account", "verification", "hosting_connections", "hosting_installations", "hosting_discovery_runs", "hosting_site_inventories", "hosting_observers", "wordpress_catalog", "railway_connections", "railway_projects", "software_release_catalog", "vercel_connections", "vercel_projects", "vercel_client_links"];
    await client.query(`LOCK TABLE ${tables.map(quote).join(",")} IN EXCLUSIVE MODE`);
    for (const table of tables) {
      if ((await client.query(`SELECT 1 FROM ${quote(table)} LIMIT 1`)).rowCount)
        throw new Error(`Import refusé : la table ${table} contient déjà des données.`);
    }
    for (const table of tables) {
      const rows = snapshot.prepare(`SELECT * FROM ${quote(table)}`).all();
      const columns = snapshot.prepare(`PRAGMA table_info(${quote(table)})`).all() as { name: string; type: string }[];
      const converted = rows.map(row => Object.fromEntries(columns.map(column => {
        let value = row[column.name];
        if (column.type.toLowerCase() === "date" && value !== null)
          value = new Date(typeof value === "number" || /^\d+$/.test(String(value)) ? Number(value) : String(value)).toISOString();
        if (column.name === "emailVerified") value = !!value as never;
        return [column.name, value];
      })));
      for (const row of converted) {
        await client.query(`INSERT INTO ${quote(table)}(${columns.map(column => quote(column.name)).join(",")}) VALUES(${columns.map((_, index) => `$${index + 1}`).join(",")})`, columns.map(column => row[column.name]));
      }
      const imported = (await client.query(`SELECT * FROM ${quote(table)}`)).rows;
      const canonical = (row: Record<string, unknown>) => JSON.stringify(columns.map(column => {
        const value = row[column.name];
        return value instanceof Date ? value.toISOString() : value;
      }));
      if (JSON.stringify(converted.map(canonical).sort()) !== JSON.stringify(imported.map(canonical).sort()))
        throw new Error(`Vérification échouée : ${table}. Transaction annulée.`);
      console.log(`${table} : ${rows.length} lignes vérifiées.`);
    }
    await client.query("COMMIT");
    console.log(`Import terminé. Sauvegarde : ${backupPath}`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { snapshot.close(); client.release(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(() => postgresPool().end());
