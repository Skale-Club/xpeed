package club.skale.xpeed;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;

/**
 * Foreground service that keeps Xpeed running with the screen off while it is
 * linked to the OBD adapter: the persistent notification tells Android the
 * app is doing user-visible work, and a partial wake lock keeps the CPU awake
 * so the web layer can keep polling the car and recording the trip.
 */
public class TripService extends Service {
    static final String CHANNEL_ID = "xpeed_trip";
    static final int NOTIFICATION_ID = 7001;
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_TEXT = "text";

    static volatile boolean running = false;

    private PowerManager.WakeLock wakeLock;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String title = intent != null ? intent.getStringExtra(EXTRA_TITLE) : null;
        String text = intent != null ? intent.getStringExtra(EXTRA_TEXT) : null;
        Notification notification = buildNotification(this, title, text);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        running = true;

        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "xpeed:trip");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire();
        }
        // If Android kills the app, the web layer that talks to the car is gone
        // too, so there is nothing useful to restart.
        return START_NOT_STICKY;
    }

    /**
     * The user swiped Xpeed away: the web layer that talks to the car is gone,
     * so drop the notification and the wake lock instead of keeping them forever.
     */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        running = false;
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /** Change the notification text without restarting the service. */
    static void updateNotification(Context context, String title, String text) {
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        nm.notify(NOTIFICATION_ID, buildNotification(context, title, text));
    }

    private static Notification buildNotification(Context context, String title, String text) {
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Xpeed", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Connection to your car");
            channel.setShowBadge(false);
            nm.createNotificationChannel(channel);
        }

        Intent open = new Intent(context, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent tap = PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        return new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                .setContentTitle(title != null ? title : "Xpeed")
                .setContentText(text != null ? text : "")
                .setContentIntent(tap)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .build();
    }
}
