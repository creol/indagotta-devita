@echo off
REM ==========================================================================
REM  Sync this project to the QNAP, then rebuild the container there.
REM
REM  Y:\indagotta-devita  ==  /share/ZFS21_DATA/docker_containers/indagotta-devita
REM
REM  Deliberately NOT copied:
REM    node_modules, dist, server-dist  - rebuilt inside the Docker image
REM    .git                             - not needed to run
REM    .env                             - lives ONLY on the NAS
REM
REM  That last one matters. /MIR mirrors, which means it DELETES files on the
REM  destination that are missing from the source. Listing .env under /XF
REM  excludes it from the purge as well as the copy, so the API token on the
REM  NAS survives every sync. Do not remove it from the /XF list.
REM ==========================================================================

setlocal
set SRC=C:\Dev\indagotta-devita
set DEST=Y:\indagotta-devita

echo Syncing %SRC%
echo     to %DEST%
echo.

robocopy "%SRC%" "%DEST%" /MIR /NFL /NDL /NP ^
  /XD node_modules .git dist server-dist .vscode ^
  /XF .env *.log

REM Robocopy uses 0-7 for success and 8+ for real failures, so the usual
REM "if errorlevel 1" check would report a successful copy as an error.
if %ERRORLEVEL% GEQ 8 (
  echo.
  echo ROBOCOPY FAILED with exit code %ERRORLEVEL%
  pause
  exit /b 1
)

echo.
echo Files synced. Now rebuild on the NAS:
echo.
echo    ssh admin@your-nas
echo    cd /share/ZFS21_DATA/docker_containers/indagotta-devita
echo    ./deploy.sh
echo.
pause
