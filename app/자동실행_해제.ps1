[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$taskName = "Culture Subtitle Queue Server"
$startupFolder = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startupFolder "Culture Subtitle Workbench.lnk"

Remove-Item -LiteralPath $shortcutPath -Force -ErrorAction SilentlyContinue
Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "CultureSubtitleWorkbench" -ErrorAction SilentlyContinue
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Output "Autostart removed: $shortcutPath"
    exit 0
}

Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
Write-Output "Autostart removed: $taskName"
