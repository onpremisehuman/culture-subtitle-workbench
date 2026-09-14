[CmdletBinding()]
param(
    [switch]$InstallFfmpeg,
    [switch]$RegisterAutostart
)

$ErrorActionPreference = "Stop"
$skillRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$appRoot = Join-Path $skillRoot "app"
$requirements = Join-Path $appRoot "requirements.txt"
$python = Get-Command python.exe -ErrorAction SilentlyContinue

if (-not $python) {
    throw "Python 3.10 or newer is required. Install Python, reopen PowerShell, and retry."
}

$versionText = & $python.Source -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
$version = [version]$versionText
if ($version -lt [version]"3.10") {
    throw "Python 3.10 or newer is required; found $versionText."
}

& $python.Source -m pip install --upgrade pip
& $python.Source -m pip install --upgrade -r $requirements

if (-not (Get-Command ffmpeg.exe -ErrorAction SilentlyContinue)) {
    if ($InstallFfmpeg) {
        $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
        if (-not $winget) {
            throw "winget is unavailable. Install FFmpeg manually and ensure ffmpeg.exe is on PATH."
        }
        & $winget.Source install --id Gyan.FFmpeg --exact --accept-package-agreements --accept-source-agreements
    }
    else {
        Write-Warning "FFmpeg is missing. Re-run with -InstallFfmpeg or install it manually."
    }
}

if (-not (Get-Command codex.cmd -ErrorAction SilentlyContinue)) {
    Write-Warning "Codex CLI is missing. Install it, then run: codex login"
}

if ($RegisterAutostart) {
    & (Join-Path $appRoot "자동실행_설치.ps1")
}

& (Join-Path $skillRoot "scripts\doctor.ps1")
