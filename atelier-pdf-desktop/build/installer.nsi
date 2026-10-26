; Installateur Windows d'Atelier PDF (NSIS)
; Installe pour l'utilisateur courant, sans droits administrateur.
; Si Atelier PDF est déjà installé, l'installateur se comporte comme une MISE À JOUR :
; même dossier, une seule fenêtre, raccourcis et réglages conservés, relance automatique.
Unicode true
!define APPNAME "Atelier PDF"
!ifndef VERSION
  !define VERSION "1.9.0"
!endif
!define EXE "Atelier PDF.exe"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\AtelierPDF"
!define PROGID "AtelierPDF.Document"

Name "${APPNAME}"
OutFile "..\dist\Atelier-PDF-Setup-${VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\Atelier PDF"
InstallDirRegKey HKCU "Software\AtelierPDF" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64
BrandingText "Atelier PDF ${VERSION}"
ShowInstDetails nevershow

VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=1036 "ProductName" "Atelier PDF"
VIAddVersionKey /LANG=1036 "FileDescription" "Installation et mise à jour d'Atelier PDF"
VIAddVersionKey /LANG=1036 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1036 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=1036 "LegalCopyright" "Logiciel libre"

Var IsUpdate
Var OldVersion
Var WelcomeTitle
Var WelcomeText

!include "MUI2.nsh"
!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
!define MUI_ABORTWARNING
!define MUI_ABORTWARNING_TEXT "Voulez-vous vraiment interrompre l'installation d'Atelier PDF ?"

!define MUI_WELCOMEPAGE_TITLE "$WelcomeTitle"
!define MUI_WELCOMEPAGE_TEXT "$WelcomeText"
!define MUI_PAGE_CUSTOMFUNCTION_SHOW WelcomeShow
!insertmacro MUI_PAGE_WELCOME

!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfUpdate
!insertmacro MUI_PAGE_DIRECTORY

!insertmacro MUI_PAGE_INSTFILES

!define MUI_PAGE_CUSTOMFUNCTION_PRE FinishPre
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Lancer Atelier PDF"
!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Choisir Atelier PDF comme lecteur PDF par défaut"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION OpenDefaultApps
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "French"

Function .onInit
  StrCpy $IsUpdate 0
  ReadRegStr $0 HKCU "Software\AtelierPDF" "InstallDir"
  StrCmp $0 "" fresh
  IfFileExists "$0\${EXE}" 0 fresh
    StrCpy $IsUpdate 1
    StrCpy $INSTDIR $0
    ReadRegStr $OldVersion HKCU "${UNINST_KEY}" "DisplayVersion"
    StrCmp $OldVersion "" 0 +2
      StrCpy $OldVersion "précédente"
    StrCpy $WelcomeTitle "Mise à jour d'Atelier PDF"
    StrCpy $WelcomeText "Atelier PDF $OldVersion est installé sur cet ordinateur. Cette mise à jour installe la version ${VERSION}.$\r$\n$\r$\nVos réglages, signatures enregistrées et raccourcis sont conservés.$\r$\n$\r$\nCliquez sur Mettre à jour."
    Goto done
  fresh:
    StrCpy $WelcomeTitle "Installation d'Atelier PDF"
    StrCpy $WelcomeText "Atelier PDF permet de corriger le texte d'un PDF, de remplir et signer des formulaires, de réorganiser et fusionner des documents, et d'imprimer seulement les pages voulues.$\r$\n$\r$\nTout se passe sur cet ordinateur : vos documents ne sont envoyés nulle part.$\r$\n$\r$\nCliquez sur Suivant pour continuer."
  done:
FunctionEnd

Function WelcomeShow
  StrCmp $IsUpdate 1 0 +3
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:Mettre à jour"
FunctionEnd

Function SkipIfUpdate
  StrCmp $IsUpdate 1 0 +2
    Abort
FunctionEnd

; Mise à jour : pas de page de fin, Atelier PDF se relance directement
Function FinishPre
  StrCmp $IsUpdate 1 0 +3
    Exec '"$INSTDIR\${EXE}"'
    Abort
FunctionEnd

Function OpenDefaultApps
  ; Windows réserve ce choix à l'utilisateur : on ouvre la page de réglage d'Atelier PDF
  ExecShell "open" "ms-settings:defaultapps?registeredAppUser=Atelier%20PDF"
