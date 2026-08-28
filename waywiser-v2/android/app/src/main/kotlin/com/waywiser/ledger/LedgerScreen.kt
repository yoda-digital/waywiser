package com.waywiser.ledger

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * Activity Ledger — user-facing record of all actions Waywiser has taken.
 *
 * Each entry shows:
 * - Time + action summary
 * - Why it was done
 * - What authority allowed it
 * - Whether the outcome was verified
 * - Undo button (for reversible actions)
 * - "Don't do this automatically" (revokes the authorizing lease)
 */
@Composable
fun LedgerScreen() {
    // TODO: Connect to Rust runtime for live ledger data
    val entries = remember { emptyList<LedgerEntryUiModel>() }

    if (entries.isEmpty()) {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text("No actions yet", style = MaterialTheme.typography.titleMedium)
                Text(
                    "Actions Waywiser takes on your behalf appear here",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    } else {
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(entries) { entry ->
                LedgerCard(entry)
            }
        }
    }
}

@Composable
private fun LedgerCard(entry: LedgerEntryUiModel) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp)) {
            // Time + summary
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(entry.time, style = MaterialTheme.typography.labelMedium)
                VerificationBadge(entry.verification)
            }

            Text(
                text = entry.summary,
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.padding(vertical = 4.dp),
            )

            // Reason
            if (entry.reason.isNotBlank()) {
                Text(
                    text = "Why: ${entry.reason}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            // Authority
            Text(
                text = "Authority: ${entry.authority}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Spacer(modifier = Modifier.height(8.dp))

            // Action buttons
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (entry.canUndo) {
                    OutlinedButton(
                        onClick = { /* TODO: undo via Rust runtime */ },
                        modifier = Modifier.padding(end = 8.dp),
                    ) {
                        Text("Undo")
                    }
                }
                if (entry.canRevokeAutomation) {
                    TextButton(
                        onClick = { /* TODO: revoke lease via Rust runtime */ },
                        colors = ButtonDefaults.textButtonColors(
                            contentColor = MaterialTheme.colorScheme.error,
                        ),
                    ) {
                        Text("Don't do this automatically")
                    }
                }
            }
        }
    }
}

@Composable
private fun VerificationBadge(verification: String) {
    val color = when (verification) {
        "Verified" -> MaterialTheme.colorScheme.primary
        "Likely" -> MaterialTheme.colorScheme.tertiary
        "Unexpected" -> MaterialTheme.colorScheme.error
        else -> MaterialTheme.colorScheme.outline
    }
    Surface(
        shape = MaterialTheme.shapes.small,
        color = color.copy(alpha = 0.12f),
    ) {
        Text(
            text = verification,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
            style = MaterialTheme.typography.labelSmall,
            color = color,
        )
    }
}

/** UI model for a ledger entry. */
data class LedgerEntryUiModel(
    val id: String,
    val time: String,
    val summary: String,
    val reason: String,
    val authority: String,
    val verification: String,
    val canUndo: Boolean,
    val canRevokeAutomation: Boolean,
)
