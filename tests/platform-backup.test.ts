import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { archiveSources } from "../scripts/platform-backup";
import { githubBackupToken } from "../scripts/backup-github-app";
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
