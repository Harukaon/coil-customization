#!/bin/bash
# Records the form audit either from the current build or from a saved one.
# usage: scripts/form-audit-compare.sh <saved-out-dir|current> <output json> [repo]
# Save a baseline build with: cp -R apps/desktop/out /tmp/out-before
set -e
MODE="$1"; OUT="$2"; REPO="${3:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$REPO"
if [ "$MODE" != "current" ]; then
  rm -rf apps/desktop/out.saved
  mv apps/desktop/out apps/desktop/out.saved
  cp -R "$MODE" apps/desktop/out
  trap 'rm -rf apps/desktop/out; mv apps/desktop/out.saved apps/desktop/out' EXIT
fi
FORM_AUDIT_OUT="$OUT" env -u ELECTRON_RUN_AS_NODE npm run e2e -- form-audit 2>&1 | grep -E "form-audit:|SKIPPED|FAIL" | cut -c1-300
