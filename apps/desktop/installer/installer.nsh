; Custom steps of the Consulvia installer (electron-builder includes this file in the NSIS script).
;
; Installing over a running Consulvia, and uninstalling it, must not kill it. Consulvia is the window
; program plus the API, the worker and the database as programs of their own: the stock check of
; electron-builder ends every one of them with "taskkill /F", which stops the database in the middle of
; whatever it is writing and, if a backup or a restore is running, in the middle of that.
;
; So the running program is asked to quit by itself (`Consulvia.exe --quit`, the same as "Salir" in the
; tray: it stops the API and the worker, then the database, in order) and waited for. Only a program that has
; not gone after 90 seconds is ended by force, as the stock check would have done at once. The database is a
; program of its own that the kill does not reach, so on that path it is stopped the way it likes (`pg_ctl stop -m
; fast`, a checkpoint and a clean exit) and only a `postgres.exe` that runs from the folder being replaced and
; still did not stop is ended: never one of another program, a database of another product, or another install.
;
; This replaces the stock check (electron-builder uses `customCheckAppRunning` instead of its own when it is
; defined), so everything the stock check did is done here: look for the program, ask it to close, make sure
; it is gone before the files are replaced.

!macro consulviaIsRunning RESULT
  ; 0 when a Consulvia.exe of this Windows user is running (the window program, or one of its children).
  nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
  Pop ${RESULT}
!macroend

!macro customCheckAppRunning
  !insertmacro consulviaIsRunning $R0
  ${if} $R0 == 0
    DetailPrint "$(appClosing)"
    ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      ; The second copy hands the request to the one that is running and ends at once.
      ExecWait `"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --quit`
    ${endif}
    StrCpy $R1 0
    consulviaWait:
      Sleep 1000
      !insertmacro consulviaIsRunning $R0
      ${if} $R0 != 0
        Goto consulviaGone
      ${endif}
      IntOp $R1 $R1 + 1
      ${if} $R1 < 90
        Goto consulviaWait
      ${endif}
    ; It did not go by itself in a minute and a half: end what is left, as a last resort.
    DetailPrint "Waiting for ${PRODUCT_NAME} to close."
    nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%"`
    Pop $R0
    ; The database that Consulvia started is still there: ask it to stop, cleanly.
    ReadEnvStr $R2 CONSULVIA_DATA_DIR
    ${if} $R2 == ""
      StrCpy $R2 "$LOCALAPPDATA\Consulvia"
    ${endif}
    ${if} ${FileExists} "$INSTDIR\resources\postgres\bin\pg_ctl.exe"
      nsExec::Exec `"$INSTDIR\resources\postgres\bin\pg_ctl.exe" stop -m fast -t 60 -D "$R2\pgdata"`
      Pop $R0
    ${endif}
    ; Whatever of that same database is left: only the programs that run from this folder, found by the path of
    ; their executable and not by their name or their command line. The folder reaches PowerShell through the
    ; environment so that a quote in a user name cannot end the string.
    System::Call `Kernel32::SetEnvironmentVariable(t "CONSULVIA_INSTDIR", t "$INSTDIR")`
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$root = (Join-Path $$env:CONSULVIA_INSTDIR 'resources\postgres') + '\'; Get-CimInstance Win32_Process -Filter \"Name='postgres.exe'\" | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$root, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
    Pop $R0
    ; The files must not be "in use" when they are replaced.
    Sleep 2000
    consulviaGone:
  ${endif}
!macroend
