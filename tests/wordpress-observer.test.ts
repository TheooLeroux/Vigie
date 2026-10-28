import { authFixture } from "./auth-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename, dirname } from "node:path";
import { createServer } from "node:net";
import {
  observerHeaders,
  observerUrl,
  parseObserverPayload,
  collectObserver,
  publicAddress,
} from "../src/lib/connectors/wordpress-observer";
import {
  sealConnectorSecret,
  openConnectorSecret,
} from "../src/lib/connector-secrets";
import { GET, POST } from "../src/app/api/[...path]/route";
import { saveHostingConnection } from "../src/lib/hosting-connections";
import {
  applyDiscoverySnapshot,
  hostingDiscovery,
} from "../src/lib/hosting-discovery";
import { transaction, createProject } from "../src/lib/db";
import { createProjectSchema } from "../src/lib/validation";
import {
  installObserver,
  observerPlan,
  provisionLinkedObservers,
  provisionLinkedObserver,
  collectHostingInventories,
} from "../src/lib/hosting-inventory";
import { hostingStorage } from "../src/lib/hosting-storage";
process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const nonce = "a".repeat(32),
  secret = "b".repeat(64),
  root = "/home/testuser/site";
function payload() {
  return {
    format: "vigie.wordpress.v1",
    nonce,
    collectedAt: new Date().toISOString(),
    documentRoot: root,
    wordpress: {
      version: "6.7.2",
      latestVersion: "6.8.1",
      updateState: "available",
      updateCheckedAt: new Date().toISOString(),
      updateSource: "wordpress",
    },
    php: {
      version: "8.2.34",
      scope: "web",
      sapi: "litespeed",
      limits: { memory_limit: "512M" },
      extensions: ["mysqli", "curl"],
    },
    site: {
      name: "Site",
      url: "https://site.example.org",
      home: "https://site.example.org",
      locale: "fr_FR",
      timezone: "Europe/Paris",
      multisite: false,
      searchEnginesVisible: true,
      https: true,
    },
    configuration: {
      debug: true,
      debugDisplay: true,
      cronDisabled: false,
      fileEditDisabled: true,
      fileModsDisabled: false,
      pageCache: true,
      objectCache: true,
    },
    database: { version: "10.6.1" },
    plugins: [
      {
        file: "private/plugin.php",
        slug: "private",
        name: "Private",
        version: "1.0",
        active: true,
        mustUse: false,
        autoUpdate: false,
        requiresPhp: "7.4",
        requiresWordPress: "6.0",
        template: null,
        latestVersion: null,
        updateState: "unknown",
        updateCheckedAt: null,
        updateSource: "wordpress",
      },
    ],
    themes: [],
  };
}
test("observateur : format strict, nonce, répertoire, fraîcheur et données privées exclues", () => {
  const data = payload(),
    result = parseObserverPayload(
      { ...data, secret: "never-return", users: ["hidden"] },
      nonce,
      root,
    );
  assert.equal(result.php?.version, "8.2.34");
  assert.equal(result.plugins[0].active, true);
  assert.equal(result.plugins[0].updateState, "unknown");
  assert.equal(result.warnings.length, 2);
  assert.ok(!JSON.stringify(result).includes("never-return"));
  assert.ok(!JSON.stringify(result).includes("hidden"));
  const external = payload();
  const classified = parseObserverPayload({ ...external, plugins: [{ ...external.plugins[0], updateOrigin: "external", updateUri: "https://private.invalid/?token=never-return" }] }, nonce, root);
  assert.equal(classified.plugins[0].updateOrigin, "external");
  assert.ok(!JSON.stringify(classified).includes("never-return"));
  for (const bad of [
    { ...data, nonce: "c".repeat(32) },
    { ...data, documentRoot: "/home/other/site" },
    { ...data, collectedAt: "2020-01-01T00:00:00Z" },
    { ...data, php: { ...data.php, version: "secret-debug-text" } },
  ])
    assert.throws(
      () => parseObserverPayload(bad, nonce, root),
      /connecteur|correspond pas/,
    );
});
test("observateur : HTTPS public, IP privées et redirections bloquées ; réponse liée à la requête", async () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.2.3",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
  ])
    assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress("109.234.161.69"), true);
  const dns = (async () => [{ address: "109.234.161.69", family: 4 }]) as any;
  const privateDns = (async () => [{ address: "127.0.0.1", family: 4 }]) as any;
  for (const url of [
    "http://site.example.org/",
    "https://user:pass@site.example.org/",
    "https://site.example.org:2083/",
    "https://site.example.org/?token=test",
  ])
    await assert.rejects(observerUrl(url, dns));
  await assert.rejects(
    observerUrl("https://site.example.org/", privateDns),
    /locale ou privée/,
  );
  let calls = 0;
  const transport = (async (url, options) => {
    calls++;
    assert.equal(options?.redirect, "manual");
    assert.equal(options?.method, "POST");
    assert.ok(!String(url).includes(secret));
    assert.ok(!JSON.stringify(options).includes(secret));
    return Response.json({
      ...payload(),
      nonce: (options!.headers as Record<string, string>)["X-Vigie-Nonce"],
    });
  }) as typeof fetch;
  assert.equal(
    (
      await collectObserver(
        "https://site.example.org/",
        root,
        secret,
        transport,
        dns,
      )
    ).source,
    "wordpress-observer",
  );
  assert.equal(calls, 1);
  await assert.rejects(
    collectObserver(
      "https://site.example.org/",
      root,
      secret,
      (async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.test" },
        })) as typeof fetch,
      dns,
    ),
    /redirige/,
  );
});
test("secrets observateurs : chiffrés, authentifiés et liés à leur installation", () => {
  const sealed = sealConnectorSecret(secret, "site-a");
  assert.ok(!sealed.includes(secret));
  assert.equal(openConnectorSecret(sealed, "site-a"), secret);
  assert.throws(() => openConnectorSecret(sealed, "site-b"), /déchiffré/);
});
test("connecteur PHP réel : requêtes ordinaires intactes ; signature, corps et horodatage contrôlés", async (t) => {
  const php =
    process.env.VIGIE_TEST_PHP_BIN || resolve(".data/tools/php81/php.exe");
  if (!existsSync(php)) {
    t.skip("Définir VIGIE_TEST_PHP_BIN pour exécuter le test PHP.");
    return;
  }
  const temporary = mkdtempSync(join(tmpdir(), "vigie-observer-auth-"));
  const source = readFileSync(
    "connectors/wordpress/vigie-observer.php",
    "utf8",
  ).replace("__VIGIE_SECRET_HEX__", secret);
  writeFileSync(join(temporary, "observer.php"), source);
  mkdirSync(join(temporary, "wp-admin/includes"), { recursive: true });
  mkdirSync(join(temporary, "wp-includes"), { recursive: true });
  for (const path of [
    "wp-admin/includes/plugin.php",
    "wp-admin/includes/update.php",
    "wp-includes/update.php",
  ])
    writeFileSync(join(temporary, path), "<?php");
  writeFileSync(
    join(temporary, "runtime.php"),
    readFileSync("tests/wordpress-runtime.fixture.php", "utf8"),
  );
  writeFileSync(
    join(temporary, "index.php"),
    "<?php define('ABSPATH', __DIR__.'/'); require __DIR__.'/runtime.php'; require __DIR__.'/observer.php'; echo 'ordinary';",
  );
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  const child = spawn(php, ["-n", "-S", `127.0.0.1:${port}`, "-t", temporary], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(
        () => reject(new Error("PHP test server unavailable")),
        5000,
      );
      child.once("error", reject);
      child.stderr.on("data", (chunk) => {
        if (String(chunk).includes("Development Server")) {
          clearTimeout(timer);
          done();
        }
      });
    });
    const base = `http://127.0.0.1:${port}/`,
      url = base + "?vigie_observer=v1",
      body = JSON.stringify({ refresh: true });
    assert.equal(await (await fetch(base)).text(), "ordinary");
    assert.equal((await fetch(url)).status, 404);
    const headers = observerHeaders(secret, body, nonce);
    const valid = await fetch(url, { method: "POST", headers, body });
    assert.equal(valid.status, 200);
    const result = await valid.json();
    assert.equal(result.configuration.objectCache, false);
    assert.equal(result.plugins[0].updateOrigin, "external");
    assert.equal(JSON.stringify(result).includes("never-return"), false);
    assert.equal(result.plugins[0].active, true);
    assert.equal(
      parseObserverPayload(result, nonce, temporary.replace(/\\/g, "/"))
        .wordpress?.version,
      "6.7.2",
    );
    const early = JSON.stringify({ refresh: false, mode: "early" });
    const fallback = await (
      await fetch(url, {
        method: "POST",
        headers: observerHeaders(secret, early, nonce),
        body: early,
      })
    ).json();
    assert.equal(fallback.collectionMode, "early");
    assert.equal(
      fallback.themes.length,
      1,
      "Le mode précoce doit enregistrer le répertoire des thèmes avant de les lister",
    );
    assert.equal(
      parseObserverPayload(fallback, nonce, temporary.replace(/\\/g, "/"))
        .configuration,
      null,
    );
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ refresh: false }),
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: { ...headers, "X-Vigie-Signature": "0".repeat(64) },
          body,
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: observerHeaders(secret, body, nonce, "1000000000"),
          body,
        })
      ).status,
      404,
    );
    const invalid = JSON.stringify({ refresh: true, update: true });
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: observerHeaders(secret, invalid, nonce),
          body: invalid,
        })
      ).status,
      400,
    );
  } finally {
    child.kill();
    await new Promise<void>((r) => {
      if (child.exitCode !== null) r();
      else child.once("exit", () => r());
    });
    assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
    assert.ok(basename(temporary).startsWith("vigie-observer-auth-"));
    rmSync(temporary, { recursive: true, force: true });
  }
});
test("installation : confirmation explicite, aucune écriture avant accord, accès Google obligatoire", async () => {
  const host = (await saveHostingConnection({
    name: "Observer",
    endpoint: "https://gaz.o2switch.net:2083",
    username: "testuser",
    authMode: "token",
    secret: "test-private-only",
  }));
  (await transaction(async () => {
    (await createProject(
      "live",
      createProjectSchema.parse({
        name: "Observer site",
        url: "https://site.example.org/",
      }),
    ));
    (await applyDiscoverySnapshot(host, {
      observedAt: new Date().toISOString(),
      installations: [
        {
          documentRoot: root,
          domains: ["site.example.org"],
          aliases: [],
          kind: "wordpress",
          version: "6.7.2",
          inspectionError: null,
          suggestedEnvironment: "production",
        },
      ],
    }));
  }));
  const item = (await hostingDiscovery(host.id)).installations[0],
    plan = (await observerPlan(item.id));
  assert.ok(plan.source.includes("__VIGIE_SECRET_HEX__"));
  assert.ok(plan.path.endsWith("wp-content/mu-plugins/vigie-observer.php"));
  let calls = 0;
  await assert.rejects(
    installObserver(item.id, false, (async () => {
      calls++;
      throw Error("Must not call");
    }) as typeof fetch),
    /Confirmez/,
  );
  assert.equal(calls, 0);
  for (const [method, path] of [
    ["GET", `installations/${item.id}/observer-plan`],
    ["POST", `installations/${item.id}/observer`],
    ["POST", `installations/${item.id}/inventory`],
    ["POST", `connections/${host.id}/inventory`],
  ] as const) {
    const response = await { GET, POST }[method](
      new Request(`http://127.0.0.1:3001/api/${path}`, {
        method,
        headers: {
          origin: "http://127.0.0.1:3001",
          "content-type": "application/json",
        },
        body: method === "POST" ? JSON.stringify({ confirm: true }) : undefined,
      }),
      { params: Promise.resolve({ path: path.split("/") }) },
    );
    assert.equal(response.status, 401);
  }
  const path = `installations/${item.id}/observer`,
    response = await POST(
      new Request(`http://127.0.0.1:3001/api/${path}`, {
        method: "POST",
        headers: {
          origin: "http://127.0.0.1:3001",
          "content-type": "application/json",
          cookie: (await authFixture()).cookie,
        },
        body: JSON.stringify({ confirm: false }),
      }),
      { params: Promise.resolve({ path: path.split("/") }) },
    );
  assert.equal(response.status, 400);
});
test("installation : dépôt unique vérifié, secret propre au site chiffré, pas d’écrasement d’un fichier inconnu", async () => {
  const host = (await saveHostingConnection({
    name: "Install",
    endpoint: "https://gaz.o2switch.net:2083",
    username: "installuser",
    authMode: "token",
    secret: "test-private-install",
  }));
  const installRoot = "/home/installuser/site";
  (await transaction(async () => {
    (await createProject(
      "live",
      createProjectSchema.parse({
        name: "Install site",
        url: "https://install.example.org/",
      }),
    ));
    (await applyDiscoverySnapshot(host, {
      observedAt: new Date().toISOString(),
      installations: [
        {
          documentRoot: installRoot,
          domains: ["install.example.org"],
          aliases: [],
          kind: "wordpress",
          version: "6.7.2",
          inspectionError: null,
          suggestedEnvironment: "production",
        },
      ],
    }));
  }));
  const item = (await hostingDiscovery(host.id)).installations[0];
  let directory = false,
    uploaded = "",
    uploads = 0,
    writes = 0;
  const dns = (async () => [{ address: "109.234.161.69", family: 4 }]) as any;
  const transport = (async (url, options) => {
    const u = new URL(String(url));
    let data: unknown;
    if (u.hostname === "www.php.net")
      return Response.json({
        version: "8.2.35",
        tags: ["security"],
        supported_versions: ["8.2", "8.3", "8.4", "8.5"],
      });
    if (u.hostname === "install.example.org") {
      const key = uploaded.match(
        /\$vigie_observer_key = '([a-f0-9]{64})'/,
      )?.[1];
      assert.ok(key);
      const headers = options!.headers as Record<string, string>;
      assert.equal(
        headers["X-Vigie-Signature"],
        observerHeaders(
          key,
          String(options!.body),
          headers["X-Vigie-Nonce"],
          headers["X-Vigie-Time"],
        )["X-Vigie-Signature"],
      );
      return Response.json({
        ...payload(),
        nonce: headers["X-Vigie-Nonce"],
        documentRoot: installRoot,
      });
    }
    if (u.pathname === "/json-api/cpanel") {
      writes++;
      const params = options!.body as URLSearchParams;
      assert.equal(params.get("name"), "mu-plugins");
      assert.equal(params.get("path"), installRoot + "/wp-content");
      directory = true;
      return Response.json({ cpanelresult: { event: { result: 1 } } });
    }
    if (u.pathname === "/execute/Fileman/upload_files") {
      writes++;
      uploads++;
      const form = options!.body as FormData;
      assert.equal(form.get("overwrite"), "0");
      assert.equal(form.get("dir"), installRoot + "/wp-content/mu-plugins");
      const file = form.get("file-1") as File;
      assert.equal(file.name, "vigie-observer.php");
      uploaded = await file.text();
      return Response.json({ result: { status: 1, data: { succeeded: 1 } } });
    }
    if (u.pathname === "/execute/Fileman/list_files")
      data = u.searchParams.get("dir")!.endsWith("mu-plugins")
        ? uploaded
          ? [
              {
                file: "vigie-observer.php",
                type: "file",
                size: uploaded.length,
              },
            ]
          : []
        : directory
          ? [{ file: "mu-plugins", type: "dir" }]
          : [];
    else if (u.pathname === "/execute/Fileman/get_file_content")
      data = { content: uploaded };
    else assert.fail("Opération imprévue");
    return Response.json({ result: { status: 1, data } });
  }) as typeof fetch;
  const automatic = await provisionLinkedObservers(host.id, transport, dns);
  assert.equal(automatic.issues.length, 0);
  const first = { installation: automatic.discovery.installations[0] };
  assert.equal(first.installation.observerConfigured, true);
  assert.equal(first.installation.inventory?.php?.version, "8.2.34");
  assert.equal(uploads, 1);
  assert.equal(writes, 2);
  await provisionLinkedObserver(item.id, transport, dns);
  assert.equal(
    writes,
    2,
    "Le rapprochement suivant conserve le connecteur sans le réinstaller",
  );
  const key = uploaded.match(/\$vigie_observer_key = '([a-f0-9]{64})'/)![1];
  assert.ok(!JSON.stringify(first).includes(key));
  assert.ok(
    !JSON.stringify(
      (await (await hostingStorage())
        .prepare("SELECT * FROM hosting_observers WHERE installation_id=?")
        .get(item.id)),
    ).includes(key),
  );
  await installObserver(item.id, true, transport, dns);
  assert.equal(uploads, 1, "Une seconde liaison ne redépose pas le fichier");
  // A restored WordPress can lose the entire MU-plugin directory while the DB
  // still records the observer. The next collection repairs it with the same key.
  directory = false;
  uploaded = "";
  await (await hostingStorage()).prepare("UPDATE hosting_site_inventories SET data=json_set(data,'$.lastAttemptAt',?) WHERE installation_id=?").run(new Date(0).toISOString(), item.id);
  const repaired = await collectHostingInventories(host.id, transport, transport, item.id, dns);
  assert.equal(repaired.success, 1);
  assert.equal(repaired.failed, 0);
  assert.equal(uploads, 2);
  assert.equal(writes, 4);
  assert.equal(uploaded.match(/\$vigie_observer_key = '([a-f0-9]{64})'/)![1], key);
  const managed = uploaded;
  uploaded += "\n// unknown remote change";
  const conflict = await provisionLinkedObservers(host.id, transport, dns);
  assert.equal(conflict.issues.length, 1);
  assert.equal(uploads, 2, "Un fichier modifié ne doit pas être remplacé par la réparation");
  assert.match(uploaded, /unknown remote change/);
  uploaded = managed;
  (await (await hostingStorage())
    .prepare("DELETE FROM hosting_observers WHERE installation_id=?")
    .run(item.id));
  await assert.rejects(
    installObserver(item.id, true, transport, dns),
    /ne sera pas écrasé/,
  );
  assert.equal(uploads, 2);
});
