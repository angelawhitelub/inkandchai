package com.inkandchai.android.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color

/**
 * The palette is lifted verbatim from the design handoff's "Design Tokens"
 * section. Every screen reads these through [InkTheme.colors] rather than
 * Material's ColorScheme, because the handoff's roles (band, line, ink, onink)
 * do not map cleanly onto Material 3's (surfaceVariant, outline, onSurface…)
 * and forcing them through it loses the distinctions the design depends on --
 * `band` and `card` would both collapse to a "surface".
 */
@Immutable
data class InkColors(
    val bg: Color,
    val card: Color,
    val ink: Color,
    val onInk: Color,
    val muted: Color,
    val line: Color,
    val band: Color,
    val accent: Color,
    val star: Color,
) {
    /** Fixed in both themes -- the handoff calls these out as brand constants. */
    val heroTop: Color get() = Color(0xFF33271F)
    val heroBottom: Color get() = Color(0xFF241B15)
    val success: Color get() = Color(0xFF2E7D54)
    val discount: Color get() = Color(0xFF3A9D68)
    /** Text on the dark hero gradient, which does not follow the theme. */
    val onHero: Color get() = Color(0xFFF6EEE1)
    val onHeroMuted: Color get() = Color(0xFFC4B6A3)
}

val LightInkColors = InkColors(
    bg     = Color(0xFFF4EDE1),
    card   = Color(0xFFFFFDF8),
    ink    = Color(0xFF2A211B),
    onInk  = Color(0xFFFBF4EA),
    muted  = Color(0xFF7C6F60),
    line   = Color(0xFFEADDC9),
    band   = Color(0xFFFBF1E2),
    accent = Color(0xFFBF5334),
    star   = Color(0xFFC8912B),
)

val DarkInkColors = InkColors(
    bg     = Color(0xFF1A1410),
    card   = Color(0xFF251D17),
    ink    = Color(0xFFF6EEE1),
    onInk  = Color(0xFF1A1410),
    muted  = Color(0xFFC4B6A3),
    line   = Color(0xFF3A2F26),
    band   = Color(0xFF2B2019),
    accent = Color(0xFFE07A4F),
    star   = Color(0xFFE6B980),
)
