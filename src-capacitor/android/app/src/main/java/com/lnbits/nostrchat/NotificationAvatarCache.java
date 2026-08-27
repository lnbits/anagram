package com.lnbits.nostrchat;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

final class NotificationAvatarCache {

    private static final String CACHE_DIRECTORY_NAME = "notification-avatars";
    private static final int AVATAR_SIZE_PX = 128;
    private static final int MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;
    private static final int[] FALLBACK_COLORS = {
        Color.rgb(214, 85, 99),
        Color.rgb(217, 119, 6),
        Color.rgb(124, 58, 237),
        Color.rgb(37, 99, 235),
        Color.rgb(15, 118, 110),
        Color.rgb(79, 70, 229),
        Color.rgb(219, 39, 119),
        Color.rgb(5, 150, 105),
        Color.rgb(2, 132, 199),
        Color.rgb(194, 65, 12),
        Color.rgb(71, 85, 105),
        Color.rgb(180, 83, 9),
    };
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();
    private static final OkHttpClient HTTP_CLIENT = new OkHttpClient.Builder()
        .connectTimeout(10L, TimeUnit.SECONDS)
        .readTimeout(15L, TimeUnit.SECONDS)
        .followRedirects(true)
        .build();

    private NotificationAvatarCache() {}

    static void refreshAsync(Context context, List<NotificationConversation> conversations) {
        Context appContext = context.getApplicationContext();
        EXECUTOR.execute(() -> refresh(appContext, conversations));
    }

    static Bitmap load(Context context, NotificationConversation conversation) {
        File avatarFile = avatarFile(context, conversation);
        Bitmap cached = BitmapFactory.decodeFile(avatarFile.getAbsolutePath());
        if (cached != null) {
            return cached;
        }
        return createFallback(conversation.name, conversation.avatarText);
    }

    static void clear(Context context) {
        File directory = cacheDirectory(context);
        File[] files = directory.listFiles();
        if (files == null) {
            return;
        }
        for (File file : files) {
            if (file.isFile()) {
                file.delete();
            }
        }
    }

    private static void refresh(Context context, List<NotificationConversation> conversations) {
        File directory = cacheDirectory(context);
        Set<String> retainedNames = new HashSet<>();
        for (NotificationConversation conversation : conversations) {
            String url = conversation.avatarUrl.trim();
            if (url.isEmpty() || (!url.startsWith("https://") && !url.startsWith("http://"))) {
                continue;
            }
            File target = avatarFile(context, conversation);
            retainedNames.add(target.getName());
            if (target.isFile() && target.length() > 0L) {
                continue;
            }
            downloadAvatar(url, target);
        }

        File[] existing = directory.listFiles();
        if (existing == null) {
            return;
        }
        for (File file : existing) {
            if (file.isFile() && !retainedNames.contains(file.getName())) {
                file.delete();
            }
        }
    }

    private static void downloadAvatar(String url, File target) {
        Request request;
        try {
            request = new Request.Builder().url(url).get().build();
        } catch (IllegalArgumentException exception) {
            target.delete();
            return;
        }

        try (Response response = HTTP_CLIENT.newCall(request).execute()) {
            ResponseBody body = response.body();
            if (!response.isSuccessful() || body == null || body.contentLength() > MAX_DOWNLOAD_BYTES) {
                return;
            }
            byte[] bytes = readBounded(body.byteStream());
            Bitmap decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            if (decoded == null) {
                return;
            }
            Bitmap scaled = Bitmap.createScaledBitmap(decoded, AVATAR_SIZE_PX, AVATAR_SIZE_PX, true);
            if (scaled != decoded) {
                decoded.recycle();
            }
            File temporary = new File(target.getParentFile(), target.getName() + ".tmp");
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                if (!scaled.compress(Bitmap.CompressFormat.PNG, 100, output)) {
                    temporary.delete();
                    return;
                }
            } finally {
                scaled.recycle();
            }
            if (!temporary.renameTo(target)) {
                temporary.delete();
            }
        } catch (IOException ignored) {}
    }

    private static byte[] readBounded(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int total = 0;
        int read;
        while ((read = input.read(buffer)) != -1) {
            total += read;
            if (total > MAX_DOWNLOAD_BYTES) {
                throw new IOException("Avatar exceeds download limit.");
            }
            output.write(buffer, 0, read);
        }
        return output.toByteArray();
    }

    private static Bitmap createFallback(String name, String avatarText) {
        Bitmap bitmap = Bitmap.createBitmap(AVATAR_SIZE_PX, AVATAR_SIZE_PX, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        int colorIndex = Math.floorMod(name.toLowerCase(Locale.ROOT).hashCode(), FALLBACK_COLORS.length);
        paint.setColor(FALLBACK_COLORS[colorIndex]);
        canvas.drawCircle(AVATAR_SIZE_PX / 2f, AVATAR_SIZE_PX / 2f, AVATAR_SIZE_PX / 2f, paint);

        paint.setColor(Color.WHITE);
        paint.setTextAlign(Paint.Align.CENTER);
        paint.setTextSize(AVATAR_SIZE_PX * 0.38f);
        paint.setFakeBoldText(true);
        String label = avatarText.trim().toUpperCase(Locale.ROOT);
        if (label.isEmpty()) {
            label = "NC";
        }
        Paint.FontMetrics metrics = paint.getFontMetrics();
        float baseline = (AVATAR_SIZE_PX - metrics.bottom - metrics.top) / 2f;
        canvas.drawText(label, AVATAR_SIZE_PX / 2f, baseline, paint);
        return bitmap;
    }

    private static File avatarFile(Context context, NotificationConversation conversation) {
        return new File(
            cacheDirectory(context),
            shortHash(conversation.chatPubkey + "\n" + conversation.avatarUrl) + ".png"
        );
    }

    private static File cacheDirectory(Context context) {
        File directory = new File(context.getCacheDir(), CACHE_DIRECTORY_NAME);
        if (!directory.exists()) {
            directory.mkdirs();
        }
        return directory;
    }

    private static String shortHash(String value) {
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(
                value.getBytes(StandardCharsets.UTF_8)
            );
            StringBuilder result = new StringBuilder(32);
            for (int index = 0; index < 16; index += 1) {
                result.append(String.format(Locale.ROOT, "%02x", hash[index] & 0xff));
            }
            return result.toString();
        } catch (NoSuchAlgorithmException exception) {
            return Integer.toHexString(value.hashCode());
        }
    }
}
