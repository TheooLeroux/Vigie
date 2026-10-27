import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

test("Lanceur local : Phar absent préparé automatiquement, configuration CLI et arguments conservés", { skip: process.env.VIGIE_TEST_WORDPRESS_AGENT !== "1", timeout: 180_000 }, async () => {
  const bootstrap = Buffer.from(await readFile("connectors/wordpress/agent-bootstrap.php")).toString("base64");
  const worker = await readFile("connectors/wordpress/local-agent.php");
  const config = Buffer.from(JSON.stringify({ protocol: "vigie-local-v1", root: "/home/vigietest/site", secret: "a".repeat(64), phpBinary: "/usr/bin/php84", wpBinary: "/tmp/vigie/wp.php", environment: "staging", workerSha256: createHash("sha256").update(worker).digest("hex"), planSha256: "0".repeat(64) })).toString("base64");
  const fixture = Buffer.from(`<?php
if(!extension_loaded('phar'))exit(3);
if(in_array('eval-file',$argv,true))exit(7); // Plans can be unavailable without blocking installation.
file_put_contents('/tmp/cli-proof.json',json_encode(['phar'=>extension_loaded('phar'),'memory'=>ini_get('memory_limit'),'scan'=>getenv('PHP_INI_SCAN_DIR'),'argument'=>$argv[1]])."\\n");
echo json_encode(['multisite'=>false,'fileModsDisabled'=>false,'home'=>'https://fixture.invalid']);
`).toString("base64");
  const script = `set -eu
apk add --no-cache php84 php84-phar >/dev/null
mkdir -p /tmp/vigie/php.d /tmp/vigie/jobs /tmp/vigie/results /tmp/cli-extra /home/vigietest/site
chmod 700 /tmp/vigie
printf '%s' '${bootstrap}' | base64 -d > /tmp/vigie/bootstrap.php
printf '%s' '${worker.toString("base64")}' | base64 -d > /tmp/vigie/agent.php
printf '%s' '${fixture}' | base64 -d > /tmp/vigie/wp.php
printf '%s' '${config}' | base64 -d > /tmp/vigie/config.json
printf 'extension=phar.so\\n' > /tmp/vigie/php.d/10-phar.ini
printf 'memory_limit=333M\\n' > /tmp/cli-extra/20-memory.ini
PHP_INI_SCAN_DIR=/tmp/cli-extra php84 -r 'if(extension_loaded("phar"))exit(3);'
PHP_INI_SCAN_DIR=/tmp/cli-extra php84 /tmp/vigie/bootstrap.php /tmp/vigie/config.json
test -f /tmp/vigie/heartbeat.json
PHP_INI_SCAN_DIR=/tmp/cli-extra php84 -r '$v=json_decode(base64_decode(json_decode(file_get_contents("/tmp/vigie/readiness.json"),true)["payload"]),true);if(!$v["ready"])exit(5);'
cat /tmp/cli-proof.json
rm /tmp/vigie/readiness.json
PHP_INI_SCAN_DIR=/tmp/cli-extra:/etc/php84/conf.d php84 /tmp/vigie/bootstrap.php /tmp/vigie/config.json
PHP_INI_SCAN_DIR=/tmp/cli-extra php84 -r '$v=json_decode(base64_decode(json_decode(file_get_contents("/tmp/vigie/readiness.json"),true)["payload"]),true);if(!$v["ready"])exit(5);'
cat /tmp/cli-proof.json
`;
  const raw = await new Promise<string>((resolve, reject) => {
    const child = spawn("docker", ["run", "--rm", "-i", "alpine:3.23", "sh", "-s"], { windowsHide: true });
    let output = "", error = "";
    child.stdout.on("data", value => { output += value; }); child.stderr.on("data", value => { error += value; });
    child.on("error", reject); child.on("close", code => code === 0 ? resolve(output) : reject(new Error(`Bootstrap fixture (${code}): ${error}`)));
    child.stdin.on("error", () => {}); child.stdin.end(script);
  });
  const results = raw.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(results.length, 2);
  for (const value of results) {
    assert.equal(value.phar, true);
    assert.equal(value.memory, "333M");
    assert.equal(value.argument, "--path=/home/vigietest/site");
  }
  assert.equal(results[0].scan, "/tmp/cli-extra:/tmp/vigie/php.d");
  assert.equal(results[1].scan, "/tmp/cli-extra:/etc/php84/conf.d");
});
