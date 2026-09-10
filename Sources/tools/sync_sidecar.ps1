param([switch]$DevOnly)

$ErrorActionPreference = "Stop"

function Set-TanrenProgress {
    param([int]$Value)
    if ($env:TANREN_PROGRESS_FILE) {
        [System.IO.File]::WriteAllText($env:TANREN_PROGRESS_FILE, ([Math]::Max(0, [Math]::Min(100, $Value))).ToString())
    }
}

function Set-TanrenPhase {
    param([string]$Value)
    if ($env:TANREN_PHASE_FILE) {
        [System.IO.File]::WriteAllText($env:TANREN_PHASE_FILE, $Value)
    }
}

Set-TanrenProgress 1
Set-TanrenPhase "checking"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$Sources = Join-Path $Root "Sources"
$Results = Join-Path $Root "Results"
$Output = Join-Path $Results "sidecar"
$Script = Join-Path $Sources "src-tauri\sidecar\japanese_sidecar.py"
$Requirements = Join-Path $Sources "src-tauri\sidecar\requirements-build.txt"
$RuntimeRequirements = Join-Path $Sources "src-tauri\sidecar\requirements.txt"
$BuildScript = Join-Path $Sources "tools\build_sidecar.ps1"
$MarkerName = if ($DevOnly) { ".tanren-language-dev-source" } else { ".tanren-language-source" }
$Marker = Join-Path $Output $MarkerName
$VersionMarker = Join-Path $Output ".tanren-language-versions.json"

function Resolve-LatestVersions {
    $pyopenjtalk = (Invoke-RestMethod -Uri "https://pypi.org/pypi/pyopenjtalk-plus/json" -TimeoutSec 10).info.version
    $fugashi = (Invoke-RestMethod -Uri "https://pypi.org/pypi/fugashi/json" -TimeoutSec 10).info.version
    $unidicPackage = (Invoke-RestMethod -Uri "https://pypi.org/pypi/unidic/json" -TimeoutSec 10).info.version
    $page = Invoke-WebRequest -UseBasicParsing -Uri "https://clrd.ninjal.ac.jp/unidic/download.html" -TimeoutSec 10
    $link = $page.Links | Where-Object { $_.href -match '/unidic_archive/[^/]+/unidic-cwj-([0-9]+)\.zip$' } | Sort-Object { [int64]([regex]::Match([string]$_.href, 'unidic-cwj-([0-9]+)\.zip$').Groups[1].Value) } -Descending | Select-Object -First 1
    if (-not $link) { throw "latest UniDic CWJ download could not be resolved" }
    $match = [regex]::Match([string]$link.href, 'unidic-cwj-([0-9]+)\.zip$')
    if (-not $match.Success) { throw "latest UniDic CWJ version could not be resolved" }
    $url = [string]$link.href
    if ($url.StartsWith('/')) { $url = "https://clrd.ninjal.ac.jp$url" }
    [pscustomobject]@{
        pyopenjtalk_plus = [string]$pyopenjtalk
        fugashi = [string]$fugashi
        unidic_package = [string]$unidicPackage
        unidic_cwj = $match.Groups[1].Value
        unidic_url = $url
    }
}

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
$SourceFingerprint = ($FingerprintFiles | ForEach-Object {
    (Get-FileHash $_ -Algorithm SHA256).Hash
}) -join ":"

try {
    $Versions = Resolve-LatestVersions
    Set-TanrenProgress 12
} catch {
    if (Test-Path $VersionMarker) {
        $Versions = Get-Content $VersionMarker -Raw | ConvertFrom-Json
        Write-Warning "sidecar latest-version check failed; using cached version metadata"
    } elseif (($DevOnly -or (Test-Path $Executable)) -and (Test-Path $Marker)) {
        $BuiltFingerprint = (Get-Content $Marker -Raw).Trim()
        if ($BuiltFingerprint -eq $SourceFingerprint) {
            Set-TanrenPhase "done"
            Write-Warning "sidecar latest-version check failed; keeping existing binary"
            exit 0
        }
        throw
    } else {
        throw
    }
}

