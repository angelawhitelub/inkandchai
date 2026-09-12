package com.inkandchai.android.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.inkandchai.android.data.Api
import com.inkandchai.android.data.rupees
import com.inkandchai.android.ui.theme.InkShape
import com.inkandchai.android.ui.theme.InkTheme

/** A book cover with the warm placeholder the design uses while loading. */
@Composable
fun Cover(
    url: String,
    width: Dp,
    height: Dp,
    modifier: Modifier = Modifier,
    radius: Dp = 10.dp,
    elevation: Dp = 0.dp,
) {
    val colors = InkTheme.colors
    Box(
        modifier
            .size(width, height)
            .then(
                if (elevation > 0.dp) {
                    Modifier.shadow(elevation, RoundedCornerShape(radius), clip = false)
                } else Modifier,
            )
            .clip(RoundedCornerShape(radius))
            .background(colors.band),
    ) {
        if (url.isNotBlank()) {
            AsyncImage(
                model = Api.imageUrl(url),
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        }
    }
}

/**
 * Cover that takes the width it is given instead of a fixed one -- the
 * 2-column new-arrivals grid sizes by column, not by a hard 126dp.
 */
@Composable
fun CoverFill(
    url: String,
    height: Dp,
    modifier: Modifier = Modifier,
    radius: Dp = 10.dp,
    elevation: Dp = 0.dp,
) {
    val colors = InkTheme.colors
    Box(
        modifier
            .fillMaxWidth()
            .height(height)
            .then(
                if (elevation > 0.dp) {
                    Modifier.shadow(elevation, RoundedCornerShape(radius), clip = false)
                } else Modifier,
            )
            .clip(RoundedCornerShape(radius))
            .background(colors.band),
    ) {
        if (url.isNotBlank()) {
            AsyncImage(
                model = Api.imageUrl(url),
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        }
    }
}

/** Top-left "-31%" flag on a card. Absent entirely when there is no discount. */
@Composable
fun DiscountBadge(percent: Int, modifier: Modifier = Modifier) {
    if (percent <= 0) return
    val colors = InkTheme.colors
    Text(
        text = "-$percent%",
        style = InkTheme.type.micro,
        color = Color.White,
        modifier = modifier
            .clip(RoundedCornerShape(topStart = 10.dp, bottomEnd = 10.dp))
            .background(colors.accent)
            .padding(horizontal = 7.dp, vertical = 4.dp),
    )
}

/** The floating circular "+" that adds one unit without opening the book. */
@Composable
fun AddButton(onClick: () -> Unit, modifier: Modifier = Modifier, size: Dp = 30.dp) {
    val colors = InkTheme.colors
    Box(
        modifier
            .shadow(3.dp, androidx.compose.foundation.shape.CircleShape, clip = false)
            .clip(androidx.compose.foundation.shape.CircleShape)
            .background(colors.accent)
            .clickable(onClick = onClick)
            .size(size),
        contentAlignment = Alignment.Center,
    ) {
        Icon(InkIcons.Plus, contentDescription = "Add to cart", tint = Color.White, modifier = Modifier.size(size * 0.55f))
    }
}

@Composable
fun PriceRow(price: Int, mrp: Int, showDiscount: Boolean = true) {
    val colors = InkTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("₹${price.rupees()}", style = InkTheme.type.price, color = colors.ink)
        if (mrp > price) {
            Text(
                "₹${mrp.rupees()}",
                style = InkTheme.type.secondary.copy(textDecoration = TextDecoration.LineThrough),
                color = colors.muted,
            )
            if (showDiscount) {
                val pct = ((mrp - price) * 100.0 / mrp).toInt()
                Text("$pct% off", style = InkTheme.type.micro, color = colors.discount)
            }
        }
    }
}

@Composable
fun SectionHeader(
    title: String,
    modifier: Modifier = Modifier,
    action: String? = null,
    onAction: (() -> Unit)? = null,
) {
    Row(
        modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, style = InkTheme.type.sectionHeader, color = InkTheme.colors.ink)
        if (action != null && onAction != null) {
            Text(
                action,
                style = InkTheme.type.label,
                color = InkTheme.colors.accent,
                modifier = Modifier.clickable(onClick = onAction),
            )
        }
    }
}

