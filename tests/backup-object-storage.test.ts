import { authFixture } from "./auth-fixture";
import assert from "node:assert/strict";
import { mkdtemp, rmdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GET } from "../src/app/api/[...path]/route";
import { cleanupAbandonedBackupUploads, runBackup, verifyBackupRoundtrip } from "../src/lib/backups";
import { sqliteDatabase } from "../src/lib/db-sqlite";

type Stored = { body: Buffer; hash: string; disposition: string };

test("Stockage objet : multipart, contrôle avant publication, téléchargement signé et échec sans perte", async () => {
  const objects = new Map<string, Stored>();
  const uploads = new Map<string, { headers: Stored; parts: Map<number, Buffer> }>();
  let corrupt = false;
  let multipartCount = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    const key = url.pathname;
    const parts = [];
    for await (const chunk of request) parts.push(Buffer.from(chunk));
    const body = Buffer.concat(parts);
    const metadata = () => ({
      body,
      hash: String(request.headers["x-amz-meta-sha256"] || ""),
      disposition: String(request.headers["content-disposition"] || ""),
    });
    const xml = (data: string) => {
      response.setHeader("Content-Type", "application/xml");
      response.end(data);
    };
    if (request.method === "POST" && url.searchParams.has("uploads")) {
      multipartCount++;
      uploads.set(key, { headers: metadata(), parts: new Map() });
      xml("<InitiateMultipartUploadResult><UploadId>fixture-upload</UploadId></InitiateMultipartUploadResult>");
    } else if (request.method === "PUT" && url.searchParams.has("partNumber")) {
      const number = Number(url.searchParams.get("partNumber"));
      uploads.get(key)!.parts.set(number, body);
      response.setHeader("ETag", '"fixture-' + number + '"');
      response.end();
    } else if (request.method === "POST" && url.searchParams.has("uploadId")) {
      const upload = uploads.get(key)!;
      const ordered = [...upload.parts.entries()].sort(([left], [right]) => left - right);
      objects.set(key, { ...upload.headers, body: Buffer.concat(ordered.map(([, part]) => part)) });
      uploads.delete(key);
      xml('<CompleteMultipartUploadResult><ETag>"fixture"</ETag></CompleteMultipartUploadResult>');
    } else if (request.method === "PUT") {
      objects.set(key, metadata());
      response.setHeader("ETag", '"fixture"');
      response.end();
    } else if (request.method === "DELETE") {
      objects.delete(key);
      response.writeHead(204).end();
    } else {
      const stored = objects.get(key);
      if (!stored) {
        response.writeHead(404).end();
        return;
      }
      response.setHeader("Content-Type", "application/zip");
      response.setHeader("Content-Length", stored.body.length);
      response.setHeader("Content-Disposition", stored.disposition);
      response.setHeader("x-amz-meta-sha256", stored.hash);
      if (request.method === "HEAD") {
        response.end();
      } else {
        const payload = corrupt ? Buffer.from(stored.body) : stored.body;
        if (corrupt) payload[0] ^= 1;
        response.end(payload);
      }
    }
  });
  const scratch = await mkdtemp(join(tmpdir(), "vigie-s3-test-"));
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = "http://127.0.0.1:" + address.port;
    process.env.VIGIE_BACKUP_S3_ENDPOINT = origin;
    process.env.VIGIE_BACKUP_S3_BUCKET = "fixture";
    process.env.VIGIE_BACKUP_S3_KEY_ID = "fixture-read-key";
    process.env.VIGIE_BACKUP_S3_SECRET = "fixture-only-secret";
    process.env.VIGIE_BACKUP_SCRATCH_DIRECTORY = scratch;
    const { cookie } = await authFixture();
    const get = (path: string[], session = true) => GET(
      new Request("http://127.0.0.1:3001/api/" + path.join("/"), { headers: session ? { cookie } : {} }),
      { params: Promise.resolve({ path }) },
    );
    const site = { installationId: "s3-fixture", projectId: null, domain: "site.example.test" };
    const archive = Buffer.alloc(17 * 1024 ** 2, 87);
    const slot = new Date("2026-11-09T02:13:00Z");
    assert.equal(await runBackup(site, (_folder, output) => writeFile(output, archive), slot), true);
    assert.equal(multipartCount, 1);
    const [group] = await (await get(["backups"])).json();
    const path = ["backups", group.backups[0].id, "download"];
    assert.equal((await get(path, false)).status, 401);
    const redirect = await get(path);
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("cache-control"), "private, no-store");
    const signed = new URL(redirect.headers.get("location")!);
    assert.equal(signed.origin, origin);
    assert.equal(signed.searchParams.get("X-Amz-Expires"), "300");
    assert.match(signed.searchParams.get("X-Amz-Signature")!, /^[0-9a-f]{64}$/);
    const downloaded = await fetch(signed);
    assert.match(downloaded.headers.get("content-disposition")!, /site-example-test-2026-11-09\.zip/);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), archive);

    const fixture = Buffer.from("temporary ZIP");
    assert.equal(await verifyBackupRoundtrip((_folder, output) => writeFile(output, fixture)), fixture.length);
    assert.equal(objects.size, 1);
    assert.equal(sqliteDatabase().prepare("SELECT count(*) AS count FROM backup_pending_uploads").get()?.count, 0);
    assert.equal((await (await get(["backups"])).json())[0].backups.length, 1);

    corrupt = true;
    const following = new Date("2026-11-16T02:13:00Z");
    await assert.rejects(runBackup(site, (_folder, output) => writeFile(output, "broken"), following), /vérification/);
    assert.equal(objects.size, 1);
    assert.equal((await (await get(["backups"])).json())[0].backups.length, 1);
    assert.equal(sqliteDatabase().prepare("SELECT count(*) AS count FROM backup_pending_uploads").get()?.count, 1);
    await cleanupAbandonedBackupUploads(new Date("2026-11-17T02:13:00Z"));
    assert.equal(sqliteDatabase().prepare("SELECT count(*) AS count FROM backup_pending_uploads").get()?.count, 0);
    assert.equal(objects.size, 1);
  } finally {
    for (const name of ["S3_ENDPOINT", "S3_BUCKET", "S3_KEY_ID", "S3_SECRET", "SCRATCH_DIRECTORY"]) {
      delete process.env["VIGIE_BACKUP_" + name];
    }
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rmdir(scratch);
  }
});
