@echo off
cd /d "%~dp0"
where pnpm >nul 2>nul || (echo pnpm is not installed. Run: npm install -g pnpm & pause & exit /b 1)
if not exist node_modules (echo First run: installing packages... & call pnpm install)
if not exist server\node_modules (pushd server & call pnpm install & popd)
call pnpm start
pause
