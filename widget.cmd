@echo off
rem Opens Checkpoint as a compact chromeless widget window, docked top-right.
rem Self-contained: works even where IT policy blocks PowerShell script files.
setlocal

set "HTML=%~dp0index.html"
if not exist "%HTML%" (
  echo index.html not found next to this script.
  pause
  exit /b 1
)
set "URL=file:///%HTML:\=/%?widget=1"

set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%BROWSER%" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%BROWSER%" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%BROWSER%" set "BROWSER=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not exist "%BROWSER%" (
  echo Could not find Microsoft Edge or Google Chrome.
  pause
  exit /b 1
)

rem Screen width via PowerShell -Command (allowed even in ConstrainedLanguage)
set "SW="
for /f %%W in ('powershell -NoProfile -Command "(Get-CimInstance Win32_VideoController ^| Where-Object CurrentHorizontalResolution ^| Select-Object -First 1).CurrentHorizontalResolution" 2^>nul') do set "SW=%%W"
if not defined SW set "SW=1920"
set /a POSX=SW-386
if %POSX% lss 0 set POSX=16

start "" "%BROWSER%" --app="%URL%" --window-size=360,560 --window-position=%POSX%,16

endlocal
