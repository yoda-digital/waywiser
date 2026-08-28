package com.waywiser

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.waywiser.ledger.LedgerScreen
import com.waywiser.trust.TrustCenterScreen
import com.waywiser.ui.ConversationScreen
import com.waywiser.ui.theme.WaywiserTheme

/**
 * Single-activity Compose host. All screens are Compose destinations.
 */
class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        setContent {
            WaywiserTheme {
                val navController = rememberNavController()
                var selectedTab by remember { mutableIntStateOf(0) }

                Scaffold(
                    modifier = Modifier.fillMaxSize(),
                    bottomBar = {
                        NavigationBar {
                            NavigationBarItem(
                                selected = selectedTab == 0,
                                onClick = {
                                    selectedTab = 0
                                    navController.navigate("conversation") {
                                        popUpTo("conversation") { inclusive = true }
                                    }
                                },
                                icon = { /* Icon(Icons.Default.Chat) */ },
                                label = { Text("Chat") }
                            )
                            NavigationBarItem(
                                selected = selectedTab == 1,
                                onClick = {
                                    selectedTab = 1
                                    navController.navigate("ledger")
                                },
                                icon = { /* Icon(Icons.Default.History) */ },
                                label = { Text("Activity") }
                            )
                            NavigationBarItem(
                                selected = selectedTab == 2,
                                onClick = {
                                    selectedTab = 2
                                    navController.navigate("trust")
                                },
                                icon = { /* Icon(Icons.Default.Security) */ },
                                label = { Text("Trust") }
                            )
                        }
                    }
                ) { innerPadding ->
                    NavHost(
                        navController = navController,
                        startDestination = "conversation",
                        modifier = Modifier.padding(innerPadding),
                    ) {
                        composable("conversation") {
                            ConversationScreen()
                        }
                        composable("ledger") {
                            LedgerScreen()
                        }
                        composable("trust") {
                            TrustCenterScreen()
                        }
                    }
                }
            }
        }
    }
}
