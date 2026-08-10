"""Server-side file browser/editor for an uploaded project's extracted
source (``job.project_dir``).

Powers two things in the UI: the "Project files" panel on a job ticket
(browse/edit/add/delete/rename files, then hit Rebuild) and the error
assistant's quick-fix editor (jump straight to the file the error
mentions, patch it, save). Both are meant for small, targeted corrections
on an already-uploaded project — not a general-purpose IDE — hence the
size cap and the binary-file rejection below.
"""
from __future__ import annotations

import shutil
from pathlib import Path

# Never worth listing/opening — either huge generated/vendor trees or
# caches that aren't meaningful to hand-edit, and in the case of
# node_modules potentially tens of thousands of entries that would blow
# past _MAX_TREE_ENTRIES on their own and crowd out the project's own
# source from the listing.
_SKIP_DIR_NAMES = frozenset(
    {
        "node_modules", ".git", ".gradle", "gradle-home", "build", ".idea",
        "dist", "www", "out", ".dart_tool", ".pub-cache",
    }
)

# A quick-fix editor, not a full IDE — bounds how much a single listing or
# file can cost to read/render.
_MAX_TREE_ENTRIES = 4000
_MAX_FILE_BYTES = 2 * 1024 * 1024  # 2MB


class FileApiError(Exception):
    """Raised for any invalid file-editor request — routes.py converts
    this straight into an HTTPException using `status_code` below."""

    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


def resolve_path(project_dir: Path, rel_path: str) -> Path:
    """Resolves a client-supplied relative path against project_dir,
    guaranteeing the result can never land outside it — path traversal
    (``../../etc/passwd``), an absolute path, or a symlink escape. This
    directly reads/writes/deletes files based on user input, so this
    check is load-bearing, not a nicety.
    """
    if not rel_path or not rel_path.strip():
        raise FileApiError("A file path is required.")
    rel = rel_path.strip().lstrip("/")
    if not rel:
        raise FileApiError("A file path is required.")

    project_root = project_dir.resolve()
    candidate = (project_dir / rel).resolve()
    if candidate != project_root and project_root not in candidate.parents:
        raise FileApiError("That path escapes the project directory.", 400)
    return candidate


def build_tree(project_dir: Path) -> dict:
    """A nested {name, path, type, children?} tree, breadth-limited to
    _MAX_TREE_ENTRIES total nodes across the whole walk (not per
    directory) — a single huge folder shouldn't be able to starve the
    rest of the listing of its share of the cap.
    """
    if not project_dir.exists():
        return {"tree": [], "truncated": False}

    counter = {"n": 0}
    truncated = {"v": False}

    def walk(dir_path: Path, rel_prefix: str) -> list[dict]:
        if truncated["v"]:
            return []
        try:
            entries = sorted(dir_path.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
        except OSError:
            return []

        nodes: list[dict] = []
        for entry in entries:
            if counter["n"] >= _MAX_TREE_ENTRIES:
                truncated["v"] = True
                break
            counter["n"] += 1
            rel = f"{rel_prefix}{entry.name}"

            if entry.is_dir():
                # Still shown (so it's clear e.g. node_modules exists),
                # just not descended into.
                skip_children = entry.name in _SKIP_DIR_NAMES
                nodes.append(
                    {
                        "name": entry.name,
                        "path": rel,
                        "type": "dir",
                        "children": [] if skip_children else walk(entry, f"{rel}/"),
                        "skipped": skip_children,
                    }
                )
            else:
                try:
                    size = entry.stat().st_size
                except OSError:
                    size = 0
                nodes.append({"name": entry.name, "path": rel, "type": "file", "size": size})
        return nodes

    return {"tree": walk(project_dir, ""), "truncated": truncated["v"]}


def read_file(project_dir: Path, rel_path: str) -> dict:
    path = resolve_path(project_dir, rel_path)
    if not path.exists() or not path.is_file():
        raise FileApiError("File not found.", 404)

    size = path.stat().st_size
    if size > _MAX_FILE_BYTES:
        raise FileApiError(
            f"File is too large to edit here ({size // 1024}KB, limit {_MAX_FILE_BYTES // 1024 // 1024}MB).",
            413,
        )

    raw = path.read_bytes()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise FileApiError("This looks like a binary file — it can't be edited here.", 415) from exc

    return {"path": rel_path, "content": text, "size": size}


def write_file(project_dir: Path, rel_path: str, content: str, *, create: bool) -> dict:
    path = resolve_path(project_dir, rel_path)
    if create and path.exists():
        raise FileApiError("A file or folder already exists at that path.", 409)
    if not create and not path.exists():
        raise FileApiError("File not found.", 404)
    if path.exists() and path.is_dir():
        raise FileApiError("That path is a folder, not a file.", 400)
    if len(content.encode("utf-8")) > _MAX_FILE_BYTES:
        raise FileApiError(f"Content exceeds the {_MAX_FILE_BYTES // 1024 // 1024}MB edit limit.", 413)

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return {"path": rel_path, "size": path.stat().st_size}


def create_dir(project_dir: Path, rel_path: str) -> dict:
    path = resolve_path(project_dir, rel_path)
    if path.exists():
        raise FileApiError("A file or folder already exists at that path.", 409)
    path.mkdir(parents=True, exist_ok=False)
    return {"path": rel_path}


def delete_path(project_dir: Path, rel_path: str) -> dict:
    path = resolve_path(project_dir, rel_path)
    if path == project_dir.resolve():
        raise FileApiError("Can't delete the project root.", 400)
    if not path.exists():
        raise FileApiError("Not found.", 404)

    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink()
    return {"path": rel_path, "deleted": True}


def rename_path(project_dir: Path, from_rel: str, to_rel: str) -> dict:
    src = resolve_path(project_dir, from_rel)
    dst = resolve_path(project_dir, to_rel)
    if not src.exists():
        raise FileApiError("Source not found.", 404)
    if dst.exists():
        raise FileApiError("A file or folder already exists at the destination.", 409)

    dst.parent.mkdir(parents=True, exist_ok=True)
    src.rename(dst)
    return {"path": to_rel}
