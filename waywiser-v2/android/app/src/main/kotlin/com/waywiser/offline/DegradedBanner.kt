package com.waywiser.offline

import androidx.compose.animation.*
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.waywiser.WaywiserApplication

/**
 * Banner displayed when inference is unavailable (offline or degraded).
 * Shows clearly what still works and what doesn't (blueprint §67).
 */
@Composable
fun DegradedBanner() {
    val monitor = remember { WaywiserApplication.instance.connectivityMonitor }
    val inferenceStatus by monitor.inferenceStatus.collectAsStateWithLifecycle()
    val networkStatus by monitor.networkStatus.collectAsStateWithLifecycle()

    AnimatedVisibility(
        visible = inferenceStatus != ConnectivityMonitor.InferenceStatus.AVAILABLE,
        enter = slideInVertically() + fadeIn(),
        exit = slideOutVertically() + fadeOut(),
    ) {
        val (text, color) = when {
            networkStatus == ConnectivityMonitor.NetworkStatus.DISCONNECTED ->
                "Offline — capture and memory available, conversation paused" to
                    MaterialTheme.colorScheme.errorContainer

            inferenceStatus == ConnectivityMonitor.InferenceStatus.DEGRADED ->
                "Inference degraded — responses may be slow" to
                    MaterialTheme.colorScheme.tertiaryContainer

            else ->
                "Inference unavailable — capture and memory available" to
                    MaterialTheme.colorScheme.errorContainer
        }

        Surface(
            color = color,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Row(
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                // Icon(Icons.Default.CloudOff, contentDescription = null, modifier = Modifier.size(16.dp))
                Text(
                    text = text,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
}
