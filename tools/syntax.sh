#!/usr/bin/env bash
# Checks every module as real ESM. `node --check` on a .js file silently
# reparses and, combined with a careless `|| true`, once reported OK for a file
# that the browser rejected. This version cannot lie.
set -u
fail=0
tmp=$(mktemp -d)
while IFS= read -r f; do
  cp "$f" "$tmp/m.mjs"
  if out=$(node --check "$tmp/m.mjs" 2>&1); then
    printf '  \033[32m✓\033[0m %s\n' "$f"
  else
    printf '  \033[31m✗\033[0m %s\n%s\n' "$f" "$(echo "$out" | sed 's|^|      |' | head -8)"
    fail=1
  fi
done < <(find public/js -name '*.js' | sort)
rm -rf "$tmp"
exit $fail
