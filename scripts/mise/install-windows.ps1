# The whole Windows pipeline in one command: installs dependencies, compiles, packages a
# fresh per-user installer and installs Code - OSS for the current user.
# Invoked by `mise run install:windows`.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')

Write-Host '==> installing dependencies'
npm run install-fast
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host '==> compiling'
npm run gulp core-ci
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host '==> packaging'
& (Join-Path $PSScriptRoot 'release-windows.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$setup = Get-ChildItem .build\win32-x64\user-setup\*.exe | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Host "==> installing $($setup.Name)"
$process = Start-Process -FilePath $setup.FullName -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/MERGETASKS=!runcode' -Wait -PassThru
if ($process.ExitCode -ne 0) { Write-Error "installer exited with code $($process.ExitCode)"; exit $process.ExitCode }
Write-Host "==> installed for the current user; launch 'Code - OSS' from the Start menu"
