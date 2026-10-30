@echo off
cd /d "%~dp0"
echo Stopping MindGate Agent Service...
powershell -Command "Start-Process powershell -ArgumentList '-NoProfile -Command Stop-Service mindgateagent.exe -Force -ErrorAction SilentlyContinue' -Verb RunAs -Wait"
echo.
echo Stopping Tray App...
powershell -Command "Get-CimInstance Win32_Process -Filter ""name='node.exe'"" | Where-Object {$_.CommandLine -match 'src[/\\]index\.js'} | Invoke-CimMethod -MethodName Terminate" >nul 2>&1
powershell -Command "Stop-Process -Name 'tray_windows*' -Force -ErrorAction SilentlyContinue" >nul 2>&1
echo.
echo Pulling latest code changes...
git pull
if errorlevel 1 (
  echo git pull failed. Restarting the previous version...
  goto :start
)
echo.
echo Updating the agent (npm install, build)...
:: subst gives tsc a path without special characters, avoiding EPERM on node:fs lstat
subst Z: "%~dp0" >nul 2>&1
pushd Z:\agent
call npm install
if errorlevel 1 (
  popd
  subst Z: /d >nul 2>&1
  echo The agent did not install. The service was NOT restarted, so the previous version keeps running.
  pause
  exit /b 1
)
call npm run build
if errorlevel 1 (
  popd
  subst Z: /d >nul 2>&1
  echo The agent did not build. The service was NOT restarted, so the previous version keeps running.
  pause
  exit /b 1
)
popd
subst Z: /d >nul 2>&1
echo.
:start
echo Restarting MindGate Agent Service...
powershell -Command "Start-Process powershell -ArgumentList '-NoProfile -Command Start-Service mindgateagent.exe' -Verb RunAs -Wait"
echo.
echo Restarting Tray App...
echo Set WshShell = CreateObject("WScript.Shell") > "%temp%\run_tray.vbs"
echo WshShell.CurrentDirectory = "%~dp0tray" >> "%temp%\run_tray.vbs"
echo WshShell.Run "node.exe ""%~dp0tray\src\index.js""", 0, False >> "%temp%\run_tray.vbs"
wscript "%temp%\run_tray.vbs"
del "%temp%\run_tray.vbs"
echo.
echo Done! Both apps have been restarted.
timeout /t 10
exit
