# Installs the latest League Coach from GitHub Releases.
# You only need this once: after that the app updates itself every time new code is pushed.
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File C:\Users\This0\league-coach\scripts\update-installed.ps1
$ErrorActionPreference = "Stop"
$release = Invoke-RestMethod "https://api.github.com/repos/touchdowned/league-coach/releases/latest" -Headers @{ "User-Agent" = "league-coach-installer" }
$asset = $release.assets | Where-Object { $_.name -like "League-Coach-Setup-*.exe" } | Select-Object -First 1
if (-not $asset) { throw "No installer found on the latest release yet." }
$setup = Join-Path $env:TEMP $asset.name
Write-Host "Downloading $($asset.name)..."
Invoke-WebRequest $asset.browser_download_url -OutFile $setup
Get-Process "League Coach" -ErrorAction SilentlyContinue | Stop-Process
Start-Process $setup -Wait
Write-Host "League Coach $($release.tag_name) installed. It will keep itself up to date from now on."
