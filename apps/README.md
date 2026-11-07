# OpenMail apps

The web app (`web/`) is installable as it is (a PWA). The shells here give it a native home on platforms where installing
from the browser isn't enough. **None of them bundle the mail client.** Each one asks once for the server address
(`shell/index.html`, the shared first-run screen), remembers it, and then opens that server's own web app. So one build
works with any OpenMail server and updates when the server does.

| | Where | Status |
|---|---|---|
| PWA | `web/public/manifest.webmanifest`, `sw.js` | Install prompt (Settings → App), Compose/Inbox shortcuts, “Share to OpenMail” (text, links, files), unread badge, mailto handler |
| Desktop (macOS, Windows, Linux) | `desktop/` (Electron) | Builds and runs on macOS; mailto handler. Unsigned |
| iOS, Android | `mobile/` (Capacitor 8) | Projects generated, **not built yet** (no Xcode or Android SDK on the machine that made them) |

Tooling needs Node 22+. Icons for all of them come from one mark: `cd desktop && npx electron ../make-icons.js`.

## Sign-in (OAuth) in the apps

The web app signs in from its own page with OAuth (authorization code + PKCE). The redirect URI it sends is the page's
own origin (`https://mail.example.com/`), and the server checks it against the `openmail-web` client's registered
redirects. The shells load the page from the server's own origin, so **the redirect `install.sh` already registers
(`$PUBLIC_URL/`) covers every app**. There's no custom URL scheme to register, and none to hijack. If a server is
reached under a second name, register that origin too. For development, `deploy/dev-setup.mjs` registers
`http://localhost:5173/` (desktop app, iOS Simulator) and `http://10.0.2.2:5173/` (the Android emulator's name for your
computer: run `npm run dev -- --host`, and add `"cleartext": true` under `server` in `mobile/capacitor.config.json`, dev only).
“Keep me signed in” works too: its HttpOnly cookie belongs to the server's origin, which the app's web view keeps.

## Desktop (`desktop/`)

```sh
cd apps/desktop && npm install
npm start               # run from source
npm run package         # → dist/OpenMail-darwin-arm64/OpenMail.app (on Windows/Linux: that platform's build)
```

- First run asks for the server. To switch servers, use File → Change Server….
- Email links: the app declares `mailto:` (Info.plist). **File → Use OpenMail for Email Links** makes it the default
  (it's never changed without asking). Each link opens Compose in its own window.
- Links inside email open in your browser. The server's page can show notifications and use the clipboard, and nothing else.
- Unread count on the Dock icon (the web app's `navigator.setAppBadge`). Notifications work while the app runs.
  There's no Web Push in Electron, so nothing arrives while it's quit.
- **Still open:** code signing and notarization (Apple Developer ID, $99/yr). Unsigned, macOS says the app "can't be
  opened" (right-click → Open once). Also a Windows installer (and its signing certificate), Linux packages (.deb/AppImage),
  and auto-update. `@electron/packager` makes the bare app; add `electron-builder` when installers are needed.

## iOS and Android (`mobile/`)

```sh
cd apps/mobile && npm install
npx cap sync                       # after changing shell/index.html or capacitor.config.json
npx cap open android               # Android Studio: Run, or ./gradlew assembleDebug in android/
npx cap open ios                   # Xcode: pick a simulator, Run
```

Needs: **Android Studio** (SDK 36, JDK 21) for Android, and **Xcode 16+** for iOS. The iOS project uses Swift Package
Manager, so CocoaPods isn't needed. App id: `org.openmail.app` (change it in `capacitor.config.json` before publishing).

- The app starts on the bundled server-address screen, then navigates to the server (`allowNavigation: ["*"]`, because
  the server isn't known at build time). If the server can't be reached, it comes back to that screen and says so
  (`errorPath`). Settings → App → Change server returns to it.
- The web view adds `OpenMailApp` to its user agent, so the web app knows it's inside the shell.
- **Limits of this approach:**
  - Capacitor injects its native bridge only into its own bundled origin. The server's page therefore has no native
    plugins (push, share sheet, badges).
  - Android's WebView and iOS's WKWebView have no Web Push and no Notification API, so the shell gets no notifications
    until native push exists.
  - Apple may reject an app that is "just a website" (App Review guideline 4.2). Native push and share are what usually
    get it through.

### Native push: what the owner must set up (TODO)

`@capacitor/push-notifications` is installed and configured, but **nothing calls it**. Without
`google-services.json`, `register()` crashes on Android. Each step below needs an account only the owner can create:

1. **Build per server.** Set `server.url` in `capacitor.config.json` to the server (for example the hosted instance),
   so the bridge is injected into its pages. A generic "any server" build can't receive native push.
2. **Android (FCM).** Create a Firebase project. Add an Android app `org.openmail.app` and download `google-services.json`
   into `mobile/android/app/`. Create a service-account key for sending.
3. **iOS (APNs).** Apple Developer Program ($99/yr). Add the Push Notifications capability to the App target, and create an
   APNs auth key (.p8, with key ID and team ID).
4. **A push gateway.** Stalwart sends standard Web Push (JMAP `PushSubscription` with a URL), not FCM or APNs. Run a small
   relay that gets a per-device URL. It receives Stalwart's push and forwards a content-free "new mail" through
   FCM/APNs using the keys above. UnifiedPush or ntfy can play this role on Android.
5. **The web app.** When `window.Capacitor?.Plugins?.PushNotifications` exists: `requestPermissions()`, `register()`,
   and on `registration` create the JMAP push subscription with the gateway URL for that token (the same shape as
   `enablePush` in `web/src/notify.ts`).

Also open: store listings (Google Play $25 once, App Store $99/yr), signing keys (Android upload key, iOS certificates
and profiles), the splash screen (Capacitor's default), and native "Share to OpenMail" (Android intent filter / iOS
share extension; the installed PWA on Android already has it).
