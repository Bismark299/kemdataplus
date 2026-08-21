#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Install exactly the dependency versions recorded for the backend, then
# regenerate the Prisma client in case its schema changed in the merged task.
npm ci --prefix server
npx --prefix server prisma generate --schema server/prisma/schema.prisma