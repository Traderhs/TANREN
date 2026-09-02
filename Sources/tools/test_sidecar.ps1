param(
    [string]$Executable = ""
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$Results = Join-Path $Root "Results"

if ([string]::IsNullOrWhiteSpace($Executable)) {
    $Rustc = Join-Path $Results "toolchains\cargo\bin\rustc.exe"
    if (!(Test-Path $Rustc)) {
        $Rustc = (Get-Command rustc -ErrorAction Stop).Source
    }
    $TargetTriple = (& $Rustc --print host-tuple).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($TargetTriple)) {
        throw "Unable to determine rustc host target triple"
    }
    $Executable = Join-Path $Results "sidecar\tanren-language-$TargetTriple.exe"
}

if (!(Test-Path $Executable)) {
    throw "Sidecar executable not found: $Executable"
}

function Invoke-Sidecar {
    param(
        [string]$Payload,
        [switch]$AsArgument,
        [switch]$WithBom
    )

    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $Executable
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $psi.StandardOutputEncoding = $utf8
    $psi.StandardErrorEncoding = $utf8
    if (-not $AsArgument) {
        $psi.RedirectStandardInput = $true
    }
    if ($AsArgument) {
        # Windows PowerShell 5 / .NET Framework has no ProcessStartInfo.ArgumentList.
        # These argument-mode smoke payloads contain no literal backslashes, so
        # quoting JSON quotes is sufficient and mirrors the Tauri sidecar call.
        $psi.Arguments = '"' + $Payload.Replace('"', '\"') + '"'
    }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $psi
    [void]$process.Start()
    if (-not $AsArgument) {
        $stdinPayload = if ($WithBom) { [char]0xFEFF + $Payload } else { $Payload }
        $process.StandardInput.Write($stdinPayload)
        $process.StandardInput.Close()
    }
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()

    [pscustomobject]@{
        ExitCode = $process.ExitCode
        Stdout = $stdout
        Stderr = $stderr
    }
}

function Assert-JsonSuccess {
    param(
        [string]$Name,
        [pscustomobject]$Result
    )
    if ($Result.ExitCode -ne 0) {
        throw "$Name failed with exit code $($Result.ExitCode): $($Result.Stderr)"
    }
    try {
        return $Result.Stdout | ConvertFrom-Json -ErrorAction Stop
    } catch {
        throw "$Name emitted non-JSON stdout: $($Result.Stdout)"
    }
}

$case1 = Assert-JsonSuccess "word with reading hint" (Invoke-Sidecar -AsArgument -Payload '{"text":"見据える","reading_hint":"みすえる"}')
if ($case1.reading -ne "みすえる") { throw "reading hint was not preserved" }
Write-Host "PASS 1/5 word + reading hint"

$case2 = Assert-JsonSuccess "word without reading hint" (Invoke-Sidecar -AsArgument -Payload '{"text":"見据える"}')
if ([string]::IsNullOrWhiteSpace([string]$case2.reading)) { throw "reading was not generated" }
Write-Host "PASS 2/5 word + no reading hint"

$case3 = Assert-JsonSuccess "kana-only BOM input" (Invoke-Sidecar -WithBom -Payload '{"text":"かな"}')
if ($case3.normalized_text -ne "かな" -or [string]::IsNullOrWhiteSpace([string]$case3.reading)) {
    throw "kana-only input was not handled correctly"
}
Write-Host "PASS 3/5 kana-only + UTF-8 BOM"

$audioDir = Join-Path ([System.IO.Path]::GetTempPath()) ("tanren-sidecar-smoke-{0}" -f [guid]::NewGuid().ToString("N"))
$audioJson = @{ text = "かな"; audio_dir = $audioDir } | ConvertTo-Json -Compress
$case4 = Assert-JsonSuccess "no TTS fallback" (Invoke-Sidecar -Payload $audioJson)
if ($case4.audio_written -or @($case4.audio_assets).Count -ne 0) {
    throw "sidecar synthesized audio without the managed VOICEVOX runtime"
}
Write-Host "PASS 4/5 no TTS fallback"

$case5 = Invoke-Sidecar -Payload '{not-json'
if ($case5.ExitCode -eq 0) { throw "malformed JSON unexpectedly succeeded" }
if (-not [string]::IsNullOrWhiteSpace($case5.Stdout)) { throw "malformed JSON wrote non-JSON data to stdout" }
Write-Host "PASS 5/5 malformed JSON failure"

Write-Host "Sidecar smoke test PASS: $Executable"
