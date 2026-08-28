package com.waywiser.trust

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * Trust Center — the user's control panel for permissions, leases,
 * capabilities, and audit history.
 *
 * Three tabs: Active Leases | Capabilities | History
 */
@Composable
fun TrustCenterScreen() {
    var selectedTab by remember { mutableIntStateOf(0) }
    val tabs = listOf("Leases", "Capabilities", "History")

    Column(modifier = Modifier.fillMaxSize()) {
        TabRow(selectedTabIndex = selectedTab) {
            tabs.forEachIndexed { index, title ->
                Tab(
                    selected = selectedTab == index,
                    onClick = { selectedTab = index },
                    text = { Text(title) },
                )
            }
        }

        when (selectedTab) {
            0 -> ActiveLeasesTab()
            1 -> CapabilitiesTab()
            2 -> AuditHistoryTab()
        }
    }
}

@Composable
private fun ActiveLeasesTab() {
    // TODO: Connect to Rust runtime for live lease data
    val leases = remember { emptyList<LeaseUiModel>() }

    if (leases.isEmpty()) {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("No active leases", style = MaterialTheme.typography.bodyLarge)
        }
    } else {
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(leases) { lease ->
                LeaseCard(lease)
            }
        }
    }
}

@Composable
private fun LeaseCard(lease: LeaseUiModel) {
    Card(
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                text = lease.capabilityName,
                style = MaterialTheme.typography.titleMedium,
            )

            Spacer(modifier = Modifier.height(4.dp))

            // Risk badge (color-coded)
            Surface(
                shape = MaterialTheme.shapes.small,
                color = lease.riskColor(),
            ) {
                Text(
                    text = lease.riskLevel,
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                    style = MaterialTheme.typography.labelSmall,
                )
            }

            Spacer(modifier = Modifier.height(8.dp))

            // Expiry countdown
            Text(
                text = "Expires: ${lease.expiresIn}",
                style = MaterialTheme.typography.bodySmall,
            )

            // Usage progress
            LinearProgressIndicator(
                progress = { lease.usageRatio },
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 4.dp),
            )
            Text(
                text = "${lease.executionsUsed}/${lease.maxExecutions} executions",
                style = MaterialTheme.typography.labelSmall,
            )

            Spacer(modifier = Modifier.height(8.dp))

            // Revoke button
            TextButton(
                onClick = { /* TODO: revoke via Rust runtime */ },
                colors = ButtonDefaults.textButtonColors(
                    contentColor = MaterialTheme.colorScheme.error,
                ),
            ) {
                Text("Revoke")
            }
        }
    }
}

@Composable
private fun CapabilitiesTab() {
    // TODO: Show registered capabilities from Rust CapabilityRegistry
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text("Capability registry", style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable
private fun AuditHistoryTab() {
    // TODO: Show audit log from Rust SecurityKernel
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text("Authorization audit log", style = MaterialTheme.typography.bodyLarge)
    }
}

/** UI model for an active approval lease. */
data class LeaseUiModel(
    val id: String,
    val capabilityName: String,
    val riskLevel: String,
    val expiresIn: String,
    val executionsUsed: Int,
    val maxExecutions: Int,
) {
    val usageRatio: Float get() =
        if (maxExecutions > 0) executionsUsed.toFloat() / maxExecutions else 0f

    @Composable
    fun riskColor() = when (riskLevel) {
        "ReadPersonal" -> MaterialTheme.colorScheme.tertiary
        "DeviceControl", "CrossAppWrite" -> MaterialTheme.colorScheme.secondary
        "Communication" -> MaterialTheme.colorScheme.primary
        "Financial", "Destructive" -> MaterialTheme.colorScheme.error
        else -> MaterialTheme.colorScheme.outline
    }
}
