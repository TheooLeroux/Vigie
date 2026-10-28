import "./auth-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import { hostingStorage } from "../src/lib/hosting-storage";
import { catalogUpdate } from "../src/lib/connectors/wordpress-catalog";
import { enrichVercelTechnologies } from "../src/lib/connectors/vercel-analysis";
import { database } from "../src/lib/db";
import type { VercelAnalysis } from "../src/lib/vercel-types";

test("Catalogues horaires : les anciennes entrées de six heures sont ignorées dès le déploiement", async () => {
  const db = await hostingStorage(), before = Date.now();
  await db.prepare("INSERT INTO wordpress_catalog(cache_key,data,expires_at) VALUES(?,?,?)").run("plugin:hourly-fixture", JSON.stringify({ version: "1.0", checkedAt: new Date().toISOString(), found: true }), new Date(before + 6 * 3600_000).toISOString());
  let calls = 0;
  const transport = (async () => { calls++; return Response.json({ slug: "hourly-fixture", version: "2.0" }); }) as typeof fetch;
  const first = await catalogUpdate("plugin", "hourly-fixture", "1.0", transport);
  assert.equal(first.latestVersion, "2.0");
  assert.equal(first.updateState, "available");
  await catalogUpdate("plugin", "hourly-fixture", "1.0", transport);
  assert.equal(calls, 1);
  const row = await db.prepare("SELECT expires_at FROM wordpress_catalog WHERE cache_key=?").get("plugin:hourly-fixture:hourly:1") as { expires_at: string };
  assert.ok(Date.parse(row.expires_at) <= Date.now() + 3600_000);
  assert.ok(Date.parse(row.expires_at) >= before + 3600_000);
});

test("Catalogue Vercel : versions npm renouvelées à une heure et ancien cache écarté", async () => {
  const db = database();
  await db.initialize("CREATE TABLE IF NOT EXISTS software_release_catalog(cache_key TEXT PRIMARY KEY,data TEXT NOT NULL,expires_at TEXT NOT NULL)");
  await db.prepare("INSERT INTO software_release_catalog(cache_key,data,expires_at) VALUES(?,?,?)").run("npm:public:next", JSON.stringify({ version: "15.0.0", checkedAt: new Date().toISOString() }), new Date(Date.now() + 6 * 3600_000).toISOString());
  const analysis: VercelAnalysis = { status: "observed", checkedAt: new Date().toISOString(), truncated: false, languages: [], runtimes: [], technologies: [{ name: "next", version: "16.0.0", usage: "framework", source: "build-log" }] };
  await enrichVercelTechnologies([analysis], (async () => Response.json({ name: "next", version: "16.4.2" })) as typeof fetch);
  assert.equal(analysis.technologies[0].latestVersion, "16.4.2");
  const row = await db.prepare("SELECT expires_at FROM software_release_catalog WHERE cache_key=?").get("npm:public:next:hourly:1") as { expires_at: string };
  assert.ok(Date.parse(row.expires_at) <= Date.now() + 3600_000);
});
