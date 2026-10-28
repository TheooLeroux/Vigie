import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { wordpressBackupScript, wordpressUpdateScript } from "../src/lib/updates/wordpress";
import { parseWordPressPlan, wordpressPlanScript } from "../src/lib/updates/wordpress-security";

function docker(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let output = "", error = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { error += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(output) : reject(new Error(`Fixture Docker: ${output}\n${error}`)));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

test("WordPress réel : sauvegarde, mise à jour core/extensions/thèmes et restauration isolée", { skip: process.env.VIGIE_TEST_WORDPRESS !== "1", timeout: 600_000 }, async () => {
  const id = `vigie-wp-test-${randomUUID()}`, network = `${id}-network`, volume = `${id}-files`, db = `${id}-db`, cli = `${id}-cli`;
  const root = "/home/vigietest/site";
  const execute = (script: string) => docker(["exec", "--user", "82:82", "-i", cli, "bash", "-s"], script);
  await docker(["network", "create", network]);
  try {
    await docker(["volume", "create", volume]);
    await docker(["run", "-d", "--name", db, "--network", network, "--env", "MARIADB_ROOT_PASSWORD=fixture-root", "--env", "MARIADB_DATABASE=fixture_wp", "--env", "MARIADB_USER=fixture", "--env", "MARIADB_PASSWORD=fixture-only", "mariadb:11.4"]);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { await docker(["exec", db, "mariadb", "--protocol=tcp", "-h127.0.0.1", "-ufixture", "-pfixture-only", "fixture_wp", "-e", "SELECT 1"]); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
    }
    assert.ok(ready, "La base de test doit être prête.");
    await docker(["run", "-d", "--name", cli, "--network", network, "--publish", "127.0.0.1::8080", "--env", "HOME=/home/vigietest", "--mount", `type=volume,source=${volume},target=/home/vigietest`, "--entrypoint", "sh", "wordpress:cli-php8.3", "-c", "sleep 600"]);
    await docker(["exec", "--user", "0", cli, "sh", "-c", `apk add --no-cache bash coreutils tar findutils >/dev/null && mkdir -p ${root} && chown -R 82:82 /home/vigietest && printf 'memory_limit=512M\\n' > /usr/local/etc/php/conf.d/vigie-fixture.ini`]);
    const port = (await docker(["port", cli, "8080"])).trim().split(":").at(-1)!;
    const url = `http://127.0.0.1:${port}`;
    await execute(`set -eu
wp --path=${root} core download --version=6.8.3
wp --path=${root} config create --dbname=fixture_wp --dbuser=fixture --dbpass=fixture-only --dbhost=${db}
wp --path=${root} config set DISABLE_WP_CRON true --raw
wp --path=${root} config set AUTOMATIC_UPDATER_DISABLED true --raw
wp --path=${root} core install --url=${url} --title='Vigie isolated test' --admin_user=fixture --admin_password=fixture-only-password --admin_email=fixture@example.test --skip-email
wp --path=${root} plugin install akismet --version=5.3 --force
wp --path=${root} theme install twentytwentyfour --version=1.1 --force
wp --path=${root} post create --post_title='Vigie backup proof' --post_status=publish
`);
    const php = (await docker(["exec", cli, "php", "-r", "echo PHP_VERSION;"])).trim();
    await assert.rejects(execute(wordpressBackupScript(root, "vigietest", randomUUID(), url, "0.0.0")), /VIGIE_ERROR=php_mismatch/);
    const runId = randomUUID();
    const saved = await execute(wordpressBackupScript(root, "vigietest", runId, url, php));
    const backup = saved.match(/^VIGIE_BACKUP=(.+)$/m)?.[1];
    assert.ok(backup);
    assert.ok(backup.startsWith(`/home/vigietest/.vigie-backups/${runId}/`));
    const plan = parseWordPressPlan(await execute(wordpressPlanScript(root)));
    const updated = await execute(wordpressUpdateScript(root, backup, plan));
    assert.match(updated, /^VIGIE_WORDPRESS=/m);
    assert.doesNotMatch(updated, /^VIGIE_WORDPRESS=6\.8\.3$/m);
    assert.match(updated, /^VIGIE_PLUGINS=0$/m);
    assert.match(updated, /^VIGIE_THEMES=\d+$/m);
    assert.equal((await execute(`wp --path=${root} theme get twentytwentyfour --field=version`)).trim(), "1.1");
    const repeated = await execute(wordpressUpdateScript(root, backup, parseWordPressPlan(await execute(wordpressPlanScript(root)))));
    assert.match(repeated, /^VIGIE_PLUGINS=0$/m);
    assert.match(repeated, /^VIGIE_THEMES=\d+$/m);
    await execute(`test ! -f ${root}/.maintenance`);
    await docker(["exec", "--user", "82:82", "-d", cli, "php", "-S", "0.0.0.0:8080", "-t", root]);
    let response: Response | undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      try { response = await fetch(url, { signal: AbortSignal.timeout(3000) }); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    assert.equal(response?.status, 200);
    assert.match(await response!.text(), /Vigie isolated test/);
    await docker(["exec", db, "mariadb", "-uroot", "-pfixture-root", "-e", "CREATE DATABASE fixture_restore; GRANT ALL ON fixture_restore.* TO 'fixture'@'%';"]);
    const restored = "/home/vigietest/restored";
    const proof = await execute(`set -eu
cd '${backup}'
sha256sum -c SHA256SUMS >/dev/null
mkdir ${restored}
tar -xzf files.tar.gz -C ${restored}
wp --path=${restored} config set DB_NAME fixture_restore
wp --path=${restored} db import '${backup}/database.sql' >/dev/null
printf 'RESTORED_CORE='; wp --path=${restored} core version
printf 'RESTORED_PLUGIN='; wp --path=${restored} plugin get akismet --field=version
printf 'RESTORED_THEME='; wp --path=${restored} theme get twentytwentyfour --field=version
wp --path=${restored} post list --post_type=post --format=json
`);
    assert.match(proof, /^RESTORED_CORE=6\.8\.3$/m);
    assert.match(proof, /^RESTORED_PLUGIN=5\.3$/m);
    assert.match(proof, /^RESTORED_THEME=1\.1$/m);
    assert.match(proof, /Vigie backup proof/);
  } finally {
    await docker(["rm", "--force", "--volumes", cli, db]).catch(() => {});
    await docker(["volume", "rm", volume]).catch(() => {});
    await docker(["network", "rm", network]).catch(() => {});
  }
});
