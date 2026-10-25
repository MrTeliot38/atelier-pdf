; Ajouts pour l'installateur fabriqué par « npm run dist » (electron-builder) :
; « Ouvrir avec », inscription dans « Applications par défaut » de Windows.
!macro customInstall
  WriteRegStr HKCU "Software\Classes\AtelierPDF.Document" "" "Document PDF"
  WriteRegStr HKCU "Software\Classes\AtelierPDF.Document" "FriendlyTypeName" "Document PDF"
  WriteRegStr HKCU "Software\Classes\AtelierPDF.Document\DefaultIcon" "" "$INSTDIR\Atelier PDF.exe,0"
  WriteRegStr HKCU "Software\Classes\AtelierPDF.Document\shell\open" "FriendlyAppName" "Atelier PDF"
  WriteRegStr HKCU "Software\Classes\AtelierPDF.Document\shell\open\command" "" '"$INSTDIR\Atelier PDF.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\.pdf\OpenWithProgids" "AtelierPDF.Document" ""
  WriteRegStr HKCU "Software\AtelierPDF\Capabilities" "ApplicationName" "Atelier PDF"
  WriteRegStr HKCU "Software\AtelierPDF\Capabilities" "ApplicationDescription" "Lire, corriger, remplir, signer et partager des PDF"
  WriteRegStr HKCU "Software\AtelierPDF\Capabilities\FileAssociations" ".pdf" "AtelierPDF.Document"
  WriteRegStr HKCU "Software\RegisteredApplications" "Atelier PDF" "Software\AtelierPDF\Capabilities"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\AtelierPDF.Document"
  DeleteRegValue HKCU "Software\Classes\.pdf\OpenWithProgids" "AtelierPDF.Document"
  DeleteRegKey HKCU "Software\AtelierPDF"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Atelier PDF"
!macroend
