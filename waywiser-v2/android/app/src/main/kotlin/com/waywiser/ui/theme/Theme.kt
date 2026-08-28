package com.waywiser.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

private val WaywiserBlue = Color(0xFF2563EB)
private val WaywiserBlueLight = Color(0xFF60A5FA)

private val DarkColorScheme = darkColorScheme(
    primary = WaywiserBlueLight,
    onPrimary = Color(0xFF002B75),
    primaryContainer = Color(0xFF0040A0),
    onPrimaryContainer = Color(0xFFD6E3FF),
    secondary = Color(0xFFBEC6DC),
    onSecondary = Color(0xFF283141),
    secondaryContainer = Color(0xFF3E4758),
    onSecondaryContainer = Color(0xFFDAE2F9),
    tertiary = Color(0xFFDCBCE1),
    tertiaryContainer = Color(0xFF523E56),
    background = Color(0xFF0B1120),
    surface = Color(0xFF131D30),
    surfaceVariant = Color(0xFF1A2740),
    error = Color(0xFFF87171),
    errorContainer = Color(0xFF2D1215),
)

private val LightColorScheme = lightColorScheme(
    primary = WaywiserBlue,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFD6E3FF),
    onPrimaryContainer = Color(0xFF001A41),
    secondary = Color(0xFF565E71),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFDAE2F9),
    onSecondaryContainer = Color(0xFF131C2B),
    tertiary = Color(0xFF6B5778),
    tertiaryContainer = Color(0xFFF2DAFF),
    background = Color(0xFFF5F6FA),
    surface = Color.White,
    surfaceVariant = Color(0xFFEEF0F6),
    error = Color(0xFFDC2626),
    errorContainer = Color(0xFFFEF2F2),
)

@Composable
fun WaywiserTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    dynamicColor: Boolean = false,
    content: @Composable () -> Unit,
) {
    val colorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val context = LocalContext.current
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        }
        darkTheme -> DarkColorScheme
        else -> LightColorScheme
    }

    MaterialTheme(
        colorScheme = colorScheme,
        typography = Typography(), // default Material3 typography
        content = content,
    )
}
