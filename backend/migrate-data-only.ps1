# Data-only migration (schema already exists in Neon)
# This skips CREATE TABLE statements and only copies data

param(
  [string]$LocalPassword = "super@123",
  [string]$NeonPassword = "npg_Wv3K9xtgUhme"
)

Write-Host "[Migration] Data-only migration: Local to Neon" -ForegroundColor Green
Write-Host ""

# Source: Local PostgreSQL
$PGHOST = "localhost"
$PGPORT = "5432"
$PGUSER = "postgres"
$PGDATABASE = "s88_app"

# Target: Neon
$NEON_HOST = "ep-frosty-moon-agkc49t5-pooler.c-2.eu-central-1.aws.neon.tech"
$NEON_PORT = "5432"
$NEON_USER = "neondb_owner"
$NEON_DATABASE = "s88_app"

# Create temp dump file
$DumpFile = Join-Path $env:TEMP "s88_app_data_only.sql"

Write-Host "[Migration] Dumping local data (schema only)..."
$env:PGPASSWORD = $LocalPassword

# Dump data only, skip schema
& "G:\pgSQL\bin\pg_dump.exe" -h $PGHOST -U $PGUSER -d $PGDATABASE `
  --data-only `
  --no-owner `
  --no-acl `
  --disable-triggers > $DumpFile

if ($LASTEXITCODE -ne 0) {
  Write-Host "[Migration] FAILED to dump local database" -ForegroundColor Red
  exit 1
}

$fileSize = [Math]::Round((Get-Item $DumpFile).Length / 1MB, 2)
Write-Host "[Migration] OK Dump complete ($fileSize MB)"
Write-Host ""

Write-Host "[Migration] Restoring data to Neon..."
$env:PGPASSWORD = $NeonPassword

# Read and execute dump
$content = Get-Content $DumpFile -Raw

# Replace any problematic statements
$content = $content -replace "SET session_replication_role.*?;", ""

$content | & "G:\pgSQL\bin\psql.exe" -h $NEON_HOST -U $NEON_USER -d $NEON_DATABASE --quiet 2>&1 | Out-Null

if ($LASTEXITCODE -ne 0) {
  Write-Host "[Migration] FAILED to restore to Neon" -ForegroundColor Red
  Write-Host "[Migration] Check that schema already exists in Neon" -ForegroundColor Yellow
  exit 1
}

Write-Host "[Migration] OK Restore complete"
Write-Host ""

# Cleanup
Remove-Item $DumpFile -Force -ErrorAction SilentlyContinue
Write-Host "[Migration] COMPLETE - Data migrated successfully!" -ForegroundColor Green
