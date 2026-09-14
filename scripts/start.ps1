[CmdletBinding()]
param([switch]$NoBrowser)

$ErrorActionPreference = "Stop"
$skillRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$appRoot = Join-Path $skillRoot "app"
$launcher = Join-Path $appRoot "culture-subtitle-autostart.pyw"
$healthUrl = "http://127.0.0.1:8876/api/health"
$appUrl = "http://127.0.0.1:8876/app/"

function Test-Server {
    try {
        $response = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
        return $response.ok -eq $true
    }
    catch {
        return $false
    }
}

if (-not (Test-Server)) {
    $pythonw = Get-Command pythonw.exe -ErrorAction SilentlyContinue
    if (-not $pythonw) {
        throw "pythonw.exe was not found. Run scripts/doctor.ps1."
    }
    Start-Process -FilePath $pythonw.Source -ArgumentList @("`"$launcher`"") -WorkingDirectory $appRoot -WindowStyle Hidden
    for ($attempt = 0; $attempt -lt 40 -and -not (Test-Server); $attempt++) {
        Start-Sleep -Milliseconds 250
    }
}

if (-not (Test-Server)) {
    throw "The server did not start. Check app/data/logs/autostart-server-error.log."
}

if (-not $NoBrowser) {
    Start-Process $appUrl
}
Write-Host "Culture Subtitle Workbench: $appUrl"
