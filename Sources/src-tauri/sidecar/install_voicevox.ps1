param([Parameter(Mandatory = $true)][string]$HomePath)

$ErrorActionPreference = "Stop"
$SevenZipVersion = "26.02"
$Runtime = Join-Path $HomePath "runtime"
$Downloads = Join-Path $HomePath "downloads"
$VvmMarker = Join-Path $HomePath ".tanren-vvm-version"
New-Item -ItemType Directory -Force -Path $Runtime, $Downloads | Out-Null

$RequiredVoiceModels = @("0.vvm", "4.vvm", "7.vvm", "12.vvm", "13.vvm", "15.vvm", "21.vvm")

function Get-GitHubLatestRelease {
    param([string]$Repo)
    Invoke-RestMethod -Headers @{ "User-Agent" = "TANREN" } -Uri "https://api.github.com/repos/$Repo/releases/latest" -TimeoutSec 10
}

function Get-GitHubRelease {
    param([string]$Repo, [string]$Tag)
    Invoke-RestMethod -Headers @{ "User-Agent" = "TANREN" } -Uri "https://api.github.com/repos/$Repo/releases/tags/$Tag" -TimeoutSec 10
}

function Get-Version {
    param($Release)
    ([string]$Release.tag_name) -replace '^v', ''
}

function Get-ReleaseAsset {
    param($Release, [string]$Name)
    $asset = $Release.assets | Where-Object { $_.name -eq $Name } | Select-Object -First 1
    if (-not $asset) { throw "release asset not found: $Name" }
    if (-not $asset.digest -or -not $asset.digest.StartsWith("sha256:")) { throw "release asset has no SHA256 digest: $Name" }
    $asset
}

function Get-VerifiedReleaseAsset {
    param($Release, [string]$Name, [string]$Destination)
    $asset = Get-ReleaseAsset $Release $Name
    $expected = $asset.digest.Substring(7).ToLowerInvariant()
    New-Item -ItemType Directory -Force -Path (Split-Path $Destination -Parent) | Out-Null
    if (Test-Path -LiteralPath $Destination) {
        $actual = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -eq $expected) { return }
    }
    $partial = "$Destination.partial"
    & curl.exe --fail --location --retry 5 --continue-at - --output $partial $asset.browser_download_url
    if ($LASTEXITCODE -ne 0) { throw "download failed: $($asset.browser_download_url)" }
    $actual = (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "checksum mismatch for $Name expected=$expected actual=$actual" }
    Move-Item -LiteralPath $partial -Destination $Destination -Force
}

