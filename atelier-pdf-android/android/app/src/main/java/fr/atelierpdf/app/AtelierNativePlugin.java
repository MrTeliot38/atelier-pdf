package fr.atelierpdf.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
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
    private byte[] toSave = null;

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
        if (data == null) { call.reject("Aucune donnée"); return; }
        toSave = Base64.decode(data, Base64.DEFAULT);
        Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType(mime);
        i.putExtra(Intent.EXTRA_TITLE, name);
        startActivityForResult(call, i, "saveResult");
    }

    @ActivityCallback
    private void saveResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        byte[] bytes = toSave;
        toSave = null;
        JSObject ret = new JSObject();
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null || bytes == null) {
            ret.put("saved", false);
            call.resolve(ret);
            return;
        }
        Uri uri = result.getData().getData();
        try (OutputStream os = getContext().getContentResolver().openOutputStream(uri, "wt")) {
            if (os == null) throw new Exception("Flux indisponible");
            os.write(bytes);
            ret.put("saved", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Impossible d'enregistrer : " + e.getMessage());
        }
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

    private static String safeName(String n) {
        String s = n == null ? "" : n.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]+", "-").replaceAll("^\\.+", "").trim();
        if (s.isEmpty()) s = "document.pdf";
        if (s.length() > 150) s = s.substring(0, 150);
        return s;
    }
}
