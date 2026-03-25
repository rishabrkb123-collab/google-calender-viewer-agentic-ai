@echo off
REM Updated 2026-03-10 (deterministic chatbot by default + optional Ollama)
setlocal EnableExtensions
cd /d "%~dp0"

set "BACKEND_PORT=3000"
set "FRONTEND_URL=http://localhost:%BACKEND_PORT%"
set "BACKEND_URL=http://localhost:%BACKEND_PORT%"
set "CHAT_MODEL=gpt-oss:120b-cloud"
set "CHAT_USE_LLM_INTENT=false"
set "CHAT_USE_LLM_REPLY=false"
set "CHAT_USE_LLM_SEMANTIC_FALLBACK=true"
set "USE_OLLAMA=true"

if not exist ".env" (
  copy ".env.example" ".env" >nul
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not in PATH.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm is not installed or not in PATH.
  pause
  exit /b 1
)

set "missing="
findstr /B /C:"GOOGLE_CLIENT_ID=" ".env" >nul || set "missing=1"
findstr /B /C:"GOOGLE_CLIENT_SECRET=" ".env" >nul || set "missing=1"
findstr /B /C:"SESSION_SECRET=" ".env" >nul || set "missing=1"
findstr /B /C:"MONGODB_URI=" ".env" >nul || set "missing=1"

if defined missing (
  echo.
  echo Missing required values in .env. Please open .env and fill in:
  echo   GOOGLE_CLIENT_ID
  echo   GOOGLE_CLIENT_SECRET
  echo   SESSION_SECRET
  echo   MONGODB_URI
  echo.
  pause
  exit /b 1
)

echo Installing backend dependencies...
call npm.cmd install --no-audit --no-fund
if errorlevel 1 (
  echo Backend dependency installation failed.
  pause
  exit /b 1
)

if exist "client\package.json" (
  echo Installing frontend dependencies...
  call npm.cmd --prefix client install --no-audit --no-fund
  if errorlevel 1 (
    echo Frontend dependency installation failed.
    pause
    exit /b 1
  )
  echo Building frontend...
  call npm.cmd run client:build
  if errorlevel 1 (
    echo Frontend build failed.
    pause
    exit /b 1
  )
)

echo.
echo Chatbot startup mode:
echo   CHAT_USE_LLM_INTENT=%CHAT_USE_LLM_INTENT%
echo   CHAT_USE_LLM_REPLY=%CHAT_USE_LLM_REPLY%
echo   CHAT_USE_LLM_SEMANTIC_FALLBACK=%CHAT_USE_LLM_SEMANTIC_FALLBACK%
echo   USE_OLLAMA=%USE_OLLAMA%
echo.

for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":%BACKEND_PORT% .*LISTENING"') do (
  taskkill /PID %%p /F >nul 2>nul
)
REM Kill anything on backend port

if /I "%USE_OLLAMA%"=="true" (
  where ollama >nul 2>nul
  if not errorlevel 1 (
    powershell -NoProfile -Command "try { Invoke-RestMethod -TimeoutSec 2 http://localhost:11434/api/tags > $null } catch { exit 1 }"
    if errorlevel 1 (
      start "Ollama" cmd /c "ollama serve"
      timeout /t 2 >nul
    )
    echo Ensuring Ollama model is available: %CHAT_MODEL%
    call ollama pull %CHAT_MODEL%
  ) else (
    echo Ollama was requested but is not installed. Continuing without it.
  )
)

start "Backend" cmd /c "set OLLAMA_MODEL=%CHAT_MODEL%&& set CHAT_USE_LLM_INTENT=%CHAT_USE_LLM_INTENT%&& set CHAT_USE_LLM_REPLY=%CHAT_USE_LLM_REPLY%&& set CHAT_USE_LLM_SEMANTIC_FALLBACK=%CHAT_USE_LLM_SEMANTIC_FALLBACK%&& npm.cmd start 1>server-run.out.log 2>server-run.err.log"

set "BACKEND_READY="
for /L %%i in (1,1,30) do (
  powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 '%BACKEND_URL%/api/local/me' > $null; exit 0 } catch { exit 1 }"
  if not errorlevel 1 (
    set "BACKEND_READY=1"
    goto :wait_for_open
  )
  timeout /t 1 >nul
)

:wait_for_open
set "OPENED="
for /L %%i in (1,1,30) do (
  powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 '%FRONTEND_URL%' > $null; exit 0 } catch { exit 1 }"
  if not errorlevel 1 (
    set "OPENED=1"
    goto :open_browser
  )
  timeout /t 1 >nul
)

:open_browser
if defined OPENED (
  echo Opening application in browser...
  echo Note: each user must log in locally and then connect Google Calendar before chat can answer from their events.
  start "" "%FRONTEND_URL%"
) else (
  start "" "%BACKEND_URL%"
)
