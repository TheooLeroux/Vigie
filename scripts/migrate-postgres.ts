import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { postgresPool } from "../src/lib/storage";

export async function migratePostgres() {
  const client = await postgresPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(736452091)");
    await client.query("CREATE TABLE IF NOT EXISTS vigie_schema_migrations(name TEXT PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())");
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of (await readdir(directory)).filter(name => name.endsWith(".sql")).sort()) {
      if ((await client.query("SELECT name FROM vigie_schema_migrations WHERE name=$1", [name])).rowCount) continue;
      await client.query(await readFile(new URL(name, directory), "utf8"));
      await client.query("INSERT INTO vigie_schema_migrations(name) VALUES($1)", [name]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migratePostgres().then(() => console.log("Schéma PostgreSQL à jour."))
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => postgresPool().end());
}
