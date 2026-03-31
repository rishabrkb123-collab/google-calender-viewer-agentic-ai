@echo off
REM ============================================================
REM  install-dependencies.bat
REM  Installs ALL dependencies for the Google Calendar Agent.
REM  Run this ONCE on a fresh machine (or after cloning).
REM  After this completes, use run-project.bat to start the app.
REM ============================================================
setlocal EnableExtensions
cd /d "%~dp0"

echo ============================================================
echo  Google Calendar Agent — Full Dependency Installer
echo ============================================================
echo.

REM ── 1. Check Node.js ─────────────────────────────────────────
echo [1/6] Checking Node.js...
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js is NOT installed.
  echo.
  echo Please install Node.js 18 or later from:
  echo   https://nodejs.org/en/download
  echo.
  echo After installing, re-run this script.
  pause & exit /b 1
)
for /f "tokens=*" %%V in ('node -v') do set "NODE_VER=%%V"
echo [OK]   Node.js %NODE_VER% found.

REM ── 2. Check npm ─────────────────────────────────────────────
echo [2/6] Checking npm...
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm not found. Reinstall Node.js from https://nodejs.org
  pause & exit /b 1
)
for /f "tokens=*" %%V in ('npm -v') do set "NPM_VER=%%V"
echo [OK]   npm %NPM_VER% found.

REM ── 3. Install backend dependencies ──────────────────────────
echo.
echo [3/6] Installing backend Node.js dependencies...
call npm.cmd install
if errorlevel 1 (
  echo [ERROR] Backend npm install failed. Check your internet connection and try again.
  pause & exit /b 1
)
echo [OK]   Backend dependencies installed.

REM ── 4. Install frontend dependencies ─────────────────────────
echo.
echo [4/6] Installing frontend (React/Vite) dependencies...
if exist "client\package.json" (
  call npm.cmd --prefix client install
  if errorlevel 1 (
    echo [ERROR] Frontend npm install failed.
    pause & exit /b 1
  )
  echo [OK]   Frontend dependencies installed.
) else (
  echo [SKIP] No client/package.json found — skipping frontend install.
)

REM ── 5. Build frontend ────────────────────────────────────────
echo.
echo [5/6] Building React frontend...
if exist "client\package.json" (
  call npm.cmd run client:build
  if errorlevel 1 (
    echo [ERROR] Frontend build failed. Check client/src for errors.
    pause & exit /b 1
  )
  echo [OK]   Frontend built successfully.
) else (
  echo [SKIP] No client found — skipping build.
)

REM ── 6. Check .env ────────────────────────────────────────────
echo.
echo [6/6] Checking .env configuration...
if not exist ".env" (
  if exist ".env.example" (
    copy ".env.example" ".env" >nul
    echo [OK]   Created .env from .env.example.
  ) else (
    echo [WARN] No .env or .env.example found. You will need to create .env manually.
  )
) else (
  echo [OK]   .env exists.
)

REM ── Optional: Ollama ─────────────────────────────────────────
echo.
echo ── Optional: Ollama (AI chatbot enhancement) ───────────────
where ollama >nul 2>nul
if errorlevel 1 (
  echo [INFO] Ollama is NOT installed.
  echo        The chatbot works without it (using rule-based replies).
  echo        To enable AI-powered responses, install Ollama from:
  echo          https://ollama.com/download
  echo        Then pull the model configured in your .env (OLLAMA_MODEL).
) else (
  for /f "tokens=*" %%V in ('ollama version 2^>nul') do set "OLLAMA_VER=%%V"
  echo [OK]   Ollama found: %OLLAMA_VER%
  echo        Start it with: ollama serve
  echo        Pull a model:  ollama pull llama3
)

REM ── MongoDB reminder ─────────────────────────────────────────
echo.
echo ── MongoDB Atlas ───────────────────────────────────────────
echo [INFO] Make sure MONGODB_URI in .env points to a valid MongoDB Atlas cluster.
echo        Free tier: https://www.mongodb.com/cloud/atlas/register
echo        The app will create all collections automatically on first run.

REM ── Google OAuth reminder ────────────────────────────────────
echo.
echo ── Google OAuth Credentials ────────────────────────────────
echo [INFO] Fill in .env with your Google OAuth credentials:
echo          GOOGLE_CLIENT_ID=...
echo          GOOGLE_CLIENT_SECRET=...
echo        Get them from: https://console.cloud.google.com/apis/credentials
echo        Authorized redirect URI: http://localhost:3000/oauth2callback

echo.
echo ============================================================
echo  Installation complete!
echo.
echo  Next steps:
echo    1. Open .env and fill in:
echo       - GOOGLE_CLIENT_ID
echo       - GOOGLE_CLIENT_SECRET
echo       - SESSION_SECRET  (any long random string)
echo       - MONGODB_URI     (MongoDB Atlas connection string)
echo.
echo    2. Run run-project.bat to start the application.
echo ============================================================
echo.
pause
