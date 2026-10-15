# Installs Code - OSS for the current user, rebuilding the installer first when it is missing or
# was built from a different commit. Invoked by `mise run install:windows`.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')

$head = (git rev-parse HEAD).Trim()
$productJson = Get-ChildItem ..\VSCode-win32-x64 -Recurse -Filter product.json -ErrorAction SilentlyContinue |
	Where-Object { $_.FullName -like '*\resources\app\product.json' } | Select-Object -First 1
$packaged = if ($productJson) { (Get-Content $productJson.FullName -Raw | ConvertFrom-Json).commit } else { '' }
$setup = Get-ChildItem .build\win32-x64\user-setup\*.exe -ErrorAction SilentlyContinue |
	Sort-Object LastWriteTime -Descending | Select-Object -First 1

if (git status --porcelain -- src extensions) {
	Write-Warning "uncommitted changes in src/ or extensions/ are not detected; commit them or run 'mise run release:windows' to include them"
}

if (-not $setup -or $packaged -ne $head) {
	Write-Host "==> installer missing or built from '$packaged', HEAD is ${head}: building"
	& (Join-Path $PSScriptRoot 'release-windows.ps1')
	if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
	$setup = Get-ChildItem .build\win32-x64\user-setup\*.exe | Sort-Object LastWriteTime -Descending | Select-Object -First 1
} else {
	Write-Host "==> reusing $($setup.FullName) (built from HEAD)"
}

Write-Host "==> installing $($setup.Name)"
$process = Start-Process -FilePath $setup.FullName -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/MERGETASKS=!runcode' -Wait -PassThru
if ($process.ExitCode -ne 0) { Write-Error "installer exited with code $($process.ExitCode)"; exit $process.ExitCode }
Write-Host "==> installed for the current user; launch 'Code - OSS' from the Start menu"