FunctionEnd

; Atelier PDF ne doit pas tourner pendant la copie des fichiers
Function WaitForAppClosed
  IfFileExists "$INSTDIR\${EXE}" 0 free
  check:
    ClearErrors
    FileOpen $0 "$INSTDIR\${EXE}" a
    IfErrors busy
    FileClose $0
    Goto free
  busy:
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Atelier PDF est ouvert.$\r$\n$\r$\nEnregistrez vos documents et fermez toutes ses fenêtres, puis cliquez sur Réessayer." IDRETRY check
    Quit
  free:
FunctionEnd

Section "Atelier PDF"
  Call WaitForAppClosed
  SetOutPath "$INSTDIR"
  ; mise à jour : on retire les fichiers de l'ancienne version (uniquement ceux de l'application)
  StrCmp $IsUpdate 1 0 +3
    RMDir /r "$INSTDIR\resources"
    RMDir /r "$INSTDIR\locales"
  File /r "..\dist\win-unpacked\*.*"
  WriteUninstaller "$INSTDIR\Désinstaller Atelier PDF.exe"

  CreateShortcut "$SMPROGRAMS\Atelier PDF.lnk" "$INSTDIR\${EXE}"
  ; raccourci du Bureau : créé à la première installation, simplement actualisé lors d'une mise à jour
  StrCmp $IsUpdate 1 0 newdesk
    IfFileExists "$DESKTOP\Atelier PDF.lnk" 0 deskdone
  newdesk:
    CreateShortcut "$DESKTOP\Atelier PDF.lnk" "$INSTDIR\${EXE}"
  deskdone:

  WriteRegStr HKCU "Software\AtelierPDF" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "Atelier PDF"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "Atelier PDF"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${EXE},0"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Désinstaller Atelier PDF.exe"'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" 290000

  ; « Ouvrir avec → Atelier PDF » pour les fichiers PDF (sans changer l'application par défaut)
  WriteRegStr HKCU "Software\Classes\${PROGID}" "" "Document PDF"
  WriteRegStr HKCU "Software\Classes\${PROGID}" "FriendlyTypeName" "Document PDF"
  WriteRegStr HKCU "Software\Classes\${PROGID}\DefaultIcon" "" "$INSTDIR\${EXE},0"
  WriteRegStr HKCU "Software\Classes\${PROGID}\shell\open" "FriendlyAppName" "Atelier PDF"
  WriteRegStr HKCU "Software\Classes\${PROGID}\shell\open\command" "" '"$INSTDIR\${EXE}" "%1"'
  WriteRegStr HKCU "Software\Classes\.pdf\OpenWithProgids" "${PROGID}" ""
  WriteRegStr HKCU "Software\Classes\Applications\${EXE}\shell\open\command" "" '"$INSTDIR\${EXE}" "%1"'
  WriteRegStr HKCU "Software\Classes\Applications\${EXE}\SupportedTypes" ".pdf" ""
  WriteRegStr HKCU "Software\Classes\Applications\${EXE}" "FriendlyAppName" "Atelier PDF"
  ; inscription dans « Applications par défaut » de Windows
  WriteRegStr HKCU "Software\AtelierPDF\Capabilities" "ApplicationName" "Atelier PDF"
  WriteRegStr HKCU "Software\AtelierPDF\Capabilities" "ApplicationDescription" "Lire, corriger, remplir, signer, fusionner et partager des PDF"
  WriteRegStr HKCU "Software\AtelierPDF\Capabilities" "ApplicationIcon" "$INSTDIR\${EXE},0"
  WriteRegStr HKCU "Software\AtelierPDF\Capabilities\FileAssociations" ".pdf" "${PROGID}"
  WriteRegStr HKCU "Software\RegisteredApplications" "Atelier PDF" "Software\AtelierPDF\Capabilities"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
SectionEnd

Section "Uninstall"
  Delete "$SMPROGRAMS\Atelier PDF.lnk"
  Delete "$DESKTOP\Atelier PDF.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\AtelierPDF"
  DeleteRegKey HKCU "Software\Classes\${PROGID}"
  DeleteRegValue HKCU "Software\Classes\.pdf\OpenWithProgids" "${PROGID}"
  DeleteRegKey HKCU "Software\Classes\Applications\${EXE}"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Atelier PDF"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
SectionEnd
