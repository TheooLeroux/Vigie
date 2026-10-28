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
async function enqueueLocalAgent(id: string) {
  try { await (await import("./updates/wordpress-agent-setup")).requestAgentInstallation(id); }
  catch {
    const site = await hostingInstallation(id);
    await log("live", "hosting.agent_queue_failed", "La préparation automatique de l’agent sera réessayée au prochain contrôle.", site.project?.id || null);
  }
}
type ObserverRow = { secret_cipher: string; data: string };
async function observerRow(id: string) {
  return (await (await hostingStorage())
    .prepare(
      "SELECT secret_cipher,data FROM hosting_observers WHERE installation_id=?",
    )
    .get(id)) as ObserverRow | undefined;
}
function observerContext(item: HostingInstallationView) {
  return `vigie:wordpress-observer:v1:${item.id}:${item.connectionId}:${item.documentRoot}`;
}
async function writeInventory(id: string, inventory: SiteInventory) {
  (await (await hostingStorage())
    .prepare(
      "INSERT INTO hosting_site_inventories VALUES (?,?) ON CONFLICT(installation_id) DO UPDATE SET data=excluded.data",
    )
    .run(id, JSON.stringify(inventory)));
}
async function assertCurrent(original: HostingInstallationView) {
  const current = (await hostingInstallation(original.id));
  if (current.missingSince || current.ignored || current.documentRoot !== original.documentRoot || current.connectionId !== original.connectionId || current.project?.id !== original.project?.id || (original.project?.lifecycle === "active" && current.project?.lifecycle !== "active"))
    throw new ApiError(
      "L’installation a changé pendant la collecte. Relancez la synchronisation.",
      409,
    );
  return current;
}
export async function inventoryUrl(item: HostingInstallationView) {
  const project = item.project
    ? (await get<Project>("projects", item.project.id, "live"))
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
  let installations = (await hostingDiscovery(connectionId)).installations.filter(
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
            const observer = (await observerRow(item.id));
            if (observer) {
              try {
                snapshot = await collectObserver(await inventoryUrl(item), item.documentRoot,
                  openConnectorSecret(observer.secret_cipher, observerContext(item)), transport, resolveDns);
              } catch (error) {
                // A database registration does not prove that a restored site still has our file.
                // Repair only linked active sites; ownership/hash checks still apply before writing.
                if (!item.project || item.project.lifecycle !== "active") throw error;
                const repaired = await installObserverOnAccount(await observerPlan(item.id), item, transport, resolveDns);
                snapshot = repaired.installation.inventory!;
              }
            } else if (item.project?.lifecycle === "active") {
              const installed = await installObserverOnAccount(await observerPlan(item.id), item, transport, resolveDns);
              snapshot = installed.installation.inventory!;
            } else {
              snapshot = await collectWordPressFiles(client, item.documentRoot, catalogTransport);
            }
            snapshot = await enrichPhpRelease(snapshot, catalogTransport);
            (await transaction(async () => {
              (await assertCurrent(item));
              (await writeInventory(item.id, snapshot));
              (await log(
                "live",
                "hosting.inventory",
                `Inventaire ${snapshot.source === "wordpress-observer" ? "WordPress" : "des fichiers WordPress"} relevé sur ${item.domains[0]} : ${snapshot.plugins.length} extensions, ${snapshot.themes.length} thèmes.`,
                item.project?.id || null,
              ));
            }));
            if (item.project) await enqueueLocalAgent(item.id);
            success++;
          } catch (e) {
            const message =
              e instanceof ApiError
                ? e.message
                : "La collecte a échoué. Le dernier inventaire est conservé.";
            (await transaction(async () => {
              const current = (await assertCurrent(item)),
                now = new Date().toISOString();
              if (current.inventory)
                (await writeInventory(item.id, {
                  ...current.inventory,
                  lastAttemptAt: now,
                  error: message,
                }));
              else
                (await writeInventory(item.id, {
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
                }));
              (await log(
                "live",
                "hosting.inventory_failed",
                `Collecte impossible sur ${item.domains[0]} : ${message}`,
                item.project?.id || null,
              ));
            }));
            failed++;
          }
        }
      }
      await Promise.all([worker(), worker(), worker()]);
      return { success, failed, discovery: (await hostingDiscovery(connectionId)) };
    });
  } finally {
    running.delete(connectionId);
  }
}
const observerFile = "vigie-observer.php";
async function recordObserverFailure(id: string, error: unknown) {
  const message =
    error instanceof ApiError
      ? error.message
      : "Installation du connecteur impossible.";
  (await transaction(async () => {
    const item = (await hostingInstallation(id)),
      now = new Date().toISOString();
    (await writeInventory(
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
    ));
    (await log(
      "live",
      "hosting.observer_failed",
      `Connecteur sur ${item.domains[0]} : ${message}`,
      item.project?.id || null,
    ));
  }));
}
export async function provisionLinkedObservers(
  connectionId: string,
  transport: typeof fetch = fetch,
  resolveDns = lookup,
) {
  const issues: { installationId: string; message: string }[] = [];
  for (const site of (await hostingDiscovery(connectionId)).installations.filter(
    (i) =>
      i.kind === "wordpress" &&
      i.project?.lifecycle === "active" &&
      !i.ignored &&
      !i.missingSince,
  )) {
    try {
      await installObserver(site.id, true, transport, resolveDns);
    } catch (error) {
      (await recordObserverFailure(site.id, error));
      issues.push({
        installationId: site.id,
        message:
          error instanceof ApiError
            ? error.message
            : "Installation impossible.",
      });
    }
  }
  for (const site of (await hostingDiscovery(connectionId)).installations.filter(i => i.kind === "wordpress" && i.project?.lifecycle === "active" && !i.ignored && !i.missingSince)) await enqueueLocalAgent(site.id);
  return { discovery: (await hostingDiscovery(connectionId)), issues };
}
export async function provisionLinkedObserver(
  id: string,
  transport: typeof fetch = fetch,
  resolveDns = lookup,
) {
  const item = (await hostingInstallation(id));
  if (
    item.kind !== "wordpress" ||
    item.project?.lifecycle !== "active" ||
    item.ignored ||
    item.missingSince
  )
    return;
  try {
    await installObserver(id, true, transport, resolveDns);
  } catch (error) {
    (await recordObserverFailure(id, error));
  }
  await enqueueLocalAgent(id);
}
export async function observerPlan(id: string) {
  const item = (await hostingInstallation(id));
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
    url: (await inventoryUrl(item)),
    version: "1.0.5",
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    installed: Boolean((await observerRow(id))),
    source,
  };
}
// Remote writes are limited to the confirmed installation and authorized automatic repair paths.
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
  const plan = (await observerPlan(id)),
    item = (await hostingInstallation(id));
  if (running.has(item.connectionId))
    throw new ApiError("Une collecte est déjà en cours sur ce compte.", 409);
  running.add(item.connectionId);
  try {
    return await installObserverOnAccount(plan, item, transport, resolveDns);
  } finally {
    running.delete(item.connectionId);
  }
}
// Caller owns the account collection lock; never reacquire it during a repair.
async function installObserverOnAccount(
  plan: Awaited<ReturnType<typeof observerPlan>>,
  item: HostingInstallationView,
  transport: typeof fetch,
  resolveDns: typeof lookup,
) {
  const id = item.id;
  return withHostingCredentials(item.connectionId, async (input) => {
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
      let row = (await observerRow(id));
      if (existing && existing.type !== "file")
        throw new ApiError("Le connecteur existant n’est pas un fichier utilisable.", 409);
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
      (await transaction(async () => {
        (await assertCurrent(item));
        (await (await hostingStorage())
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
          ));
      }));
      const owner = await observerRow(id);
      if (!owner || openConnectorSecret(owner.secret_cipher, observerContext(item)) !== secret)
        throw new ApiError("Une autre installation du connecteur est en cours. Le prochain contrôle réessaiera.", 409);
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
      (await transaction(async () => {
        (await assertCurrent(item));
        const current = await observerRow(id);
        if (!current) throw new ApiError("Le rattachement du connecteur a changé pendant son installation.", 409);
        (await (await hostingStorage())
          .prepare(
            "UPDATE hosting_observers SET data=? WHERE installation_id=?",
          )
          .run(JSON.stringify({ ...JSON.parse(current.data), sourceSha256: hash }), id));
      }));
      const snapshot = await enrichPhpRelease(
        await collectObserver(plan.url, root, secret, transport, resolveDns),
        transport,
      );
      (await transaction(async () => {
        (await assertCurrent(item));
        (await writeInventory(id, snapshot));
        (await (await hostingStorage())
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
          ));
        (await log(
          "live",
          "hosting.observer_installed",
          `Connecteur d’inventaire WordPress 1.0.5 installé et vérifié sur ${item.domains[0]}.`,
          item.project!.id,
        ));
      }));
      return {
        installation: (await hostingInstallation(id)),
        discovery: (await hostingDiscovery(item.connectionId)),
      };
    });
}
