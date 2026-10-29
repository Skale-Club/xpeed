package club.skale.xpeed;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/** JS bridge for TripService: start / update / stop the background service. */
@CapacitorPlugin(
        name = "TripService",
        permissions = { @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications") }
)
public class TripServicePlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        // Android 13+ hides the notification unless allowed; ask once, start either way.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "afterNotificationPermission");
            return;
        }
        startService(call);
    }

    @PermissionCallback
    private void afterNotificationPermission(PluginCall call) {
        startService(call);
    }

    private void startService(PluginCall call) {
        Context context = getContext();
        String title = call.getString("title", "Xpeed");
        String text = call.getString("text", "");
        boolean awake = Boolean.TRUE.equals(call.getBoolean("awake", true));
        if (TripService.running) {
            TripService.updateNotification(context, title, text, call.getObject("trip") != null ? call.getObject("trip").toString() : null);
            TripService.setAwake(awake);
            call.resolve();
            return;
        }
        // Android 14+ only lets a "connected device" service start once Bluetooth
        // permission is granted; asking for it first is the connection's job. Without
        // it startForeground() would throw inside the service.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE
                && ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
            call.reject("Bluetooth permission is not granted yet.");
            return;
        }
        Intent intent = new Intent(context, TripService.class)
                .putExtra(TripService.EXTRA_TITLE, title)
                .putExtra(TripService.EXTRA_TEXT, text)
                .putExtra(TripService.EXTRA_AWAKE, awake)
                .putExtra(TripService.EXTRA_TRIP, call.getObject("trip") != null ? call.getObject("trip").toString() : null);
        try {
            ContextCompat.startForegroundService(context, intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not start the background service: " + e.getMessage());
        }
    }

    @PluginMethod
    public void update(PluginCall call) {
        // If the service isn't running (it refused to start, or Android stopped it),
        // this starts it again instead of silently doing nothing.
        startService(call);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context context = getContext();
        // stopService() is asynchronous: mark it stopped now so a start right
        // after this really starts it again instead of only updating the notification.
        TripService.running = false;
        context.stopService(new Intent(context, TripService.class));
        call.resolve();
    }
}
