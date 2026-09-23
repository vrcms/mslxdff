@echo off
setlocal
set "ROOT=%~dp0"
set "RESTART_ROOT=%ROOT%"
rem slow-threshold configurable: 20s default is too harsh for heavy-reasoning models
rem first-chunk timeout: 0=disabled. external values are respected.
if "%MSLXDFF_SLOW_TOTAL_MS%"=="" set "MSLXDFF_SLOW_TOTAL_MS=300000"
if "%MSLXDFF_STREAM_TIMEOUT_MS%"=="" set "MSLXDFF_STREAM_TIMEOUT_MS=0"
powershell -NoProfile -NonInteractive -Command "$node=(Get-Command node -ErrorAction Stop).Source; $q=[char]34; $inner='set MSLXDFF_SLOW_TOTAL_MS='+$env:MSLXDFF_SLOW_TOTAL_MS+'&& set MSLXDFF_STREAM_TIMEOUT_MS='+$env:MSLXDFF_STREAM_TIMEOUT_MS+'&& '+$q+$node+$q+' '+$q+$env:RESTART_ROOT+'bin\mslxdff.js'+$q+' -restart'; $cmd='cmd /c '+$q+$inner+$q; ((Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$cmd;CurrentDirectory=$env:RESTART_ROOT}).ProcessId)"
echo restart requested - poll daemon.pid and /health afterwards
endlocal
