@echo off
REM ============================================================
REM  run-project.bat  —  Check dependencies, start server, open browser
REM  Run install-dependencies.bat first if this is a fresh setup.
REM ============================================================
setlocal EnableExtensions
cd /d "%~dp0"

set "BACKEND_PORT=3000"

REM ── Read PORT from .env if present ──────────────────────────
if exist ".env" (
  for /f "usebackq tokens=1,* delims==" %%A in (`findstr /R /B /C:"PORT=" ".env" 2^>nul`) do (
    if /I "%%A"=="PORT" if not "%%B"=="" set "BACKEND_PORT=%%B"
  )
) else (
  if exist ".env.example" copy ".env.example" ".env" >nul
  echo NOTE: .env was missing — copied from .env.example. Fill in your credentials.
)

set "APP_URL=http://localhost:%BACKEND_PORT%"

echo ============================================================
echo  Google Calendar Agent — Startup Check
echo ============================================================
echo.

REM ── 1. Node.js ───────────────────────────────────────────────
where node >nul 2>nul
if errorlevel 1 (
  echo [FAIL] Node.js not found. Run install-dependencies.bat first.
  pause & exit /b 1
)
for /f "tokens=*" %%V in ('node -v 2^>nul') do set "NODE_VER=%%V"
echo [OK]   Node.js %NODE_VER%

REM ── 2. npm ───────────────────────────────────────────────────
where npm >nul 2>nul
if errorlevel 1 (
  echo [FAIL] npm not found. Run install-dependencies.bat first.
  pause & exit /b 1
)
echo [OK]   npm found

REM ── 3. Backend node_modules ──────────────────────────────────
if not exist "node_modules" (
  echo [FAIL] Backend dependencies missing. Run install-dependencies.bat first.
  pause & exit /b 1
)
echo [OK]   Backend dependencies present

REM ── 4. Frontend node_modules ─────────────────────────────────
if exist "client\package.json" (
  if not exist "client\node_modules" (
    echo [FAIL] Frontend dependencies missing. Run install-dependencies.bat first.
    pause & exit /b 1
  )
  echo [OK]   Frontend dependencies present
)

REM ── 5. Built frontend ────────────────────────────────────────
if not exist "public\index.html" (
  echo [FAIL] Frontend not built. Run install-dependencies.bat first.
  pause & exit /b 1
)
echo [OK]   Frontend build present

REM ── 6. .env credentials ──────────────────────────────────────
set "missing_creds="
findstr /B /C:"GOOGLE_CLIENT_ID=" ".env" >nul 2>nul || set "missing_creds=1"
findstr /B /C:"GOOGLE_CLIENT_SECRET=" ".env" >nul 2>nul || set "missing_creds=1"
findstr /B /C:"SESSION_SECRET=" ".env" >nul 2>nul || set "missing_creds=1"
findstr /B /C:"MONGODB_URI=" ".env" >nul 2>nul || set "missing_creds=1"

if defined missing_creds (
  echo.
  echo [WARN] .env is missing required values. Open .env and fill in:
  echo   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_SECRET, MONGODB_URI
  echo.
  echo The server may fail to start without these. Press any key to continue anyway...
  pause >nul
)

REM ── 7. Optional: start Ollama if available ────────────────────
where ollama >nul 2>nul
if not errorlevel 1 (
  powershell -NoProfile -Command "try { Invoke-RestMethod -TimeoutSec 2 http://localhost:11434/api/tags > $null; exit 0 } catch { exit 1 }" >nul 2>nul
  if errorlevel 1 (
    echo Starting Ollama in background...
    start "" /B cmd /c "ollama serve" >nul 2>nul
    timeout /t 2 >nul
  )
  echo [OK]   Ollama running
) else (
  echo [INFO] Ollama not installed — chatbot will use deterministic replies.
)

REM ── Kill any existing server on this port ────────────────────
for /f "tokens=5" %%P in ('netstat -ano 2^>nul ^| findstr ":%BACKEND_PORT% " ^| findstr "LISTENING"') do (
  taskkill /PID %%P /F >nul 2>nul
)

echo.
echo ============================================================
echo  Starting server on port %BACKEND_PORT% ...
echo ============================================================
echo.

start "Google Calendar Agent" cmd /k "node server.js 2>&1"

REM ── Wait for server to be ready (up to 30 s) ─────────────────
set "BACKEND_READY="
for /L %%i in (1,1,30) do (
  if not defined BACKEND_READY (
    powershell -NoProfile -Command "if (Test-NetConnection -ComputerName localhost -Port %BACKEND_PORT% -InformationLevel Quiet -WarningAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>nul
    if not errorlevel 1 set "BACKEND_READY=1"
    if not defined BACKEND_READY timeout /t 1 >nul
  )
)

if defined BACKEND_READY (
  echo Server is up! Opening %APP_URL% ...
  start "" "%APP_URL%"
  echo.
  echo NOTE: Log in as admin / admin, then click "Connect Google Calendar".
) else (
  echo Server did not respond within 30 seconds.
  echo Check the server window for errors, or view server-run.err.log.
  start "" "%APP_URL%"
)

echo.
echo The server is running in a separate window.
echo Close that window to stop the server.
echo.
