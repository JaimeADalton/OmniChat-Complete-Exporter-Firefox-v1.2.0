#!/usr/bin/env python3
"""Validate an OmniChat ZIP without extracting or executing its contents."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import sys
import zipfile

def verify(path: Path) -> int:
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("Entradas duplicadas en el ZIP")
        for name in names:
            p = PurePosixPath(name)
            if p.is_absolute() or ".." in p.parts:
                raise ValueError("Ruta no válida en el ZIP")
        bad = archive.testzip()
        if bad:
            raise ValueError(f"CRC incorrecto: {bad}")
        if "integrity.json" not in names:
            raise ValueError("El ZIP no incluye integrity.json; el CRC por sí solo no valida los archivos originales")
        manifest = json.loads(archive.read("integrity.json"))
        expected = manifest.get("entries")
        if not isinstance(expected, list):
            raise ValueError("Formato de manifiesto no válido")
        described: set[str] = set()
        for entry in expected:
            name = entry["path"]
            if name in described:
                raise ValueError("Entrada repetida en el manifiesto")
            described.add(name)
            info = archive.getinfo(name)
            if info.file_size != entry["bytes"]:
                raise ValueError(f"Tamaño incorrecto: {name}")
            digest = hashlib.sha256()
            with archive.open(info) as stream:
                while chunk := stream.read(1024 * 1024):
                    digest.update(chunk)
            if digest.hexdigest() != entry["sha256"]:
                raise ValueError(f"SHA-256 incorrecto: {name}")
        extras = set(names) - described - {"integrity.json", "SHA256SUMS.txt"}
        if extras:
            raise ValueError(f"{len(extras)} entradas no cubiertas por el manifiesto")
        return len(expected)

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("zip", type=Path, help="ZIP exportado o reparado")
    args = parser.parse_args()
    try:
        count = verify(args.zip)
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(f"Integridad verificada: {count} archivos; tamaños, SHA-256 y CRC correctos.")
    print("Esta comprobación no certifica la cobertura ni la autenticidad de la conversación.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
