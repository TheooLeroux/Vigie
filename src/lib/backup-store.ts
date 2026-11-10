import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { addAbortSignal, Readable } from "node:stream";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client, S3ServiceException } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

type Archive = { owner: string; bytes: number | string; sha256: string | null };

export type BackupStore = {
  id: string;
  publish: (path: string, owner: string, bytes: number, filename: string) => Promise<string | null>;
  exists: (archive: Archive) => Promise<boolean>;
  download: (archive: Archive, filename: string) => Promise<Response | null>;
  remove: (owner: string) => Promise<void>;
};

const prefix = "vigie/backups/v1/";
const cacheControl = "private, no-store";
export const backupLeaseMs = 4 * 60 * 60_000;

function archiveName(owner: string) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(owner)) throw new Error("Identifiant de fichier invalide.");
  return owner + ".zip";
}

function missingFile(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ELOOP";
}

export function backupDirectory(variable = "VIGIE_BACKUP_DIRECTORY") {
  const dir = process.env[variable];
  if (!dir) return undefined;
  if (!isAbsolute(dir)) throw new Error(variable + " doit être un chemin absolu.");
  const fromPublic = relative(resolve("public"), resolve(dir));
  if (fromPublic !== ".." && !fromPublic.startsWith(".." + sep) && !isAbsolute(fromPublic)) {
    throw new Error("Le dossier de sauvegardes doit être hors du répertoire public.");
  }
  return resolve(dir);
}

function localStore(directory: string): BackupStore {
  const path = (owner: string) => join(directory, archiveName(owner));
  return {
    id: "local",
    async publish(source, owner) {
      await rename(source, path(owner));
      return null;
    },
    async exists(archive) {
      const info = await lstat(path(archive.owner)).catch(error => {
        if (missingFile(error)) return null;
        throw error;
      });
      return !!info?.isFile() && info.size === Number(archive.bytes);
    },
    async download(archive, filename) {
      const infoOnDisk = await lstat(path(archive.owner)).catch(error => {
        if (missingFile(error)) return null;
        throw error;
      });
      if (!infoOnDisk?.isFile()) return null;
      const file = await open(path(archive.owner), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(error => {
        if (missingFile(error)) return null;
        throw error;
      });
      if (!file) return null;
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size !== Number(archive.bytes)) {
          await file.close();
          return null;
        }
        const stream = Readable.toWeb(file.createReadStream()) as ReadableStream<Uint8Array>;
        return new Response(stream, { headers: {
          "Content-Type": "application/zip",
          "Content-Length": String(info.size),
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": cacheControl,
          "X-Content-Type-Options": "nosniff",
        } });
      } catch (error) {
        await file.close();
        throw error;
      }
    },
    async remove(owner) {
      await unlink(path(owner)).catch(error => { if (!missingFile(error)) throw error; });
    },
  };
}

async function sha256(stream: AsyncIterable<Uint8Array>) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of stream) {
    hash.update(chunk);
    bytes += chunk.byteLength;
  }
  return { bytes, digest: hash.digest("hex") };
}

function objectStore(): BackupStore | undefined {
  const { VIGIE_BACKUP_S3_ENDPOINT: endpoint, VIGIE_BACKUP_S3_BUCKET: bucket,
    VIGIE_BACKUP_S3_KEY_ID: accessKeyId, VIGIE_BACKUP_S3_SECRET: secretAccessKey } = process.env;
  if (!endpoint && !bucket && !accessKeyId && !secretAccessKey) return;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error("Configuration du stockage S3 incomplète.");
  }
  const url = new URL(endpoint);
  const loopback = process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Adresse du stockage S3 invalide.");
  }
  const region = process.env.VIGIE_BACKUP_S3_REGION || "auto";
  const id = "s3:" + createHash("sha256").update(JSON.stringify([url.origin, bucket, region])).digest("hex");
  const client = new S3Client({
    endpoint: url.origin, region, forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const object = (owner: string) => ({ Bucket: bucket, Key: prefix + archiveName(owner) });

  async function exists(archive: Archive) {
    if (!archive.sha256) return false;
    try {
      const stored = await client.send(new HeadObjectCommand(object(archive.owner)), { abortSignal: AbortSignal.timeout(10_000) });
      return stored.ContentLength === Number(archive.bytes) && stored.Metadata?.sha256 === archive.sha256;
    } catch (error) {
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) return false;
      throw new Error("Le stockage S3 ne répond pas au contrôle du ZIP.");
    }
  }

  return {
    id,
    exists,
    async publish(path, owner, bytes, filename) {
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), 90 * 60_000);
      let body: Readable | undefined;
      try {
        const source = await sha256(createReadStream(path, { signal: deadline.signal }));
        if (source.bytes !== bytes) throw new Error("Le ZIP local a changé.");
        body = createReadStream(path, { signal: deadline.signal });
        await new Upload({
          client, abortController: deadline, partSize: 16 * 1024 ** 2, queueSize: 2,
          params: {
            ...object(owner), Body: body, ContentLength: bytes, ContentType: "application/zip",
            ContentDisposition: `attachment; filename="${filename}"`, CacheControl: cacheControl,
            Metadata: { sha256: source.digest },
          },
        }).done();
        const stored = await client.send(new GetObjectCommand(object(owner)), { abortSignal: deadline.signal });
        if (!(stored.Body instanceof Readable)) throw new Error("Flux S3 absent.");
        if (stored.ContentLength !== bytes || stored.Metadata?.sha256 !== source.digest) {
          stored.Body.destroy();
          throw new Error("Métadonnées du ZIP incohérentes.");
        }
        const check = await sha256(addAbortSignal(deadline.signal, stored.Body));
        if (check.bytes !== bytes || check.digest !== source.digest) throw new Error("Empreinte du ZIP stocké incohérente.");
        return source.digest;
      } catch {
        throw new Error("Envoi ou vérification du ZIP dans le stockage S3 en échec.");
      } finally {
        clearTimeout(timer);
        body?.destroy();
      }
    },
    async download(archive) {
      if (!await exists(archive)) return null;
      const url = await getSignedUrl(client, new GetObjectCommand(object(archive.owner)), { expiresIn: 300 });
      return new Response(null, { status: 302, headers: {
        Location: url, "Cache-Control": cacheControl, "Referrer-Policy": "no-referrer",
      } });
    },
    async remove(owner) {
      try {
        await client.send(new DeleteObjectCommand(object(owner)), { abortSignal: AbortSignal.timeout(10_000) });
      } catch {
        throw new Error("Suppression du ZIP expiré dans le stockage S3 en échec.");
      }
    },
  };
}

export function backupStores() {
  const directory = backupDirectory();
  const local = directory ? localStore(directory) : undefined;
  const remote = objectStore();
  const byId = new Map<string, BackupStore>();
  for (const store of [local, remote]) if (store) byId.set(store.id, store);
  return { byId, remote, destination: remote || local, directory };
}
