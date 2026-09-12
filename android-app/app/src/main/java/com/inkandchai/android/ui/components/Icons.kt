package com.inkandchai.android.ui.components

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

/**
 * Hand-drawn line icons, as the handoff specifies (~1.8px stroke on a 24 grid).
 * Built here rather than pulling in material-icons-extended, which ships a few
 * thousand filled glyphs to use eight of them and does not match this set's
 * weight.
 */
object InkIcons {

    private fun lineIcon(name: String, builder: ImageVector.Builder.() -> Unit): ImageVector =
        ImageVector.Builder(
            name = name,
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
        ).apply(builder).build()

    private fun ImageVector.Builder.stroke(
        width: Float = 1.8f,
        pathBuilder: androidx.compose.ui.graphics.vector.PathBuilder.() -> Unit,
    ) = path(
        stroke = SolidColor(Color.Black),
        strokeLineWidth = width,
        strokeLineCap = StrokeCap.Round,
        strokeLineJoin = StrokeJoin.Round,
        pathBuilder = pathBuilder,
    )

    val Home: ImageVector by lazy {
        lineIcon("home") {
            stroke { moveTo(3.5f, 10.5f); lineTo(12f, 3.5f); lineTo(20.5f, 10.5f); lineTo(20.5f, 20f); lineTo(3.5f, 20f); close() }
            stroke { moveTo(9.5f, 20f); lineTo(9.5f, 14f); lineTo(14.5f, 14f); lineTo(14.5f, 20f) }
        }
    }

    val Search: ImageVector by lazy {
        lineIcon("search") {
            stroke { moveTo(11f, 4f); arcToRelative(7f, 7f, 0f, true, true, 0f, 14f); arcToRelative(7f, 7f, 0f, true, true, 0f, -14f); close() }
            stroke { moveTo(16.2f, 16.2f); lineTo(20.5f, 20.5f) }
        }
    }

    val Cart: ImageVector by lazy {
        lineIcon("cart") {
            stroke { moveTo(3f, 4.5f); lineTo(5.4f, 4.5f); lineTo(7.6f, 14.5f); lineTo(18.4f, 14.5f); lineTo(20.3f, 7.3f); lineTo(6.2f, 7.3f) }
            stroke { moveTo(9f, 18.2f); arcToRelative(1.4f, 1.4f, 0f, true, true, 0f, 2.8f); arcToRelative(1.4f, 1.4f, 0f, true, true, 0f, -2.8f); close() }
            stroke { moveTo(17f, 18.2f); arcToRelative(1.4f, 1.4f, 0f, true, true, 0f, 2.8f); arcToRelative(1.4f, 1.4f, 0f, true, true, 0f, -2.8f); close() }
        }
    }

    val Account: ImageVector by lazy {
        lineIcon("account") {
            stroke { moveTo(12f, 3.8f); arcToRelative(3.9f, 3.9f, 0f, true, true, 0f, 7.8f); arcToRelative(3.9f, 3.9f, 0f, true, true, 0f, -7.8f); close() }
            stroke { moveTo(4.2f, 20.2f); curveTo(4.2f, 16.3f, 7.7f, 14f, 12f, 14f); reflectiveCurveTo(19.8f, 16.3f, 19.8f, 20.2f) }
        }
    }

    val Heart: ImageVector by lazy {
        lineIcon("heart") {
            stroke(2f) {
                moveTo(12f, 20.3f)
                curveTo(12f, 20.3f, 3.2f, 15.1f, 3.2f, 9.2f)
                curveTo(3.2f, 6.2f, 5.5f, 4f, 8.3f, 4f)
                curveTo(10.1f, 4f, 11.4f, 5f, 12f, 6.1f)
                curveTo(12.6f, 5f, 13.9f, 4f, 15.7f, 4f)
                curveTo(18.5f, 4f, 20.8f, 6.2f, 20.8f, 9.2f)
                curveTo(20.8f, 15.1f, 12f, 20.3f, 12f, 20.3f)
                close()
            }
        }
    }

