package club.skale.xpeed;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.AlertDialog;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.pm.PackageManager;
import android.content.Intent;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/** ELM327 serial port transport for paired Bluetooth Classic adapters. */
@CapacitorPlugin(name = "ObdSerial")
public class ObdSerialPlugin extends Plugin {
    private static final UUID SPP = UUID.fromString("00001101-0000-1000-8000-00805f9b34fb");
    private final ExecutorService io = Executors.newCachedThreadPool();
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor();
    private final Object lock = new Object();
    private BluetoothSocket socket;
    private String connectionId;

    private BluetoothAdapter adapter() {
        BluetoothManager manager = getContext().getSystemService(BluetoothManager.class);
        return manager == null ? null : manager.getAdapter();
    }

    private boolean permitted(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 31 && ContextCompat.checkSelfPermission(getContext(),
                Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
            call.reject("Nearby devices permission is required.");
            return false;
        }
        return true;
    }

    @SuppressLint("MissingPermission")
    @PluginMethod
    public void choose(PluginCall call) {
        if (!permitted(call)) return;
        BluetoothAdapter adapter = adapter();
        if (adapter == null || !adapter.isEnabled()) { call.reject("Bluetooth is off."); return; }
        List<BluetoothDevice> devices = new ArrayList<>();
        for (BluetoothDevice device : adapter.getBondedDevices()) {
            if (device.getType() != BluetoothDevice.DEVICE_TYPE_LE) devices.add(device);
        }
        devices.sort((a, b) -> label(a).compareToIgnoreCase(label(b)));
        String[] labels = new String[devices.size() + 1];
        labels[0] = call.getString("bleLabel", "Find Bluetooth LE adapter");
        for (int i = 0; i < devices.size(); i++) labels[i + 1] = label(devices.get(i)) + " (Classic)";
        getActivity().runOnUiThread(() -> new AlertDialog.Builder(getActivity())
                .setTitle(call.getString("title", "Choose OBD2 adapter"))
                .setItems(labels, (dialog, index) -> {
                    JSObject result = new JSObject();
                    if (index == 0) result.put("ble", true);
                    else {
                        BluetoothDevice device = devices.get(index - 1);
                        result.put("deviceId", device.getAddress());
                        result.put("name", label(device));
                    }
                    call.resolve(result);
                })
                .setNegativeButton(android.R.string.cancel, (dialog, which) -> call.reject("Cancelled"))
                .setNeutralButton(call.getString("pairLabel", "Pair a Classic adapter"), (dialog, which) -> {
                    getActivity().startActivity(new Intent(Settings.ACTION_BLUETOOTH_SETTINGS));
                    call.reject("Cancelled");
                })
                .setOnCancelListener(dialog -> call.reject("Cancelled"))
                .show());
    }

    @SuppressLint("MissingPermission")
    private String label(BluetoothDevice device) {
        String name = device.getName();
        return name == null ? device.getAddress() : name;
    }

    @SuppressLint("MissingPermission")
    @PluginMethod
    public void connect(PluginCall call) {
        if (!permitted(call)) return;
        String address = call.getString("deviceId");
        String token = call.getString("connectionId");
        if (address == null || token == null || !BluetoothAdapter.checkBluetoothAddress(address)) {
            call.reject("Invalid Bluetooth adapter address."); return;
        }
        BluetoothAdapter adapter = adapter();
        if (adapter == null || !adapter.isEnabled()) { call.reject("Bluetooth is off."); return; }
        final BluetoothSocket candidate;
        try {
            candidate = adapter.getRemoteDevice(address).createRfcommSocketToServiceRecord(SPP);
        } catch (Exception e) { call.reject("Classic Bluetooth: " + e.getMessage()); return; }
        synchronized (lock) {
            if (socket != null) { close(candidate); call.reject("A Bluetooth connection is already open."); return; }
            socket = candidate;
            connectionId = token;
        }
        ScheduledFuture<?> deadline = timer.schedule(() -> close(candidate), 25, TimeUnit.SECONDS);
        io.execute(() -> {
            try {
                // Discovery slows RFCOMM connection establishment substantially.
                if (Build.VERSION.SDK_INT < 31 || ContextCompat.checkSelfPermission(getContext(),
                        Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED) adapter.cancelDiscovery();
                candidate.connect();
                deadline.cancel(false);
                synchronized (lock) {
                    if (socket != candidate) throw new IOException("Connection cancelled.");
                }
                call.resolve();
                read(candidate, token);
            } catch (Exception e) {
                deadline.cancel(false);
                release(candidate);
                call.reject("Classic Bluetooth connection: " + e.getMessage());
            }
        });
    }

    private void read(BluetoothSocket source, String token) {
        try {
            InputStream input = source.getInputStream();
            byte[] buffer = new byte[1024];
            int count;
            while ((count = input.read(buffer)) != -1) {
                JSObject event = new JSObject();
                event.put("connectionId", token);
                event.put("data", new String(buffer, 0, count, StandardCharsets.US_ASCII));
                notifyListeners("data", event);
            }
        } catch (IOException ignored) {
            // A closed local socket is silent; remote drops notify the scanner below.
        } finally {
            if (release(source)) {
                JSObject event = new JSObject();
                event.put("connectionId", token);
                notifyListeners("disconnected", event);
            }
        }
    }

    @PluginMethod
    public void write(PluginCall call) {
        String token = call.getString("connectionId");
        String data = call.getString("data", "");
        io.execute(() -> {
            try {
                BluetoothSocket current;
                synchronized (lock) {
                    if (socket == null || !connectionId.equals(token)) throw new IOException("Connection closed.");
                    current = socket;
                }
                current.getOutputStream().write(data.getBytes(StandardCharsets.US_ASCII));
                call.resolve();
            } catch (Exception e) { call.reject("Classic Bluetooth write: " + e.getMessage()); }
        });
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        synchronized (lock) {
            if (socket != null && connectionId.equals(call.getString("connectionId"))) {
                BluetoothSocket previous = socket;
                socket = null;
                connectionId = null;
                close(previous);
            }
        }
        call.resolve();
    }

    private boolean release(BluetoothSocket source) {
        boolean active;
        synchronized (lock) {
            active = socket == source;
            if (active) { socket = null; connectionId = null; }
        }
        close(source);
        return active;
    }

    private static void close(BluetoothSocket source) {
        try { source.close(); } catch (IOException ignored) { }
    }

    @Override
    protected void handleOnDestroy() {
        synchronized (lock) {
            if (socket != null) close(socket);
            socket = null;
            connectionId = null;
        }
        io.shutdownNow();
        timer.shutdownNow();
    }
}
