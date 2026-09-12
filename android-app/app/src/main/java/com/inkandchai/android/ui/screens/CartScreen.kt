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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.inkandchai.android.AppViewModel
import com.inkandchai.android.data.CartEntry
import com.inkandchai.android.data.Pricing
import com.inkandchai.android.data.Totals
import com.inkandchai.android.data.rupees
import com.inkandchai.android.ui.components.Cover
import com.inkandchai.android.ui.components.Divider
import com.inkandchai.android.ui.components.InkIcons
import com.inkandchai.android.ui.components.PillButton
import com.inkandchai.android.ui.theme.InkShape
import com.inkandchai.android.ui.theme.InkTheme
import com.inkandchai.android.ui.theme.ScreenPadding

@Composable
fun CartScreen(
    vm: AppViewModel,
    onBrowse: () -> Unit,
    onCheckout: () -> Unit,
    contentPadding: PaddingValues,
) {
    val cart by vm.cart.collectAsState()
    val coupon by vm.coupon.collectAsState()
    val colors = InkTheme.colors
    val totals = remember(cart, coupon) { vm.totals(cod = false) }

    if (cart.isEmpty()) {
        Column(
            Modifier.fillMaxSize().background(colors.bg).padding(contentPadding),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text("📚", style = InkTheme.type.detailTitle)
            Spacer(Modifier.height(12.dp))
            Text("Your cart is empty", style = InkTheme.type.screenTitle, color = colors.ink)
            Spacer(Modifier.height(6.dp))
            Text("Books you add will show up here.", style = InkTheme.type.body, color = colors.muted)
            Spacer(Modifier.height(20.dp))
            PillButton("Browse books", onBrowse, Modifier.width(190.dp))
        }
        return
    }

    Box(Modifier.fillMaxSize().background(colors.bg)) {
        LazyColumn(
            contentPadding = PaddingValues(
                top = contentPadding.calculateTopPadding() + 8.dp,
                bottom = 108.dp + contentPadding.calculateBottomPadding(),
            ),
        ) {
            item {
                Text(
                    "Your cart",
                    style = InkTheme.type.screenTitle,
                    color = colors.ink,
                    modifier = Modifier.padding(horizontal = ScreenPadding, vertical = 8.dp),
                )
            }
            items(cart.size) { index ->
                val entry = cart[index]
                CartLineRow(
                    entry = entry,
                    onQty = { vm.setQty(entry.book.slug, it) },
                    onRemove = { vm.removeFromCart(entry.book.slug) },
                )
                if (index < cart.lastIndex) {
                    Divider(Modifier.padding(horizontal = ScreenPadding))
                }
            }
            item { Spacer(Modifier.height(18.dp)) }
            item { CouponCard(vm, totals) }
            item { Spacer(Modifier.height(16.dp)) }
            item { OrderSummary(totals, Modifier.padding(horizontal = ScreenPadding)) }
        }

        Column(
            Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .background(colors.bg)
                .padding(
                    start = ScreenPadding,
                    end = ScreenPadding,
                    top = 12.dp,
                    bottom = 12.dp + contentPadding.calculateBottomPadding(),
                ),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("Total", style = InkTheme.type.body, color = colors.muted)
                Text("₹${totals.total.rupees()}", style = InkTheme.type.price, color = colors.ink)
            }
            PillButton("Checkout →", onCheckout, Modifier.fillMaxWidth())
        }
    }
}

@Composable
private fun CartLineRow(entry: CartEntry, onQty: (Int) -> Unit, onRemove: () -> Unit) {
    val colors = InkTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(horizontal = ScreenPadding, vertical = 14.dp),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Cover(entry.book.image, 70.dp, 104.dp, elevation = 4.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Text(
                entry.book.title,
                style = InkTheme.type.bookTitle,
                color = colors.ink,
                maxLines = 2,
                overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
            )
            if (entry.book.author.isNotBlank()) {
                Text(entry.book.author, style = InkTheme.type.secondary, color = colors.muted)
            }
            Text("₹${entry.book.price.rupees()}", style = InkTheme.type.price, color = colors.ink)
            Spacer(Modifier.height(2.dp))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                QtyButton(InkIcons.Minus, "Decrease") { onQty(entry.qty - 1) }
                Text("${entry.qty}", style = InkTheme.type.bodyStrong, color = colors.ink)
                QtyButton(InkIcons.Plus, "Increase") { onQty(entry.qty + 1) }
                Spacer(Modifier.width(6.dp))
                Text(
                    "Remove",
                    style = InkTheme.type.label,
                    color = colors.muted,
                    modifier = Modifier.clickable(onClick = onRemove),
                )
            }
        }
    }
}

