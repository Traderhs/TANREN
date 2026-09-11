param(
    [string]$Python = "python",
    [switch]$DevOnly,
    [string]$PyOpenJTalkVersion,
    [string]$FugashiVersion,
    [string]$UniDicPackageVersion,
    [string]$UniDicVersion,
    [string]$UniDicUrl,
    [string]$Fingerprint
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$Sources = Join-Path $Root "Sources"
$Results = Join-Path $Root "Results"
$EnvDir = Join-Path $Results "python-sidecar-env"
$Output = Join-Path $Results "sidecar"
$Script = Join-Path $Sources "src-tauri\sidecar\japanese_sidecar.py"
$Requirements = Join-Path $Sources "src-tauri\sidecar\requirements-build.txt"
$RuntimeRequirements = Join-Path $Sources "src-tauri\sidecar\requirements.txt"
$Marker = Join-Path $Output ".tanren-language-source"
$CacheRoot = Join-Path $Results "python-sidecar-cache"
$BundledDictionary = Join-Path $Output "tanren-unidic"

function Install-UniDicDictionary {
    param([string]$Version, [string]$Url, [string]$PythonPath)
    if ([string]::IsNullOrWhiteSpace($Version) -or [string]::IsNullOrWhiteSpace($Url)) { return }

    $cache = Join-Path $CacheRoot "unidic"
    New-Item -ItemType Directory -Force -Path $cache | Out-Null
    $archive = Join-Path $cache "unidic-cwj-$Version.zip"
    $hashPath = "$archive.sha256"
    $expected = if (Test-Path -LiteralPath $hashPath) { (Get-Content -LiteralPath $hashPath -Raw).Trim().ToLowerInvariant() } else { $null }

    if (Test-Path -LiteralPath $archive) {
        $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($expected -and $actual -ne $expected) {
            Remove-Item -LiteralPath $archive -Force
        } elseif (-not $expected) {
            $expected = $actual
            Set-Content -LiteralPath $hashPath -Value $expected -NoNewline
        }
    }

    if (-not (Test-Path -LiteralPath $archive)) {
        $partial = "$archive.partial"
        & curl.exe --fail --location --retry 5 --continue-at - --output $partial $Url
        if ($LASTEXITCODE -ne 0) { throw "UniDic download failed: $Url" }
        $actual = (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($expected -and $actual -ne $expected) {
            Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
            throw "UniDic checksum mismatch expected=$expected actual=$actual"
        }
        Move-Item -LiteralPath $partial -Destination $archive -Force
        $expected = $actual
        Set-Content -LiteralPath $hashPath -Value $expected -NoNewline
    }

    $extract = Join-Path $cache "unidic-cwj-$Version"
    $extractMarker = Join-Path $extract ".tanren-archive-sha256"
    $extractReady = (Test-Path -LiteralPath $extractMarker) -and ((Get-Content -LiteralPath $extractMarker -Raw).Trim().ToLowerInvariant() -eq $expected)
    if (-not $extractReady) {
        Remove-Item -LiteralPath $extract -Recurse -Force -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Force -Path $extract | Out-Null
        Expand-Archive -LiteralPath $archive -DestinationPath $extract -Force
        Set-Content -LiteralPath $extractMarker -Value $expected -NoNewline
    }

    $sysDic = Get-ChildItem -LiteralPath $extract -Recurse -Filter "sys.dic" -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $sysDic) { throw "UniDic archive does not contain sys.dic" }
    $source = $sysDic.Directory.FullName
    foreach ($name in @("dicrc", "matrix.bin", "char.bin", "unk.dic", "sys.dic")) {
        if (-not (Test-Path -LiteralPath (Join-Path $source $name))) { throw "UniDic archive is missing $name" }
    }
    $mecabRc = Join-Path $source "mecabrc"
    if (-not (Test-Path -LiteralPath $mecabRc)) { [System.IO.File]::WriteAllText($mecabRc, "") }
    [System.IO.File]::WriteAllText((Join-Path $source "version"), $Version)

    $dicDir = (& $PythonPath -c "import unidic; print(unidic.DICDIR)").Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($dicDir)) { throw "unable to resolve UniDic dictionary directory" }
    if (Test-Path -LiteralPath $dicDir) {
        if ((Get-Item -LiteralPath $dicDir).LinkType -eq "Junction") {
            & cmd.exe /d /c rmdir "$dicDir"
            if ($LASTEXITCODE -ne 0) { throw "existing UniDic dictionary junction removal failed with exit code $LASTEXITCODE" }
        } else {
            Remove-Item -LiteralPath $dicDir -Recurse -Force
        }
    }
    New-Item -ItemType Junction -Path $dicDir -Target $source | Out-Null
    return $source
}

