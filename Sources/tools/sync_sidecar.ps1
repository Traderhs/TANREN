$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$Sources = Join-Path $Root "Sources"
$Results = Join-Path $Root "Results"
$Output = Join-Path $Results "sidecar"
$Script = Join-Path $Sources "src-tauri\sidecar\japanese_sidecar.py"
$Requirements = Join-Path $Sources "src-tauri\sidecar\requirements-build.txt"
$RuntimeRequirements = Join-Path $Sources "src-tauri\sidecar\requirements.txt"
$BuildScript = Join-Path $Sources "tools\build_sidecar.ps1"
$Marker = Join-Path $Output ".tanren-language-source"

$Rustc = Join-Path $Results "toolchains\cargo\bin\rustc.exe"
if (!(Test-Path $Rustc)) {
    $Rustc = (Get-Command rustc -ErrorAction Stop).Source
}
$TargetTriple = (& $Rustc --print host-tuple).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($TargetTriple)) {
    throw "Unable to determine rustc host target triple"
}

$Executable = Join-Path $Output "tanren-language-$TargetTriple.exe"
$FingerprintFiles = @($Script, $Requirements, $RuntimeRequirements, $BuildScript)
$Fingerprint = ($FingerprintFiles | ForEach-Object {
    (Get-FileHash $_ -Algorithm SHA256).Hash
}) -join ":"

if ((Test-Path $Executable) -and (Test-Path $Marker)) {
    $BuiltFingerprint = (Get-Content $Marker -Raw).Trim()
    if ($BuiltFingerprint -eq $Fingerprint) {
        Write-Host "TANREN language sidecar is up to date."
        exit 0
    }
}

Write-Host "TANREN language sidecar is stale; rebuilding..."
& powershell -ExecutionPolicy Bypass -File $BuildScript
if ($LASTEXITCODE -ne 0) {
    throw "sidecar build failed with exit code $LASTEXITCODE"
}
