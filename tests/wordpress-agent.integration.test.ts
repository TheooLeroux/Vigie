import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { agentBundle, agentDirectory, localAgentOperation, signAgentPayload, agentPlan, type AgentFiles, type AgentOperation } from "../src/lib/updates/wordpress-agent";

async function docker(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }); let output = "", error = "";
    child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { error += chunk; });
    child.on("error", reject); child.on("close", code => code === 0 ? resolve(output) : reject(new Error(`Fixture Docker (${code}): ${output}\n${error}`)));
    child.stdin.on("error", () => {}); child.stdin.end(input);
  });
}
test("Agent sans SSH : copie WordPress réelle, mises à jour, anti-rejeu et récupération après panne du cœur", { skip: process.env.VIGIE_TEST_WORDPRESS_AGENT !== "1", timeout: 900_000 }, async () => {
  const id = `vigie-agent-${randomUUID()}`, db = `${id}-db`, cli = `${id}-cli`, volume = `${id}-volume`, network = `${id}-network`;
  const root = "/home/vigietest/site", original = "/home/vigietest/original", directory = agentDirectory(root, "vigietest");
  const shell = (script: string) => docker(["exec", "--user", "82:82", "-i", cli, "bash", "-s"], script);
  const exec = (args: string[], input?: string) => docker(["exec", "--user", "82:82", "-i", cli, ...args], input);
  const report: Record<string, unknown> = { startedAt: new Date().toISOString(), environment: "isolated Docker fixture; no production connection or secret", checks: [] as string[] };
  const check = (name: string) => { (report.checks as string[]).push(name); console.log(`Agent pilot: ${name}`); };
  await docker(["network", "create", network]);
  try {
    await docker(["volume", "create", volume]);
    await docker(["run", "-d", "--name", db, "--network", network, "--env", "MARIADB_ROOT_PASSWORD=fixture-root", "--env", "MARIADB_DATABASE=fixture_original", "--env", "MARIADB_USER=fixture", "--env", "MARIADB_PASSWORD=fixture-only", "mariadb:11.4"]);
    let ready = false;
    for (let i = 0; i < 60; i++) { try { await docker(["exec", db, "mariadb", "-uroot", "-pfixture-root", "-e", "SELECT 1"]); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 1000)); } }
    assert.ok(ready);
    await docker(["exec", db, "mariadb", "-uroot", "-pfixture-root", "-e", "CREATE DATABASE fixture_copy; GRANT ALL ON fixture_copy.* TO 'fixture'@'%';"]);
    await docker(["run", "-d", "--name", cli, "--network", network, "--publish", "127.0.0.1::8080", "--env", "HOME=/home/vigietest", "--mount", `type=volume,source=${volume},target=/home/vigietest`, "--entrypoint", "sh", "wordpress:cli-php8.3", "-c", "sleep 1800"]);
    await docker(["exec", "--user", "0", cli, "sh", "-c", "apk add --no-cache bash coreutils tar findutils >/dev/null && mkdir -p /home/vigietest && chown -R 82:82 /home/vigietest && printf 'memory_limit=512M\\n' > /usr/local/etc/php/conf.d/vigie-agent-fixture.ini"]);
    const port = (await docker(["port", cli, "8080"])).trim().split(":").at(-1)!; const url = `http://127.0.0.1:${port}`;
    await shell(`set -eu
wp --path=${original} core download --version=6.8.3
wp --path=${original} config create --dbname=fixture_original --dbuser=fixture --dbpass=fixture-only --dbhost=${db}
wp --path=${original} config set DISABLE_WP_CRON true --raw
wp --path=${original} config set AUTOMATIC_UPDATER_DISABLED true --raw
wp --path=${original} core install --url=http://fixture.invalid --title='Original immutable' --admin_user=fixture --admin_password=fixture-only-password --admin_email=fixture@example.test --skip-email
wp --path=${original} plugin install akismet --version=5.3 --force
wp --path=${original} theme install twentytwentyfour --version=1.1 --force
wp --path=${original} post create --post_title='Vigie copy proof' --post_status=publish
wp --path=${original} db export /home/vigietest/copy.sql --single-transaction
cp -a ${original} ${root}
wp --path=${root} config set DB_NAME fixture_copy
wp --path=${root} db import /home/vigietest/copy.sql
wp --path=${root} option update home ${url}
wp --path=${root} option update siteurl ${url}
`);
    const php = (await exec(["php", "-r", "echo PHP_VERSION;"])).trim();
    const bundle = await agentBundle(root, "vigietest", php, "staging");
    const settings = { ...bundle.settings, phpBinary: "/usr/local/bin/php", wpBinary: "/usr/local/bin/wp", ready: true };
    const config = { ...JSON.parse(bundle.files["config.json"]), phpBinary: settings.phpBinary, wpBinary: settings.wpBinary };
    await shell(`mkdir -p '${directory}/jobs' '${directory}/results' '${directory}/backups' '${directory}/php.d'; chmod 700 '${directory}'`);
    for (const [name, text] of Object.entries({ ...bundle.files, "config.json": JSON.stringify(config) })) await exec(["sh", "-c", 'cat > "$1"', "sh", `${directory}/${name}`], text);
    const tick = () => exec(["php", `${directory}/bootstrap.php`, `${directory}/config.json`]);
    const files: AgentFiles = {
      read: async file => { try { return await exec(["cat", `${directory}/${file}`]); } catch { return null; } },
      write: async (file, text) => { await exec(["sh", "-c", 'cat > "$1"', "sh", `${directory}/${file}`], text); },
    };
    const op = (run: string, name: AgentOperation, extra = {}, requestId?: string) => localAgentOperation(files, settings, root, run, name, extra, { timeoutMs: 600_000, pollMs: 1, sleep: async () => { await tick(); }, requestId });
    const run = randomUUID();
    const plan = agentPlan((await op(run, "inspect")).plan); report.before = plan;
    assert.equal(plan.wordpress.current, "6.8.3"); check("copy inspected without SSH");
    const forged = { id: randomUUID(), runId: run, root, operation: "backup", issuedAt: Math.floor(Date.now()/1000), webPhp: php };
    await files.write(`jobs/${forged.id}.json`, JSON.stringify(signAgentPayload(forged, randomBytes(32).toString("hex")))); await tick();
    assert.equal(await files.read(`results/${forged.id}.json`), null); check("forged signature rejected");
    for (const mismatch of [{ root: "/home/vigietest/original" }, { issuedAt: Math.floor(Date.now()/1000) - 3600 }]) {
      const invalid = { ...forged, ...mismatch, id: randomUUID() };
      await files.write(`jobs/${invalid.id}.json`, JSON.stringify(signAgentPayload(invalid, settings.secret))); await tick();
      assert.equal(await files.read(`results/${invalid.id}.json`), null);
    }
    check("signed requests for another site or expired requests rejected");
    await assert.rejects(op(randomUUID(), "backup", { webPhp: "0.0.0" }), /php_mismatch/); check("PHP mismatch rejected before backup");
    const saved = await op(run, "backup", { webPhp: php }); assert.equal(saved.backup, `${directory}/backups/${run}`); check("files and SQL backup verified");
    const updated = agentPlan((await op(run, "update", { plan, webPhp: php })).plan); report.after = updated;
    assert.equal(updated.wordpress.current, plan.wordpress.target); assert.notEqual(updated.wordpress.current, "6.8.3");
    assert.equal(updated.plugins.find(p=>p.slug==='akismet')?.current, plan.plugins.find(p=>p.slug==='akismet')?.target); check("core and extensions updated to exact plan");
    const beforeReplay = await exec(["stat", "-c", "%Y", `${directory}/backups/${run}/manifest.json`]);
    await op(run, "backup", { webPhp: php }); await tick();
    assert.equal(await exec(["stat", "-c", "%Y", `${directory}/backups/${run}/manifest.json`]), beforeReplay); check("duplicate backup was not executed twice");
    await docker(["exec", "--user", "82:82", "-d", cli, "php", "-d", "opcache.enable=0", "-S", "0.0.0.0:8080", "-t", root]);
    await new Promise(resolve=>setTimeout(resolve,500));
    assert.equal((await fetch(url)).status, 200); check("updated copy answers HTTP");
    assert.equal((await shell(`wp --path=${original} core version`)).trim(), "6.8.3");
    assert.equal((await shell(`wp --path=${original} plugin get akismet --field=version`)).trim(), "5.3"); check("original files and database untouched");
    assert.equal((await shell(`wp --path=${original} option get home`)).trim(), "http://fixture.invalid");
    await exec(["sh", "-c", 'cat > "$1"', "sh", `${root}/introduced-after-backup.php`], "<?php // Fixture file absent from the backup.\n");
    await exec(["sh", "-c", 'cat > "$1"', "sh", `${root}/wp-includes/version.php`], "<?php throw new RuntimeException('intentional fixture failure');");
    assert.equal((await fetch(url)).status, 500); check("intentional core failure reproduced");
    await assert.rejects(op(run, "restore"), /restore_requires_staging_confirmation/);
    // Restore has its own immutable operation ID. A refused request is never replayed with new contents.
    assert.equal((await op(run, "restore", { confirmDataLoss: true }, randomUUID())).restored, true);
    assert.equal((await shell(`wp --path=${root} core version`)).trim(), "6.8.3");
    assert.equal((await shell(`wp --path=${root} plugin get akismet --field=version`)).trim(), "5.3");
    assert.match(await shell(`wp --path=${root} post list --format=json`), /Vigie copy proof/);
    await shell(`test ! -f ${root}/introduced-after-backup.php`);
    assert.equal((await fetch(url)).status, 200); check("independent agent restored code and database after WordPress failed");
    report.completedAt = new Date().toISOString(); report.status = "passed";
  } catch (error) { report.status = "failed"; report.failure = error instanceof Error ? error.message : "test failure"; throw error; }
  finally {
    await mkdir(".data/analysis", { recursive: true }); await writeFile(".data/analysis/wordpress-local-agent-pilot.json", JSON.stringify(report, null, 2));
    if (process.env.VIGIE_KEEP_WORDPRESS_AGENT_FIXTURE === "1" && report.status === "failed") console.log(JSON.stringify({ fixture: { cli, db, volume, network, root, directory } }));
    else {
      await docker(["rm", "--force", "--volumes", cli, db]).catch(()=>{});
      await docker(["volume", "rm", volume]).catch(()=>{}); await docker(["network", "rm", network]).catch(()=>{});
    }
  }
});
