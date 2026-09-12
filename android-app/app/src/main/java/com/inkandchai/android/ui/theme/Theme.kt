package com.inkandchai.android.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat

private val LocalInkColors = staticCompositionLocalOf { LightInkColors }
private val LocalInkTypography = staticCompositionLocalOf { InkTypography() }

object InkTheme {
    val colors: InkColors
        @Composable get() = LocalInkColors.current
    val type: InkTypography
        @Composable get() = LocalInkTypography.current
}

/** Radii from the handoff: 12-20dp by element size, 100dp for chips and pills. */
object InkShape {
    val chip = 100.dp
    val pill = 100.dp
    val small = 12.dp
    val medium = 16.dp
    val large = 20.dp
}

/** Horizontal screen padding is a fixed 20dp everywhere. */
val ScreenPadding = 20.dp

@Composable
fun InkAndChaiTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val colors = if (darkTheme) DarkInkColors else LightInkColors
    val view = LocalView.current

    if (!view.isInEditMode) {
        val window = (view.context as? android.app.Activity)?.window
        if (window != null) {
            window.statusBarColor = colors.bg.toArgb()
            window.navigationBarColor = colors.bg.toArgb()
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !darkTheme
                isAppearanceLightNavigationBars = !darkTheme
            }
        }
    }

    CompositionLocalProvider(
        LocalInkColors provides colors,
        LocalInkTypography provides InkTypography(),
    ) {
        MaterialTheme(
            // Material is only here for ripples, text-field internals and the
            // few M3 components used; colour and type come from InkTheme.
            colorScheme = MaterialTheme.colorScheme.copy(
                primary = colors.accent,
                background = colors.bg,
                surface = colors.card,
            ),
        ) {
            CompositionLocalProvider(
                LocalTextStyle provides InkTypography().body.copy(color = colors.ink),
                content = content,
            )
        }
    }
}

private fun Color.toArgb(): Int = android.graphics.Color.argb(
    (alpha * 255).toInt(), (red * 255).toInt(), (green * 255).toInt(), (blue * 255).toInt(),
)