function Set-UniDicFrozenDictionaryLocation {
    param([string]$PythonPath)
    $modulePath = (& $PythonPath -c "import unidic.unidic; print(unidic.unidic.__file__)").Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($modulePath)) { throw "unable to resolve UniDic Python module" }
    $content = Get-Content -LiteralPath $modulePath -Raw
    $content = $content -replace "_curdir = os\.path\.dirname\(__file__\)", "_curdir = os.path.dirname(sys.executable) if getattr(sys, 'frozen', False) else os.path.dirname(__file__)"
    $content = $content -replace "DICDIR = os\.path\.join\(_curdir, 'dicdir'\)", "DICDIR = os.path.join(_curdir, 'tanren-unidic' if getattr(sys, 'frozen', False) else 'dicdir')"
    Set-Content -LiteralPath $modulePath -Value $content -Encoding UTF8 -NoNewline
}

$EnvPython = Join-Path $EnvDir "Scripts\python.exe"
$RecreateEnv = !(Test-Path $EnvPython)
if (!$RecreateEnv) {
    try {
        & $EnvPython -c "import sys" *> $null
        $RecreateEnv = $LASTEXITCODE -ne 0
    } catch {
        $RecreateEnv = $true
    }
}
if ($RecreateEnv) {
    Remove-Item $EnvDir -Recurse -Force -ErrorAction SilentlyContinue
    & $Python -m venv $EnvDir
}

& $EnvPython -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "pip upgrade failed with exit code $LASTEXITCODE" }
& $EnvPython -m pip install -r $Requirements
if ($LASTEXITCODE -ne 0) { throw "sidecar dependency install failed with exit code $LASTEXITCODE" }

$HasUniDicLite = ((& $EnvPython -c "import importlib.util; print('1' if importlib.util.find_spec('unidic_lite') else '0')").Trim() -eq "1")
if ($HasUniDicLite) {
    & $EnvPython -m pip uninstall -y unidic-lite | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "stale unidic-lite removal failed with exit code $LASTEXITCODE" }
}
$SitePackages = (& $EnvPython -c "import sysconfig; print(sysconfig.get_paths()['purelib'])").Trim()
$StaleUniDicLite = Join-Path $SitePackages "unidic_lite"
if (Test-Path -LiteralPath $StaleUniDicLite) {
    $StaleUniDicLiteDictionary = Join-Path $StaleUniDicLite "dicdir"
    if ((Test-Path -LiteralPath $StaleUniDicLiteDictionary) -and ((Get-Item -LiteralPath $StaleUniDicLiteDictionary).LinkType -eq "Junction")) {
        & cmd.exe /d /c rmdir "$StaleUniDicLiteDictionary"
        if ($LASTEXITCODE -ne 0) { throw "stale unidic-lite dictionary junction removal failed with exit code $LASTEXITCODE" }
    }
    Remove-Item -LiteralPath $StaleUniDicLite -Recurse -Force
}

if (-not [string]::IsNullOrWhiteSpace($PyOpenJTalkVersion) -and -not [string]::IsNullOrWhiteSpace($FugashiVersion) -and -not [string]::IsNullOrWhiteSpace($UniDicPackageVersion)) {
    & $EnvPython -m pip install --upgrade "pyopenjtalk-plus==$PyOpenJTalkVersion" "fugashi==$FugashiVersion" "unidic==$UniDicPackageVersion"
    if ($LASTEXITCODE -ne 0) { throw "latest sidecar runtime dependency install failed with exit code $LASTEXITCODE" }
}

$UniDicSource = Install-UniDicDictionary $UniDicVersion $UniDicUrl $EnvPython
if (-not [string]::IsNullOrWhiteSpace($UniDicVersion)) {
    & $EnvPython -c "import fugashi; t=fugashi.Tagger(); assert list(t('椅子'))"
    if ($LASTEXITCODE -ne 0) { throw "latest UniDic/Fugashi smoke test failed with exit code $LASTEXITCODE" }
}

