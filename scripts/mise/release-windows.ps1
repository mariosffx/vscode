# Packages Code - OSS for Windows x64: a portable app folder at ..\VSCode-win32-x64 and a
# per-user installer in .build\win32-x64\user-setup. Invoked by `mise run release:windows`.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')

foreach ($task in 'vscode-win32-x64-min', 'vscode-win32-x64-inno-updater', 'vscode-win32-x64-user-setup') {
	Write-Host "==> npm run gulp $task"
	npm run gulp $task
	if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host "==> app folder: $(Resolve-Path ..\VSCode-win32-x64)  (launch: 'Code - OSS.exe' inside it)"
Write-Host "==> installer:  $(Get-ChildItem .build\win32-x64\user-setup\*.exe | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName)"
