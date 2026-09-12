package com.inkandchai.android.ui.screens

import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
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
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.inkandchai.android.AppViewModel
import com.inkandchai.android.data.rupees
import com.inkandchai.android.ui.components.Divider
import com.inkandchai.android.ui.components.InkCard
import com.inkandchai.android.ui.components.InkIcons
import com.inkandchai.android.ui.components.PillButton
import com.inkandchai.android.ui.theme.InkTheme
import com.inkandchai.android.ui.theme.ScreenPadding

@Composable
fun SuccessScreen(
    vm: AppViewModel,
    orderId: String,
    onTrack: (String) -> Unit,
    onKeepShopping: () -> Unit,
    contentPadding: PaddingValues,
) {
    val colors = InkTheme.colors
    val orders by vm.orders.collectAsState()
    val order = orders.firstOrNull { it.orderId == orderId }
    var popped by remember { mutableStateOf(false) }
    val scale by animateFloatAsState(
        targetValue = if (popped) 1f else 0.6f,
        animationSpec = spring(dampingRatio = Spring.DampingRatioMediumBouncy),
        label = "checkPop",
    )
    LaunchedEffect(Unit) { popped = true }

    // The server owns payment state. This screen confirms the order EXISTS and
    // says what will happen next; it never claims money has been received.
    var statusLine by remember { mutableStateOf("We are confirming your payment with the bank.") }
    LaunchedEffect(orderId) {
        val phone = order?.phone.orEmpty()
        if (orderId.isNotBlank() && phone.isNotBlank()) {
            runCatching { vm.repository.track(orderId, phone) }
                .getOrNull()
                ?.let { tracked ->
                    if (tracked.found && tracked.status.isNotBlank()) {
                        statusLine = when (tracked.status.lowercase()) {
                            "cod_pending", "confirmed" -> "Confirmed. We will pack it shortly."
                            "paid" -> "Payment received. We will pack it shortly."
                            "pending_phonepe" -> "Waiting for the bank to confirm your payment."
                            else -> "Status: ${tracked.status.replace('_', ' ')}"
                        }
                    }
                }
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .background(colors.bg)
            .padding(contentPadding)
            .padding(horizontal = ScreenPadding),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(
            Modifier
                .size(74.dp)
                .scale(scale)
                .clip(CircleShape)
                .background(colors.success),
            contentAlignment = Alignment.Center,
        ) {
            Icon(InkIcons.Check, null, tint = Color.White, modifier = Modifier.size(36.dp))
        }
        Spacer(Modifier.height(20.dp))
        Text("Order placed!", style = InkTheme.type.screenTitle, color = colors.ink)
        Spacer(Modifier.height(8.dp))
        Text(
            statusLine,
            style = InkTheme.type.body,
            color = colors.muted,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(24.dp))

        InkCard(Modifier.fillMaxWidth()) {
            ReceiptRow("Order ID", orderId)
            Spacer(Modifier.height(10.dp))
            Divider()
            Spacer(Modifier.height(10.dp))
            ReceiptRow("Amount", "₹${(order?.total ?: 0).rupees()}")
            Spacer(Modifier.height(10.dp))
            Divider()
            Spacer(Modifier.height(10.dp))
            ReceiptRow("Arrives by", "2–5 days")
        }

        Spacer(Modifier.height(24.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            PillButton("Track order", { onTrack(orderId) }, Modifier.weight(1f))
            PillButton("Keep shopping", onKeepShopping, Modifier.weight(1f), ink = true)
        }
    }
}

@Composable
private fun ReceiptRow(label: String, value: String) {
    val colors = InkTheme.colors
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = InkTheme.type.body, color = colors.muted)
        Text(value, style = InkTheme.type.bodyStrong, color = colors.ink)
    }
}
