@echo off
echo Running Restart script...
cd /d "%~dp0"
echo Pulling latest code changes...
git pull
echo.
echo Restarting MindGate Agent Service...
powershell -Command "Start-Process powershell -ArgumentList '-NoProfile -Command Restart-Service mindgateagent.exe -Force' -Verb RunAs -Wait"
echo.
echo Restarting Tray App...
powershell -Command "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | Where-Object {$_.CommandLine -match 'src[\\\\/]index\\.js'} | Invoke-CimMethod -MethodName Terminate"
powershell -Command "Stop-Process -Name 'tray_windows*' -Force -ErrorAction SilentlyContinue"
echo.
echo Set WshShell = CreateObject("WScript.Shell") > "%temp%\run_tray.vbs"
echo WshShell.CurrentDirectory = "%~dp0tray" >> "%temp%\run_tray.vbs"
echo WshShell.Run "node.exe """"%~dp0tray\src\index.js"""""", 0, False >> "%temp%\run_tray.vbs"
wscript "%temp%\run_tray.vbs"
del "%temp%\run_tray.vbs"
echo.
echo Done! Both apps have been restarted.
pause
