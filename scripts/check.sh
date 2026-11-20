#!/usr/bin/env bash
# Validate the marketplace and every mod, then run each mod's tests.
# Stops at the first failure and exits non-zero.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

if ! command -v claude >/dev/null 2>&1; then
  echo "check: claude CLI not found on PATH" >&2
  exit 1
fi

echo "check: validate marketplace"
claude plugin validate .

for dir in plugins/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"

  echo "check: validate $name"
  claude plugin validate "$dir"

  # Only run tests when the mod has test files; claude plugin test fails on none
  if find "$dir" \( -name '*.test.ts' -o -name '*.test.tsx' \) -not -path '*/node_modules/*' | grep -q .; then
    echo "check: test $name"
    (cd "$dir" && claude plugin test)
  else
    echo "check: test $name skipped (no *.test.ts or *.test.tsx yet)"
  fi
done

echo "check: all passed"
