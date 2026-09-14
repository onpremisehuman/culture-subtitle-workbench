[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcherPath = Join-Path $projectRoot "culture-subtitle-autostart.pyw"
$taskName = "Culture Subtitle Queue Server"
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

if (-not (Test-Path -LiteralPath $launcherPath)) {
    throw "Autostart launcher was not found: $launcherPath"
}

$pythonwCommand = Get-Command pythonw.exe -ErrorAction SilentlyContinue
$pythonwPath = if ($pythonwCommand) { $pythonwCommand.Source } else { $null }
if (-not $pythonwPath) {
    throw "pythonw.exe was not found on PATH. Install the standard Windows build of Python."
}

$action = New-ScheduledTaskAction -Execute $pythonwPath -Argument "`"$launcherPath`"" -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "Starts the local Culture Subtitle queue server without a console window at Windows logon." `
    -Force | Out-Null

Start-ScheduledTask -TaskName $taskName
Write-Output "Autostart registered: $taskName"
