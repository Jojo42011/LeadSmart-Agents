# Upload local data/scrub_log.db to the Fly volume via HTTPS.
# Requires: fly CLI (for secrets), DB on disk at ../data/scrub_log.db
#
# Usage:
#   .\scripts\push-db-to-fly.ps1
#   .\scripts\push-db-to-fly.ps1 -App leadsmart-ringba-scrub -Secret "your-import-secret"

param(
  [string]$App = "leadsmart-ringba-scrub",
  [string]$Secret = $env:DB_IMPORT_SECRET,
  [string]$DbPath = (Join-Path $PSScriptRoot "..\data\scrub_log.db")
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $DbPath)) {
  Write-Error "Database not found: $DbPath"
}

if (-not $Secret) {
  $Secret = [guid]::NewGuid().ToString()
  Write-Host "Setting DB_IMPORT_SECRET on Fly (save this for re-runs): $Secret"
  fly secrets set "DB_IMPORT_SECRET=$Secret" -a $App
  Write-Host "Waiting for machine to pick up secret..."
  Start-Sleep -Seconds 8
}

$url = "https://$App.fly.dev/api/import-db"
$bytes = [System.IO.File]::ReadAllBytes((Resolve-Path $DbPath))

Write-Host "Uploading $($bytes.Length) bytes to $url ..."

$response = Invoke-WebRequest -Uri $url -Method POST `
  -Headers @{ Authorization = "Bearer $Secret" } `
  -ContentType "application/octet-stream" `
  -Body $bytes

Write-Host $response.Content
Write-Host "Done. Open https://$App.fly.dev and refresh."
