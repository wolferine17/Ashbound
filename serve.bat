@echo off
REM ════════════════════════════════════════════════════════════════
REM  Ashbound — local development server
REM  Double-click this file to host the game at http://localhost:8000
REM  Required because browsers block API calls from file:// origins.
REM ════════════════════════════════════════════════════════════════

setlocal
set PORT=8000

echo.
echo  ╔══════════════════════════════════════════════════╗
echo  ║          ASHBOUND — local game server            ║
echo  ╚══════════════════════════════════════════════════╝
echo.
echo  Starting on http://localhost:%PORT%
echo  Your browser will open automatically.
echo  Press Ctrl+C in this window to stop the server.
echo.

REM Open the browser in the background (small delay so the server is up first)
start "" cmd /c "timeout /t 1 /nobreak >nul && start http://localhost:%PORT%"

REM ── Try Python 3 (most common) ──
where python >nul 2>nul
if %errorlevel% equ 0 (
  echo  Using: Python http.server
  python -m http.server %PORT%
  goto :end
)

REM ── Try the "py" launcher (Windows Python installer default) ──
where py >nul 2>nul
if %errorlevel% equ 0 (
  echo  Using: py -3 http.server
  py -3 -m http.server %PORT%
  goto :end
)

REM ── Try Node.js (npx http-server) ──
where npx >nul 2>nul
if %errorlevel% equ 0 (
  echo  Using: npx http-server ^(installing on first run, give it a moment^)
  npx --yes http-server -p %PORT% -c-1
  goto :end
)

REM ── Nothing found ──
echo.
echo  ✗ Could not find Python or Node.js on your PATH.
echo.
echo  Install ONE of these (free, takes 2 minutes):
echo    Python:  https://www.python.org/downloads/  ^(check "Add to PATH" during install^)
echo    Node:    https://nodejs.org/
echo.
echo  Then re-run serve.bat.
echo.
pause

:end
endlocal