function Get-Run {
    param([string]$Root)
    Get-ChildItem -LiteralPath $Root -Recurse -Filter "run.exe" -File -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Get-InstalledVersion {
    param($Run)
    if (-not $Run) { return $null }
    $manifest = Join-Path $Run.Directory.FullName "engine_manifest.json"
    if (-not (Test-Path -LiteralPath $manifest)) { return $null }
    try {
        # VOICEVOX ships engine_manifest.json as UTF-8 without a BOM. Windows
        # PowerShell 5.1 otherwise decodes BOM-less text with the machine's
        # legacy ANSI code page, which can make a valid runtime fail version
        # validation on some locales.
        $json = [System.IO.File]::ReadAllText($manifest, [System.Text.Encoding]::UTF8)
        ([string](($json | ConvertFrom-Json).version)).Trim()
    } catch {
        $null
    }
}

function Test-ModelsPresent {
    param($Run)
    if (-not $Run) { return $false }
    $dir = Join-Path $Run.Directory.FullName "model"
    foreach ($name in $RequiredVoiceModels) {
        if (-not (Test-Path -LiteralPath (Join-Path $dir $name))) { return $false }
    }
    return $true
}

function Test-ModelLayoutCurrent {
    param($Run)
    if (-not (Test-ModelsPresent $Run)) { return $false }
    $dir = Join-Path $Run.Directory.FullName "model"
    $installed = @(Get-ChildItem -LiteralPath $dir -Filter "*.vvm" -File -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
    if ($installed.Count -ne $RequiredVoiceModels.Count) { return $false }
    foreach ($name in $installed) {
        if ($RequiredVoiceModels -notcontains $name) { return $false }
    }
    return $true
}

$Run = Get-Run $Runtime
$LocalComplete = $Run -and (Test-ModelsPresent $Run)

try {
    $engineRelease = Get-GitHubLatestRelease "VOICEVOX/voicevox_engine"
    $vvmRelease = Get-GitHubLatestRelease "VOICEVOX/voicevox_vvm"
} catch {
    if ($LocalComplete) {
        Write-Warning "VOICEVOX update check failed; keeping existing runtime."
        exit 0
    }
    throw
}

$EngineVersion = Get-Version $engineRelease
$VvmVersion = Get-Version $vvmRelease
$InstalledVersion = Get-InstalledVersion $Run
$InstalledVvmVersion = if (Test-Path -LiteralPath $VvmMarker) { (Get-Content -LiteralPath $VvmMarker -Raw).Trim() } else { $null }
$NeedsEngine = -not $Run -or $InstalledVersion -ne $EngineVersion
$NeedsModels = $NeedsEngine -or -not (Test-ModelLayoutCurrent $Run) -or $InstalledVvmVersion -ne $VvmVersion

if (-not $NeedsEngine -and $NeedsModels -and -not $InstalledVvmVersion) {
    $modelDir = Join-Path $Run.Directory.FullName "model"
    $NeedsModels = $false
    foreach ($name in $RequiredVoiceModels) {
        $asset = Get-ReleaseAsset $vvmRelease $name
        $expected = $asset.digest.Substring(7).ToLowerInvariant()
        $actual = (Get-FileHash -LiteralPath (Join-Path $modelDir $name) -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $expected) { $NeedsModels = $true; break }
    }
    if (-not $NeedsModels) { Set-Content -LiteralPath $VvmMarker -Value $VvmVersion -NoNewline }
}

try {
    if ($NeedsEngine) {
        $Stage = "$Runtime.new"
        $Backup = "$Runtime.old"
        Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $Backup -Recurse -Force -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Force -Path $Stage | Out-Null

        $listName = "voicevox_engine-windows-directml-$EngineVersion.7z.txt"
        $listPath = Join-Path $Downloads $listName
        Get-VerifiedReleaseAsset $engineRelease $listName $listPath
        $parts = @(Get-Content -LiteralPath $listPath | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        foreach ($part in $parts) { Get-VerifiedReleaseAsset $engineRelease $part (Join-Path $Downloads $part) }

        $sevenRelease = Get-GitHubRelease "ip7z/7zip" $SevenZipVersion
        $sevenZip = Join-Path $Downloads "7zr.exe"
        Get-VerifiedReleaseAsset $sevenRelease "7zr.exe" $sevenZip
        & $sevenZip x (Join-Path $Downloads $parts[0]) "-o$Stage" -y | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "VOICEVOX archive extraction failed" }
        $StageRun = Get-Run $Stage
        if (-not $StageRun) { throw "VOICEVOX engine validation failed: run.exe is missing" }
        $StageVersion = Get-InstalledVersion $StageRun
        if ($StageVersion -ne $EngineVersion) {
            $actual = if ($StageVersion) { $StageVersion } else { "unreadable" }
            throw "VOICEVOX engine validation failed: expected=$EngineVersion actual=$actual manifest=$($StageRun.Directory.FullName)\engine_manifest.json"
        }

        $stageModelDir = Join-Path $StageRun.Directory.FullName "model"
        New-Item -ItemType Directory -Force -Path $stageModelDir | Out-Null
        if ($Run) {
            $existingModelDir = Join-Path $Run.Directory.FullName "model"
            if (Test-Path -LiteralPath $existingModelDir) {
                Get-ChildItem -LiteralPath $existingModelDir -Filter "*.vvm" -File -ErrorAction SilentlyContinue |
                    Where-Object { $RequiredVoiceModels -contains $_.Name } |
                    Copy-Item -Destination $stageModelDir -Force
            }
        }
        foreach ($name in $RequiredVoiceModels) {
            Get-VerifiedReleaseAsset $vvmRelease $name (Join-Path $stageModelDir $name)
        }
        Get-ChildItem -LiteralPath $stageModelDir -Filter "*.vvm" -File -ErrorAction SilentlyContinue |
            Where-Object { $RequiredVoiceModels -notcontains $_.Name } | Remove-Item -Force

        if (Test-Path -LiteralPath $Runtime) { Move-Item -LiteralPath $Runtime -Destination $Backup }
        try {
            Move-Item -LiteralPath $Stage -Destination $Runtime
            Set-Content -LiteralPath $VvmMarker -Value $VvmVersion -NoNewline
        }
        catch {
            Remove-Item -LiteralPath $Runtime -Recurse -Force -ErrorAction SilentlyContinue
            if (Test-Path -LiteralPath $Backup) { Move-Item -LiteralPath $Backup -Destination $Runtime }
            throw
        }
        Remove-Item -LiteralPath $Backup -Recurse -Force -ErrorAction SilentlyContinue
        $Run = Get-Run $Runtime
        $NeedsModels = $false
    }

    if ($NeedsModels) {
        $modelDir = Join-Path $Run.Directory.FullName "model"
        $StageModels = Join-Path $HomePath "model.new"
        Remove-Item -LiteralPath $StageModels -Recurse -Force -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Force -Path $StageModels | Out-Null
        Get-ChildItem -LiteralPath $modelDir -Filter "*.vvm" -File -ErrorAction SilentlyContinue |
            Where-Object { $RequiredVoiceModels -contains $_.Name } |
            Copy-Item -Destination $StageModels -Force
        foreach ($name in $RequiredVoiceModels) { Get-VerifiedReleaseAsset $vvmRelease $name (Join-Path $StageModels $name) }
        New-Item -ItemType Directory -Force -Path $modelDir | Out-Null
        Get-ChildItem -LiteralPath $StageModels -File | Copy-Item -Destination $modelDir -Force
        Remove-Item -LiteralPath $StageModels -Recurse -Force
        Get-ChildItem -LiteralPath $modelDir -Filter "*.vvm" -File -ErrorAction SilentlyContinue |
            Where-Object { $RequiredVoiceModels -notcontains $_.Name } | Remove-Item -Force
        Set-Content -LiteralPath $VvmMarker -Value $VvmVersion -NoNewline
    }
} catch {
    if ($LocalComplete) {
        Write-Warning "VOICEVOX update failed; keeping existing runtime: $($_.Exception.Message)"
        $Run = Get-Run $Runtime
    } else { throw }
}

if (-not $Run -or -not (Test-ModelsPresent $Run)) { throw "VOICEVOX runtime is incomplete after installation" }

[pscustomobject]@{
    engine = $Run.FullName
    version = (Get-InstalledVersion $Run)
    backend = "DirectML"
    vvm_version = $VvmVersion
    voice_models = $RequiredVoiceModels
} | ConvertTo-Json -Compress
