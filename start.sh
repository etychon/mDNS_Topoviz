#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
# Clear any stale stack or manually-started container using the same name.
docker compose down --remove-orphans 2>/dev/null || true
docker rm -f mdns-topoviz 2>/dev/null || true
docker compose up -d --build
