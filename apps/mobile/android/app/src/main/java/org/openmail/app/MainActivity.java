package org.openmail.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ServerLockPlugin.class); // before super: the bridge reads its plugins there
        super.onCreate(savedInstanceState);
    }
}
