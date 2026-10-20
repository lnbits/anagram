package com.nostr.anagram

import android.app.Activity
import android.content.Context
import android.content.ComponentName
import android.content.Intent
import android.content.ServiceConnection
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.IBinder
import android.view.WindowManager
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class CallAudioArgs { var active: Boolean = false; var speaker: Boolean = false }

// Own the communication route only while a call owns captured media. All methods
// and device callbacks run on the main thread; reconnects keep the same route.
@Suppress("DEPRECATION")
class PhoneCallAudio(context: Context) {
    private val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val handler = Handler(Looper.getMainLooper())
    private var active = false
    private var speaker = false
    private var previousSpeaker = false
    private var startedSco = false
    private val devices = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(added: Array<AudioDeviceInfo>) = refresh()
        override fun onAudioDevicesRemoved(removed: Array<AudioDeviceInfo>) = refresh()
    }
    private var routeListener: AudioManager.OnCommunicationDeviceChangedListener? = null
    private fun external(device: AudioDeviceInfo): Boolean = when (device.type) {
        AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
        AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_DEVICE,
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET,
        AudioDeviceInfo.TYPE_HEARING_AID -> true
        else -> false
    }
    private fun refresh() {
        if (active) try { applyRoute() } catch (_: RuntimeException) {
            // A disconnect may race device discovery. The next device callback
            // retries; never substitute loudspeaker on a phone after a failure.
        }
    }
    private fun applyRoute() {
        if (audio.mode != AudioManager.MODE_IN_COMMUNICATION) audio.mode = AudioManager.MODE_IN_COMMUNICATION
        if (Build.VERSION.SDK_INT >= 31) {
            val available = audio.availableCommunicationDevices
            val current = audio.communicationDevice
            val target = if (speaker) available.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
                else current?.takeIf { external(it) && available.any { d -> d.id == it.id } }
                    ?: available.firstOrNull { external(it) }
                    ?: available.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE }
                    // Tablets do not have a receiver.
                    ?: available.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
            check(target != null) { "No call output device" }
            if (current?.id != target.id) check(audio.setCommunicationDevice(target)) { "Call output unavailable" }
        } else {
            audio.isSpeakerphoneOn = speaker
            val outputs = audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
            val wired = outputs.any { external(it) && it.type != AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
            val headset = !wired && outputs.any { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
            if (!speaker && headset && !audio.isBluetoothScoOn && !startedSco) {
                audio.startBluetoothSco(); audio.isBluetoothScoOn = true; startedSco = true
            } else if ((speaker || !headset) && startedSco) {
                audio.stopBluetoothSco(); audio.isBluetoothScoOn = false; startedSco = false
            }
        }
    }
    fun configure(enabled: Boolean, loudspeaker: Boolean) {
        check(Looper.myLooper() == Looper.getMainLooper())
        if (!enabled) { close(); return }
        if (!active) {
            previousSpeaker = audio.isSpeakerphoneOn
            active = true
            audio.registerAudioDeviceCallback(devices, handler)
            if (Build.VERSION.SDK_INT >= 31) {
                val listener = AudioManager.OnCommunicationDeviceChangedListener { refresh() }
                routeListener = listener
                audio.addOnCommunicationDeviceChangedListener({ task -> handler.post(task) }, listener)
            }
        }
        val previous = speaker
        speaker = loudspeaker
        try { applyRoute() } catch (error: RuntimeException) { speaker = previous; throw error }
    }
    fun close() {
        if (!active) return
        active = false
        audio.unregisterAudioDeviceCallback(devices)
        if (Build.VERSION.SDK_INT >= 31) {
            routeListener?.let { audio.removeOnCommunicationDeviceChangedListener(it) }
            routeListener = null
            audio.clearCommunicationDevice()
        } else {
            if (startedSco) { audio.stopBluetoothSco(); audio.isBluetoothScoOn = false }
            audio.isSpeakerphoneOn = previousSpeaker
        }
        startedSco = false
        // MODE_NORMAL removes this process's mode request. Restoring the global
        // mode read after WebView capture could leave our own call mode latched.
        // Android preserves requests from other apps (including cellular calls).
        audio.mode = AudioManager.MODE_NORMAL
        speaker = false
    }
}

@TauriPlugin
class CallAudioPlugin(private val activity: Activity) : Plugin(activity) {
    private var service: CallAudioService? = null
    private var binding: ServiceConnection? = null
    private var pending: Invoke? = null
    private var keptScreenOn = false
    private val handler = Handler(Looper.getMainLooper())
    private val timeout = Runnable { close(); }

    private fun close() {
        handler.removeCallbacks(timeout)
        pending?.reject("Call audio service stopped")
        pending = null
        (activity as? MainActivity)?.keepCallAudioRunning(false)
        try { service?.release() } finally {
            service = null
            binding?.let {
                try { activity.unbindService(it) } catch (_: IllegalArgumentException) { /* already disconnected */ }
            }
            binding = null
            if (keptScreenOn) activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            keptScreenOn = false
        }
    }
    private fun configureService(invoke: Invoke, speaker: Boolean) {
        try {
            service!!.configure(speaker)
            (activity as? MainActivity)?.keepCallAudioRunning(true)
            if (activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON == 0) {
                activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                keptScreenOn = true
            }
            invoke.resolve()
        } catch (_: RuntimeException) {
            if (service?.isActive != true) close()
            invoke.reject("Call audio service unavailable")
        }
    }
    @Command
    fun configure(invoke: Invoke) {
        val args = invoke.parseArgs(CallAudioArgs::class.java)
        activity.runOnUiThread {
            if (!args.active) { close(); invoke.resolve(); return@runOnUiThread }
            if (service != null) { configureService(invoke, args.speaker); return@runOnUiThread }
            if (binding != null) { invoke.reject("Call audio service is starting"); return@runOnUiThread }
            val connection = object : ServiceConnection {
                override fun onServiceConnected(name: ComponentName, binder: IBinder) {
                    if (binding !== this) return
                    handler.removeCallbacks(timeout)
                    val request = pending ?: return
                    pending = null
                    service = (binder as CallAudioService.CallBinder).service
                    configureService(request, args.speaker)
                }
                override fun onServiceDisconnected(name: ComponentName) { if (binding === this) close() }
                override fun onBindingDied(name: ComponentName) { if (binding === this) close() }
                override fun onNullBinding(name: ComponentName) { if (binding === this) close() }
            }
            pending = invoke
            try {
                if (!activity.bindService(Intent(activity, CallAudioService::class.java), connection, Context.BIND_AUTO_CREATE)) {
                    pending = null
                    invoke.reject("Call audio service unavailable")
                    return@runOnUiThread
                }
                binding = connection
                handler.postDelayed(timeout, 5000)
            } catch (_: RuntimeException) {
                pending = null
                invoke.reject("Call audio service unavailable")
            }
        }
    }
    override fun onDestroy(activity: AppCompatActivity) { close() }
}
