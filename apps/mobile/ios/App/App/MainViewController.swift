import Capacitor
import UIKit

/// The app's web view controller: Capacitor's, plus our own ServerLock plugin.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(ServerLockPlugin())
    }
}
