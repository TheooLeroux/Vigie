import json
import pathlib
import stat
import sys
import zipfile

operation, archive_name, folder_name = sys.argv[1:4]
folder = pathlib.Path(folder_name).resolve()


def safe_path(name):
    parts = pathlib.PurePosixPath(name).parts
    if not parts or name.startswith("/") or "\\" in name or any(part.lower() in (".", "..", ".git", "node_modules") for part in name.rstrip("/").split("/")) or "//" in name:
        raise ValueError("Chemin non autorisé dans les sources")
    if any(ord(character) < 32 for character in name) or ":" in name:
        raise ValueError("Chemin non autorisé dans les sources")
    basename = parts[-1]
    if (basename.startswith(".env") and basename not in (".env.example", ".env.sample")) or basename in ("id_rsa", "id_ed25519") or basename.endswith((".pem", ".key")):
        raise ValueError("Les sources ne doivent pas contenir de secrets")
    return folder.joinpath(*parts)


if operation in ("extract", "extract-github"):
    with zipfile.ZipFile(archive_name) as archive:
        members = archive.infolist()
        if len(members) > 20000 or sum(member.file_size for member in members) > 150000000:
            raise ValueError("Archive trop volumineuse")
        prefix = members[0].filename.split("/")[0] + "/" if operation == "extract-github" else ""
        paths = set()
        files = []
        for member in members:
            if prefix and not member.filename.startswith(prefix):
                raise ValueError("Racine GitHub incohérente")
            name = member.filename[len(prefix):]
            if not name:
                continue
            destination = safe_path(name)
            mode = member.external_attr >> 16
            if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) and not stat.S_ISREG(mode) and not stat.S_ISDIR(mode)):
                raise ValueError("Liens et fichiers spéciaux non autorisés")
            canonical = str(destination.relative_to(folder))
            if member.flag_bits & 1 or canonical in paths:
                raise ValueError("Archive chiffrée ou dupliquée")
            paths.add(canonical)
            if not member.is_dir():
                files.append((member, destination))
        folder.mkdir(parents=True, exist_ok=True)
        for member, destination in files:
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(archive.read(member))
            destination.chmod(0o755 if member.external_attr >> 16 & 0o111 else 0o644)
        print(json.dumps([str(destination.relative_to(folder)).replace("\\", "/") for member, destination in files]))
elif operation == "pack":
    names = json.loads(sys.stdin.read())
    with zipfile.ZipFile(archive_name, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in names:
            source = safe_path(name)
            if source.is_symlink() or not source.is_file() or not source.resolve().is_relative_to(folder):
                raise ValueError("Source non autorisée")
            archive.write(source, name)
else:
    raise ValueError("Opération inconnue")
