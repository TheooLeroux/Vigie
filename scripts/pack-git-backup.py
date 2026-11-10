"""Pack verified Git sources and a logical database dump."""
import hashlib
import json
import pathlib
import re
import sys
import tarfile
import zipfile


def pack(folder, destination, sources):
    if not sources or any(not re.fullmatch(r"app-[0-9a-f]{40}\.tar\.gz", name) for name in sources):
        raise ValueError("Archives source manquantes ou invalides")
    names = ["deployment.json", "database.dump", *sources]
    deployment = json.loads((folder / "deployment.json").read_text(encoding="utf8"))
    for name in sources:
        commit = name.removeprefix("app-").removesuffix(".tar.gz")
        expected = {str(pathlib.PurePosixPath(service["root"].lstrip("/")) / "package.json")
                    for service in deployment["services"] if service["commit"] == commit}
        with tarfile.open(folder / name, "r:gz") as source:
            if not expected or not expected.issubset(entry.name for entry in source if entry.isfile()):
                raise ValueError("Sources d’un service déployé absentes du ZIP")
    hashes = {}
    with zipfile.ZipFile(destination, "x") as archive:
        for name in names:
            path = folder / name
            if path.is_symlink() or not path.is_file() or not path.stat().st_size:
                raise ValueError("Composant de sauvegarde absent")
            with path.open("rb") as source:
                hashes[name] = {"bytes": path.stat().st_size, "sha256": hashlib.file_digest(source, "sha256").hexdigest()}
            archive.write(path, name)
        archive.writestr("manifest.json", json.dumps({"files": hashes}, indent=2) + "\n")
    with zipfile.ZipFile(destination) as archive:
        if archive.testzip() is not None:
            raise ValueError("ZIP de sauvegarde corrompu")


if __name__ == "__main__":
    folder, destination, *sources = sys.argv[1:]
    pack(pathlib.Path(folder), pathlib.Path(destination), sources)