/** Filled pill. `ink = true` uses the dark ink fill, otherwise the accent. */
@Composable
fun PillButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    ink: Boolean = false,
    enabled: Boolean = true,
    height: Dp = 50.dp,
) {
    val colors = InkTheme.colors
    val background = when {
        !enabled -> colors.muted.copy(alpha = 0.35f)
        ink -> colors.ink
        else -> colors.accent
    }
    Box(
        modifier
            .height(height)
            .clip(RoundedCornerShape(InkShape.pill))
            .background(background)
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            style = InkTheme.type.button,
            color = if (ink) colors.onInk else Color.White,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(horizontal = 20.dp),
        )
    }
}

/** Outlined pill, used for secondary actions like "Track order". */
@Composable
fun GhostPill(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    height: Dp = 38.dp,
) {
    val colors = InkTheme.colors
    Box(
        modifier
            .height(height)
            .clip(RoundedCornerShape(InkShape.pill))
            .border(1.dp, colors.line, RoundedCornerShape(InkShape.pill))
            .background(colors.card)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, style = InkTheme.type.label, color = colors.ink, modifier = Modifier.padding(horizontal = 14.dp))
    }
}

@Composable
fun CategoryChip(label: String, selected: Boolean, onClick: () -> Unit) {
    val colors = InkTheme.colors
    Box(
        Modifier
            .clip(RoundedCornerShape(InkShape.chip))
            .background(if (selected) colors.ink else colors.card)
            .then(if (selected) Modifier else Modifier.border(1.dp, colors.line, RoundedCornerShape(InkShape.chip)))
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 9.dp),
    ) {
        Text(
            label,
            style = InkTheme.type.label.copy(fontWeight = FontWeight.SemiBold),
            color = if (selected) colors.onInk else colors.muted,
        )
    }
}

@Composable
fun InkCard(
    modifier: Modifier = Modifier,
    radius: Dp = InkShape.medium,
    content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit,
) {
    val colors = InkTheme.colors
    Column(
        modifier
            .clip(RoundedCornerShape(radius))
            .background(colors.card)
            .border(1.dp, colors.line, RoundedCornerShape(radius))
            .padding(16.dp),
        content = content,
    )
}

@Composable
fun Divider(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(1.dp).background(InkTheme.colors.line))
}

/** Bottom toast: dark pill, 0.25s slide-and-fade, auto-dismissed by the caller. */
@Composable
fun InkToast(message: String?, modifier: Modifier = Modifier) {
    AnimatedVisibility(
        visible = message != null,
        enter = fadeIn(androidx.compose.animation.core.tween(250)) + slideInVertically(androidx.compose.animation.core.tween(250)) { it / 2 },
        exit = fadeOut(androidx.compose.animation.core.tween(200)) + slideOutVertically(androidx.compose.animation.core.tween(200)) { it / 2 },
        modifier = modifier,
    ) {
        Box(
            Modifier
                .clip(RoundedCornerShape(InkShape.pill))
                .background(Color(0xFF241B15))
                .padding(horizontal = 22.dp, vertical = 12.dp),
        ) {
            Text(message.orEmpty(), style = InkTheme.type.bodyStrong, color = Color(0xFFF6EEE1))
        }
    }
}

@Composable
fun LoadingRow(label: String = "Loading more books…") {
    val colors = InkTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(vertical = 22.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CircularProgressIndicator(color = colors.accent, strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(10.dp))
        Text(label, style = InkTheme.type.secondary, color = colors.muted)
    }
}

@Composable
fun IconPill(
    icon: ImageVector,
    contentDescription: String?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    tint: Color? = null,
) {
    val colors = InkTheme.colors
    Box(
        modifier
            .size(38.dp)
            .clip(androidx.compose.foundation.shape.CircleShape)
            .background(colors.card)
            .border(1.dp, colors.line, androidx.compose.foundation.shape.CircleShape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription, tint = tint ?: colors.ink, modifier = Modifier.size(19.dp))
    }
}

@Composable
fun TruncatedTitle(text: String, maxLines: Int = 2, modifier: Modifier = Modifier) {
    Text(
        text,
        style = InkTheme.type.bookTitle,
        color = InkTheme.colors.ink,
        maxLines = maxLines,
        overflow = TextOverflow.Ellipsis,
        modifier = modifier,
    )
}
