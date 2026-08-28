package com.waywiser.trust

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.waywiser.ui.theme.WaywiserTheme

/**
 * Security approval activity — shown when the SecurityKernel requires
 * user or biometric confirmation for a protected action.
 *
 * Two modes:
 * - UserConfirm: simple "Allow" / "Allow for 1 hour" / "Deny"
 * - BiometricConfirm: fingerprint/face first, then confirmation
 */
class ApprovalActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val capability = intent.getStringExtra(EXTRA_CAPABILITY) ?: "unknown"
        val riskLevel = intent.getStringExtra(EXTRA_RISK_LEVEL) ?: "unknown"
        val reason = intent.getStringExtra(EXTRA_REASON) ?: ""
        val requiresBiometric = intent.getBooleanExtra(EXTRA_BIOMETRIC, false)

        setContent {
            WaywiserTheme {
                ApprovalScreen(
                    capability = capability,
                    riskLevel = riskLevel,
                    reason = reason,
                    requiresBiometric = requiresBiometric,
                    onAllow = { leaseHours ->
                        setResult(RESULT_OK, android.content.Intent().apply {
                            putExtra(RESULT_LEASE_HOURS, leaseHours)
                        })
                        finish()
                    },
                    onDeny = {
                        setResult(RESULT_CANCELED)
                        finish()
                    },
                    onBiometricRequired = { onSuccess ->
                        showBiometricPrompt(onSuccess)
                    },
                )
            }
        }
    }

    private fun showBiometricPrompt(onSuccess: () -> Unit) {
        val executor = ContextCompat.getMainExecutor(this)
        val prompt = BiometricPrompt(this, executor,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    onSuccess()
                }
                override fun onAuthenticationFailed() {
                    // User can retry
                }
                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    setResult(RESULT_CANCELED)
                    finish()
                }
            }
        )

        val promptInfo = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Waywiser Security")
            .setSubtitle("Confirm protected action")
            .setNegativeButtonText("Cancel")
            .setAllowedAuthenticators(
                BiometricManager.Authenticators.BIOMETRIC_STRONG or
                BiometricManager.Authenticators.DEVICE_CREDENTIAL
            )
            .build()

        prompt.authenticate(promptInfo)
    }

    companion object {
        const val EXTRA_CAPABILITY = "capability"
        const val EXTRA_RISK_LEVEL = "risk_level"
        const val EXTRA_REASON = "reason"
        const val EXTRA_BIOMETRIC = "requires_biometric"
        const val RESULT_LEASE_HOURS = "lease_hours"
    }
}

@Composable
private fun ApprovalScreen(
    capability: String,
    riskLevel: String,
    reason: String,
    requiresBiometric: Boolean,
    onAllow: (leaseHours: Int) -> Unit,
    onDeny: () -> Unit,
    onBiometricRequired: (onSuccess: () -> Unit) -> Unit,
) {
    Surface(
        modifier = Modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.surface,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Spacer(modifier = Modifier.height(32.dp))

            Text(
                text = "Action Approval Required",
                style = MaterialTheme.typography.headlineMedium,
            )

            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text("Capability", style = MaterialTheme.typography.labelMedium)
                    Text(capability, style = MaterialTheme.typography.bodyLarge)

                    Spacer(modifier = Modifier.height(8.dp))

                    Text("Risk Level", style = MaterialTheme.typography.labelMedium)
                    Text(riskLevel, style = MaterialTheme.typography.bodyLarge)

                    if (reason.isNotBlank()) {
                        Spacer(modifier = Modifier.height(8.dp))
                        Text("Reason", style = MaterialTheme.typography.labelMedium)
                        Text(reason, style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }

            Spacer(modifier = Modifier.weight(1f))

            // Allow with lease option
            Button(
                onClick = {
                    if (requiresBiometric) {
                        onBiometricRequired { onAllow(0) }
                    } else {
                        onAllow(0) // no lease, one-time
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Allow")
            }

            OutlinedButton(
                onClick = {
                    if (requiresBiometric) {
                        onBiometricRequired { onAllow(1) }
                    } else {
                        onAllow(1) // 1-hour lease
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Allow for 1 hour")
            }

            TextButton(
                onClick = onDeny,
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.textButtonColors(
                    contentColor = MaterialTheme.colorScheme.error,
                ),
            ) {
                Text("Deny")
            }
        }
    }
}
