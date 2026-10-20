package com.nostr.anagram;

import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;
import static org.junit.Assume.*;

@RunWith(AndroidJUnit4.class)
public final class CallAudioDeviceTest {
    @Test public void microphoneServiceSurvivesScreenOffAndReleasesOnHangup() throws Exception {
        assumeTrue(Build.VERSION.SDK_INT >= 30);
        android.app.Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        android.content.Context context = instrumentation.getTargetContext();
        shell(instrumentation, "pm grant " + context.getPackageName() + " android.permission.RECORD_AUDIO");
        android.os.PowerManager power = context.getSystemService(android.os.PowerManager.class);
        final CallAudioService[] service = new CallAudioService[1];
        java.util.concurrent.CountDownLatch connected = new java.util.concurrent.CountDownLatch(1);
        android.content.ServiceConnection connection = new android.content.ServiceConnection() {
            @Override public void onServiceConnected(android.content.ComponentName name, android.os.IBinder binder) {
                service[0] = ((CallAudioService.CallBinder) binder).getService();
                connected.countDown();
            }
            @Override public void onServiceDisconnected(android.content.ComponentName name) { service[0] = null; }
        };
        android.media.AudioRecord recorder = null;
        boolean bound = false;
        shell(instrumentation, "input keyevent KEYCODE_WAKEUP");
        shell(instrumentation, "wm dismiss-keyguard");
        try (androidx.test.core.app.ActivityScenario<CallAudioTestActivity> activity =
                androidx.test.core.app.ActivityScenario.launch(CallAudioTestActivity.class)) {
            bound = context.bindService(new android.content.Intent(context, CallAudioService.class),
                connection, android.content.Context.BIND_AUTO_CREATE);
            assertTrue(bound);
            assertTrue(connected.await(5, java.util.concurrent.TimeUnit.SECONDS));
            final RuntimeException[] error = new RuntimeException[1];
            instrumentation.runOnMainSync(() -> {
                try { service[0].configure(false); } catch (RuntimeException e) { error[0] = e; }
            });
            if (error[0] != null) throw error[0];
            assertEquals(android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE |
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
                service[0].getForegroundServiceType());
            int minimum = android.media.AudioRecord.getMinBufferSize(16000,
                android.media.AudioFormat.CHANNEL_IN_MONO, android.media.AudioFormat.ENCODING_PCM_16BIT);
            recorder = new android.media.AudioRecord(android.media.MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                16000, android.media.AudioFormat.CHANNEL_IN_MONO,
                android.media.AudioFormat.ENCODING_PCM_16BIT, Math.max(minimum * 2, 6400));
            assertEquals(android.media.AudioRecord.STATE_INITIALIZED, recorder.getState());
            recorder.startRecording();
            shell(instrumentation, "input keyevent KEYCODE_SLEEP");
            long deadline = System.currentTimeMillis() + 5000;
            while (power.isInteractive() && System.currentTimeMillis() < deadline) Thread.sleep(50);
            assertFalse("Device must actually be screen-off", power.isInteractive());
            // Check multiple buffers so a pre-lock buffer cannot mask silenced capture.
            short[] samples = new short[1600];
            for (int i = 0; i < 30; i++) {
                assertTrue("Microphone stopped delivering frames", recorder.read(samples, 0, samples.length) > 0);
                android.media.AudioRecordingConfiguration recording = recorder.getActiveRecordingConfiguration();
                assertNotNull(recording);
                assertFalse("Android silenced background microphone", recording.isClientSilenced());
            }
            assertTrue(service[0].isActive());
            recorder.stop();
            recorder.release();
            recorder = null;
            instrumentation.runOnMainSync(() -> service[0].release());
            assertFalse(service[0].isActive());
            android.app.NotificationManager notifications = context.getSystemService(android.app.NotificationManager.class);
            // stopForeground queues notification removal in Android's system process.
            long notificationDeadline = android.os.SystemClock.elapsedRealtime() + 5000;
            while (java.util.Arrays.stream(notifications.getActiveNotifications())
                    .anyMatch(n -> n.getId() == CallAudioService.NOTIFICATION_ID)
                    && android.os.SystemClock.elapsedRealtime() < notificationDeadline) {
                Thread.sleep(50);
            }
            assertFalse("Call notification remained after hangup for 5 seconds",
                java.util.Arrays.stream(notifications.getActiveNotifications())
                .anyMatch(n -> n.getId() == CallAudioService.NOTIFICATION_ID));
        } finally {
            if (recorder != null) { recorder.stop(); recorder.release(); }
            if (service[0] != null) instrumentation.runOnMainSync(() -> service[0].release());
            if (bound) context.unbindService(connection);
            shell(instrumentation, "input keyevent KEYCODE_WAKEUP");
            shell(instrumentation, "wm dismiss-keyguard");
        }
    }
    private static void shell(android.app.Instrumentation instrumentation, String command) throws Exception {
        try (android.os.ParcelFileDescriptor descriptor = instrumentation.getUiAutomation().executeShellCommand(command);
             java.io.FileInputStream output = new java.io.FileInputStream(descriptor.getFileDescriptor())) {
            byte[] buffer = new byte[1024];
            while (output.read(buffer) != -1) { /* wait for command completion */ }
        }
    }
    @Test public void defaultsToReceiverWhenPresentAndRestoresRoutingAfterHangup() throws Exception {
        assumeTrue(Build.VERSION.SDK_INT >= 31);
        android.app.Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        AudioManager audio = instrumentation.getTargetContext().getSystemService(AudioManager.class);
        // Generic emulators/tablets may expose only a loudspeaker. Report that
        // case explicitly; passing there is not physical receiver validation.
        boolean receiver = audio.getAvailableCommunicationDevices().stream()
            .anyMatch(d -> d.getType() == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE);
        int defaultOutput = receiver ? AudioDeviceInfo.TYPE_BUILTIN_EARPIECE : AudioDeviceInfo.TYPE_BUILTIN_SPEAKER;
        System.out.println("Call audio receiver available: " + receiver);
        final PhoneCallAudio[] routing = new PhoneCallAudio[1];
        int previousMode = audio.getMode();
        // This tests AudioManager directly. WebView rendering/IPC is validated separately.
        instrumentation.runOnMainSync(() -> routing[0] = new PhoneCallAudio(instrumentation.getTargetContext()));
        try {
                // WebView capture may already have requested communication mode
                // before the call acquires its native route. Hangup must release it.
                instrumentation.runOnMainSync(() -> audio.setMode(AudioManager.MODE_IN_COMMUNICATION));
                instrumentation.runOnMainSync(() -> routing[0].configure(true, false));
                waitForDevice(audio, defaultOutput);
                instrumentation.runOnMainSync(() -> routing[0].configure(true, true));
                waitForDevice(audio, AudioDeviceInfo.TYPE_BUILTIN_SPEAKER);
                instrumentation.runOnMainSync(() -> routing[0].configure(true, false));
                waitForDevice(audio, defaultOutput);
                instrumentation.runOnMainSync(() -> routing[0].close());
                long deadline = System.currentTimeMillis() + 5000;
                while (audio.getMode() != previousMode && System.currentTimeMillis() < deadline) Thread.sleep(50);
                assertEquals(previousMode, audio.getMode());
                // A previous loudspeaker choice must not carry into the next call.
                instrumentation.runOnMainSync(() -> routing[0].configure(true, false));
                waitForDevice(audio, defaultOutput);
        } finally { instrumentation.runOnMainSync(() -> routing[0].close()); }
    }
    private void waitForDevice(AudioManager audio, int type) throws Exception {
        long deadline = System.currentTimeMillis() + 5000;
        while (System.currentTimeMillis() < deadline) {
            AudioDeviceInfo device = audio.getCommunicationDevice();
            if (device != null && device.getType() == type && audio.getMode() == AudioManager.MODE_IN_COMMUNICATION) return;
            Thread.sleep(50);
        }
        fail("Call output did not reach device type " + type);
    }
}
