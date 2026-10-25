@echo off
rem Pulls the latest code, rebuilds the agent, then restarts the agent's Windows service and the tray app.
echo Running Restart script...
rem The script lives in scripts\windows; the repository root is two levels up.
for %%I in ("%~dp0..\..") do set "ROOT=%%~fI"
cd /d "%ROOT%"
echo Pulling latest code changes...
git pull
echo.
echo Updating the agent (npm install, build)...
pushd "%ROOT%\agent"
call npm install
if errorlevel 1 (
  popd
  echo The agent did not install. The service was NOT restarted, so the previous version keeps running.
  pause
  exit /b 1
)
call npm run build
if errorlevel 1 (
  popd
  echo The agent did not build. The service was NOT restarted, so the previous version keeps running.
  pause
  exit /b 1
)
popd
echo.
echo Restarting MindGate Agent Service...
powershell -Command "Start-Process powershell -ArgumentList '-NoProfile -Command Restart-Service mindgateagent.exe -Force' -Verb RunAs -Wait"
echo.
echo Restarting Tray App...
powershell -Command "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | Where-Object {$_.CommandLine -match 'src[\\\\/]index\\.js'} | Invoke-CimMethod -MethodName Terminate"
powershell -Command "Stop-Process -Name 'tray_windows*' -Force -ErrorAction SilentlyContinue"
echo.
echo Set WshShell = CreateObject("WScript.Shell") > "%temp%\run_tray.vbs"
echo WshShell.CurrentDirectory = "%ROOT%\tray" >> "%temp%\run_tray.vbs"
echo WshShell.Run "node.exe ""%ROOT%\tray\src\index.js""", 0, False >> "%temp%\run_tray.vbs"
wscript "%temp%\run_tray.vbs"
del "%temp%\run_tray.vbs"
echo.
echo Done! Both apps have been restarted.
timeout /t 10
exit
