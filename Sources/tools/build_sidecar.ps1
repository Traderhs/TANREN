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
$RuntimeRequirements = Join-Path $Sources "src-tauri\sidecar\requirements.txt"
$Marker = Join-Path $Output ".tanren-language-source"

$EnvPython = Join-Path $EnvDir "Scripts\python.exe"
$RecreateEnv = !(Test-Path $EnvPython)
if (!$RecreateEnv) {
    try {
        & $EnvPython -c "import sys" *> $null
        $RecreateEnv = $LASTEXITCODE -ne 0
    } catch {
        $RecreateEnv = $true
    }
}
if ($RecreateEnv) {
    Remove-Item $EnvDir -Recurse -Force -ErrorAction SilentlyContinue
    & $Python -m venv $EnvDir
}

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

$FingerprintFiles = @($Script, $Requirements, $RuntimeRequirements, $PSCommandPath)
$Fingerprint = ($FingerprintFiles | ForEach-Object {
    (Get-FileHash $_ -Algorithm SHA256).Hash
}) -join ":"
Set-Content -Path $Marker -Value $Fingerprint -NoNewline

Write-Host "Tauri sidecar: $TauriSidecar"
