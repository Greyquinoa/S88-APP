#!/bin/bash
set -e

echo "🔌 Exporting local database schema and data..."
pg_dump -h localhost -U postgres -d s88_app \
  --data-only \
  --disable-triggers \
  -F custom -f /tmp/s88_app_data.dump

echo "✓ Exported local data"

echo "📍 Restoring to Neon..."
pg_restore -h ep-frosty-moon-agkc49t5-pooler.c-2.eu-central-1.aws.neon.tech \
  -U neondb_owner \
  -d s88_app \
  --disable-triggers \
  --no-owner \
  /tmp/s88_app_data.dump

echo "✅ Restore complete!"
