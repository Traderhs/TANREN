param([Parameter(Mandatory = $true)][string]$HomePath)

$ErrorActionPreference = "Stop"
$ModelName = "Qwen3-Embedding-8B-Q4_K_M.gguf"
$ModelSha256 = "3fcd3febec8b3fd64435204db75bf0dd73b91e8d0661e0331acfe7e7c3120b85"
$LlamaSha256 = "81c2ff62e14b549cd5c766ccdd5c61f09e821a171655c3047bdccfddc2d1a1e2"
$CudaSha256 = "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6"
$Models = Join-Path $HomePath "models"
$Runtime = Join-Path $HomePath "runtime"
New-Item -ItemType Directory -Force -Path $Models, $Runtime | Out-Null

function Get-VerifiedAsset {
    param([string]$Uri, [string]$Path, [string]$Sha256)
    if (Test-Path -LiteralPath $Path) {
        $existing = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
        if ($existing -eq $Sha256) { return }
    }
    $partial = "$Path.partial"
    & curl.exe --fail --location --retry 5 --continue-at - --output $partial $Uri
    if ($LASTEXITCODE -ne 0) { throw "download failed: $Uri" }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $partial).Hash.ToLowerInvariant()
    if ($actual -ne $Sha256) { throw "checksum mismatch for $Uri expected=$Sha256 actual=$actual" }
    Move-Item -LiteralPath $partial -Destination $Path -Force
}

$ModelPath = Join-Path $Models $ModelName
Get-VerifiedAsset `
    "https://huggingface.co/Qwen/Qwen3-Embedding-8B-GGUF/resolve/main/Qwen3-Embedding-8B-Q4_K_M.gguf" `
    $ModelPath `
    $ModelSha256

$Server = Get-ChildItem -LiteralPath $Runtime -Recurse -Filter "llama-server.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $Server) {
    $LlamaZip = Join-Path $Runtime "llama-b10621-bin-win-cuda-12.4-x64.zip"
    $CudaZip = Join-Path $Runtime "cudart-llama-bin-win-cuda-12.4-x64.zip"
    Get-VerifiedAsset "https://github.com/ggml-org/llama.cpp/releases/download/b10621/llama-b10621-bin-win-cuda-12.4-x64.zip" $LlamaZip $LlamaSha256
    Get-VerifiedAsset "https://github.com/ggml-org/llama.cpp/releases/download/b10621/cudart-llama-bin-win-cuda-12.4-x64.zip" $CudaZip $CudaSha256
    Expand-Archive -LiteralPath $LlamaZip -DestinationPath $Runtime -Force
    Expand-Archive -LiteralPath $CudaZip -DestinationPath $Runtime -Force
    $Server = Get-ChildItem -LiteralPath $Runtime -Recurse -Filter "llama-server.exe" | Select-Object -First 1
}
if (-not $Server) { throw "llama-server.exe was not installed" }

[pscustomobject]@{
    model = $ModelPath
    server = $Server.FullName
    model_sha256 = $ModelSha256
    runtime = "llama.cpp-b10621-cuda-12.4"
} | ConvertTo-Json -Compress
