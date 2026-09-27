[CmdletBinding()]
param()

$ErrorActionPreference = "Continue"
$missing = [System.Collections.Generic.List[string]]::new()

function Test-Command {
    param([string]$Name, [string]$Hint)
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command) {
        Write-Host "[OK] $Name -> $($command.Source)"
        return
    }
    Write-Host "[MISSING] $Name — $Hint" -ForegroundColor Yellow
    $missing.Add($Name)
}

Test-Command "python.exe" "Install Python 3.10 or newer."
Test-Command "pythonw.exe" "Install the standard Windows build of Python."
Test-Command "ffmpeg.exe" "Run install.ps1 -InstallFfmpeg or install FFmpeg manually."
Test-Command "yt-dlp.exe" "Run install.ps1."
Test-Command "whisper.exe" "Run install.ps1."
$appRoot = Join-Path $PSScriptRoot "../app"
if (Get-Command python.exe -ErrorAction SilentlyContinue) {
    & python -c "import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); import agent_cli; s=agent_cli.BackendSettings(Path(sys.argv[1])/'data'/'ai-settings.json'); d=agent_cli.describe(s.load()['backend']); print(d); sys.exit(1 if d['error'] else 0)" $appRoot
    if ($LASTEXITCODE -ne 0) { $missing.Add("ai-cli") }
}
Write-Host "CLI installation does not verify account login or remaining quota."

if ($missing.Count -gt 0) {
    Write-Host "Doctor found $($missing.Count) required action(s)." -ForegroundColor Yellow
    exit 1
}

Write-Host "Culture Subtitle Workbench is ready." -ForegroundColor Green
