@echo off
setlocal
set "ROOT=%~dp0"
set "RESTART_ROOT=%ROOT%"
rem slow-threshold configurable: 20s default is too harsh for heavy-reasoning models
rem first-chunk timeout: 0=disabled. external values are respected.
if "%MSLXDFF_SLOW_TOTAL_MS%"=="" set "MSLXDFF_SLOW_TOTAL_MS=300000"
if "%MSLXDFF_STREAM_TIMEOUT_MS%"=="" set "MSLXDFF_STREAM_TIMEOUT_MS=0"
rem Two clocks, split on purpose (2026-10-05 triage):
rem  STALL = idle kill, re-armed on every frame. It catches DEAD streams: qoder hung silent 180s on
rem  api1.qoder.sh (3 frames, 274 bytes, maxGap 179986ms). Legit LIVE gaps measured max 8.0s (qwen)
rem  and 0.4s (qoder), so 30s keeps about 4x headroom over real thinking pauses.
rem  *_TIMEOUT_MS = provider whole-request deadline (queue+connect+body share one budget). Kept generous
rem  so LIVE long-reasoning turns are not cut mid-stream (qwen: 113-117s carrying 500-900KB). qoder and
rem  zcode legit turns top out at 87.3s, so the old 120s backstop still covers 100 pct of them.
if "%MSLXDFF_STALL_TIMEOUT_MS%"=="" set "MSLXDFF_STALL_TIMEOUT_MS=30000"
rem STALL_TIMEOUT_MS doubles as the fallback source of SCORE_STALL_MS: pin it so stallHits keeps meaning 15s.
if "%MSLXDFF_SCORE_STALL_MS%"=="" set "MSLXDFF_SCORE_STALL_MS=15000"
if "%MSLXDFF_QWENWORK_TIMEOUT_MS%"=="" set "MSLXDFF_QWENWORK_TIMEOUT_MS=300000"
if "%MSLXDFF_GLOBALQWENWORK_TIMEOUT_MS%"=="" set "MSLXDFF_GLOBALQWENWORK_TIMEOUT_MS=300000"
if "%MSLXDFF_QODER_TIMEOUT_MS%"=="" set "MSLXDFF_QODER_TIMEOUT_MS=120000"
if "%MSLXDFF_ZCODE_TIMEOUT_MS%"=="" set "MSLXDFF_ZCODE_TIMEOUT_MS=120000"
rem Invoke-CimMethod spawns WITHOUT this shell's env: every var must be re-set inside $inner or it never reaches the daemon.
powershell -NoProfile -NonInteractive -Command "$node=(Get-Command node -ErrorAction Stop).Source; $q=[char]34; $inner='set MSLXDFF_SLOW_TOTAL_MS='+$env:MSLXDFF_SLOW_TOTAL_MS+'&& set MSLXDFF_STREAM_TIMEOUT_MS='+$env:MSLXDFF_STREAM_TIMEOUT_MS+'&& set MSLXDFF_STALL_TIMEOUT_MS='+$env:MSLXDFF_STALL_TIMEOUT_MS+'&& set MSLXDFF_SCORE_STALL_MS='+$env:MSLXDFF_SCORE_STALL_MS+'&& set MSLXDFF_QWENWORK_TIMEOUT_MS='+$env:MSLXDFF_QWENWORK_TIMEOUT_MS+'&& set MSLXDFF_GLOBALQWENWORK_TIMEOUT_MS='+$env:MSLXDFF_GLOBALQWENWORK_TIMEOUT_MS+'&& set MSLXDFF_QODER_TIMEOUT_MS='+$env:MSLXDFF_QODER_TIMEOUT_MS+'&& set MSLXDFF_ZCODE_TIMEOUT_MS='+$env:MSLXDFF_ZCODE_TIMEOUT_MS+$(if ($env:MSLXDFF_TALK_FULL) { '&& set MSLXDFF_TALK_FULL='+$env:MSLXDFF_TALK_FULL } else { '' })+$(if ($env:MSLXDFF_TALK_CAP_CHARS) { '&& set MSLXDFF_TALK_CAP_CHARS='+$env:MSLXDFF_TALK_CAP_CHARS } else { '' }) + '&& '+$q+$node+$q+' '+$q+$env:RESTART_ROOT+'bin\mslxdff.js'+$q+' -restart'; $cmd='cmd /c '+$q+$inner+$q; ((Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$cmd;CurrentDirectory=$env:RESTART_ROOT}).ProcessId)"
echo restart requested - poll daemon.pid and /health afterwards
endlocal
