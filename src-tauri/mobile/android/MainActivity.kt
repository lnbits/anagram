package com.nostr.anagram

import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var callWebView: WebView? = null
  private var callAudioActive = false
  private var paused = false

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    callWebView = webView
  }

  fun keepCallAudioRunning(active: Boolean) {
    callAudioActive = active
    if (paused) {
      if (active) callWebView?.onResume() else callWebView?.onPause()
    }
  }

  override fun onPause() {
    super.onPause()
    paused = true
    // Wry pauses the WebView in super.onPause(). The foreground microphone
    // service grants background capture, but the worklet must keep running too.
    if (callAudioActive) callWebView?.onResume()
  }

  override fun onResume() {
    paused = false
    super.onResume()
  }

  override fun onDestroy() {
    callWebView = null
    super.onDestroy()
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // Inset the whole WebView so every screen and dialog clears system bars,
    // including older WebViews that do not expose CSS safe-area insets.
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, windowInsets ->
      val types = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      val bars = windowInsets.getInsets(types)
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      // These insets are handled here; keep keyboard updates reaching WebView.
      WindowInsetsCompat.Builder(windowInsets)
        .setInsets(types, Insets.NONE)
        .build()
    }
    ViewCompat.requestApplyInsets(content)
  }
}
