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
import android.os.SystemClock;
import android.widget.RemoteViews;
import org.json.JSONObject;

import androidx.core.app.NotificationCompat;

/**
 * Foreground service that keeps Xpeed running with the screen off while it is
 * linked to the OBD adapter: the persistent notification tells Android the
 * app is doing user-visible work, and a partial wake lock keeps the CPU awake
 * so the web layer can keep polling the car and recording the trip. The wake
 * lock is only held while a trip is recorded or the car is on (the web layer
 * says so); waiting for a parked car, the notification alone keeps the
 * connection alive and the phone can sleep.
 */
public class TripService extends Service {
    static final String CHANNEL_ID = "xpeed_trip";
    static final int NOTIFICATION_ID = 7001;
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_TEXT = "text";
    static final String EXTRA_TRIP = "trip";
    static final String EXTRA_AWAKE = "awake";

    static volatile boolean running = false;
    private static TripService instance;

    private PowerManager.WakeLock wakeLock;

    @Override
    public void onCreate() {
        super.onCreate();
        synchronized (TripService.class) {
            instance = this;
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String title = intent != null ? intent.getStringExtra(EXTRA_TITLE) : null;
        String text = intent != null ? intent.getStringExtra(EXTRA_TEXT) : null;
        boolean awake = intent == null || intent.getBooleanExtra(EXTRA_AWAKE, true);
        try {
            Notification notification = buildNotification(this, title, text, intent != null ? intent.getStringExtra(EXTRA_TRIP) : null);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (RuntimeException e) {
            // Android 14+ refuses a "connected device" service while Bluetooth permission
            // isn't granted (SecurityException), and Android 12+ refuses to start one from the
            // background. Nothing here may crash the app: just don't run the service.
            running = false;
            stopSelf();
            return START_NOT_STICKY;
        }
        running = true;
        applyAwake(awake);
        // If Android kills the app, the web layer that talks to the car is gone
        // too, so there is nothing useful to restart.
        return START_NOT_STICKY;
    }

    /** Hold or release the CPU wake lock. */
    private synchronized void applyAwake(boolean awake) {
        if (awake) {
            if (wakeLock == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "xpeed:trip");
                wakeLock.setReferenceCounted(false);
            }
            if (!wakeLock.isHeld()) wakeLock.acquire();
        } else if (wakeLock != null) {
            if (wakeLock.isHeld()) wakeLock.release();
            wakeLock = null;
        }
    }

    /** Called from the web layer: hold the wake lock only while a trip is recorded or the car is on. */
    static void setAwake(boolean awake) {
        TripService service;
        synchronized (TripService.class) {
            service = instance;
        }
        if (service != null) service.applyAwake(awake);
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
        synchronized (TripService.class) {
            if (instance == this) instance = null;
        }
        applyAwake(false);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /** Change the notification text without restarting the service. */
    static void updateNotification(Context context, String title, String text, String trip) {
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        nm.notify(NOTIFICATION_ID, buildNotification(context, title, text, trip));
    }

    private static Notification buildNotification(Context context, String title, String text, String trip) {
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

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                .setContentTitle(title != null ? title : "Xpeed")
                .setContentText(text != null ? text : "")
                .setContentIntent(tap)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setShowWhen(false);
        if (trip != null) {
            try {
                JSONObject data = new JSONObject(trip);
                if (data.optBoolean("active")) {
                    RemoteViews card = new RemoteViews(context.getPackageName(), R.layout.notification_trip);
                    card.setTextViewText(R.id.trip_vehicle, data.optString("vehicle", "Xpeed"));
                    card.setTextViewText(R.id.trip_status, data.optString("status", ""));
                    card.setTextViewText(R.id.trip_speed, data.optString("speed", "—"));
                    card.setTextViewText(R.id.trip_speed_unit, data.optString("speedUnit", "km/h"));
                    card.setTextViewText(R.id.trip_distance, data.optString("distance", "—"));
                    card.setTextViewText(R.id.trip_distance_unit, data.optString("distanceUnit", "km"));
                    long started = data.optLong("startedAt", 0);
                    long elapsed = Math.max(0, System.currentTimeMillis() - started);
                    card.setChronometer(R.id.trip_time, SystemClock.elapsedRealtime() - elapsed, null, started > 0);
                    builder.setStyle(new NotificationCompat.DecoratedCustomViewStyle())
                            .setCustomBigContentView(card)
                            .setContentTitle(data.optString("vehicle", "Xpeed"))
                            .setContentText(data.optString("speed", "—") + " " + data.optString("speedUnit", "km/h")
                                + " · " + data.optString("distance", "—") + " " + data.optString("distanceUnit", "km"))
                            .setSubText(data.optString("status", ""));
                    if (started > 0) builder.setWhen(started).setShowWhen(true).setUsesChronometer(true);
                }
            } catch (org.json.JSONException ignored) { /* Old clients keep the text notification. */ }
        }
        return builder.build();
    }
}
