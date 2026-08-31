param(
    [string]$SemanticHome = (Join-Path (Split-Path $PSScriptRoot -Parent) '..\Results\semantic'),
    [int]$Port = 18081
)

$ErrorActionPreference = 'Stop'
$server = Get-ChildItem -LiteralPath (Join-Path $SemanticHome 'runtime') -Filter 'llama-server.exe' -Recurse | Select-Object -First 1
$model = Join-Path $SemanticHome 'models\Qwen3-Embedding-8B-Q4_K_M.gguf'
if (-not $server -or -not (Test-Path -LiteralPath $model)) {
    throw 'Semantic runtime or model is missing. Start TANREN once to install it.'
}

$stdout = Join-Path $SemanticHome 'benchmark-server.stdout.log'
$stderr = Join-Path $SemanticHome 'benchmark-server.stderr.log'
$arguments = @('--model', $model, '--embedding', '--pooling', 'last', '--no-webui', '--host', '127.0.0.1', '--port', "$Port", '--ctx-size', '1024', '--batch-size', '256', '--ubatch-size', '256', '--parallel', '1', '--n-gpu-layers', 'auto')
$started = Get-Date
$process = Start-Process -FilePath $server.FullName -ArgumentList $arguments -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
try {
    for ($attempt = 0; $attempt -lt 300; $attempt++) {
        try {
            Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2 | Out-Null
            break
        } catch {
            if ($process.HasExited) { throw 'llama-server exited during model load.' }
            Start-Sleep -Milliseconds 250
        }
    }
    if ($attempt -eq 300) { throw 'Timed out waiting for llama-server.' }
    $loadMs = [math]::Round(((Get-Date) - $started).TotalMilliseconds)
    python (Join-Path $PSScriptRoot 'benchmark_semantic.py') --url "http://127.0.0.1:$Port"
    Write-Output "MODEL_LOAD_MS=$loadMs"
    nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader
    Get-Process -Id $process.Id | Select-Object Id,@{N='PrivateMB';E={[math]::Round($_.PrivateMemorySize64/1MB,1)}},@{N='WorkingSetMB';E={[math]::Round($_.WorkingSet64/1MB,1)}}
} finally {
    if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
}
