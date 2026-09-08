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

$Repo = "msonrm/hechima"
$BaselineCommit = "f67193be2131af80eeae422ecb4e2c179980e2e1"
$BaselineAdapterSha256 = "4b25311d7ded26810c86b5e563edb938534bd2997d32d5caa21fc794cf0686c8"
$SourceRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$VendorRoot = Join-Path $SourceRoot "public\vendor"
$AdapterPath = Join-Path $VendorRoot "hechima\hechima.js"
$MarkerPath = Join-Path $VendorRoot ".tanren-hechima-pin"

$Files = @(
  @{ Source = "site/public/vendor/hechima/hechima-worker.js"; Destination = "hechima/hechima-worker.js"; BaselineSha256 = "dc39ff4b6281a6f8013a733522f7fdf4b87676500096ca353866989624a836ac" },
  @{ Source = "site/public/vendor/hechima/hechima.d.ts"; Destination = "hechima/hechima.d.ts"; BaselineSha256 = "a3d916709114e4005086aba5c10810314adeee1d2a554eeda16b251a3ce1b7e2" },
  @{ Source = "site/public/vendor/hechima-wasm/hechima-wasm.js"; Destination = "hechima-wasm/hechima-wasm.js"; BaselineSha256 = "919c95012901731ec490660b9e823d20998c658dba2d78a60119fa00438f8e7d" },
  @{ Source = "site/public/vendor/hechima-wasm/hechima-wasm.wasm"; Destination = "hechima-wasm/hechima-wasm.wasm"; BaselineSha256 = "e0d3d7e7a84b8a4980626bf16f7404d7c65d67403b98da298f33690fd74a33a4" },
  @{ Source = "site/public/vendor/hechima-wasm/mozc.data"; Destination = "hechima-wasm/mozc.data"; BaselineSha256 = "0a3eec3a34e7582c3519f05fb90d09158cd4b42d2668a7790288fb519b44b84f" },
  @{ Source = "site/public/vendor/hechima-wasm/BUILD_INFO.txt"; Destination = "hechima-wasm/BUILD_INFO.txt"; BaselineSha256 = "05e602761b46a18be3fe9d461d51415e94642b2ad0069d52afd33b5625fe6902" },
  @{ Source = "LICENSE"; Destination = "hechima-notices/LICENSE"; BaselineSha256 = "117002442c176c5a5c4906dd095824ea7963dd8ca146298a06e4ef1d20c28a3c" },
  @{ Source = "THIRD_PARTY_NOTICES.md"; Destination = "hechima-notices/THIRD_PARTY_NOTICES.md"; BaselineSha256 = "228a0670b44bcdc4da61fca575ea767323cab9b1de22cd8d7e94517ad44f96ba" },
  @{ Source = "site/public/vendor/VENDOR.md"; Destination = "hechima-notices/VENDOR.md"; BaselineSha256 = "b51a939e615e3609732a0d57a68357fedcf557f74a1967de26c549d3d0512ae8" }
)

function Get-AdapterVersion {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $match = [regex]::Match((Get-Content -LiteralPath $Path -Raw), 'HECHIMA_VERSION\s*=\s*"([^"]+)"')
  if ($match.Success) { return $match.Groups[1].Value }
  return $null
}

function Get-Marker {
  if (-not (Test-Path -LiteralPath $MarkerPath)) { return $null }
  try { Get-Content -LiteralPath $MarkerPath -Raw | ConvertFrom-Json } catch { $null }
}

function Test-BaselineBundle {
  foreach ($file in $Files) {
    $path = Join-Path $VendorRoot $file.Destination
    if (-not (Test-Path -LiteralPath $path)) { return $false }
    $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $file.BaselineSha256) { return $false }
  }
  return $true
}

function Test-MarkerBundle {
  param($Marker, [string]$Commit)
  if (-not $Marker -or [string]$Marker.commit -ne $Commit) { return $false }
  foreach ($file in $Files) {
    $record = $Marker.files | Where-Object { $_.path -eq $file.Destination } | Select-Object -First 1
    $path = Join-Path $VendorRoot $file.Destination
    if (-not $record -or -not (Test-Path -LiteralPath $path)) { return $false }
    $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne ([string]$record.sha256).ToLowerInvariant()) { return $false }
  }
  return $true
}

