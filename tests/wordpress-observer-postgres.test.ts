import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";

test("PostgreSQL : installation et mise à niveau réelles du connecteur simulé, clé conservée et fichier inconnu protégé", { skip: !process.env.VIGIE_UPDATES_TEST_DATABASE_URL }, async () => {
  const url = new URL(process.env.VIGIE_UPDATES_TEST_DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  const admin = new Pool({ connectionString: url.href });
  const schema = `vigie_observer_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set("options", `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.href;
  delete process.env.VIGIE_DB_PATH;
  process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  const { postgresPool } = await import("../src/lib/storage");
  const pool = postgresPool();
  try {
    for (const name of (await readdir(new URL("../migrations/", import.meta.url))).filter(name => name.endsWith(".sql")).sort()) await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    const { createProject } = await import("../src/lib/db");
    const { createProjectSchema } = await import("../src/lib/validation");
    const { saveHostingConnection } = await import("../src/lib/hosting-connections");
    const { applyDiscoverySnapshot, hostingDiscovery } = await import("../src/lib/hosting-discovery");
    const { installObserver } = await import("../src/lib/hosting-inventory");
    const project = await createProject("live", createProjectSchema.parse({ name: "Postgres observer", url: "https://observer.example.org/" }));
    const connection = await saveHostingConnection({ name: "Fixture", endpoint: "https://gaz.o2switch.net:2083", username: "pgfixture", authMode: "token", secret: "fake-test-only" });
    const root = "/home/pgfixture/site";
    await applyDiscoverySnapshot(connection, { observedAt: new Date().toISOString(), installations: [{ documentRoot: root, domains: ["observer.example.org"], aliases: [], kind: "wordpress", version: "7.1.3", inspectionError: null, suggestedEnvironment: "production" }] });
    const site = (await hostingDiscovery(connection.id)).installations[0];
    assert.equal(site.project?.id, project.id);
    let uploaded = "", uploads = 0;
    const hash = () => createHash("sha256").update(uploaded).digest("hex");
    const transport = (async (input, options) => {
      const url = new URL(String(input));
      if (url.hostname === "www.php.net") return Response.json({ version: "8.3.31", tags: [], supported_versions: ["8.3", "8.4"] });
      if (url.hostname === "observer.example.org") {
        const nonce = new Headers(options?.headers).get("X-Vigie-Nonce");
        const update = { latestVersion: "7.1.3", updateState: "current", updateCheckedAt: new Date().toISOString(), updateSource: "wordpress" };
        return Response.json({ format: "vigie.wordpress.v1", nonce, collectedAt: new Date().toISOString(), documentRoot: root, wordpress: { version: "7.1.3", ...update }, php: { version: "8.3.31", scope: "web", sapi: "litespeed", limits: {}, extensions: [] }, site: { name: "Fixture", url: "https://observer.example.org/", home: "https://observer.example.org/", locale: "fr_FR", timezone: "Europe/Paris", multisite: false, searchEnginesVisible: true, https: true }, configuration: { debug: false, debugDisplay: false, cronDisabled: false, fileEditDisabled: true, fileModsDisabled: false, pageCache: false, objectCache: false }, database: { version: "10.11.0" }, plugins: [], themes: [] });
      }
      assert.equal(url.hostname, "gaz.o2switch.net");
      let data: unknown;
      if (url.pathname.endsWith("/upload_files")) {
        const form = options!.body as FormData;
        assert.equal(form.get("overwrite"), uploaded ? "1" : "0");
        uploaded = await (form.get("file-1") as File).text(); uploads++;
        data = { succeeded: 1 };
      } else if (url.pathname.endsWith("/list_files")) {
        data = url.searchParams.get("dir")?.endsWith("mu-plugins") ? uploaded ? [{ file: "vigie-observer.php", type: "file", size: uploaded.length }] : [] : [{ file: "mu-plugins", type: "dir" }];
      } else if (url.pathname.endsWith("/get_file_content")) data = { content: uploaded };
      else assert.fail("Unexpected cPanel operation");
      return Response.json({ result: { status: 1, data } });
    }) as typeof fetch;
    const dns = (async () => [{ address: "109.234.161.69", family: 4 }]) as any;
    assert.equal((await installObserver(site.id, true, transport, dns)).installation.observerConfigured, true);
    const first = (await pool.query("SELECT secret_cipher,data FROM hosting_observers WHERE installation_id=$1", [site.id])).rows[0];
    assert.equal(JSON.parse(first.data).sourceSha256, hash());
    uploaded = uploaded.replace("Version: 1.0.5", "Version: 1.0.4");
    await pool.query("UPDATE hosting_observers SET data=$1 WHERE installation_id=$2", [JSON.stringify({ ...JSON.parse(first.data), sourceSha256: hash() }), site.id]);
    await installObserver(site.id, true, transport, dns);
    const upgraded = (await pool.query("SELECT secret_cipher,data FROM hosting_observers WHERE installation_id=$1", [site.id])).rows[0];
    assert.equal(upgraded.secret_cipher, first.secret_cipher);
    assert.equal(JSON.parse(upgraded.data).sourceSha256, hash());
    assert.match(uploaded, /Version: 1\.0\.5/);
    assert.equal(uploads, 2);
    uploaded += "\n// Unknown remote modification";
    await assert.rejects(installObserver(site.id, true, transport, dns), /Aucun écrasement/);
    assert.equal(uploads, 2);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
