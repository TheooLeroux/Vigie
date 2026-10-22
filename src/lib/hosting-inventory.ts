import { randomBytes, createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { hostingStorage } from "./hosting-storage";
import {
  withHostingCredentials,
  hostingConnections,
} from "./hosting-connections";
import { hostingDiscovery, hostingInstallation } from "./hosting-discovery";
import { transaction, log, get } from "./db";
import { ApiError } from "./http";
import { sealConnectorSecret, openConnectorSecret } from "./connector-secrets";
import { cpanelReadClient } from "./connectors/cpanel-read";
import { collectWordPressFiles } from "./connectors/wordpress-files";
import { collectObserver } from "./connectors/wordpress-observer";
import { enrichPhpRelease } from "./connectors/php-releases";
import type { HostingInstallationView, SiteInventory, Project } from "./types";
const running = new Set<string>();
type ObserverRow = { secret_cipher: string; data: string };
function observerRow(id: string) {
  return hostingStorage()
    .prepare(
      "SELECT secret_cipher,data FROM hosting_observers WHERE installation_id=?",
    )
    .get(id) as ObserverRow | undefined;
}
function observerContext(item: HostingInstallationView) {
  return `vigie:wordpress-observer:v1:${item.id}:${item.connectionId}:${item.documentRoot}`;
}
function writeInventory(id: string, inventory: SiteInventory) {
  hostingStorage()
    .prepare(
      "INSERT INTO hosting_site_inventories VALUES (?,?) ON CONFLICT(installation_id) DO UPDATE SET data=excluded.data",
    )
    .run(id, JSON.stringify(inventory));
}
function assertCurrent(original: HostingInstallationView) {
  const current = hostingInstallation(original.id);
  if (current.missingSince || current.documentRoot !== original.documentRoot)
    throw new ApiError(
      "L’installation a changé pendant la collecte. Relancez la synchronisation.",
      409,
    );
  return current;
}
export function inventoryUrl(item: HostingInstallationView) {
  const project = item.project
    ? get<Project>("projects", item.project.id, "live")
    : null;
  if (project?.url) {
    try {
      const url = new URL(project.url);
      if (
        [...item.domains, ...item.aliases].includes(url.hostname.toLowerCase())
      )
        return url.href;
    } catch {
      /* Use a discovered domain instead. */
    }
  }
  if (!item.domains[0])
    throw new ApiError("Aucun domaine n’est associé à ce site.");
  return `https://${item.domains[0]}/`;
}
export async function collectHostingInventories(
  connectionId: string,
  transport: typeof fetch = fetch,
  catalogTransport: typeof fetch = fetch,
  installationId?: string,
  resolveDns = lookup,
) {
  if (running.has(connectionId))
    throw new ApiError("Une collecte est déjà en cours sur ce compte.", 409);
  let installations = hostingDiscovery(connectionId).installations.filter(
    (i) =>
      i.kind === "wordpress" &&
      !i.ignored &&
      !i.missingSince &&
      (!installationId || i.id === installationId),
  );
  if (installationId && !installations.length)
    throw new ApiError(
      "Cette installation WordPress ne peut pas être collectée.",
    );
  if (
    installationId &&
    installations.some(
      (i) =>
        i.inventory &&
        Date.now() - Date.parse(i.inventory.lastAttemptAt) < 10_000,
    )
  )
    throw new ApiError(
      "Attendez quelques secondes avant de relancer la collecte.",
      429,
    );
  installations = installations.filter(
    (i) =>
      !i.inventory ||
      Date.now() - Date.parse(i.inventory.lastAttemptAt) >= 10_000,
  );
  running.add(connectionId);
  try {
    return await withHostingCredentials(connectionId, async (input) => {
      const client = cpanelReadClient(input, transport);
      let cursor = 0,
        success = 0,
        failed = 0;
      async function worker() {
        while (cursor < installations.length) {
          const item = installations[cursor++];
          let snapshot: SiteInventory;
          try {
            const observer = observerRow(item.id);
            snapshot = observer
              ? await collectObserver(
                  inventoryUrl(item),
                  item.documentRoot,
                  openConnectorSecret(
                    observer.secret_cipher,
                    observerContext(item),
                  ),
                  transport,
                  resolveDns,
                )
              : await collectWordPressFiles(
                  client,
                  item.documentRoot,
                  catalogTransport,
                );
            snapshot = await enrichPhpRelease(snapshot, catalogTransport);
            transaction(() => {
              assertCurrent(item);
              writeInventory(item.id, snapshot);
              log(
                "live",
                "hosting.inventory",
                `Inventaire ${snapshot.source === "wordpress-observer" ? "WordPress" : "des fichiers WordPress"} relevé sur ${item.domains[0]} : ${snapshot.plugins.length} extensions, ${snapshot.themes.length} thèmes.`,
                item.project?.id || null,
              );
            });
            success++;
          } catch (e) {
            const message =
              e instanceof ApiError
                ? e.message
                : "La collecte a échoué. Le dernier inventaire est conservé.";
            transaction(() => {
              const current = assertCurrent(item),
                now = new Date().toISOString();
              if (current.inventory)
                writeInventory(item.id, {
                  ...current.inventory,
                  lastAttemptAt: now,
                  error: message,
                });
              else
                writeInventory(item.id, {
                  source: "cpanel-files",
                  observedAt: null,
                  lastAttemptAt: now,
                  error: message,
                  wordpress: null,
                  php: null,
                  site: null,
                  configuration: null,
                  database: null,
                  plugins: [],
                  themes: [],
                  warnings: [],
                });
              log(
                "live",
                "hosting.inventory_failed",
                `Collecte impossible sur ${item.domains[0]} : ${message}`,
                item.project?.id || null,
              );
            });
            failed++;
          }
        }
      }
      await Promise.all([worker(), worker(), worker()]);
      return { success, failed, discovery: hostingDiscovery(connectionId) };
    });
  } finally {
    running.delete(connectionId);
  }
}
const observerFile = "vigie-observer.php";
function recordObserverFailure(id: string, error: unknown) {
  const message =
    error instanceof ApiError
      ? error.message
      : "Installation du connecteur impossible.";
  transaction(() => {
    const item = hostingInstallation(id),
      now = new Date().toISOString();
    writeInventory(
      id,
      item.inventory
        ? {
            ...item.inventory,
            lastAttemptAt: now,
            error: `Connecteur : ${message}`,
          }
        : {
            source: "cpanel-files",
            observedAt: null,
            lastAttemptAt: now,
            error: `Connecteur : ${message}`,
            wordpress: null,
            php: null,
            site: null,
            configuration: null,
            database: null,
            plugins: [],
            themes: [],
            warnings: [],
          },
    );
    log(
      "live",
      "hosting.observer_failed",
      `Connecteur sur ${item.domains[0]} : ${message}`,
      item.project?.id || null,
    );
  });
}
export async function provisionLinkedObservers(
  connectionId: string,
  transport: typeof fetch = fetch,
  resolveDns = lookup,
) {
  const issues: { installationId: string; message: string }[] = [];
  for (const site of hostingDiscovery(connectionId).installations.filter(
    (i) =>
      i.kind === "wordpress" &&
      i.project &&
      !i.ignored &&
      !i.missingSince &&
      !i.observerConfigured,
  )) {
    try {
      await installObserver(site.id, true, transport, resolveDns);
    } catch (error) {
      recordObserverFailure(site.id, error);
      issues.push({
        installationId: site.id,
        message:
          error instanceof ApiError
            ? error.message
            : "Installation impossible.",
      });
    }
  }
  return { discovery: hostingDiscovery(connectionId), issues };
}
export async function provisionLinkedObserver(
  id: string,
  transport: typeof fetch = fetch,
  resolveDns = lookup,
) {
  const item = hostingInstallation(id);
  if (
    item.kind !== "wordpress" ||
    !item.project ||
    item.observerConfigured ||
    item.missingSince
  )
    return;
  try {
    await installObserver(id, true, transport, resolveDns);
  } catch (error) {
    recordObserverFailure(id, error);
  }
}
export function observerPlan(id: string) {
  const item = hostingInstallation(id);
  if (item.kind !== "wordpress" || item.missingSince || !item.project)
    throw new ApiError(
      "Le connecteur nécessite un WordPress rattaché et retrouvé.",
    );
  const source = readFileSync(
    join(process.cwd(), "connectors/wordpress", observerFile),
    "utf8",
  );
  return {
    installationId: id,
    domain: item.domains[0],
    project: item.project.name,
    path: posix.join(item.documentRoot, "wp-content/mu-plugins", observerFile),
    url: inventoryUrl(item),
    version: "1.0.3",
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    installed: Boolean(observerRow(id)),
    source,
  };
}
// This is the only remote write path. It runs only after explicit installation confirmation.
export async function installObserver(
  id: string,
  confirmed: boolean,
  transport: typeof fetch = fetch,
  resolveDns = lookup,
) {
  if (confirmed !== true)
    throw new ApiError(
      "Confirmez l’installation du connecteur de lecture sur ce WordPress.",
    );
  const plan = observerPlan(id),
    item = hostingInstallation(id);
  if (running.has(item.connectionId))
    throw new ApiError("Une collecte est déjà en cours sur ce compte.", 409);
  running.add(item.connectionId);
  try {
    return await withHostingCredentials(item.connectionId, async (input) => {
      const root = posix.normalize(item.documentRoot);
      if (!root.startsWith(`/home/${input.username}/`) || root.includes("\0"))
        throw new ApiError("Répertoire hors du compte o2switch.");
      const client = cpanelReadClient(input, transport),
        contentDir = posix.join(root, "wp-content"),
        dir = posix.join(contentDir, "mu-plugins");
      const contents = await client.list(contentDir, ["mu-plugins"]),
        mu = contents.find((f) => f.file === "mu-plugins");
      if (mu && mu.type !== "dir")
        throw new ApiError(
          "Le dossier mu-plugins n’est pas un répertoire utilisable.",
        );
      const files = mu ? await client.list(dir) : [];
      const existing = files.find((f) => f.file === observerFile);
      let row = observerRow(id);
      if (existing && !row)
        throw new ApiError(
          "Un fichier vigie-observer.php existe déjà. Il ne sera pas écrasé.",
          409,
        );
      let secret = row
        ? openConnectorSecret(row.secret_cipher, observerContext(item))
        : randomBytes(32).toString("hex");
      const source = plan.source.replace("__VIGIE_SECRET_HEX__", secret),
        hash = createHash("sha256").update(source).digest("hex");
      let needsUpgrade = false;
      if (existing) {
        const current = await client.read(dir, observerFile);
        const currentHash = createHash("sha256").update(current).digest("hex");
        if (
          currentHash !== hash &&
          currentHash !== JSON.parse(row!.data).sourceSha256
        )
          throw new ApiError(
            "Le connecteur existant diffère du fichier prévu. Aucun écrasement automatique.",
            409,
          );
        needsUpgrade = currentHash !== hash;
      }
      transaction(() => {
        assertCurrent(item);
        hostingStorage()
          .prepare(
            "INSERT INTO hosting_observers VALUES (?,?,?) ON CONFLICT(installation_id) DO NOTHING",
          )
          .run(
            id,
            sealConnectorSecret(secret, observerContext(item)),
            JSON.stringify({
              status: "pending",
              sourceSha256: hash,
              createdAt: new Date().toISOString(),
            }),
          );
      });
      const authorization =
        input.authMode === "token"
          ? `cpanel ${input.username}:${input.secret}`
          : `Basic ${Buffer.from(input.username + ":" + input.secret).toString("base64")}`;
      if (!mu) {
        const params = new URLSearchParams({
          cpanel_jsonapi_user: input.username,
          cpanel_jsonapi_apiversion: "2",
          cpanel_jsonapi_module: "Fileman",
          cpanel_jsonapi_func: "mkdir",
          path: contentDir,
          name: "mu-plugins",
          permissions: "0755",
        });
        const response = await transport(input.endpoint + "/json-api/cpanel", {
          method: "POST",
          headers: {
            Authorization: authorization,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: params,
          redirect: "manual",
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok)
          throw new ApiError(
            "Le dossier du connecteur n’a pas pu être créé.",
            502,
          );
        // Verify actual filesystem state rather than trusting the API2 event flag.
        if (
          !(await client.list(contentDir, ["mu-plugins"])).some(
            (f) => f.file === "mu-plugins" && f.type === "dir",
          )
        )
          throw new ApiError(
            "Le dossier du connecteur n’a pas pu être créé.",
            502,
          );
      }
      if (!existing || needsUpgrade) {
        const form = new FormData();
        form.set("dir", dir);
        form.set("overwrite", needsUpgrade ? "1" : "0");
        form.set(
          "file-1",
          new Blob([source], { type: "application/x-httpd-php" }),
          observerFile,
        );
        const response = await transport(
          input.endpoint + "/execute/Fileman/upload_files",
          {
            method: "POST",
            headers: { Authorization: authorization },
            body: form,
            redirect: "manual",
            signal: AbortSignal.timeout(30_000),
          },
        );
        if (!response.ok)
          throw new ApiError(
            "Le connecteur n’a pas pu être déposé sur le site.",
            502,
          );
        const saved = await client.read(dir, observerFile);
        if (createHash("sha256").update(saved).digest("hex") !== hash)
          throw new ApiError("Le fichier déposé n’a pas pu être vérifié.", 502);
      }
      transaction(() => {
        assertCurrent(item);
        hostingStorage()
          .prepare(
            "UPDATE hosting_observers SET data=json_set(data,'$.sourceSha256',?) WHERE installation_id=?",
          )
          .run(hash, id);
      });
      const snapshot = await enrichPhpRelease(
        await collectObserver(plan.url, root, secret, transport, resolveDns),
        transport,
      );
      transaction(() => {
        assertCurrent(item);
        writeInventory(id, snapshot);
        hostingStorage()
          .prepare(
            "UPDATE hosting_observers SET data=? WHERE installation_id=?",
          )
          .run(
            JSON.stringify({
              status: "installed",
              sourceSha256: hash,
              installedAt: new Date().toISOString(),
            }),
            id,
          );
        log(
          "live",
          "hosting.observer_installed",
          `Connecteur d’inventaire WordPress 1.0.3 installé et vérifié sur ${item.domains[0]}.`,
          item.project!.id,
        );
      });
      return {
        installation: hostingInstallation(id),
        discovery: hostingDiscovery(item.connectionId),
      };
    });
  } finally {
    running.delete(item.connectionId);
  }
}
