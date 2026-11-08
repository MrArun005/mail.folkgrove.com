package org.openmail.app;

import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Keeps the app's web view on the app's own page and the one server chosen at first launch. Any other web address
 * (a link in an email, say) opens in the phone's browser instead, so no other site ever runs inside the app.
 * The first-run page (apps/shell) calls ServerLock.set({ origin }) before opening the server.
 */
@CapacitorPlugin(name = "ServerLock")
public class ServerLockPlugin extends Plugin {
    private SharedPreferences prefs() { return getContext().getSharedPreferences("openmail", 0); }

    private static String originOf(Uri u) { return u.getScheme() + "://" + u.getAuthority(); }

    @PluginMethod
    public void set(PluginCall call) {
        String o = call.getString("origin");
        Uri u = o == null ? null : Uri.parse(o);
        if (u == null || u.getScheme() == null || u.getAuthority() == null) { call.reject("origin required"); return; }
        prefs().edit().putString("origin", originOf(u)).apply();
        call.resolve();
    }

    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        String scheme = url.getScheme();
        if (!"http".equals(scheme) && !"https".equals(scheme)) return null; // mailto:, tel: …: Capacitor's default
        if ("localhost".equals(url.getHost())) return false; // the app's own first-run page
        if (originOf(url).equals(prefs().getString("origin", null))) return false; // the chosen server
        try { getActivity().startActivity(new Intent(Intent.ACTION_VIEW, url)); } catch (Exception ignored) { }
        return true;
    }
}
