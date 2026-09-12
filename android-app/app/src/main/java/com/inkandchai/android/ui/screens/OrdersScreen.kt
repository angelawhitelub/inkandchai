package com.inkandchai.android.ui.screens

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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import com.inkandchai.android.AppViewModel
import com.inkandchai.android.data.PlacedOrder
import com.inkandchai.android.data.rupees
import com.inkandchai.android.ui.components.Cover
import com.inkandchai.android.ui.components.Divider
import com.inkandchai.android.ui.components.GhostPill
import com.inkandchai.android.ui.theme.InkShape
import com.inkandchai.android.ui.theme.InkTheme
import com.inkandchai.android.ui.theme.ScreenPadding
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun OrdersScreen(
    vm: AppViewModel,
    onBack: () -> Unit,
    onTrack: (String) -> Unit,
    contentPadding: PaddingValues,
) {
    val colors = InkTheme.colors
    val orders by vm.orders.collectAsState()

    Column(Modifier.fillMaxSize().background(colors.bg)) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(top = contentPadding.calculateTopPadding())
                .padding(horizontal = ScreenPadding, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                "←",
                style = InkTheme.type.screenTitle,
                color = colors.ink,
                modifier = Modifier.clickable(onClick = onBack),
            )
            Text("My orders", style = InkTheme.type.screenTitle, color = colors.ink)
        }

        if (orders.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("📦", style = InkTheme.type.detailTitle)
                    Spacer(Modifier.height(10.dp))
                    Text("No orders yet", style = InkTheme.type.subHeader, color = colors.ink)
                    Spacer(Modifier.height(6.dp))
                    Text(
                        "Orders placed in the app appear here.",
                        style = InkTheme.type.secondary,
                        color = colors.muted,
                    )
                }
            }
            return@Column
        }

        LazyColumn(
            contentPadding = PaddingValues(
                start = ScreenPadding,
                end = ScreenPadding,
                bottom = contentPadding.calculateBottomPadding() + 16.dp,
            ),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            items(orders, key = { it.orderId }) { order -> OrderCard(order, onTrack) }
        }
    }
}

@Composable
private fun OrderCard(order: PlacedOrder, onTrack: (String) -> Unit) {
    val colors = InkTheme.colors
    val placed = remember(order.placedAtMillis) {
        SimpleDateFormat("d MMM yyyy", Locale("en", "IN")).format(Date(order.placedAtMillis))
    }
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(InkShape.medium))
            .background(colors.card)
            .border(1.dp, colors.line, RoundedCornerShape(InkShape.medium))
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Column {
                Text(order.orderId, style = InkTheme.type.bodyStrong, color = colors.ink)
                Text("Placed $placed", style = InkTheme.type.secondary, color = colors.muted)
            }
            Text(
                "In progress",
                style = InkTheme.type.micro,
                color = colors.accent,
                modifier = Modifier
                    .clip(RoundedCornerShape(InkShape.pill))
                    .background(colors.accent.copy(alpha = 0.12f))
                    .padding(horizontal = 10.dp, vertical = 5.dp),
            )
        }

        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            order.covers.take(3).forEach { Cover(it, 40.dp, 60.dp, radius = 6.dp) }
            val first = order.titles.firstOrNull().orEmpty()
            val more = (order.titles.size - 1).coerceAtLeast(0)
            Text(
                if (more > 0) "$first + $more more" else first,
                style = InkTheme.type.secondary,
                color = colors.muted,
                maxLines = 2,
                overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
            )
        }

        Divider()

        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column {
                Text("Arrives in 2–5 days", style = InkTheme.type.secondary, color = colors.muted)
                Text("₹${order.total.rupees()}", style = InkTheme.type.price, color = colors.ink)
            }
            GhostPill("Track order →", { onTrack(order.orderId) })
        }
    }
}
