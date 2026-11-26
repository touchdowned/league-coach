; The old hand-packaged copy lived in this same folder with its code unpacked in resources\app.
; Electron loads resources\app before resources\app.asar, so remove it or the old code would keep running.
!macro customInstall
  RMDir /r "$INSTDIR\resources\app"
!macroend