Push-Location (Join-Path $Sources "src-tauri\sidecar")
try {
    & $EnvPython -m unittest test_japanese_sidecar.py
    if ($LASTEXITCODE -ne 0) { throw "sidecar regression tests failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

if (-not [string]::IsNullOrWhiteSpace($UniDicSource)) {
    $dicDir = (& $EnvPython -c "import unidic; print(unidic.DICDIR)").Trim()
    if ((Test-Path -LiteralPath $dicDir) -and ((Get-Item -LiteralPath $dicDir).LinkType -eq "Junction")) {
        & cmd.exe /d /c rmdir "$dicDir"
        if ($LASTEXITCODE -ne 0) { throw "temporary UniDic dictionary junction removal failed with exit code $LASTEXITCODE" }
    }
    if (-not $DevOnly) { Set-UniDicFrozenDictionaryLocation $EnvPython }
    New-Item -ItemType Directory -Force -Path $BundledDictionary | Out-Null
    Get-ChildItem -LiteralPath $UniDicSource -Recurse -Force | ForEach-Object {
        $relative = $_.FullName.Substring($UniDicSource.Length).TrimStart([IO.Path]::DirectorySeparatorChar)
        $destination = Join-Path $BundledDictionary $relative
        if ($_.PSIsContainer) {
            New-Item -ItemType Directory -Force -Path $destination | Out-Null
        } else {
            $sourcePath = $_.FullName
            $parent = Split-Path -Parent $destination
            New-Item -ItemType Directory -Force -Path $parent | Out-Null
            $reuseExisting = $false
            if (Test-Path -LiteralPath $destination) {
                $existing = Get-Item -LiteralPath $destination -Force
                if (($existing.LinkType -eq "HardLink") -and (@($existing.Target) -contains $sourcePath)) {
                    $reuseExisting = $true
                } else {
                    Remove-Item -LiteralPath $destination -Force
                }
            }
            if (-not $reuseExisting) {
                try {
                    New-Item -ItemType HardLink -Path $destination -Target $sourcePath -ErrorAction Stop | Out-Null
                } catch {
                    Copy-Item -LiteralPath $sourcePath -Destination $destination -Force
                }
            }
        }
    }
}

if ($DevOnly) {
    Write-Host "TANREN development language runtime is ready."
    exit 0
}

New-Item -ItemType Directory -Force $Output | Out-Null
& $EnvPython -m PyInstaller `
    --noconfirm `
    --clean `
    --onefile `
    --name tanren-language `
    --distpath $Output `
    --workpath (Join-Path $Results "pyinstaller-work") `
    --specpath (Join-Path $Results "pyinstaller-spec") `
    --collect-all pyopenjtalk `
    --collect-all fugashi `
    --collect-all unidic `
    $Script
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed with exit code $LASTEXITCODE" }

$Built = Join-Path $Output "tanren-language.exe"
if (!(Test-Path $Built)) {
    throw "PyInstaller completed without producing $Built"
}

$Rustc = Join-Path $Results "toolchains\cargo\bin\rustc.exe"
if (!(Test-Path $Rustc)) {
    $RustcCommand = Get-Command rustc -ErrorAction Stop
    $Rustc = $RustcCommand.Source
}
$TargetTriple = (& $Rustc --print host-tuple).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($TargetTriple)) {
    throw "Unable to determine rustc host target triple"
}

$TauriSidecar = Join-Path $Output "tanren-language-$TargetTriple.exe"
Copy-Item $Built $TauriSidecar -Force
Remove-Item $Built -Force

if ([string]::IsNullOrWhiteSpace($Fingerprint)) {
    $FingerprintFiles = @($Script, $Requirements, $RuntimeRequirements, $PSCommandPath)
    $Fingerprint = ($FingerprintFiles | ForEach-Object {
        (Get-FileHash $_ -Algorithm SHA256).Hash
    }) -join ":"
}
Set-Content -Path $Marker -Value $Fingerprint -NoNewline

Write-Host "Tauri sidecar: $TauriSidecar"