    val Back: ImageVector by lazy {
        lineIcon("back") {
            stroke(2f) { moveTo(15f, 4.5f); lineTo(8f, 12f); lineTo(15f, 19.5f) }
        }
    }

    val Truck: ImageVector by lazy {
        lineIcon("truck") {
            stroke { moveTo(2.8f, 6f); lineTo(14f, 6f); lineTo(14f, 16.4f); lineTo(2.8f, 16.4f); close() }
            stroke { moveTo(14f, 9.4f); lineTo(18.2f, 9.4f); lineTo(21.2f, 12.6f); lineTo(21.2f, 16.4f); lineTo(14f, 16.4f) }
            stroke { moveTo(7f, 16.6f); arcToRelative(1.7f, 1.7f, 0f, true, true, 0f, 3.4f); arcToRelative(1.7f, 1.7f, 0f, true, true, 0f, -3.4f); close() }
            stroke { moveTo(17.4f, 16.6f); arcToRelative(1.7f, 1.7f, 0f, true, true, 0f, 3.4f); arcToRelative(1.7f, 1.7f, 0f, true, true, 0f, -3.4f); close() }
        }
    }

    val Check: ImageVector by lazy {
        lineIcon("check") {
            stroke(2.2f) { moveTo(5f, 12.5f); lineTo(10f, 17.5f); lineTo(19f, 6.5f) }
        }
    }

    val Plus: ImageVector by lazy {
        lineIcon("plus") {
            stroke(2.2f) { moveTo(12f, 5.5f); lineTo(12f, 18.5f) }
            stroke(2.2f) { moveTo(5.5f, 12f); lineTo(18.5f, 12f) }
        }
    }

    val Minus: ImageVector by lazy {
        lineIcon("minus") {
            stroke(2.2f) { moveTo(5.5f, 12f); lineTo(18.5f, 12f) }
        }
    }

    val Sun: ImageVector by lazy {
        lineIcon("sun") {
            stroke { moveTo(12f, 8f); arcToRelative(4f, 4f, 0f, true, true, 0f, 8f); arcToRelative(4f, 4f, 0f, true, true, 0f, -8f); close() }
            stroke { moveTo(12f, 2.6f); lineTo(12f, 4.6f) }
            stroke { moveTo(12f, 19.4f); lineTo(12f, 21.4f) }
            stroke { moveTo(2.6f, 12f); lineTo(4.6f, 12f) }
            stroke { moveTo(19.4f, 12f); lineTo(21.4f, 12f) }
            stroke { moveTo(5.4f, 5.4f); lineTo(6.8f, 6.8f) }
            stroke { moveTo(17.2f, 17.2f); lineTo(18.6f, 18.6f) }
            stroke { moveTo(18.6f, 5.4f); lineTo(17.2f, 6.8f) }
            stroke { moveTo(6.8f, 17.2f); lineTo(5.4f, 18.6f) }
        }
    }

    val Moon: ImageVector by lazy {
        lineIcon("moon") {
            stroke { moveTo(20f, 14.2f); arcTo(8.4f, 8.4f, 0f, true, true, 9.8f, 4f); arcTo(6.6f, 6.6f, 0f, false, false, 20f, 14.2f); close() }
        }
    }

    val Chevron: ImageVector by lazy {
        lineIcon("chevron") {
            stroke(2f) { moveTo(9f, 5f); lineTo(16f, 12f); lineTo(9f, 19f) }
        }
    }

    val Star: ImageVector by lazy {
        ImageVector.Builder(
            name = "star", defaultWidth = 24.dp, defaultHeight = 24.dp,
            viewportWidth = 24f, viewportHeight = 24f,
        ).apply {
            path(fill = SolidColor(Color.Black)) {
                moveTo(12f, 3.2f); lineTo(14.7f, 9f); lineTo(21f, 9.8f); lineTo(16.4f, 14.2f)
                lineTo(17.6f, 20.5f); lineTo(12f, 17.4f); lineTo(6.4f, 20.5f); lineTo(7.6f, 14.2f)
                lineTo(3f, 9.8f); lineTo(9.3f, 9f); close()
            }
        }.build()
    }
}
