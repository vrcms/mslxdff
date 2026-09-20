@echo off
setlocal
set "ROOT=%~dp0"
set "RESTART_ROOT=%ROOT%"
powershell -NoProfile -NonInteractive -Command "$node=(Get-Command node -ErrorAction Stop).Source; $q=[char]34; $cmd=$q+$node+$q+' '+$q+$env:RESTART_ROOT+'bin\mslxdff.js'+$q+' -restart'; ((Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$cmd}).ProcessId)"
echo restart requested - poll daemon.pid and /health afterwards
endlocal
