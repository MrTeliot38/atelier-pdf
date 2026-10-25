// Après l'assemblage Windows : icône et informations de version dans Atelier PDF.exe
// (remplace rcedit, qui nécessite Windows ou Wine)
const fs = require('fs'), path = require('path');
module.exports = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== 'win32') return;
  const ResEdit = await import('resedit');
  const R = ResEdit.default || ResEdit;
  const exe = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.exe`);
  const exeObj = R.NtExecutable.from(fs.readFileSync(exe), { ignoreCert: true });
  const res = R.NtExecutableResource.from(exeObj);
  const ico = R.Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'icon.ico')));
  const groups = R.Resource.IconGroupEntry.fromEntries(res.entries);
  const gid = groups.length ? groups[0].id : 1, lang = groups.length ? groups[0].lang : 1033;
  R.Resource.IconGroupEntry.replaceIconsForResource(res.entries, gid, lang, ico.icons.map(i => i.data));
  const v = ctx.packager.appInfo.version.split('.').map(Number);
  const vi = R.Resource.VersionInfo.fromEntries(res.entries)[0];
  const langs = vi.getAllLanguagesForStringValues();
  const strings = { ProductName: 'Atelier PDF', FileDescription: 'Atelier PDF', CompanyName: 'Atelier PDF', LegalCopyright: 'Logiciel libre', OriginalFilename: 'Atelier PDF.exe', InternalName: 'Atelier PDF' };
  for (const l of langs) vi.setStringValues(l, strings);
  vi.setFileVersion(v[0], v[1], v[2], 0, langs[0]?.lang ?? 1033);
  vi.setProductVersion(v[0], v[1], v[2], 0, langs[0]?.lang ?? 1033);
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exeObj);
  fs.writeFileSync(exe, Buffer.from(exeObj.generate()));
  console.log('  • icône et version appliquées à', path.basename(exe));

  // Verrous de sécurité intégrés à l'exécutable (« fuses ») : il ne peut pas être détourné en interpréteur
  // Node.js, ne lit pas NODE_OPTIONS, refuse le débogage en ligne de commande et ne charge que son archive.
  const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
  await flipFuses(exe, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: false,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  });
  console.log('  • verrous de sécurité Electron activés');
};
