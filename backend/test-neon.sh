#!/bin/bash
export NODE_ENV=production
export PGHOST=ep-frosty-moon-agkc49t5-pooler.c-2.eu-central-1.aws.neon.tech
export PGPORT=5432
export PGUSER=neondb_owner
export PGDATABASE=neondb

# You need to set PGPASSWORD yourself
echo "Testing Neon connection..."
echo "Make sure to set PGPASSWORD before running:"
echo "export PGPASSWORD='your-password-here'"
echo ""
echo "Then run: node diagnose-db.js"
