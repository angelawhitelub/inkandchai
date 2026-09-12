package com.inkandchai.android.ui.screens

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.inkandchai.android.AppViewModel
import com.inkandchai.android.data.TrackOrderResponse
import com.inkandchai.android.ui.components.Cover
import com.inkandchai.android.ui.components.GhostPill
import com.inkandchai.android.ui.components.InkCard
import com.inkandchai.android.ui.components.InkIcons
import com.inkandchai.android.ui.theme.InkShape
import com.inkandchai.android.ui.theme.InkTheme
import com.inkandchai.android.ui.theme.ScreenPadding

/** The five stages the timeline renders, in order. */
private val STAGES = listOf(
    "Order confirmed" to "We have your order",
    "Packed at warehouse" to "Your books are boxed",
    "Shipped" to "Handed to the courier",
    "Out for delivery" to "Arriving today",
    "Delivered" to "Enjoy the read",
)

/**
 * Maps the order's server status onto a stage index.
 *
 * Anything unrecognised stays at stage 0 rather than guessing forward: showing
 * "Out for delivery" for a status we do not understand is worse than showing
 * the honest minimum.
 */
private fun stageFor(status: String): Int = when (status.lowercase()) {
    "delivered" -> 4
    "out_for_delivery" -> 3
    "shipped", "in_transit" -> 2
    "packed", "ready_to_ship", "manifested" -> 1
    else -> 0
}

@Composable
fun TrackScreen(
    vm: AppViewModel,
    orderId: String,
    onBack: () -> Unit,
    contentPadding: PaddingValues,
) {
    val colors = InkTheme.colors
    val orders by vm.orders.collectAsState()
    val known = orders.firstOrNull { it.orderId == orderId }
    var result by remember { mutableStateOf<TrackOrderResponse?>(null) }
    var loading by remember { mutableStateOf(true) }

    LaunchedEffect(orderId) {
        loading = true
        result = runCatching { vm.repository.track(orderId, known?.phone.orEmpty()) }.getOrNull()
        loading = false
    }

    val stage = stageFor(result?.status.orEmpty())

    LazyColumn(
        Modifier.fillMaxSize().background(colors.bg),
        contentPadding = PaddingValues(
            top = contentPadding.calculateTopPadding(),
            bottom = contentPadding.calculateBottomPadding() + 24.dp,
        ),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        item {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = ScreenPadding, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text(
                    "←",
                    style = InkTheme.type.screenTitle,
                    color = colors.ink,
                    modifier = Modifier.clickable(onClick = onBack),
                )
                Text("Track order", style = InkTheme.type.screenTitle, color = colors.ink)
            }
        }

        item {
            Column(
                Modifier
                    .padding(horizontal = ScreenPadding)
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(InkShape.large))
                    .background(Brush.verticalGradient(listOf(colors.heroTop, colors.heroBottom)))
                    .padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column {
                        Text(orderId, style = InkTheme.type.secondary, color = colors.onHeroMuted)
                        Spacer(Modifier.height(4.dp))
                        Text(
                            if (loading) "Checking…" else STAGES[stage].first,
                            style = InkTheme.type.subHeader,
                            color = colors.onHero,
                        )
                    }
                    Box(
                        Modifier.size(44.dp).clip(CircleShape).background(Color(0x22FFFFFF)),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(InkIcons.Truck, null, tint = colors.accent, modifier = Modifier.size(22.dp))
                    }
                }
                Box(
                    Modifier
                        .clip(RoundedCornerShape(InkShape.pill))
                        .background(Color(0x1AFFFFFF))
                        .padding(horizontal = 12.dp, vertical = 6.dp),
                ) {
                    Text("Arrives in 2–5 days", style = InkTheme.type.micro, color = colors.onHeroMuted)
                }
            }
        }

        if (loading) {
            item {
                Box(Modifier.fillMaxWidth().height(120.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = colors.accent, strokeWidth = 2.dp)
                }
            }
        }

        item {
            Column(Modifier.padding(horizontal = ScreenPadding)) {
                STAGES.forEachIndexed { index, (label, sub) ->
                    StageRow(
                        label = label,
                        sub = sub,
                        done = index < stage,
                        active = index == stage,
                        last = index == STAGES.lastIndex,
                    )
                }
            }
        }

        result?.takeIf { it.address.isNotBlank() }?.let { tracked ->
            item {
                InkCard(Modifier.padding(horizontal = ScreenPadding)) {
                    Text("Delivery address", style = InkTheme.type.bodyStrong, color = colors.ink)
                    Spacer(Modifier.height(6.dp))
                    Text(tracked.address, style = InkTheme.type.body, color = colors.muted)
                }
            }
        }

        val items = result?.items.orEmpty().ifEmpty { null }
        if (items != null) {
            item {
                Column(
                    Modifier.padding(horizontal = ScreenPadding),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text("In this order", style = InkTheme.type.subHeader, color = colors.ink)
                    items.forEach { line ->
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Cover(line.img, 38.dp, 56.dp, radius = 6.dp)
                            Text(
                                line.title,
                                style = InkTheme.type.body,
                                color = colors.ink,
                                modifier = Modifier.weight(1f),
                                maxLines = 2,
                                overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
            }
        }

        result?.takeIf { it.trackingUrl.isNotBlank() }?.let { tracked ->
            item {
                Column(Modifier.padding(horizontal = ScreenPadding)) {
                    Text(
                        "${tracked.courier} · ${tracked.trackingId}",
                        style = InkTheme.type.secondary,
                        color = colors.muted,
                    )
                }
            }
        }

        item {
            Row(
                Modifier.padding(horizontal = ScreenPadding).fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("💬", style = InkTheme.type.body)
                Text(
                    "Need help with this order?",
                    style = InkTheme.type.body,
                    color = colors.muted,
                    modifier = Modifier.weight(1f),
                )
                GhostPill("WhatsApp", { })
            }
        }
    }
}

@Composable
private fun StageRow(label: String, sub: String, done: Boolean, active: Boolean, last: Boolean) {
    val colors = InkTheme.colors
    val pulse = rememberInfiniteTransition(label = "pulse")
    val ring by pulse.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(1600), RepeatMode.Restart),
        label = "pulseRing",
    )

    Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Box(contentAlignment = Alignment.Center) {
                if (active) {
                    Box(
                        Modifier
                            .size((22 + 16 * ring).dp)
                            .clip(CircleShape)
                            .background(colors.accent.copy(alpha = 0.35f * (1f - ring))),
                    )
                }
                Box(
                    Modifier
                        .size(22.dp)
                        .clip(CircleShape)
                        .then(
                            if (done || active) Modifier.background(colors.accent)
                            else Modifier.border(1.5.dp, colors.line, CircleShape),
                        ),
                    contentAlignment = Alignment.Center,
                ) {
                    if (done) {
                        Icon(InkIcons.Check, null, tint = Color.White, modifier = Modifier.size(12.dp))
                    }
                }
            }
            if (!last) {
                Box(
                    Modifier
                        .width(2.dp)
                        .height(40.dp)
                        .background(if (done) colors.accent else colors.line),
                )
            }
        }
        Column(Modifier.padding(bottom = if (last) 0.dp else 12.dp)) {
            Text(
                label,
                style = InkTheme.type.bodyStrong,
                color = if (done || active) colors.ink else colors.muted,
            )
            Text(sub, style = InkTheme.type.secondary, color = colors.muted)
        }
    }
}
