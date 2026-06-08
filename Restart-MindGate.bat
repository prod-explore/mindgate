@echo off
echo Requesting Administrative Privileges to restart Agent Service...
>nul 2>&1 "%SYSTEMROOT%\system32\cacls.exe" "%SYSTEMROOT%\system32\config\system"
if '%errorlevel%' NEQ '0' (
    goto UACPrompt
) else ( goto gotAdmin )

:UACPrompt
    echo Set UAC = CreateObject^("Shell.Application"^) > "%temp%\getadmin.vbs"
    echo UAC.ShellExecute "%~s0", "", "", "runas", 0 >> "%temp%\getadmin.vbs"
    "%temp%\getadmin.vbs"
    exit /B

:gotAdmin
    if exist "%temp%\getadmin.vbs" ( del "%temp%\getadmin.vbs" )
    pushd "%CD%"
    CD /D "%~dp0"

echo Pulling latest code changes...
cd /d "D:\Users\justx\Documents\=HUSTLA=\.PROJECT\FUTUMORE\mindgate"
git pull

echo.
echo Restarting MindGate Agent Service...
powershell -Command "Restart-Service mindgateagent.exe -Force"

echo.
echo Restarting Tray App...
powershell -Command "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | Where-Object {$_.CommandLine -match 'src[\\\\/]index\\.js'} | Invoke-CimMethod -MethodName Terminate"
powershell -Command "Stop-Process -Name 'tray_windows*' -Force -ErrorAction SilentlyContinue"

echo Set WshShell = CreateObject("WScript.Shell") > "%temp%\run_tray.vbs"
echo WshShell.CurrentDirectory = "D:\Users\justx\Documents\=HUSTLA=\.PROJECT\FUTUMORE\mindgate\tray" >> "%temp%\run_tray.vbs"
echo WshShell.Run "node.exe D:\Users\justx\Documents\=HUSTLA=\.PROJECT\FUTUMORE\mindgate\tray\src\index.js", 0, False >> "%temp%\run_tray.vbs"
wscript "%temp%\run_tray.vbs"
del "%temp%\run_tray.vbs"

echo.
echo Done! Both apps have been restarted.
timeout /t 3
