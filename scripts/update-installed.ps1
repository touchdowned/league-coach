# Updates the installed League Coach (Start menu app) to the latest version of this branch.
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File C:\Users\This0\league-coach\scripts\update-installed.ps1
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
Get-Process "League Coach" -ErrorAction SilentlyContinue | Stop-Process
git pull origin phase-1-match-review
npm install
npm run build
npx --yes @electron/packager . "League Coach" --platform=win32 --arch=x64 --icon=build/icon.ico --out=release --overwrite --app-version=0.1.0 --win32metadata.ProductName="League Coach" --win32metadata.FileDescription="League Coach" --ignore="^/release" --ignore="^/src" --ignore="^/tests"
$dest = Join-Path $env:LOCALAPPDATA "Programs\League Coach"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Recurse -Force "release\League Coach-win32-x64\*" $dest
Start-Process (Join-Path $dest "League Coach.exe")
Write-Host "League Coach updated."
