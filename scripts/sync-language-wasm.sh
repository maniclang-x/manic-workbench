#!/usr/bin/env bash
set -euo pipefail

workbench_root="$(cd "$(dirname "$0")/.." && pwd)"
manic_root="${1:-$workbench_root/../../manic}"
source_dir="$manic_root/crates/manic-lang/pkg"
target_dir="$workbench_root/src/client/public/wasm"

for name in manic_lang.js manic_lang_bg.wasm; do
  if [[ ! -f "$source_dir/$name" ]]; then
    echo "missing generated Manic language asset: $source_dir/$name" >&2
    echo "pass the private Manic repository path as the first argument" >&2
    exit 1
  fi
done

mkdir -p "$target_dir"
cp "$source_dir/manic_lang.js" "$target_dir/manic_lang.js"
cp "$source_dir/manic_lang_bg.wasm" "$target_dir/manic_lang_bg.wasm"
if command -v xattr >/dev/null 2>&1; then
  xattr -c "$target_dir/manic_lang.js" "$target_dir/manic_lang_bg.wasm"
fi

echo "updated Workbench language service from $source_dir"
shasum -a 256 "$target_dir/manic_lang.js" "$target_dir/manic_lang_bg.wasm"
