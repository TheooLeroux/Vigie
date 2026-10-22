import "./auth-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { cpanelReadClient } from "../src/lib/connectors/cpanel-read";
import {
  componentFromHeader,
  collectWordPressFiles,
} from "../src/lib/connectors/wordpress-files";
import {
  catalogUpdate,
  compareVersions,
} from "../src/lib/connectors/wordpress-catalog";
import { saveHostingConnection } from "../src/lib/hosting-connections";
import {
  collectHostingInventories,
  provisionLinkedObserver,
} from "../src/lib/hosting-inventory";
import { hostingStorage } from "../src/lib/hosting-storage";
import { enrichPhpRelease } from "../src/lib/connectors/php-releases";
import {
  applyDiscoverySnapshot,
  hostingDiscovery,
} from "../src/lib/hosting-discovery";
import { transaction, createProject } from "../src/lib/db";
import { createProjectSchema } from "../src/lib/validation";
process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const credentials = {
  name: "Files",
  endpoint: "https://gaz.o2switch.net:2083",
  username: "fileuser",
  authMode: "token" as const,
  secret: "unit-test-private",
};
const root = "/home/fileuser/files";
function fileTransport(calls: URL[] = []) {
  return (async (url, options) => {
    const u = new URL(String(url));
    calls.push(u);
    assert.equal(options?.method, "GET");
    assert.equal(options?.redirect, "manual");
    let value: unknown;
    const dir = u.searchParams.get("dir"),
      file = u.searchParams.get("file");
    if (u.pathname.endsWith("list_files")) {
      let files: { file: string; type: string }[] = [];
      if (dir?.endsWith("/plugins"))
        files = [
          { file: "multi", type: "dir" },
          { file: "private", type: "dir" },
        ];
      else if (dir?.endsWith("/plugins/multi"))
        files = [
          { file: "main.php", type: "file" },
          { file: "helper.php", type: "file" },
          { file: "second.php", type: "file" },
        ];
      else if (dir?.endsWith("/plugins/private"))
        files = [{ file: "private.php", type: "file" }];
      else if (dir?.endsWith("/themes"))
        files = [{ file: "child-test", type: "dir" }];
      value = files;
    } else if (u.pathname.endsWith("get_file_content")) {
      value = {
        content:
          file === "version.php"
            ? "<?php $wp_version = '6.7.2';"
            : file === "main.php"
              ? "<?php /*\nPlugin Name: Multi Main\nVersion: 1.0\nRequires PHP: 8.0\n*/"
              : file === "second.php"
                ? "<?php /*\nPlugin Name: Multi Other\nVersion: 2.0\n*/"
                : file === "private.php"
                  ? "<?php /*\nPlugin Name: Private\nVersion: 1.0\nUpdate URI: https://private.invalid/update\n*/"
                  : file === "style.css"
                    ? "/*\nTheme Name: Child\nVersion: 1.0\nTemplate: parent\n*/"
                    : "<?php // helper",
      };
    } else assert.fail("Unexpected operation");
    return Response.json({ result: { status: 1, data: value } });
  }) as typeof fetch;
}
const catalog = (async (url) => {
  const u = new URL(String(url));
  if (u.pathname.includes("/core/"))
    return Response.json({
      offers: [{ response: "upgrade", current: "6.8.1" }],
    });
  const slug = u.searchParams.get("request[slug]");
  return Response.json({ slug, version: "2.0" });
}) as typeof fetch;
test("inventaire fichiers : tous les en-têtes, thèmes enfants, activité inconnue et flux privés exclus de l’annuaire", async () => {
  const calls: URL[] = [],
    catalogCalls: string[] = [];
  const observed = await collectWordPressFiles(
    cpanelReadClient(credentials, fileTransport(calls)),
    root,
    (async (...args) => {
      catalogCalls.push(String(args[0]));
      return catalog(...args);
    }) as typeof fetch,
  );
  assert.equal(observed.source, "cpanel-files");
  assert.equal(observed.php, null);
  assert.equal(observed.wordpress?.updateState, "available");
  assert.equal(observed.plugins.length, 3);
  assert.ok(observed.plugins.every((p) => p.active === null));
  assert.equal(
    observed.plugins.find((p) => p.name === "Private")!.updateState,
    "unknown",
  );
  assert.equal(observed.themes[0].template, "parent");
  assert.equal(observed.themes[0].updateState, "unknown");
  assert.ok(!catalogCalls.some((url) => url.includes("private")));
  assert.ok(
    !calls.some((url) => url.searchParams.get("file") === "wp-config.php"),
  );
  assert.equal(
    componentFromHeader("<?php // No plugin metadata", "test.php", "plugin"),
    null,
  );
});
test("lecteur cPanel : jamais de config, hors compte, traversée ou fonction d’écriture", async () => {
  let calls = 0;
  const reader = cpanelReadClient(credentials, (async () => {
    calls++;
    return Response.json({ result: { status: 1, data: [] } });
  }) as typeof fetch);
  for (const [dir, file] of [
    [root, "wp-config.php"],
    ["/home/other/wp-content/plugins/a", "a.php"],
    [root + "/wp-content/plugins/a", "../../wp-config.php"],
    [root + "/wp-content/themes/a", "settings.php"],
    ["/home/fileuser/../../etc", "version.php"],
  ])
    await assert.rejects(reader.read(dir, file));
  assert.equal(calls, 0);
  const malicious = cpanelReadClient(credentials, (async () =>
    Response.json({
      result: {
        status: 1,
        data: [{ file: "../../wp-config.php", type: "file" }],
      },
    })) as typeof fetch);
  await assert.rejects(malicious.list(root), /non interprétable/);
});
test("catalogue : comparaison numérique prudente, cache, erreur réseau et paquets privés jamais à jour par défaut", async () => {
  assert.equal(compareVersions("1.9", "1.10"), -1);
  assert.equal(compareVersions("2.0.0", "2"), 0);
  assert.equal(compareVersions("2.0-beta", "2.0"), null);
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return Response.json({ slug: "cache-test", version: "2.1" });
  }) as typeof fetch;
  assert.equal(
    (await catalogUpdate("plugin", "cache-test", "2.0", fetcher)).updateState,
    "available",
  );
  assert.equal(
    (await catalogUpdate("plugin", "cache-test", "2.1", fetcher)).updateState,
    "current",
  );
  assert.equal(calls, 1);
  assert.equal(
    (
      await catalogUpdate("plugin", "private-unknown", "1.0", (async () =>
        Response.json({ error: "Plugin not found" })) as typeof fetch)
    ).updateState,
    "unknown",
  );
  assert.equal(
    (
      await catalogUpdate(
        "plugin",
        "failed-catalog",
        "1.0",
        (async () =>
          new Response("private debug", { status: 503 })) as typeof fetch,
      )
    ).updateState,
    "unknown",
  );
});
test("PHP : correctif publié et support standard distingués des correctifs de l’hébergeur", async () => {
  const base = {
    source: "wordpress-observer",
    observedAt: new Date().toISOString(),
    lastAttemptAt: new Date().toISOString(),
    error: null,
    wordpress: null,
    php: {
      version: "8.2.34",
      scope: "web",
      sapi: "litespeed",
      limits: {},
      extensions: [],
    },
    site: null,
    configuration: null,
    database: null,
    plugins: [],
    themes: [],
    warnings: [],
  } as const;
  const snapshot = JSON.parse(JSON.stringify(base));
  let calls = 0;
  const transport = (async (url) => {
    calls++;
    assert.equal(new URL(String(url)).hostname, "www.php.net");
    return Response.json({
      version: "8.2.35",
      tags: ["security"],
      supported_versions: ["8.2", "8.3", "8.4", "8.5"],
    });
  }) as typeof fetch;
  const current = await enrichPhpRelease(snapshot, transport);
  assert.equal(current.php?.release?.updateAvailable, true);
  assert.equal(current.php?.release?.securityRelease, true);
  assert.equal(current.php?.release?.upstreamSupported, true);
  await enrichPhpRelease(snapshot, transport);
  assert.equal(calls, 1);
  const unavailable = await enrichPhpRelease(
    { ...snapshot, php: { ...snapshot.php, version: "8.1.34" } },
    (async () => new Response("unavailable", { status: 503 })) as typeof fetch,
  );
  assert.equal(
    unavailable.php?.release,
    undefined,
    "Un catalogue indisponible ne prouve ni mise à jour ni fin de support",
  );
});
test("persistance : collecte réelle liée, échec conserve le relevé et aucune installation automatique sans fiche", async () => {
  const connection = saveHostingConnection(credentials);
  transaction(() =>
    applyDiscoverySnapshot(connection, {
      observedAt: new Date().toISOString(),
      installations: [
        {
          documentRoot: root,
          domains: ["files.example.org"],
          aliases: [],
          kind: "wordpress",
          version: "6.7.2",
          inspectionError: null,
          suggestedEnvironment: "production",
        },
      ],
    }),
  );
  const id = hostingDiscovery(connection.id).installations[0].id;
  let calls = 0;
  await provisionLinkedObserver(id, (async () => {
    calls++;
    throw Error("No install for unlinked site");
  }) as typeof fetch);
  assert.equal(calls, 0);
  const first = await collectHostingInventories(
    connection.id,
    fileTransport(),
    catalog,
  );
  assert.equal(first.success, 1);
  assert.equal(first.failed, 0);
  const original = first.discovery.installations[0].inventory!;
  assert.equal(original.plugins.length, 3);
  hostingStorage()
    .prepare(
      "UPDATE hosting_site_inventories SET data=json_set(data,'$.lastAttemptAt','2020-01-01T00:00:00Z') WHERE installation_id=?",
    )
    .run(id);
  const failed = await collectHostingInventories(
    connection.id,
    (async () =>
      new Response("do-not-expose", { status: 401 })) as typeof fetch,
    catalog,
  );
  const current = failed.discovery.installations[0].inventory!;
  assert.equal(failed.failed, 1);
  assert.equal(current.observedAt, original.observedAt);
  assert.equal(current.plugins.length, 3);
  assert.ok(current.error);
  assert.ok(!JSON.stringify(current).includes("do-not-expose"));
});
