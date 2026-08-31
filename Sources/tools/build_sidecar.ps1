param(
    [string]$Python = "python"
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$Sources = Join-Path $Root "Sources"
$Results = Join-Path $Root "Results"
$EnvDir = Join-Path $Results "python-sidecar-env"
$Output = Join-Path $Results "sidecar"
$Script = Join-Path $Sources "src-tauri\sidecar\japanese_sidecar.py"
$Requirements = Join-Path $Sources "src-tauri\sidecar\requirements-build.txt"

if (!(Test-Path (Join-Path $EnvDir "Scripts\python.exe"))) {
    & $Python -m venv $EnvDir
}

$EnvPython = Join-Path $EnvDir "Scripts\python.exe"
& $EnvPython -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "pip upgrade failed with exit code $LASTEXITCODE" }
& $EnvPython -m pip install -r $Requirements
if ($LASTEXITCODE -ne 0) { throw "sidecar dependency install failed with exit code $LASTEXITCODE" }

New-Item -ItemType Directory -Force $Output | Out-Null
& $EnvPython -m PyInstaller `
    --noconfirm `
    --clean `
    --onefile `
    --name tanren-language `
    --distpath $Output `
    --workpath (Join-Path $Results "pyinstaller-work") `
    --specpath (Join-Path $Results "pyinstaller-spec") `
    --collect-all pyopenjtalk `
    --collect-all fugashi `
    --collect-all unidic_lite `
    $Script
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed with exit code $LASTEXITCODE" }

$Built = Join-Path $Output "tanren-language.exe"
if (!(Test-Path $Built)) {
    throw "PyInstaller completed without producing $Built"
}

$Rustc = Join-Path $Results "toolchains\cargo\bin\rustc.exe"
if (!(Test-Path $Rustc)) {
    $RustcCommand = Get-Command rustc -ErrorAction Stop
    $Rustc = $RustcCommand.Source
}
$TargetTriple = (& $Rustc --print host-tuple).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($TargetTriple)) {
    throw "Unable to determine rustc host target triple"
}

$TauriSidecar = Join-Path $Output "tanren-language-$TargetTriple.exe"
Copy-Item $Built $TauriSidecar -Force
Remove-Item $Built -Force

Write-Host "Tauri sidecar: $TauriSidecar"
