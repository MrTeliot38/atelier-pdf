package fr.atelierpdf.app;

import android.app.Activity;
import android.provider.Settings;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import org.json.JSONArray;
import org.json.JSONObject;
import android.app.DownloadManager;
import android.content.ContentValues;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import java.io.OutputStream;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.provider.Settings;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintDocumentInfo;
import android.print.PrintManager;
import android.provider.OpenableColumns;
import android.util.Base64;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Fonctions propres à Android pour Atelier PDF :
 * ouvrir un PDF reçu d'une autre application, enregistrer, partager, imprimer.
 * Aucun accès réseau, aucune permission de stockage : Android demande à la personne où enregistrer.
 */
@CapacitorPlugin(name = "AtelierNative")
public class AtelierNativePlugin extends Plugin {

    private static final long MAX_BYTES = 300L * 1024 * 1024;
    private final List<JSObject> pending = new ArrayList<>();

    @Override
    public void load() {
        Activity a = getActivity();
        if (a != null) readIntent(a.getIntent());
        // bouton Retour : la page décide (fermer une fenêtre, désélectionner, demander avant de quitter…)
        getActivity().runOnUiThread(() -> getActivity().getOnBackPressedDispatcher().addCallback(getActivity(), new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                notifyListeners("backButton", new JSObject(), false);
            }
        }));
    }

    @PluginMethod
    public void exitApp(PluginCall call) {
        call.resolve();
        getActivity().runOnUiThread(() -> getActivity().finish());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        readIntent(intent);
    }

    /* ---------------- fichiers reçus (Ouvrir avec, Partager vers) ---------------- */

    private void readIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
            uris.add(intent.getData());
        } else if (Intent.ACTION_SEND.equals(action)) {
            Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) uris.add(u);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        }
        if (uris.isEmpty()) return;
        // l'intention est traitée une seule fois (pas de réouverture après rotation de l'écran)
        intent.setAction(Intent.ACTION_MAIN);
        intent.setData(null);
        intent.removeExtra(Intent.EXTRA_STREAM);
        for (Uri u : uris) {
            try {
                JSObject f = readUri(u);
                if (f == null) continue;
                synchronized (pending) { pending.add(f); }
            } catch (Exception e) {
                // fichier illisible : ignoré
            }
        }
        // la page vient chercher les fichiers elle-même (getPendingFiles) : pas de doublon
        notifyListeners("filesPending", new JSObject(), true);
    }

    private JSObject readUri(Uri uri) throws Exception {
        if (!"content".equals(uri.getScheme())) return null;
        ContentResolver cr = getContext().getContentResolver();
        String name = "document.pdf";
        try (Cursor c = cr.query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                String n = c.getString(0);
                if (n != null && !n.isEmpty()) name = n;
            }
        } catch (Exception ignored) { }
        String mime = cr.getType(uri);
        if (mime == null) mime = name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/octet-stream";
        if (!mime.equals("application/pdf") && !mime.startsWith("image/")) return null;
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (InputStream in = cr.openInputStream(uri)) {
            if (in == null) return null;
            byte[] buf = new byte[65536];
            long total = 0;
            int r;
            while ((r = in.read(buf)) > 0) {
                total += r;
                if (total > MAX_BYTES) return null;
                out.write(buf, 0, r);
            }
        }
        JSObject f = new JSObject();
        f.put("name", name);
        f.put("mime", mime);
        f.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
        return f;
    }

    @PluginMethod
    public void getPendingFiles(PluginCall call) {
        JSArray arr = new JSArray();
        synchronized (pending) {
            for (JSObject f : pending) arr.put(f);
            pending.clear();
        }
        JSObject ret = new JSObject();
        ret.put("files", arr);
        call.resolve(ret);
    }

    @PluginMethod
    public void clearPending(PluginCall call) {
        synchronized (pending) { pending.clear(); }
        call.resolve();
    }

    /* ---------------- enregistrer (choix de l'emplacement par Android) ---------------- */

    @PluginMethod
    public void saveAs(PluginCall call) {
        String name = safeName(call.getString("name", "document.pdf"));
        String mime = call.getString("mime", "application/pdf");
        String data = call.getString("data");
        if (data == null || data.isEmpty()) { call.reject("Aucune donnée à enregistrer"); return; }
        // Le contenu est d'abord écrit dans le cache : il survit si Android recrée l'activité
        // pendant que le sélecteur de fichiers est ouvert (sinon le fichier choisi restait vide).
        try {
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            if (bytes.length == 0) { call.reject("Document vide"); return; }
            File f = pendingSaveFile();
            try (FileOutputStream fos = new FileOutputStream(f)) { fos.write(bytes); }
        } catch (Exception e) { call.reject("Préparation impossible : " + e.getMessage()); return; }
        getContext().getSharedPreferences("atelier", Context.MODE_PRIVATE).edit().putString("nomEnAttente", name).apply();
        Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType(mime);
        i.putExtra(Intent.EXTRA_TITLE, name);
        startActivityForResult(call, i, "saveResult");
    }

    private File pendingSaveFile() {
        File dir = new File(getContext().getCacheDir(), "enregistrement");
        if (!dir.exists()) dir.mkdirs();
        return new File(dir, "a-enregistrer.bin");
    }

    @ActivityCallback
    private void saveResult(PluginCall call, ActivityResult result) {
        final File src = pendingSaveFile();
        final Uri uri = (result.getResultCode() == Activity.RESULT_OK && result.getData() != null) ? result.getData().getData() : null;
        if (uri == null || !src.exists() || src.length() == 0) {
            src.delete();
            if (uri != null) deleteEmptyDocument(uri);
            if (call != null) { JSObject ret = new JSObject(); ret.put("saved", false); call.resolve(ret); }
            return;
        }
        // copie hors du fil principal (gros documents)
        new Thread(() -> {
            JSObject ret = new JSObject();
            try {
                try {
                    copyToUri(src, uri);
                } catch (Exception e) {
                    // l'emplacement choisi refuse l'écriture : on n'y laisse pas de fichier vide,
                    // et le document est enregistré dans Téléchargements
                    deleteDocument(uri);
                    if (Build.VERSION.SDK_INT < 29) throw e;
                    String name = insertInDownloads(src, pendingName(), "application/pdf");
                    ret.put("fallback", true);
                    ret.put("name", name);
                }
                ret.put("saved", true);
                ret.put("size", src.length());
                if (call != null) call.resolve(ret); else notifyListeners("saveDone", ret, true);
            } catch (Exception e) {
                if (call != null) call.reject("Impossible d'enregistrer : " + e.getMessage());
                else { ret.put("saved", false); ret.put("error", String.valueOf(e.getMessage())); notifyListeners("saveDone", ret, true); }
            } finally {
                src.delete();
            }
        }).start();
    }

    private String pendingName() {
        return getContext().getSharedPreferences("atelier", Context.MODE_PRIVATE).getString("nomEnAttente", "document.pdf");
    }

    /* ---------------- enregistrer directement dans Téléchargements ---------------- */
    /** Sans sélecteur de fichiers : le document est écrit dans Téléchargements, puis relu pour vérifier sa taille. */
    @PluginMethod
    public void saveToDownloads(PluginCall call) {
        final String name = safeName(call.getString("name", "document.pdf"));
        final String mime = call.getString("mime", "application/pdf");
        final String data = call.getString("data");
        if (data == null || data.isEmpty()) { call.reject("Aucune donnée à enregistrer"); return; }
        if (Build.VERSION.SDK_INT < 29) { call.reject("ANCIEN_ANDROID"); return; }
        new Thread(() -> {
            File tmp = new File(getContext().getCacheDir(), "enregistrement-direct.bin");
            try {
                byte[] bytes = Base64.decode(data, Base64.DEFAULT);
                if (bytes.length == 0) throw new Exception("document vide");
                try (FileOutputStream fos = new FileOutputStream(tmp)) { fos.write(bytes); }
                String saved = insertInDownloads(tmp, name, mime);
                JSObject r = new JSObject();
                r.put("saved", true);
                r.put("name", saved);
                r.put("size", bytes.length);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("Impossible d'enregistrer : " + e.getMessage());
            } finally { tmp.delete(); }
        }).start();
    }

    /** Écrit src dans Téléchargements ; renvoie le nom final (Android ajoute « (1) » si le nom existe). */
    private String insertInDownloads(File src, String name, String mime) throws Exception {
        ContentResolver cr = getContext().getContentResolver();
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
        if (uri == null) throw new Exception("dossier Téléchargements indisponible");
        try {
            writeAndVerify(cr, uri, src);
            v.clear();
            v.put(MediaStore.MediaColumns.IS_PENDING, 0);
            cr.update(uri, v, null, null);
        } catch (Exception e) {
            try { cr.delete(uri, null, null); } catch (Exception ignored) { }
            throw e;
        }
        String finalName = name;
        try (Cursor c = cr.query(uri, new String[] { MediaStore.MediaColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) finalName = c.getString(0);
        } catch (Exception ignored) { }
        return finalName;
    }

    /** Écrit par descripteur de fichier (vidé, écrit, synchronisé), puis relit la taille réellement enregistrée. */
    private void writeAndVerify(ContentResolver cr, Uri uri, File src) throws Exception {
        Exception last = null;
        for (String mode : new String[] { "rwt", "wt", "w" }) {
            try (ParcelFileDescriptor pfd = cr.openFileDescriptor(uri, mode)) {
                if (pfd == null) throw new Exception("accès refusé");
                try (FileOutputStream os = new FileOutputStream(pfd.getFileDescriptor()); InputStream in = new FileInputStream(src)) {
                    try { os.getChannel().truncate(0); } catch (Exception ignored) { }
                    byte[] buf = new byte[256 * 1024]; int n;
                    while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                    os.flush();
                    try { os.getFD().sync(); } catch (Exception ignored) { }
                }
                last = null;
                break;
            } catch (Exception e) { last = e; }
        }
        if (last != null) throw last;
        long size = -1;
        try (ParcelFileDescriptor pfd = cr.openFileDescriptor(uri, "r")) { if (pfd != null) size = pfd.getStatSize(); }
        catch (Exception ignored) { }
        // certains services en ligne n'annoncent pas la taille (-1) : seul un fichier réellement vide est une erreur
        if (size == 0 || (size > 0 && size != src.length())) throw new Exception("le fichier enregistré est incomplet (" + size + " octets sur " + src.length() + ")");
    }

    private void copyToUri(File src, Uri uri) throws Exception {
        writeAndVerify(getContext().getContentResolver(), uri, src);
    }

    private void deleteDocument(Uri uri) {
        try { android.provider.DocumentsContract.deleteDocument(getContext().getContentResolver(), uri); } catch (Exception ignored) { }
    }

    /** Annulation ou échec : on ne laisse pas un document vide de 0 Ko derrière soi. */
    private void deleteEmptyDocument(Uri uri) {
        try {
            ContentResolver cr = getContext().getContentResolver();
            long size = -1;
            try (Cursor c = cr.query(uri, new String[] { OpenableColumns.SIZE }, null, null, null)) {
                if (c != null && c.moveToFirst() && !c.isNull(0)) size = c.getLong(0);
            }
            if (size == 0) android.provider.DocumentsContract.deleteDocument(cr, uri);
        } catch (Exception ignored) { }
    }

    /* ---------------- partager ---------------- */

    private File writeShareFile(String name, String data) throws Exception {
        File dir = new File(getContext().getCacheDir(), "partage");
        if (!dir.exists() && !dir.mkdirs()) throw new Exception("Dossier de partage indisponible");
        File[] old = dir.listFiles();
        if (old != null) for (File f : old) { if (f.lastModified() < System.currentTimeMillis() - 86400000L) f.delete(); }
        File f = new File(dir, safeName(name));
        try (FileOutputStream fos = new FileOutputStream(f)) {
            fos.write(Base64.decode(data, Base64.DEFAULT));
        }
        return f;
    }

    @PluginMethod
    public void share(PluginCall call) {
        String name = call.getString("name", "document.pdf");
        String mime = call.getString("mime", "application/pdf");
        String title = call.getString("title", "Partager");
        String data = call.getString("data");
        if (data == null) { call.reject("Aucune donnée"); return; }
        try {
            File f = writeShareFile(name, data);
            Context ctx = getContext();
            Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", f);
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType(mime);
            send.putExtra(Intent.EXTRA_STREAM, uri);
            send.putExtra(Intent.EXTRA_SUBJECT, title);
            send.setClipData(ClipData.newRawUri(f.getName(), uri));
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(send, "Partager « " + f.getName() + " »");
            chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().startActivity(chooser);
            call.resolve();
        } catch (Exception e) {
            call.reject("Partage impossible : " + e.getMessage());
        }
    }

    /* ---------------- imprimer ---------------- */

    @PluginMethod
    public void print(PluginCall call) {
        String name = call.getString("name", "document.pdf");
        String data = call.getString("data");
        if (data == null) { call.reject("Aucune donnée"); return; }
        final File f;
        try { f = writeShareFile(name, data); } catch (Exception e) { call.reject(e.getMessage()); return; }
        final String jobName = f.getName();
        getActivity().runOnUiThread(() -> {
            try {
                PrintManager pm = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                pm.print(jobName, new PdfFileAdapter(f, jobName), new PrintAttributes.Builder().build());
                call.resolve();
            } catch (Exception e) {
                call.reject("Impression impossible : " + e.getMessage());
            }
        });
    }

    private static class PdfFileAdapter extends PrintDocumentAdapter {
        private final File file;
        private final String name;
        PdfFileAdapter(File file, String name) { this.file = file; this.name = name; }

        @Override
        public void onLayout(PrintAttributes oldAttributes, PrintAttributes newAttributes, CancellationSignal cancellationSignal,
                             LayoutResultCallback callback, Bundle extras) {
            if (cancellationSignal.isCanceled()) { callback.onLayoutCancelled(); return; }
            PrintDocumentInfo info = new PrintDocumentInfo.Builder(name)
                .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
                .setPageCount(PrintDocumentInfo.PAGE_COUNT_UNKNOWN)
                .build();
            callback.onLayoutFinished(info, true);
        }

        @Override
        public void onWrite(PageRange[] pages, ParcelFileDescriptor destination, CancellationSignal cancellationSignal,
                            WriteResultCallback callback) {
            try (InputStream in = new FileInputStream(file); OutputStream out = new FileOutputStream(destination.getFileDescriptor())) {
                byte[] buf = new byte[65536];
                int r;
                while ((r = in.read(buf)) > 0) {
                    if (cancellationSignal.isCanceled()) { callback.onWriteCancelled(); return; }
                    out.write(buf, 0, r);
                }
                callback.onWriteFinished(new PageRange[]{PageRange.ALL_PAGES});
            } catch (Exception e) {
                callback.onWriteFailed(e.getMessage());
            }
        }
    }

    /* ---------------- lecteur PDF par défaut ---------------- */
    // Android ne permet pas à une application de se désigner elle-même : on indique l'état actuel,
    // on ouvre les réglages de l'application qui garde les PDF, puis on ouvre un PDF d'essai pour que
    // la personne choisisse « Atelier PDF » et « Toujours ».

    private Intent pdfViewIntent(Uri uri) {
        Intent i = new Intent(Intent.ACTION_VIEW);
        i.setDataAndType(uri, "application/pdf");
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        return i;
    }

    @PluginMethod
    public void defaultPdfStatus(PluginCall call) {
        JSObject r = new JSObject();
        try {
            PackageManager pm = getContext().getPackageManager();
            Uri probe = Uri.parse("content://" + getContext().getPackageName() + ".fileprovider/partage/essai.pdf");
            ResolveInfo ri = pm.resolveActivity(pdfViewIntent(probe), PackageManager.MATCH_DEFAULT_ONLY);
            String pkg = ri != null && ri.activityInfo != null ? ri.activityInfo.packageName : null;
            String cls = ri != null && ri.activityInfo != null ? ri.activityInfo.name : "";
            boolean mine = getContext().getPackageName().equals(pkg);
            boolean none = pkg == null || "android".equals(pkg) || pkg.contains("intentresolver") || cls.contains("Resolver") || cls.contains("Chooser");
            r.put("isDefault", mine);
            r.put("hasOther", !mine && !none);
            if (!mine && !none) {
                r.put("package", pkg);
                r.put("label", ri.loadLabel(pm).toString());
            }
        } catch (Exception e) {
            r.put("isDefault", false);
            r.put("hasOther", false);
        }
        call.resolve(r);
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        String pkg = call.getString("package", getContext().getPackageName());
        try {
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", pkg, null));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Réglages indisponibles : " + e.getMessage());
        }
    }

    @PluginMethod
    public void openTestPdf(PluginCall call) {
        String name = call.getString("name", "Atelier PDF - essai.pdf");
        String data = call.getString("data");
        if (data == null) { call.reject("Aucune donnée"); return; }
        try {
            File f = writeShareFile(name, data);
            Context ctx = getContext();
            Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", f);
            Intent i = pdfViewIntent(uri);
            i.setClipData(ClipData.newRawUri(f.getName(), uri));
            // pas de « choisir avec » : la fenêtre système propose « Toujours » quand aucun lecteur n'est fixé
            getActivity().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Ouverture impossible : " + e.getMessage());
        }
    }

    /**
     * PDF d'essai déposé dans Téléchargements, puis ouverture de l'application Fichiers :
     * touché depuis Fichiers, Android propose « Toujours » (ce qu'il ne fait pas toujours
     * quand c'est Atelier PDF lui-même qui ouvre le fichier).
     */
    @PluginMethod
    public void testPdfInDownloads(PluginCall call) {
        String name = safeName(call.getString("name", "Atelier PDF - essai.pdf"));
        String data = call.getString("data");
        if (data == null) { call.reject("Aucune donnée"); return; }
        if (Build.VERSION.SDK_INT < 29) { call.reject("Version d'Android trop ancienne"); return; }
        try {
            ContentResolver cr = getContext().getContentResolver();
            deleteOwnDownload(cr, name);
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, "application/pdf");
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (uri == null) throw new Exception("Téléchargements indisponible");
            try (OutputStream os = cr.openOutputStream(uri)) {
                if (os == null) throw new Exception("Écriture impossible");
                os.write(Base64.decode(data, Base64.DEFAULT));
            }
            v.clear();
            v.put(MediaStore.MediaColumns.IS_PENDING, 0);
            cr.update(uri, v, null, null);
            boolean opened = false;
            try {
                Intent i = new Intent(DownloadManager.ACTION_VIEW_DOWNLOADS);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getActivity().startActivity(i);
                opened = true;
            } catch (Exception ignored) { }
            JSObject r = new JSObject();
            r.put("saved", true);
            r.put("opened", opened);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Enregistrement impossible : " + e.getMessage());
        }
    }

    /** Retire le PDF d'essai de Téléchargements (seulement celui créé par l'application). */
    @PluginMethod
    public void removeTestPdf(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 29) {
            try { deleteOwnDownload(getContext().getContentResolver(), safeName(call.getString("name", ""))); } catch (Exception ignored) { }
        }
        call.resolve();
    }

    private void deleteOwnDownload(ContentResolver cr, String name) {
        if (Build.VERSION.SDK_INT < 29 || name.isEmpty()) return;
        // sans permission de stockage, MediaStore ne laisse toucher qu'aux fichiers créés par l'application
        try { cr.delete(MediaStore.Downloads.EXTERNAL_CONTENT_URI, MediaStore.MediaColumns.DISPLAY_NAME + "=?", new String[] { name }); }
        catch (Exception ignored) { }
    }

    /** Icônes de la barre d'état et de navigation : sombres sur thème clair, claires sur thème sombre. */
    @PluginMethod
    public void setBarStyle(PluginCall call) {
        final boolean light = Boolean.TRUE.equals(call.getBoolean("light", false));
        final Activity act = getActivity();
        act.runOnUiThread(() -> {
            try {
                WindowInsetsControllerCompat c = WindowCompat.getInsetsController(act.getWindow(), act.getWindow().getDecorView());
                c.setAppearanceLightStatusBars(light);
                c.setAppearanceLightNavigationBars(light);
            } catch (Exception ignored) { }
        });
        call.resolve();
    }

    /* ---------------- mises à jour (seulement à la demande) ---------------- */
    // Seul accès à internet de l'application : la page des versions publiées sur GitHub.
    private static final String UPDATE_API = "https://api.github.com/repos/MrTeliot38/atelier-pdf/releases/latest";
    private JSObject lastRelease = null;
    private volatile boolean downloading = false;

    private String appVersion() {
        try { return getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0).versionName; }
        catch (Exception e) { return "0"; }
    }
    private static int[] verParts(String v) {
        String[] p = (v == null ? "" : v.replaceFirst("^[vV]", "")).split("[.-]");
        int[] r = new int[3];
        for (int i = 0; i < 3 && i < p.length; i++) { try { r[i] = Integer.parseInt(p[i].replaceAll("\\D.*$", "")); } catch (Exception ignored) { } }
        return r;
    }
    private static boolean newerThan(String a, String b) {
        int[] x = verParts(a), y = verParts(b);
        for (int i = 0; i < 3; i++) if (x[i] != y[i]) return x[i] > y[i];
        return false;
    }
    private static boolean okHost(String u) {
        try {
            URL url = new URL(u);
            String h = url.getHost();
            return "https".equals(url.getProtocol()) && (h.equals("github.com") || h.endsWith(".github.com") || h.endsWith(".githubusercontent.com"));
        } catch (Exception e) { return false; }
    }
    private HttpURLConnection open(String u) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(u).openConnection();
        c.setRequestProperty("User-Agent", "Atelier-PDF/" + appVersion());
        c.setRequestProperty("Accept", "application/vnd.github+json");
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setInstanceFollowRedirects(true);
        c.setUseCaches(false);
        return c;
    }

    private JSObject fetchLatest() throws Exception {
        HttpURLConnection c = open(UPDATE_API);
        int code = c.getResponseCode();
        if (code == 404) { JSObject r = new JSObject(); r.put("latest", ""); return r; }
        if (code == 403 || code == 429) throw new Exception("GitHub limite le nombre de vérifications : réessayez dans une heure.");
        if (code != 200) throw new Exception("GitHub a répondu " + code);
        StringBuilder sb = new StringBuilder();
        try (InputStream in = c.getInputStream()) {
            byte[] buf = new byte[16384]; int n;
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            while ((n = in.read(buf)) > 0) { bo.write(buf, 0, n); if (bo.size() > 2_000_000) break; }
            sb.append(bo.toString("UTF-8"));
        } finally { c.disconnect(); }
        JSONObject j = new JSONObject(sb.toString());
        String notes = j.optString("body", "");
        if (notes.length() > 10000) notes = notes.substring(0, 10000);
        JSObject r = new JSObject();
        r.put("latest", j.optString("tag_name", "").replaceFirst("^[vV]", ""));
        r.put("notes", notes);
        String page = j.optString("html_url", "");
        r.put("page", okHost(page) ? page : "https://github.com/MrTeliot38/atelier-pdf/releases/latest");
        JSONArray assets = j.optJSONArray("assets");
        if (assets != null) for (int i = 0; i < assets.length(); i++) {
            JSONObject a = assets.getJSONObject(i);
            String name = a.optString("name", "");
            String url = a.optString("browser_download_url", "");
            if (!name.toLowerCase().endsWith(".apk") || !okHost(url)) continue;
            String sha = null;
            String dg = a.optString("digest", "");
            if (dg.toLowerCase().startsWith("sha256:") && dg.length() == 71) sha = dg.substring(7).toLowerCase();
            if (sha == null) {
                java.util.regex.Matcher m = java.util.regex.Pattern.compile("(?i)(?:APK|\\.apk)[^\\n]*?([0-9a-f]{64})").matcher(notes);
                if (m.find()) sha = m.group(1).toLowerCase();
            }
            r.put("assetName", name.replaceAll("[^\\w.-]", "_"));
            r.put("assetUrl", url);
            r.put("size", a.optLong("size", 0));
            if (sha != null) r.put("sha", sha);
            break;
        }
        return r;
    }

    @PluginMethod
    public void checkUpdate(PluginCall call) {
        new Thread(() -> {
            try {
                JSObject rel = fetchLatest();
                lastRelease = rel;
                String current = appVersion();
                String latest = rel.getString("latest", "");
                JSObject r = new JSObject();
                r.put("current", current);
                r.put("latest", latest);
                r.put("newer", latest != null && !latest.isEmpty() && newerThan(latest, current));
                r.put("notes", rel.getString("notes", ""));
                r.put("page", rel.getString("page", ""));
                r.put("size", rel.has("size") ? rel.getLong("size") : 0);
                r.put("installable", rel.has("assetUrl"));
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e instanceof java.net.UnknownHostException || e instanceof java.net.SocketTimeoutException || e instanceof java.net.ConnectException
                    ? "Pas de connexion à internet." : String.valueOf(e.getMessage()));
            }
        }).start();
    }

    private File updateFile(String name) {
        File dir = new File(getContext().getCacheDir(), "maj");
        if (!dir.exists()) dir.mkdirs();
        return new File(dir, name);
    }

    private static String sha256(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(f)) { byte[] b = new byte[256 * 1024]; int n; while ((n = in.read(b)) > 0) md.update(b, 0, n); }
        StringBuilder sb = new StringBuilder();
        for (byte x : md.digest()) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    @PluginMethod
    public void installUpdate(PluginCall call) {
        if (downloading) { call.reject("Téléchargement déjà en cours"); return; }
        downloading = true;
        new Thread(() -> {
            try {
                JSObject rel = lastRelease != null ? lastRelease : fetchLatest();
                String latest = rel.getString("latest", "");
                String url = rel.getString("assetUrl", null);
                String sha = rel.getString("sha", null);
                if (url == null || !newerThan(latest, appVersion())) throw new Exception("Aucune mise à jour à installer");
                if (sha == null) throw new Exception("Empreinte de contrôle absente de la version publiée : installation refusée par sécurité.");
                File f = updateFile(rel.getString("assetName", "mise-a-jour.apk"));
                // déjà téléchargé et vérifié (par exemple avant d'autoriser l'installation)
                if (!(f.exists() && sha.equals(sha256(f)))) {
                    File[] old = f.getParentFile().listFiles();
                    if (old != null) for (File o : old) o.delete();
                    HttpURLConnection c = open(url);
                    c.setRequestProperty("Accept", "application/octet-stream");
                    int code = c.getResponseCode();
                    if (code != 200 || !okHost(c.getURL().toString())) throw new Exception("Téléchargement refusé (" + code + ")");
                    long total = c.getContentLengthLong();
                    MessageDigest md = MessageDigest.getInstance("SHA-256");
                    long got = 0, last = 0;
                    try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(f)) {
                        byte[] b = new byte[128 * 1024]; int n;
                        while ((n = in.read(b)) > 0) {
                            out.write(b, 0, n); md.update(b, 0, n); got += n;
                            if (got > 400_000_000L) throw new Exception("Fichier trop volumineux");
                            if (System.currentTimeMillis() - last > 150) {
                                last = System.currentTimeMillis();
                                JSObject p = new JSObject(); p.put("got", got); p.put("total", total); notifyListeners("updateProgress", p);
                            }
                        }
                    } finally { c.disconnect(); }
                    StringBuilder sb = new StringBuilder();
                    for (byte x : md.digest()) sb.append(String.format("%02x", x));
                    if (!sha.equals(sb.toString())) { f.delete(); throw new Exception("Le fichier téléchargé ne correspond pas à l'empreinte publiée : installation annulée."); }
                }
                JSObject r = new JSObject();
                if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
                    // Android demande une autorisation la première fois
                    Intent s = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
                    s.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getActivity().startActivity(s);
                    r.put("needPermission", true);
                    call.resolve(r);
                    return;
                }
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
                Intent i = new Intent(Intent.ACTION_VIEW);
                i.setDataAndType(uri, "application/vnd.android.package-archive");
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getActivity().startActivity(i);
                r.put("started", true);
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e instanceof java.net.UnknownHostException || e instanceof java.net.SocketTimeoutException || e instanceof java.net.ConnectException
                    ? "Pas de connexion à internet." : String.valueOf(e.getMessage()));
            } finally {
                downloading = false;
            }
        }).start();
    }

    @PluginMethod
    public void openUrl(PluginCall call) {
        String u = call.getString("url", "");
        if (!okHost(u)) { call.reject("Adresse refusée"); return; }
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(u));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(i);
            call.resolve();
        } catch (Exception e) { call.reject("Aucun navigateur"); }
    }

    @PluginMethod
    public void openDownloads(PluginCall call) {
        try {
            Intent i = new Intent(DownloadManager.ACTION_VIEW_DOWNLOADS);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(i);
            call.resolve();
        } catch (Exception e) { call.reject("Application Fichiers introuvable"); }
    }

    private static String safeName(String n) {
        String s = n == null ? "" : n.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]+", "-").replaceAll("^\\.+", "").trim();
        if (s.isEmpty()) s = "document.pdf";
        if (s.length() > 150) s = s.substring(0, 150);
        return s;
    }
}
