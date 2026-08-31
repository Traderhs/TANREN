param([Parameter(Mandatory = $true)][string]$HomePath)

$ErrorActionPreference = "Stop"
$EngineVersion = "0.25.2"
$SevenZipVersion = "26.02"
$Runtime = Join-Path $HomePath "runtime"
$Downloads = Join-Path $HomePath "downloads"
New-Item -ItemType Directory -Force -Path $Runtime, $Downloads | Out-Null

function Get-GitHubRelease {
    param([string]$Repo, [string]$Tag)
    Invoke-RestMethod -Headers @{ "User-Agent" = "TANREN" } -Uri "https://api.github.com/repos/$Repo/releases/tags/$Tag"
}

function Get-VerifiedReleaseAsset {
    param($Release, [string]$Name, [string]$Destination)
    $asset = $Release.assets | Where-Object { $_.name -eq $Name } | Select-Object -First 1
    if (-not $asset) { throw "release asset not found: $Name" }
    $expected = if ($asset.digest -and $asset.digest.StartsWith("sha256:")) { $asset.digest.Substring(7).ToLowerInvariant() } else { $null }
    if ((Test-Path -LiteralPath $Destination) -and $expected) {
        $existing = (Get-FileHash -Algorithm SHA256 -LiteralPath $Destination).Hash.ToLowerInvariant()
        if ($existing -eq $expected) { return }
    }
    $partial = "$Destination.partial"
    & curl.exe --fail --location --retry 5 --continue-at - --output $partial $asset.browser_download_url
    if ($LASTEXITCODE -ne 0) { throw "download failed: $($asset.browser_download_url)" }
    if ($expected) {
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $partial).Hash.ToLowerInvariant()
        if ($actual -ne $expected) { throw "checksum mismatch for $Name expected=$expected actual=$actual" }
    }
    Move-Item -LiteralPath $partial -Destination $Destination -Force
}

$Run = Get-ChildItem -LiteralPath $Runtime -Recurse -Filter "run.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $Run) {
    $engineRelease = Get-GitHubRelease "VOICEVOX/voicevox_engine" $EngineVersion
    $listName = "voicevox_engine-windows-directml-$EngineVersion.7z.txt"
    $listPath = Join-Path $Downloads $listName
    Get-VerifiedReleaseAsset $engineRelease $listName $listPath
    $parts = @(Get-Content -LiteralPath $listPath | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if (-not $parts) { throw "VOICEVOX package list is empty" }
    foreach ($part in $parts) {
        Get-VerifiedReleaseAsset $engineRelease $part (Join-Path $Downloads $part)
    }

    $sevenRelease = Get-GitHubRelease "ip7z/7zip" $SevenZipVersion
    $sevenZip = Join-Path $Downloads "7zr.exe"
    Get-VerifiedReleaseAsset $sevenRelease "7zr.exe" $sevenZip
    & $sevenZip x (Join-Path $Downloads $parts[0]) "-o$Runtime" -y | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "VOICEVOX archive extraction failed" }
    $Run = Get-ChildItem -LiteralPath $Runtime -Recurse -Filter "run.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
}

if (-not $Run) { throw "VOICEVOX run.exe was not installed" }

[pscustomobject]@{
    engine = $Run.FullName
    version = $EngineVersion
    backend = "DirectML"
} | ConvertTo-Json -Compress
