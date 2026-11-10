import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { archiveSources } from "../scripts/platform-backup";
import { githubBackupToken } from "../scripts/backup-github-app";
import { railwayPostgresCommand } from "../scripts/backup-railway-linked";
import { neonBackupConnection, vercelBackupVariables } from "../scripts/backup-vercel-linked";
import { planPlatformBackups } from "../scripts/plan-platform-backups";
import { vigieVercel } from "../scripts/platform-backup-targets";
import { database, save } from "../src/lib/db";
import { runCommand } from "../src/lib/updates/process";
import { applyVercelSnapshot, linkVercelProject, saveVercelConnection } from "../src/lib/vercel";
import type { VercelProject } from "../src/lib/vercel-types";

test("Sauvegarde Git : archive le commit déployé et refuse un pointeur LFS réel", async () => {
  const folder = await mkdtemp(join(tmpdir(), "vigie-backup-git-test-"));
  const git = (...args: string[]) => runCommand("git", ["-C", folder, ...args]);
  const pointer = "version https://git-lfs.github.com/spec/v1";
  try {
    await git("init", "--quiet");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Vigie Tests");
    await git("config", "commit.gpgsign", "false");
    await writeFile(join(folder, "package.json"), "{}\n");
    await writeFile(join(folder, "check.js"), `const pointer = "${pointer}";\n`);
    await git("add", "package.json", "check.js");
    await git("commit", "--quiet", "-m", "Application");
    const deployed = (await git("rev-parse", "HEAD")).trim();
    await writeFile(join(folder, "asset"), `${pointer}\noid sha256:${"0".repeat(64)}\nsize 12\n`);
    await git("add", "asset");
    await git("commit", "--quiet", "-m", "Add an LFS pointer");
    const withLfs = (await git("rev-parse", "HEAD")).trim();

    const repository = "example/backup";
    const source = { repository, transport: "https" as const, directory: join(folder, ".git") };
    const sources = await archiveSources(folder, [{ repository, commit: deployed, root: "/" }], source);
    assert.deepEqual(sources, { [deployed]: `app-${deployed}.tar.gz` });
    assert.ok((await stat(join(folder, sources[deployed]))).size > 0);
    await assert.rejects(archiveSources(folder, [{ repository, commit: withLfs, root: "/" }], source), /Git LFS/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("Le passage automatique relit les liens Vigie et exclut un projet délié", async () => {
  process.env.VIGIE_DB_PATH = ":memory:";
  process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  const project = { id: vigieVercel.projectId, name: "Pilote QA", lifecycle: "active" };
  const other = { id: "other-project", name: "Nouveau projet QA", lifecycle: "active" };
  await save("projects", "live", project);
  await save("projects", "live", other);
  const connection = await saveVercelConnection({ name: "Vercel QA", teamId: "team_backup", secret: "fixture" });
  const pilot: VercelProject = {
    id: vigieVercel.remoteId, name: "pilot", teamId: connection.teamId, teamSlug: "backup", teamName: "Backup",
    framework: null, nodeBranch: null, rootDirectory: null, repository: null, productionBranch: null,
    domains: [], production: null, latest: null, excluded: false, clientSuggestion: null,
  };
  const unqualified = { ...pilot, id: "prj_new", name: "new" };
  await applyVercelSnapshot(connection.id, [pilot, unqualified]);
  const status = async (id: string) => (await planPlatformBackups()).find(row => row.remoteId === id)?.status;
  assert.equal(await status(pilot.id), "out-of-scope");
  await linkVercelProject(connection.id, pilot.id, project.id);
  assert.equal(await status(pilot.id), "capture-profile");
  await linkVercelProject(connection.id, unqualified.id, other.id);
  assert.equal(await status(unqualified.id), "needs-qualification");
  await database().prepare("UPDATE vercel_projects SET project_id=NULL WHERE remote_id=?").run(pilot.id);
  assert.equal(await status(pilot.id), "out-of-scope");
});

test("L’application GitHub émet un jeton en lecture pour le seul dépôt demandé", async t => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const oldId = process.env.VIGIE_BACKUP_GITHUB_APP_ID;
  const oldKey = process.env.VIGIE_BACKUP_GITHUB_APP_KEY;
  process.env.VIGIE_BACKUP_GITHUB_APP_ID = "123";
  process.env.VIGIE_BACKUP_GITHUB_APP_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  t.after(() => {
    if (oldId === undefined) delete process.env.VIGIE_BACKUP_GITHUB_APP_ID;
    else process.env.VIGIE_BACKUP_GITHUB_APP_ID = oldId;
    if (oldKey === undefined) delete process.env.VIGIE_BACKUP_GITHUB_APP_KEY;
    else process.env.VIGIE_BACKUP_GITHUB_APP_KEY = oldKey;
  });
  const calls: string[] = [];
  const transport: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const [header, payload, signature] = new Headers(init?.headers).get("authorization")!.slice(7).split(".");
    assert.ok(verify("RSA-SHA256", Buffer.from(header + "." + payload), publicKey, Buffer.from(signature, "base64url")));
    calls.push(path);
    if (path.endsWith("/installation")) return Response.json({ id: 456 });
    assert.deepEqual(JSON.parse(String(init?.body)), { repositories: ["demo"], permissions: { contents: "read" } });
    return Response.json({ token: "fixture", permissions: { contents: "read", metadata: "read" } });
  };
  assert.equal(await githubBackupToken("team/demo", transport), "fixture");
  assert.deepEqual(calls, ["/repos/team/demo/installation", "/app/installations/456/access_tokens"]);
});

test("Vercel : le collecteur refuse un changement de configuration depuis le déploiement", () => {
  const url = { id: "env_demo", key: "DATABASE_URL", type: "encrypted", target: ["production"], createdAt: 10, updatedAt: 15 };
  assert.deepEqual(vercelBackupVariables(["VERCEL_ENV", "DATABASE_URL"], [url], 20), [url]);
  assert.throws(() => vercelBackupVariables(["DATABASE_URL"], [{ ...url, updatedAt: 21 }], 20), /déploiement actif/);
  assert.throws(() => vercelBackupVariables(["DATABASE_URL"], [{ ...url, type: "sensitive" }], 20), /lisible/);
  assert.throws(() => vercelBackupVariables(["DATABASE_URL", "BLOB_READ_WRITE_TOKEN"], [url], 20), /autre collecteur/);
  assert.throws(() => vercelBackupVariables(["DATABASE_URL"], [url, url], 20), /déploiement actif/);

  const connection = neonBackupConnection("postgresql://example:secret@ep-example-pooler.eu.neon.tech/example?sslmode=require");
  assert.equal(connection.identity, "ep-example.eu.neon.tech/example");
  assert.equal(connection.environment().PGSSLMODE, "verify-full");
  assert.match(connection.environment().PGOPTIONS!, /default_transaction_read_only=on/);
  assert.throws(() => neonBackupConnection("postgresql://example:secret@neon.tech.example.test/example"), /non reconnue/);
  assert.throws(() => neonBackupConnection("postgresql://example:secret@ep-example.eu.neon.tech/example?options=unsafe"), /non reconnue/);
});

test("Railway : la commande de dump vérifie la cible et n’accepte que des noms PostgreSQL simples", () => {
  const target = {
    serviceId: "1ba0b139-d137-4366-aa50-0046c55f19e0",
    environmentId: "27da4ad0-21f1-433f-b292-ff0d77cab66c",
    deploymentId: "b83ce81c-2d8d-44be-9227-9ae0793b184b",
  };
  const command = railwayPostgresCommand(target, "example");
  for (const value of Object.values(target)) assert.ok(command.includes(value));
  assert.match(command, /pg_dump --no-password --format=custom/);
  assert.throws(() => railwayPostgresCommand(target, "host=external.example"), /non pris en charge/);
  assert.throws(() => railwayPostgresCommand({ ...target, deploymentId: "bad" }, "example"));
});
