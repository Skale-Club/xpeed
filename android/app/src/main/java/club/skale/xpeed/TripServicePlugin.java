package club.skale.xpeed;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
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
        if (TripService.running) {
            TripService.updateNotification(context, title, text);
            call.resolve();
            return;
        }
        Intent intent = new Intent(context, TripService.class)
                .putExtra(TripService.EXTRA_TITLE, title)
                .putExtra(TripService.EXTRA_TEXT, text);
        try {
            ContextCompat.startForegroundService(context, intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not start the background service: " + e.getMessage());
        }
    }

    @PluginMethod
    public void update(PluginCall call) {
        if (TripService.running) {
            TripService.updateNotification(getContext(), call.getString("title", "Xpeed"), call.getString("text", ""));
        }
        call.resolve();
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
