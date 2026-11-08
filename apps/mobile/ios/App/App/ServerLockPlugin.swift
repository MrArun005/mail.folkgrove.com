import Capacitor
import UIKit
import WebKit

/// Keeps the app's web view on the app's own page and the one server chosen at first launch. Any other web address
/// (a link in an email, say) opens in Safari instead, so no other site ever runs inside the app.
/// The first-run page (apps/shell) calls ServerLock.set({ origin }) before opening the server.
@objc(ServerLockPlugin)
public class ServerLockPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ServerLockPlugin"
    public let jsName = "ServerLock"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise)]
    private static let key = "openmail.origin"

    private static func origin(of url: URL) -> String? {
        guard let scheme = url.scheme, let host = url.host else { return nil }
        return url.port.map { "\(scheme)://\(host):\($0)" } ?? "\(scheme)://\(host)"
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let s = call.getString("origin"), let u = URL(string: s), let o = Self.origin(of: u) else {
            call.reject("origin required"); return
        }
        UserDefaults.standard.set(o, forKey: Self.key)
        call.resolve()
    }

    public override func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard let url = navigationAction.request.url, url.scheme == "http" || url.scheme == "https" else { return nil }
        if url.host == "localhost" { return NSNumber(value: false) } // the app's own first-run page
        if Self.origin(of: url) == UserDefaults.standard.string(forKey: Self.key) { return NSNumber(value: false) }
        UIApplication.shared.open(url)
        return NSNumber(value: true)
    }
}
