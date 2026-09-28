#!/usr/bin/env bash
# Copies platform/shared/*.ts into every data-plane service (each has its own Docker build context).
set -euo pipefail
cd "$(dirname "$0")/.."
for svc in platform/data-plane/auth-service platform/data-plane/api-service platform/data-plane/realtime-service platform/data-plane/storage-api; do
  mkdir -p "$svc/src/lib"
  for f in platform/shared/*.ts; do
    cp "$f" "$svc/src/lib/$(basename "$f")"
  done
done
echo "✓ shared files synced"