$VersionStamp = "$($Versions.pyopenjtalk_plus)|$($Versions.fugashi)|$($Versions.unidic_package)|$($Versions.unidic_cwj)|$($Versions.unidic_url)"
$Fingerprint = "$SourceFingerprint`n$VersionStamp"
Set-TanrenProgress 20

function Test-InstalledState {
    param($ExpectedVersions)

    $envPython = Join-Path $Results "python-sidecar-env\Scripts\python.exe"
    if (-not (Test-Path -LiteralPath $envPython)) { return $false }

    try {
        $installedJson = & $envPython -c "import importlib.metadata as m, importlib.util, json; print(json.dumps({'pyopenjtalk_plus':m.version('pyopenjtalk-plus'),'fugashi':m.version('fugashi'),'unidic_package':m.version('unidic'),'unidic_lite_present':importlib.util.find_spec('unidic_lite') is not None}))"
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($installedJson)) { return $false }
        $installed = $installedJson | ConvertFrom-Json
    } catch {
        return $false
    }

    if ([string]$installed.pyopenjtalk_plus -ne [string]$ExpectedVersions.pyopenjtalk_plus) { return $false }
    if ([string]$installed.fugashi -ne [string]$ExpectedVersions.fugashi) { return $false }
    if ([string]$installed.unidic_package -ne [string]$ExpectedVersions.unidic_package) { return $false }
    if ([bool]$installed.unidic_lite_present) { return $false }

    $dictionaryVersionPath = Join-Path $Output "tanren-unidic\version"
    if (-not (Test-Path -LiteralPath $dictionaryVersionPath)) { return $false }
    $dictionaryVersion = (Get-Content -LiteralPath $dictionaryVersionPath -Raw).Trim()
    if ($dictionaryVersion -ne [string]$ExpectedVersions.unidic_cwj) { return $false }

    return $true
}

if (($DevOnly -or (Test-Path $Executable)) -and (Test-Path $Marker)) {
    $BuiltFingerprint = (Get-Content $Marker -Raw).Trim()
    if (($BuiltFingerprint -eq $Fingerprint) -and (Test-InstalledState $Versions)) {
        Set-TanrenProgress 100
        Set-TanrenPhase "done"
        Write-Host $(if ($DevOnly) { "TANREN development language runtime is up to date." } else { "TANREN language sidecar is up to date." })
        exit 0
    }
}

Write-Host $(if ($DevOnly) { "TANREN development language runtime is stale; preparing..." } else { "TANREN language sidecar is stale; rebuilding..." })
Set-TanrenPhase "downloading"
Set-TanrenProgress 28
$BuildArgs = @(
    "-ExecutionPolicy", "Bypass", "-File", $BuildScript,
    "-PyOpenJTalkVersion", [string]$Versions.pyopenjtalk_plus,
    "-FugashiVersion", [string]$Versions.fugashi,
    "-UniDicPackageVersion", [string]$Versions.unidic_package,
    "-UniDicVersion", [string]$Versions.unidic_cwj,
    "-UniDicUrl", [string]$Versions.unidic_url,
    "-Fingerprint", $Fingerprint
)
if ($DevOnly) { $BuildArgs += "-DevOnly" }
& powershell @BuildArgs
if ($LASTEXITCODE -ne 0) {
    if ((-not $DevOnly) -and (Test-Path $Executable)) {
        Set-TanrenPhase "done"
        Write-Warning "latest sidecar update failed; keeping existing binary"
        exit 0
    }
    throw "sidecar build failed with exit code $LASTEXITCODE"
}

Set-Content -Path $Marker -Value $Fingerprint -NoNewline
$Versions | ConvertTo-Json | Set-Content -Path $VersionMarker -Encoding UTF8
Set-TanrenProgress 100
Set-TanrenPhase "done"
