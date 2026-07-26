# Fast data migration using pg_dump + psql (PowerShell)
# Much faster than row-by-row copying

param(
  [string]$LocalPassword = "super@123",
  [string]$NeonPassword = "npg_Wv3K9xtgUhme"
)

Write-Host "[Migration] Fast migration: Local PostgreSQL to Neon" -ForegroundColor Green
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
$DumpFile = Join-Path $env:TEMP "s88_app_dump.sql"

# Export local database
Write-Host "[Migration] Dumping local database..."
$env:PGPASSWORD = $LocalPassword
& "G:\pgSQL\bin\pg_dump.exe" -h $PGHOST -U $PGUSER -d $PGDATABASE --no-owner --no-acl > $DumpFile
if ($LASTEXITCODE -ne 0) {
  Write-Host "[Migration] FAILED to dump local database" -ForegroundColor Red
  exit 1
}

$fileSize = [Math]::Round((Get-Item $DumpFile).Length / 1MB, 2)
Write-Host "[Migration] OK Dump complete ($fileSize MB)"
Write-Host ""

# Import to Neon
Write-Host "[Migration] Restoring to Neon..."
$env:PGPASSWORD = $NeonPassword
$content = Get-Content $DumpFile -Raw
$content | & "G:\pgSQL\bin\psql.exe" -h $NEON_HOST -U $NEON_USER -d $NEON_DATABASE --quiet 2>&1 | Out-Null

if ($LASTEXITCODE -ne 0) {
  Write-Host "[Migration] FAILED to restore to Neon" -ForegroundColor Red
  exit 1
}

Write-Host "[Migration] OK Restore complete"
Write-Host ""

# Cleanup
Remove-Item $DumpFile -Force -ErrorAction SilentlyContinue
Write-Host "[Migration] COMPLETE - Migration successful!" -ForegroundColor Green