$marker = Get-Marker
try {
  $latest = Invoke-RestMethod -Headers @{ "User-Agent" = "TANREN" } -Uri "https://api.github.com/repos/$Repo/commits/main" -TimeoutSec 10
  $HechimaCommit = [string]$latest.sha
  Set-TanrenProgress 8
} catch {
  if ($marker -and (Test-MarkerBundle $marker ([string]$marker.commit))) {
    Set-TanrenProgress 100
    Set-TanrenPhase "done"
    Write-Host "TANREN Japanese IME assets are ready (cached $($marker.commit))."
    exit 0
  }
  if (Test-BaselineBundle) {
    Set-TanrenProgress 100
    Set-TanrenPhase "done"
    Write-Host "TANREN Japanese IME assets are ready (offline baseline $BaselineCommit)."
    exit 0
  }
  throw
}

if ($marker -and (Test-MarkerBundle $marker $HechimaCommit)) {
  Set-TanrenProgress 100
  Set-TanrenPhase "done"
  Write-Host "TANREN Japanese IME assets are ready ($HechimaCommit)."
  exit 0
}

$RawBaseUrl = "https://raw.githubusercontent.com/$Repo/$HechimaCommit"
$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "tanren-hechima-$HechimaCommit"
Remove-Item $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null

try {
  $upstreamAdapter = Join-Path $TempRoot "hechima.js"
  Invoke-WebRequest -Uri "$RawBaseUrl/site/public/vendor/hechima/hechima.js" -OutFile $upstreamAdapter -UseBasicParsing -TimeoutSec 30
  Set-TanrenProgress 12
  $localVersion = Get-AdapterVersion $AdapterPath
  $upstreamVersion = Get-AdapterVersion $upstreamAdapter
  $upstreamAdapterHash = (Get-FileHash -LiteralPath $upstreamAdapter -Algorithm SHA256).Hash.ToLowerInvariant()
  if (-not $localVersion -or -not $upstreamVersion -or $localVersion -ne $upstreamVersion -or $upstreamAdapterHash -ne $BaselineAdapterSha256) {
    if ($marker -and (Test-MarkerBundle $marker ([string]$marker.commit))) {
      Set-TanrenPhase "done"
      Write-Warning "Hechima $upstreamVersion requires an adapter update; keeping TANREN adapter/runtime $localVersion unchanged."
      exit 0
    }
    if (Test-BaselineBundle) {
      Set-TanrenPhase "done"
      Write-Warning "Hechima $upstreamVersion requires an adapter update; keeping TANREN baseline $localVersion unchanged."
      exit 0
    }
    throw "Hechima adapter version mismatch local=$localVersion upstream=$upstreamVersion"
  }

  $records = @()
  $downloadIndex = 0
  Set-TanrenPhase "downloading"
  foreach ($file in $Files) {
    $sourcePath = Join-Path $TempRoot $file.Destination
    New-Item -ItemType Directory -Path (Split-Path $sourcePath -Parent) -Force | Out-Null
    Invoke-WebRequest -Uri "$RawBaseUrl/$($file.Source)" -OutFile $sourcePath -UseBasicParsing -TimeoutSec 30
    $hash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($HechimaCommit -eq $BaselineCommit -and $hash -ne $file.BaselineSha256) {
      throw "Checksum mismatch for $($file.Source). Expected $($file.BaselineSha256), got $hash."
    }
    $records += [pscustomobject]@{ path = $file.Destination; sha256 = $hash }
    $downloadIndex += 1
    Set-TanrenProgress (12 + [Math]::Floor(($downloadIndex / [double]$Files.Count) * 78))
  }

  foreach ($file in $Files) {
    $sourcePath = Join-Path $TempRoot $file.Destination
    $destinationPath = Join-Path $VendorRoot $file.Destination
    New-Item -ItemType Directory -Path (Split-Path $destinationPath -Parent) -Force | Out-Null
    $replacement = "$destinationPath.new"
    Copy-Item -LiteralPath $sourcePath -Destination $replacement -Force
    Move-Item -LiteralPath $replacement -Destination $destinationPath -Force
  }
  Set-TanrenProgress 96

  [pscustomobject]@{
    commit = $HechimaCommit
    version = $upstreamVersion
    files = $records
    updated_at = (Get-Date).ToUniversalTime().ToString("o")
  } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $MarkerPath -Encoding UTF8
  Set-TanrenProgress 100
  Set-TanrenPhase "done"
  Write-Host "TANREN Japanese IME assets synced (Hechima $upstreamVersion / $HechimaCommit)."
}
finally {
  Remove-Item $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
