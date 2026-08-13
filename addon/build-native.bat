@echo off
setlocal
pushd "%~dp0.."

rem Keep the manual developer entry point on the same Electron/node-gyp and
rem manifest-producing path used by CI and release packaging. No user-specific
rem Visual Studio path or stale Electron header version is embedded here.
call npm run rebuild:addon
set BUILD_EXIT=%ERRORLEVEL%

popd
exit /b %BUILD_EXIT%
