[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$taskName = "Culture Subtitle Queue Server"
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Output "No registered autostart task was found."
    exit 0
}

Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
Write-Output "Autostart removed: $taskName"
