import os

EXCLUDE_DIRS = {
    "__pycache__",
    "node_modules",
    "venv",
    ".venv",
    "env",
    ".env",
    ".git",
    "dist",
    "build",
    ".idea",
    ".vscode",
    ".pytest_cache",
    ".mypy_cache",
    ".DS_Store",
}

def print_tree(startpath, output_file):
    with open(output_file, "w", encoding="utf-8") as f:
        for root, dirs, files in os.walk(startpath):
            # Modify dirs in-place to skip excluded directories
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]

            level = root.replace(startpath, '').count(os.sep)
            indent = '│   ' * level + '├── '
            folder_name = os.path.basename(root) or startpath
            f.write(f"{indent}{folder_name}/\n")

            sub_indent = '│   ' * (level + 1)
            for file in files:
                f.write(f"{sub_indent}├── {file}\n")

    print(f"\n✅ Tree structure saved to: {output_file}")

if __name__ == "__main__":
    raw = input("Enter folder path to scan (default: current folder): ").strip()

    # Remove wrapping quotes if user pasted "C:\path" or 'C:\path'
    if (raw.startswith('"') and raw.endswith('"')) or (raw.startswith("'") and raw.endswith("'")):
        raw = raw[1:-1].strip()

    # Default: scan current working directory
    folder_to_scan = raw if raw else os.getcwd()

    # Safety: verify folder exists
    if not os.path.isdir(folder_to_scan):
        raise SystemExit(f"❌ Folder does not exist: {folder_to_scan}")

    output_path = os.path.join(os.getcwd(), "folder_tree_updated.txt")
    print_tree(folder_to_scan, output_path)
