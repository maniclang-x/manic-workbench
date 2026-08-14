#!/usr/bin/env bash
set -euo pipefail

workbench_root="$(cd "$(dirname "$0")/.." && pwd)"
manic_root="${1:-$workbench_root/../../manic}"
source_dir="$manic_root/crates/manic-lang/pkg"
target_dir="$workbench_root/src/client/public/wasm"

if [[ ! -f "$manic_root/Cargo.toml" ]]; then
  echo "missing Manic source repository: $manic_root" >&2
  echo "pass the private Manic repository path as the first argument" >&2
  exit 1
fi

wasm_pack="${WASM_PACK:-wasm-pack}"
if ! command -v "$wasm_pack" >/dev/null 2>&1 && [[ -x "$HOME/.cargo/bin/wasm-pack" ]]; then
  wasm_pack="$HOME/.cargo/bin/wasm-pack"
fi
command -v "$wasm_pack" >/dev/null 2>&1 || {
  echo "wasm-pack is required (cargo install wasm-pack)" >&2
  exit 1
}

# Workbench always publishes the language service produced from the current
# Manic source. Copying an old pkg directory would make diagnostics and
# autocomplete drift from the released CLI/API engine.
(
  cd "$manic_root"
  PATH="$(dirname "$(rustup which rustc)"):$HOME/.cargo/bin:$PATH" \
    "$wasm_pack" build crates/manic-lang --target web --out-dir pkg --features wasm
)

for name in manic_lang.js manic_lang_bg.wasm manic_lang.d.ts manic_lang_bg.wasm.d.ts; do
  if [[ ! -f "$source_dir/$name" ]]; then
    echo "missing generated Manic language asset: $source_dir/$name" >&2
    exit 1
  fi
done

mkdir -p "$target_dir"
for name in manic_lang.js manic_lang_bg.wasm manic_lang.d.ts manic_lang_bg.wasm.d.ts; do
  cp "$source_dir/$name" "$target_dir/$name"
done
if command -v xattr >/dev/null 2>&1; then
  xattr -c "$target_dir/manic_lang.js" "$target_dir/manic_lang_bg.wasm" \
    "$target_dir/manic_lang.d.ts" "$target_dir/manic_lang_bg.wasm.d.ts"
fi

echo "updated Workbench language service from $source_dir"
shasum -a 256 "$target_dir/manic_lang.js" "$target_dir/manic_lang_bg.wasm" \
  "$target_dir/manic_lang.d.ts" "$target_dir/manic_lang_bg.wasm.d.ts"
