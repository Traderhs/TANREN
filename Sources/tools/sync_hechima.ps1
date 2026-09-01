$ErrorActionPreference = "Stop"

$HechimaCommit = "f67193be2131af80eeae422ecb4e2c179980e2e1"
$RawBaseUrl = "https://raw.githubusercontent.com/msonrm/hechima/$HechimaCommit"
$SourceRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$VendorRoot = Join-Path $SourceRoot "public\vendor"
$MarkerPath = Join-Path $VendorRoot ".tanren-hechima-pin"

$Files = @(
  @{ Source = "site/public/vendor/hechima/hechima-worker.js"; Destination = "hechima/hechima-worker.js"; Sha256 = "dc39ff4b6281a6f8013a733522f7fdf4b87676500096ca353866989624a836ac" },
  @{ Source = "site/public/vendor/hechima/hechima.d.ts"; Destination = "hechima/hechima.d.ts"; Sha256 = "a3d916709114e4005086aba5c10810314adeee1d2a554eeda16b251a3ce1b7e2" },
  @{ Source = "site/public/vendor/hechima-wasm/hechima-wasm.js"; Destination = "hechima-wasm/hechima-wasm.js"; Sha256 = "919c95012901731ec490660b9e823d20998c658dba2d78a60119fa00438f8e7d" },
  @{ Source = "site/public/vendor/hechima-wasm/hechima-wasm.wasm"; Destination = "hechima-wasm/hechima-wasm.wasm"; Sha256 = "e0d3d7e7a84b8a4980626bf16f7404d7c65d67403b98da298f33690fd74a33a4" },
  @{ Source = "site/public/vendor/hechima-wasm/mozc.data"; Destination = "hechima-wasm/mozc.data"; Sha256 = "0a3eec3a34e7582c3519f05fb90d09158cd4b42d2668a7790288fb519b44b84f" },
  @{ Source = "site/public/vendor/hechima-wasm/BUILD_INFO.txt"; Destination = "hechima-wasm/BUILD_INFO.txt"; Sha256 = "05e602761b46a18be3fe9d461d51415e94642b2ad0069d52afd33b5625fe6902" },
  @{ Source = "LICENSE"; Destination = "hechima-notices/LICENSE"; Sha256 = "117002442c176c5a5c4906dd095824ea7963dd8ca146298a06e4ef1d20c28a3c" },
  @{ Source = "THIRD_PARTY_NOTICES.md"; Destination = "hechima-notices/THIRD_PARTY_NOTICES.md"; Sha256 = "228a0670b44bcdc4da61fca575ea767323cab9b1de22cd8d7e94517ad44f96ba" },
  @{ Source = "site/public/vendor/VENDOR.md"; Destination = "hechima-notices/VENDOR.md"; Sha256 = "b51a939e615e3609732a0d57a68357fedcf557f74a1967de26c549d3d0512ae8" }
)

function Test-ExistingBundle {
  if (-not (Test-Path $MarkerPath)) { return $false }
  if ((Get-Content $MarkerPath -Raw).Trim() -ne $HechimaCommit) { return $false }
  foreach ($File in $Files) {
    if (-not (Test-Path (Join-Path $VendorRoot $File.Destination))) { return $false }
  }
  return $true
}

if (Test-ExistingBundle) {
  Write-Host "TANREN Japanese IME assets are ready ($HechimaCommit)."
  exit 0
}

$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "tanren-hechima-$HechimaCommit"
Remove-Item $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null

try {
  Write-Host "Downloading pinned TANREN Japanese IME assets..."
  foreach ($File in $Files) {
    $SourcePath = Join-Path $TempRoot $File.Destination
    New-Item -ItemType Directory -Path (Split-Path $SourcePath -Parent) -Force | Out-Null
    $AssetUrl = "$RawBaseUrl/$($File.Source)"
    Invoke-WebRequest -Uri $AssetUrl -OutFile $SourcePath -UseBasicParsing
    $ActualHash = (Get-FileHash $SourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($ActualHash -ne $File.Sha256) {
      throw "Checksum mismatch for $($File.Source). Expected $($File.Sha256), got $ActualHash."
    }
  }

  New-Item -ItemType Directory -Path $VendorRoot -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $VendorRoot "hechima") -Force | Out-Null
  Remove-Item (Join-Path $VendorRoot "hechima\hechima-worker.js") -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $VendorRoot "hechima\hechima.d.ts") -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $VendorRoot "hechima-wasm") -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $VendorRoot "hechima-notices") -Recurse -Force -ErrorAction SilentlyContinue

  foreach ($File in $Files) {
    $SourcePath = Join-Path $TempRoot $File.Destination
    $DestinationPath = Join-Path $VendorRoot $File.Destination
    New-Item -ItemType Directory -Path (Split-Path $DestinationPath -Parent) -Force | Out-Null
    Copy-Item $SourcePath $DestinationPath -Force
  }

  Set-Content -Path $MarkerPath -Value $HechimaCommit -NoNewline
  Write-Host "TANREN Japanese IME assets synced (Hechima 0.22.1 / Mozc WASM)."
}
finally {
  Remove-Item $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