@Composable
private fun QtyButton(icon: ImageVector, description: String, onClick: () -> Unit) {
    val colors = InkTheme.colors
    Box(
        Modifier
            .size(28.dp)
            .clip(CircleShape)
            .border(1.dp, colors.line, CircleShape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, description, tint = colors.ink, modifier = Modifier.size(14.dp))
    }
}

@Composable
private fun CouponCard(vm: AppViewModel, totals: Totals) {
    val colors = InkTheme.colors
    val applied by vm.coupon.collectAsState()
    var code by remember { mutableStateOf("") }

    Column(
        Modifier
            .padding(horizontal = ScreenPadding)
            .fillMaxWidth()
            .clip(RoundedCornerShape(InkShape.medium))
            .background(colors.band)
            .border(
                1.dp,
                colors.accent.copy(alpha = 0.45f),
                RoundedCornerShape(InkShape.medium),
            )
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("🏷️", style = InkTheme.type.body)
            Text(
                applied?.code ?: "Have a coupon?",
                style = InkTheme.type.bodyStrong.copy(fontWeight = FontWeight.Bold),
                color = colors.ink,
            )
        }
        Text(
            applied?.let { "${it.label} · prepaid orders above ₹${it.minSubtotal.rupees()}" }
                ?: "Prepaid codes only. The final discount is confirmed by the server when you pay.",
            style = InkTheme.type.secondary,
            color = colors.muted,
        )
        if (applied == null) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(
                    Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(InkShape.pill))
                        .background(colors.card)
                        .padding(horizontal = 14.dp, vertical = 11.dp),
                ) {
                    if (code.isEmpty()) {
                        Text("Enter code", style = InkTheme.type.body, color = colors.muted)
                    }
                    BasicTextField(
                        value = code,
                        onValueChange = { code = it.uppercase() },
                        singleLine = true,
                        textStyle = InkTheme.type.body.copy(color = colors.ink),
                        cursorBrush = SolidColor(colors.accent),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                PillButton("Apply", { vm.applyCoupon(code) }, height = 42.dp)
            }
        } else {
            val short = totals.subtotal < applied!!.minSubtotal
            if (short) {
                Text(
                    "Add ₹${(applied!!.minSubtotal - totals.subtotal).rupees()} more to use this code.",
                    style = InkTheme.type.secondary,
                    color = colors.accent,
                )
            }
            PillButton("Remove", { vm.removeCoupon() }, ink = true, height = 42.dp)
        }
    }
}

@Composable
fun OrderSummary(totals: Totals, modifier: Modifier = Modifier, cod: Boolean = false) {
    val colors = InkTheme.colors
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(InkShape.medium))
            .background(colors.card)
            .border(1.dp, colors.line, RoundedCornerShape(InkShape.medium))
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        SummaryRow("Subtotal", "₹${totals.subtotal.rupees()}")
        if (totals.discount > 0) {
            SummaryRow("Discount", "−₹${totals.discount.rupees()}", valueColor = colors.discount)
        }
        SummaryRow(
            "Shipping",
            if (totals.freeShipping) "FREE" else "₹${totals.shipping.rupees()}",
            valueColor = if (totals.freeShipping) colors.discount else null,
        )
        if (cod && totals.codFee > 0) {
            SummaryRow("COD handling", "₹${totals.codFee.rupees()}")
        }
        Divider()
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("Total", style = InkTheme.type.bodyStrong, color = colors.ink)
            Text("₹${totals.total.rupees()}", style = InkTheme.type.price, color = colors.ink)
        }
        if (!totals.freeShipping && totals.subtotal > 0) {
            Text(
                "Add ₹${(Pricing.FREE_SHIPPING_THRESHOLD - (totals.subtotal - totals.discount)).rupees()} more for free shipping.",
                style = InkTheme.type.secondary,
                color = colors.muted,
            )
        }
    }
}

@Composable
private fun SummaryRow(
    label: String,
    value: String,
    valueColor: androidx.compose.ui.graphics.Color? = null,
) {
    val colors = InkTheme.colors
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = InkTheme.type.body, color = colors.muted)
        Text(value, style = InkTheme.type.bodyStrong, color = valueColor ?: colors.ink)
    }
}
