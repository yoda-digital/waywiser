package com.waywiser.capture

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import com.waywiser.WaywiserApplication
import kotlinx.coroutines.launch

/**
 * Receives content shared from other apps via the Android share sheet.
 * Registered in AndroidManifest for text/* and image/* MIME types.
 *
 * Translucent activity — captures and finishes immediately.
 */
class ShareActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val shareIntent = intent ?: run { finish(); return }
        val captureManager = CaptureManager(WaywiserApplication.instance.repository)

        lifecycleScope.launch {
            captureManager.capture(CaptureManager.CaptureSource.ShareSheet(shareIntent))
            finish()
        }
    }
}
