# Copies the app folder to a Brewser SD card (or any target dir).
# Usage: .\tools\deploy-to-sd.ps1 -Drive E:     (→ E:\switch\brewser\apps\com.shirai.dreamcast)
#        .\tools\deploy-to-sd.ps1 -Target "\SWITCH\sdcard\switch\brewser\apps"   (ftpd/CIFS mounts etc.)
param(
  [string]$Drive = "",
  [string]$Target = ""
)
$src = Join-Path $PSScriptRoot "..\app\com.shirai.dreamcast"
if ($Target -eq "") {
  if ($Drive -eq "") { Write-Error "Pass -Drive <letter>: or -Target <dir>"; exit 1 }
  $Target = Join-Path $Drive "switch\brewser\apps"
}
$dst = Join-Path $Target "com.shirai.dreamcast"
New-Item -ItemType Directory -Force $dst | Out-Null
robocopy $src $dst /E /NFL /NDL /NJH /NJS /XD node_modules | Out-Null
Write-Host "Deployed to $dst"
