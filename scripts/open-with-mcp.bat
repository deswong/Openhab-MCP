@echo off
rem Open VS Code with the OpenHAB folder and this MCP repository as a multi-root setup.
rem Usage: open-with-mcp.bat C:\path\to\openhab

if "%1"=="" (
  echo Usage: %~nx0 C:\path\to\openhab
  exit /b 1
)

set "OPENHAB=%~1"

rem Determine MCP path: use MCP_PATH env var if set, otherwise assume script is in scripts\ under the MCP repo
if defined MCP_PATH (
  set "MCP=%MCP_PATH%"
) else (
  for %%I in ("%~dp0..") do set "MCP=%%~fI"
)

where code >nul 2>&1
if errorlevel 1 (
  echo Error: 'code' CLI not found. Install VS Code and enable the 'code' command.
  exit /b 2
)

echo Opening VS Code with OpenHAB: %OPENHAB% and MCP: %MCP%
code "%OPENHAB%" --add "%MCP%"
