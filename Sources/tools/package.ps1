$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$Sources = Join-Path $Root "Sources"
$Results = Join-Path $Root "Results"
$Target = Join-Path $Results "cargo-package-target"
$Output = Join-Path $Results "package"
$PackageTemp = Join-Path $Results "package-temp"
$Tauri = Join-Path $Sources "node_modules\.bin\tauri.cmd"

if (Test-Path -LiteralPath $Target) {
    Remove-Item -LiteralPath $Target -Recurse -Force
}
if (Test-Path -LiteralPath $PackageTemp) {
    Remove-Item -LiteralPath $PackageTemp -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $Output, $PackageTemp | Out-Null
$previousTemp = $env:TEMP
$previousTmp = $env:TMP
$env:CARGO_TARGET_DIR = $Target
$env:TEMP = $PackageTemp
$env:TMP = $PackageTemp

try {
    Push-Location $Sources
    try {
        & $Tauri build --config src-tauri/tauri.package.conf.json
        if ($LASTEXITCODE -ne 0) { throw "tauri build failed with exit code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }

    $bundle = Join-Path $Target "release\bundle\nsis"
    $installer = Get-ChildItem -LiteralPath $bundle -Filter "*.exe" -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $installer) { throw "NSIS installer was not produced" }
    $destination = Join-Path $Output $installer.Name
    Copy-Item -LiteralPath $installer.FullName -Destination $destination -Force
    Write-Host "TANREN installer: $destination"
} finally {
    Remove-Item Env:CARGO_TARGET_DIR -ErrorAction SilentlyContinue
    $env:TEMP = $previousTemp
    $env:TMP = $previousTmp
    if (Test-Path -LiteralPath $Target) {
        Write-Host "Removing temporary package Cargo target..."
        Remove-Item -LiteralPath $Target -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $PackageTemp) {
        Write-Host "Removing temporary package files..."
        Remove-Item -LiteralPath $PackageTemp -Recurse -Force -ErrorAction SilentlyContinue
    }
    foreach ($path in @((Join-Path $Results "pyinstaller-work"), (Join-Path $Results "pyinstaller-spec"))) {
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue }
    }
}
