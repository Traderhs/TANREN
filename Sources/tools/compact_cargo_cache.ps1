$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$Results = Join-Path $Root "Results"
$DevTarget = Join-Path $Results "cargo-target\debug"
$LegacyTarget = Join-Path $Root "Sources\src-tauri\target"
$PackageTarget = Join-Path $Results "cargo-package-target"
$PackageTemp = Join-Path $Results "package-temp"
$LimitBytes = 8GB

function Get-TreeBytes([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return 0L }
    $sum = 0L
    Get-ChildItem -LiteralPath $Path -File -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object { $sum += $_.Length }
    return $sum
}

function Test-TanrenBuildActive {
    $needle = [IO.Path]::GetFullPath($Root.Path)
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -match '^(cargo|rustc|link)\.exe$' -or
        ($_.Name -eq 'tanren.exe' -and $_.CommandLine -and $_.CommandLine.Contains($needle))
    }).Count -gt 0
}

$active = Test-TanrenBuildActive
$bytes = Get-TreeBytes $DevTarget
if ($bytes -gt $LimitBytes) {
    if ($active) {
        Write-Warning ("TANREN dev cache is {0:N1} GiB but another TANREN build is active; cache compaction skipped." -f ($bytes / 1GB))
    } else {
        Write-Host ("Compacting TANREN dev cache ({0:N1} GiB > 8 GiB)..." -f ($bytes / 1GB))
        Remove-Item -LiteralPath $DevTarget -Recurse -Force
    }
}

if ((Test-Path -LiteralPath $LegacyTarget) -and -not $active) {
    Write-Host "Removing legacy src-tauri/target cache..."
    Remove-Item -LiteralPath $LegacyTarget -Recurse -Force
}

if (-not $active) {
    foreach ($path in @($PackageTarget, $PackageTemp)) {
        if (Test-Path -LiteralPath $path) {
            Write-Host "Removing stale package cache: $path"
            Remove-Item -LiteralPath $path -Recurse -Force
        }
    }
}
