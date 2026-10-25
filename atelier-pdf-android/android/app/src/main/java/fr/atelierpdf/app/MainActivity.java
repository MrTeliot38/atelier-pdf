package fr.atelierpdf.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AtelierNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
