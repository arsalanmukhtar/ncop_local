#!/usr/bin/env python3
"""
tree_to_txt.py

Generate a directory tree (with proper hierarchy lines) and save it to a .txt file.

Examples:
  python tree_to_txt.py "D:/my_project" --exclude node_modules,"src files",.git --out tree.txt
  python tree_to_txt.py /home/user/project --exclude "node_modules,dist,.venv,__pycache__"
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
from typing import Iterable, List, Set


def parse_excludes(raw: str | None) -> Set[str]:
    """
    Parse comma-separated excludes, trimming whitespace and stripping surrounding quotes.
    Example input: node_modules,"src files", .git
    """
    if not raw:
        return set()

    parts: List[str] = []
    for p in raw.split(","):
        p = p.strip()
        if not p:
            continue
        # strip surrounding single/double quotes
        if (p.startswith('"') and p.endswith('"')) or (p.startswith("'") and p.endswith("'")):
            p = p[1:-1].strip()
        if p:
            parts.append(p)

    # folder names are compared as-is (case sensitive on Linux, usually insensitive on Windows)
    return set(parts)


def build_tree_lines(
    root: Path,
    exclude_names: Set[str],
    include_files: bool = True,
    max_depth: int | None = None,
) -> List[str]:
    """
    Return lines representing the directory tree rooted at `root`.

    Excludes apply to directory names (not full paths).
    """
    root = root.resolve()
    lines: List[str] = [str(root)]

    def walk(dir_path: Path, prefix: str, depth: int) -> None:
        if max_depth is not None and depth > max_depth:
            return

        try:
            entries = list(dir_path.iterdir())
        except PermissionError:
            lines.append(f"{prefix}└── [Permission denied]")
            return

        # Separate dirs/files; filter excluded directories
        dirs = [e for e in entries if e.is_dir() and e.name not in exclude_names]
        files = [e for e in entries if e.is_file()] if include_files else []

        # Sort: dirs first, then files (alphabetical, case-insensitive)
        dirs.sort(key=lambda p: p.name.lower())
        files.sort(key=lambda p: p.name.lower())

        combined = dirs + files

        for i, entry in enumerate(combined):
            is_last = i == len(combined) - 1
            connector = "└── " if is_last else "├── "
            lines.append(f"{prefix}{connector}{entry.name}")

            if entry.is_dir():
                extension = "    " if is_last else "│   "
                walk(entry, prefix + extension, depth + 1)

    walk(root, prefix="", depth=1)
    return lines


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate a directory tree and save it to a text file."
    )
    parser.add_argument(
        "path",
        help="Root folder path to scan",
    )
    parser.add_argument(
        "--exclude",
        default="",
        help='Comma-separated folder names to exclude (e.g., node_modules,"src files",.git)',
    )
    parser.add_argument(
        "--out",
        default="directory_tree.txt",
        help="Output text file path (default: directory_tree.txt)",
    )
    parser.add_argument(
        "--dirs-only",
        action="store_true",
        help="Only include directories (exclude files from the tree)",
    )
    parser.add_argument(
        "--max-depth",
        type=int,
        default=None,
        help="Limit traversal depth (1 = just root). Default: unlimited.",
    )

    args = parser.parse_args()

    root = Path(args.path)
    if not root.exists():
        raise SystemExit(f"Error: path does not exist: {root}")
    if not root.is_dir():
        raise SystemExit(f"Error: path is not a directory: {root}")

    exclude_names = parse_excludes(args.exclude)

    lines = build_tree_lines(
        root=root,
        exclude_names=exclude_names,
        include_files=not args.dirs_only,
        max_depth=args.max_depth,
    )

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(f"Saved tree to: {out_path.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

# python tree_to_txt.py "E:\WSL\Ubuntu2204\OS\neoc\neoc-devteam-ops-system" --exclude node_modules,"src files",.git --out tree.txt
