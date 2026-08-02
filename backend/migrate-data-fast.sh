#!/bin/bash
# Fast data migration using pg_dump + psql
# Much faster than row-by-row copying

set -e

echo "[Migration] Fast migration: Local PostgreSQL → Neon"
echo ""

# Source: Local PostgreSQL
PGHOST=localhost
PGPORT=5432
PGUSER=postgres
PGPASSWORD=super@123
PGDATABASE=s88_app

# Target: Neon
NEON_HOST=ep-frosty-moon-agkc49t5-pooler.c-2.eu-central-1.aws.neon.tech
NEON_PORT=5432
NEON_USER=neondb_owner
NEON_PASSWORD=npg_Wv3K9xtgUhme
NEON_DATABASE=s88_app

echo "[Migration] Dumping local database..."
pg_dump -h $PGHOST -U $PGUSER -d $PGDATABASE --no-owner --no-acl -v > /tmp/s88_app_dump.sql 2>&1 | grep -E "(dumping|TABLE)"

echo "[Migration] Restoring to Neon..."
PGPASSWORD=$NEON_PASSWORD psql -h $NEON_HOST -U $NEON_USER -d $NEON_DATABASE < /tmp/s88_app_dump.sql

echo "[Migration] ✅ Migration complete!"
rm /tmp/s88_app_dump.sql
