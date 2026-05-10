@echo off
setlocal
cd /d "%~dp0"
echo Starting Update Log Editor...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "& { $started = Get-Date; npm start; $code = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }; $elapsed = ((Get-Date) - $started).TotalSeconds; if ($code -ne 0 -or $elapsed -lt 8) { Write-Host ''; if ($code -ne 0) { Write-Host 'Update Log Editor failed to start.' } else { Write-Host 'Update Log Editor exited before starting a new server window.' }; Read-Host 'Press Enter to close this window' | Out-Null }; exit $code }"
