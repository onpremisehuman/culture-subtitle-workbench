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
Test-Command "codex.cmd" "Install Codex CLI and run codex login."

if (Get-Command codex.cmd -ErrorAction SilentlyContinue) {
    & codex login status
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ACTION] Run: codex login" -ForegroundColor Yellow
        $missing.Add("codex-login")
    }
}

if ($missing.Count -gt 0) {
    Write-Host "Doctor found $($missing.Count) required action(s)." -ForegroundColor Yellow
    exit 1
}

Write-Host "Culture Subtitle Workbench is ready." -ForegroundColor Green
