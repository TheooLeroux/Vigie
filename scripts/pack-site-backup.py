"""Validate and pack the files streamed by the o2switch collector."""
import datetime
import gzip
import hashlib
import json
import pathlib
import sys
import tarfile
import zipfile


CHUNK = 1024 * 1024
COMPONENTS = {"files.tar.gz": zipfile.ZIP_STORED, "database.sql": zipfile.ZIP_DEFLATED}


def copy_and_hash(source, destination):
    digest = hashlib.sha256()
    count = 0
    while chunk := source.read(CHUNK):
        digest.update(chunk)
        destination.write(chunk)
        count += len(chunk)
    return count, digest.hexdigest()


def validate_files(archive, wordpress):
    entries = set()
    with archive.open("files.tar.gz") as compressed, gzip.GzipFile(fileobj=compressed) as data:
        with tarfile.open(fileobj=data, mode="r|") as files:
            for entry in files:
                name = pathlib.PurePosixPath(entry.name)
                if name.is_absolute() or ".." in name.parts or not (entry.isfile() or entry.isdir()):
                    raise ValueError("Entrée WordPress non autorisée")
                if ((name.as_posix() in {"wp-config.php", "index.php", "index.html"} and entry.isfile())
                        or (name.as_posix() == "wp-content" and entry.isdir())):
                    entries.add(name.as_posix())
        # Read to EOF to check the gzip checksum and trailer.
        while data.read(CHUNK):
            pass
    required = {"wp-config.php", "index.php", "wp-content"} if wordpress else {"index.html"}
    if not required.issubset(entries):
        raise ValueError("Archive du site incomplète")


def validate_database(archive):
    with archive.open("database.sql") as sql:
        head = sql.read(8192)
        if b"-- MySQL dump" not in head and b"-- MariaDB dump" not in head:
            raise ValueError("En-tête SQL inattendu")
        tail = head
        has_table = b"CREATE TABLE " in head
        while chunk := sql.read(CHUNK):
            has_table |= b"CREATE TABLE " in (tail[-20:] + chunk)
            tail = chunk
        if not has_table or b"-- Dump completed on " not in tail[-4096:]:
            raise ValueError("Export SQL incomplet")


def pack(files, database, destination, project_id, domain):
    manifest = {
        "format": "vigie.site-backup",
        "version": 1,
        "projectId": project_id,
        "provider": "o2switch",
        "site": domain,
        "verifiedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "files": {},
    }
    components = [("files.tar.gz", files)]
    if database is not None:
        components.append(("database.sql", database))
    with zipfile.ZipFile(destination, "x", allowZip64=True) as archive:
        for name, path in components:
            size = path.stat().st_size
            if not path.is_file() or path.is_symlink() or size <= 0:
                raise ValueError("Composant manquant ou illisible")
            info = zipfile.ZipInfo(name)
            info.file_size = size
            info.compress_type = COMPONENTS[name]
            with path.open("rb") as source, archive.open(info, "w", force_zip64=True) as output:
                count, digest = copy_and_hash(source, output)
            if count != size:
                raise ValueError("Transfert tronqué")
            manifest["files"][name] = {"bytes": count, "sha256": digest}
        archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    with zipfile.ZipFile(destination) as archive:
        validate_files(archive, database is not None)
        if database is not None:
            validate_database(archive)
        archive.read("manifest.json")


if __name__ == "__main__":
    files, database, output, project, host = sys.argv[1:]
    pack(pathlib.Path(files), pathlib.Path(database) if database != "-" else None,
         pathlib.Path(output), project if project != "-" else None, host)
