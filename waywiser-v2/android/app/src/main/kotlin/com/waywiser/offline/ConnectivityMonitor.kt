package com.waywiser.offline

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.util.Log
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Monitors network connectivity and inference endpoint health.
 *
 * When the inference endpoint is unavailable, capabilities are
 * degraded according to the OfflineManager rules (§67):
 *
 * Available offline: capture, local memory, lexical recall,
 * cached calendar, deterministic automations, work state, Activity Ledger
 *
 * Unavailable offline: deliberative conversation, Brain Pass 2,
 * skill compilation, research, VLM reasoning, new LLM-generated plans
 */
class ConnectivityMonitor(context: Context) {

    enum class NetworkStatus { CONNECTED, DISCONNECTED }
    enum class InferenceStatus { AVAILABLE, DEGRADED, UNAVAILABLE }

    private val _networkStatus = MutableStateFlow(NetworkStatus.DISCONNECTED)
    val networkStatus: StateFlow<NetworkStatus> = _networkStatus.asStateFlow()

    private val _inferenceStatus = MutableStateFlow(InferenceStatus.UNAVAILABLE)
    val inferenceStatus: StateFlow<InferenceStatus> = _inferenceStatus.asStateFlow()

    private val connectivityManager =
        context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    private var healthCheckJob: Job? = null
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    init {
        registerNetworkCallback()
        startHealthCheck()
    }

    private fun registerNetworkCallback() {
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()

        connectivityManager.registerNetworkCallback(request, object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                _networkStatus.value = NetworkStatus.CONNECTED
                Log.d(TAG, "Network available")
            }

            override fun onLost(network: Network) {
                _networkStatus.value = NetworkStatus.DISCONNECTED
                _inferenceStatus.value = InferenceStatus.UNAVAILABLE
                Log.d(TAG, "Network lost")
            }
        })

        // Check initial state
        val activeNetwork = connectivityManager.activeNetwork
        val capabilities = activeNetwork?.let { connectivityManager.getNetworkCapabilities(it) }
        _networkStatus.value = if (capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true) {
            NetworkStatus.CONNECTED
        } else {
            NetworkStatus.DISCONNECTED
        }
    }

    private fun startHealthCheck() {
        healthCheckJob = scope.launch {
            while (isActive) {
                if (_networkStatus.value == NetworkStatus.CONNECTED) {
                    checkInferenceHealth()
                }
                // Poll every 30s when degraded, 60s when healthy
                val interval = if (_inferenceStatus.value == InferenceStatus.DEGRADED) 30_000L else 60_000L
                delay(interval)
            }
        }
    }

    private suspend fun checkInferenceHealth() {
        // TODO: Ping the inference endpoint's health check
        // val response = httpClient.get("${inferenceUrl}/api/tags")
        // Update _inferenceStatus based on response
        _inferenceStatus.value = InferenceStatus.AVAILABLE // placeholder
    }

    /** Whether deliberative conversation is possible right now. */
    fun canConverse(): Boolean =
        _inferenceStatus.value == InferenceStatus.AVAILABLE

    fun destroy() {
        healthCheckJob?.cancel()
        scope.cancel()
    }

    companion object {
        private const val TAG = "ConnectivityMonitor"
    }
}
