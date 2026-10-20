package com.nostr.anagram

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.Build
import android.os.PowerManager
import androidx.core.app.NotificationCompat

// Bound by the call plugin after microphone permission is granted. There is no
// boot/start-sticky path: losing the call owner must also release its resources.
class CallAudioService : Service() {
    inner class CallBinder : Binder() { val service get() = this@CallAudioService }
    private val binder = CallBinder()
    private lateinit var routing: PhoneCallAudio
    private var wakeLock: PowerManager.WakeLock? = null
    private var active = false
    val isActive get() = active

    override fun onCreate() {
        super.onCreate()
        routing = PhoneCallAudio(this)
    }
    override fun onBind(intent: Intent) = binder

    fun configure(speaker: Boolean) {
        val starting = !active
        try {
            if (!active) {
                if (Build.VERSION.SDK_INT >= 26) {
                    getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(
                        CHANNEL, "Active calls", NotificationManager.IMPORTANCE_LOW
                    ))
                }
                val open = PendingIntent.getActivity(this, 0,
                    Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                val notification = NotificationCompat.Builder(this, CHANNEL)
                    .setSmallIcon(android.R.drawable.stat_sys_phone_call)
                    .setContentTitle("Anagram call")
                    .setContentText("Call in progress. Tap to return to the call.")
                    .setContentIntent(open)
                    .setCategory(NotificationCompat.CATEGORY_CALL)
                    .setOngoing(true).setSilent(true)
                    .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                    .build()
                if (Build.VERSION.SDK_INT >= 30) {
                    startForeground(NOTIFICATION_ID, notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
                            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
                } else startForeground(NOTIFICATION_ID, notification)
                active = true
                // Keep packet processing/networking scheduled with the screen off.
                // The binding and onDestroy bound this lock to the active call.
                wakeLock = getSystemService(PowerManager::class.java)
                    .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Anagram:CallAudio")
                    .also { it.acquire() }
            }
            routing.configure(true, speaker)
        } catch (error: RuntimeException) {
            if (starting) release()
            throw error
        }
    }

    fun release() {
        try { routing.close() } catch (_: RuntimeException) {
            // Device removal or permission changes must not prevent cleanup.
        } finally {
            wakeLock?.let { if (it.isHeld) it.release() }
            wakeLock = null
            if (active) stopForeground(STOP_FOREGROUND_REMOVE)
            active = false
        }
    }
    override fun onUnbind(intent: Intent): Boolean { release(); return false }
    override fun onDestroy() { release(); super.onDestroy() }

    companion object {
        const val CHANNEL = "anagram-active-call"
        const val NOTIFICATION_ID = 7314
    }
}
