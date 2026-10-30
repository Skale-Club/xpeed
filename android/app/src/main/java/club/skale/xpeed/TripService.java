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
import android.view.View;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.style.RelativeSizeSpan;
import org.json.JSONObject;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            String name = context.getString(R.string.notification_channel);
            NotificationChannel channel = nm.getNotificationChannel(CHANNEL_ID);
            if (channel == null || !name.contentEquals(channel.getName())) {
                if (channel == null) channel = new NotificationChannel(CHANNEL_ID, name, NotificationManager.IMPORTANCE_LOW);
                channel.setName(name);
                channel.setDescription(context.getString(R.string.notification_channel_description));
                channel.setShowBadge(false);
                nm.createNotificationChannel(channel);
            }
        }

        Intent open = new Intent(context, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent tap = PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_xpeed)
                .setColor(ContextCompat.getColor(context, R.color.notification_accent))
                .setColorized(false)
                .setContentTitle(title != null ? title : "Xpeed")
                .setContentText(text != null ? text : "")
                .setContentIntent(tap)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setShowWhen(false);
        if (trip != null) {
            try {
                JSONObject data = new JSONObject(trip);
                String vehicle = field(data, "vehicle", "Xpeed");
                String status = field(data, "status", text != null ? text : "");
                builder.setContentTitle(vehicle).setContentText(status);
                if (data.optBoolean("active")) {
                    // Android owns the surrounding surface, app header and expand control.
                    // The compact content fits 48 dp; expanded content adds readable metrics.
                    RemoteViews compact = tripCard(context, data, true);
                    RemoteViews expanded = tripCard(context, data, false);
                    builder.setStyle(new NotificationCompat.DecoratedCustomViewStyle())
                            .setCustomContentView(compact)
                            .setCustomBigContentView(expanded)
                            .setContentText(field(data, "speed", "—") + " " + field(data, "speedUnit", "km/h")
                                    + " · " + field(data, "distance", "—") + " " + field(data, "distanceUnit", "km"))
                            .addAction(R.drawable.ic_stat_xpeed, field(data, "openLabel", context.getString(R.string.notification_open)), tap);
                }
            } catch (org.json.JSONException ignored) { /* Old clients keep a standard text notification. */ }
        }
        return builder.build();
    }

    private static String field(JSONObject data, String name, String fallback) {
        String value = data.optString(name, fallback);
        return value.trim().isEmpty() ? fallback : value;
    }

    private static CharSequence compactMetric(String value, String unit) {
        SpannableString metric = new SpannableString(value + " " + unit);
        metric.setSpan(new RelativeSizeSpan(0.6f), value.length() + 1, metric.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        return metric;
    }

    private static RemoteViews tripCard(Context context, JSONObject data, boolean compact) {
        RemoteViews card = new RemoteViews(context.getPackageName(), compact ? R.layout.notification_trip_compact : R.layout.notification_trip);
        String speed = field(data, "speed", "—"), speedUnit = field(data, "speedUnit", "km/h");
        String distance = field(data, "distance", "—"), distanceUnit = field(data, "distanceUnit", "km");
        String state = field(data, "state", "recording");
        String status = field(data, "status", context.getString(R.string.notification_recording));
        int color = ContextCompat.getColor(context, "recording".equals(state) ? R.color.notification_recording : R.color.notification_waiting);
        card.setTextViewText(R.id.trip_vehicle, field(data, "vehicle", "Xpeed"));
        card.setTextViewText(R.id.trip_status, status);
        card.setTextColor(R.id.trip_status, color);
        card.setImageViewResource(R.id.trip_status_dot, "recording".equals(state)
                ? R.drawable.notification_status_dot : R.drawable.notification_waiting_dot);
        card.setContentDescription(R.id.trip_status, status);
        card.setTextViewText(R.id.trip_speed, compact ? compactMetric(speed, speedUnit) : speed);
        card.setTextViewText(R.id.trip_distance, compact ? compactMetric(distance, distanceUnit) : distance);
        if (!compact) {
            card.setTextViewText(R.id.trip_speed_unit, speedUnit);
            card.setTextViewText(R.id.trip_distance_unit, distanceUnit);
            card.setTextViewText(R.id.trip_time_label, field(data, "timeLabel", context.getString(R.string.notification_time)));
            boolean hasMotion = data.has("accelerationLabel");
            card.setViewVisibility(R.id.trip_motion, hasMotion ? View.VISIBLE : View.GONE);
            if (hasMotion) {
                double acceleration = data.optDouble("acceleration", Double.NaN);
                int motionColor = ContextCompat.getColor(context,
                        !Double.isFinite(acceleration) || Math.abs(acceleration) <= 0.15 ? R.color.notification_motion_neutral
                        : acceleration > 0 ? R.color.notification_acceleration : R.color.notification_waiting);
                card.setTextViewText(R.id.trip_acceleration_label, field(data, "accelerationLabel", ""));
                card.setTextColor(R.id.trip_acceleration_label, motionColor);
                card.setImageViewBitmap(R.id.trip_acceleration_bar, motionBar(context, acceleration, motionColor));
            }
        }
        long started = data.optLong("startedAt", 0);
        long elapsed = started > 0 ? Math.max(0, System.currentTimeMillis() - started) : 0;
        card.setChronometer(R.id.trip_time, SystemClock.elapsedRealtime() - elapsed, null, started > 0);
        return card;
    }

    /** A meter of measured speed change, not an animated or invented waveform. */
    private static Bitmap motionBar(Context context, double acceleration, int color) {
        final int width = 720, height = 48, bars = 32;
        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        int active = Double.isFinite(acceleration) && Math.abs(acceleration) > 0.15
                ? Math.max(1, (int) Math.ceil(Math.min(1, Math.abs(acceleration) / 3.0) * bars)) : 0;
        int track = ContextCompat.getColor(context, R.color.notification_motion_track);
        float gap = 5f, barWidth = (width - gap * (bars - 1)) / bars;
        for (int i = 0; i < bars; i++) {
            float barHeight = 12f + 34f * i / (bars - 1);
            float left = i * (barWidth + gap);
            paint.setColor(i < active ? color : track);
            canvas.drawRoundRect(left, height - barHeight, left + barWidth, height, 2.5f, 2.5f, paint);
        }
        return bitmap;
    }
}
