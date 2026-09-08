$ErrorActionPreference = "Stop"

$Sources = Resolve-Path (Join-Path $PSScriptRoot "..")
$Tauri = Join-Path $Sources "node_modules\.bin\tauri.cmd"
if (Test-Path -LiteralPath $Tauri) {
    exit 0
}

Push-Location $Sources
try {
    & npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
        throw "npm install failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

if (-not (Test-Path -LiteralPath $Tauri)) {
    throw "@tauri-apps/cli is still missing after npm install"
}
