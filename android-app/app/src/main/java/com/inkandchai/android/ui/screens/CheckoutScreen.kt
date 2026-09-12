package com.inkandchai.android.ui.screens

import android.content.Context
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.inkandchai.android.AppViewModel
import com.inkandchai.android.data.CartLine
import com.inkandchai.android.data.CodOrderRequest
import com.inkandchai.android.data.Customer
import com.inkandchai.android.data.PhonePeOrderRequest
import com.inkandchai.android.data.PlacedOrder
import com.inkandchai.android.data.Pricing
import com.inkandchai.android.data.SavedAddress
import com.inkandchai.android.data.rupees
import com.inkandchai.android.ui.components.PillButton
import com.inkandchai.android.ui.theme.InkShape
import com.inkandchai.android.ui.theme.InkTheme
import com.inkandchai.android.ui.theme.ScreenPadding
import kotlinx.coroutines.launch

enum class PaymentMethod(val label: String, val note: String, val cod: Boolean) {
    UPI("UPI", "Pay by any UPI app", false),
    CARD("Card", "Credit or debit card", false),
    NETBANKING("Net banking", "All major banks", false),
    COD("Cash on delivery", "Pay the courier when it arrives", true),
}

@Composable
fun CheckoutScreen(
    vm: AppViewModel,
    onBack: () -> Unit,
    onPlaced: (String) -> Unit,
    contentPadding: PaddingValues,
) {
    val colors = InkTheme.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val cart by vm.cart.collectAsState()
    val saved by vm.savedAddress.collectAsState()
    val coupon by vm.coupon.collectAsState()

    var name by remember { mutableStateOf("") }
    var phone by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var line by remember { mutableStateOf("") }
    var city by remember { mutableStateOf("") }
    var pincode by remember { mutableStateOf("") }
    var method by remember { mutableStateOf(PaymentMethod.UPI) }
    var busy by remember { mutableStateOf(false) }

    // Pre-fill from the last order rather than making a returning customer
    // retype an address the app already knows.
    LaunchedEffect(saved) {
        if (name.isBlank()) {
            name = saved.name; phone = saved.phone; email = saved.email
            line = saved.line; city = saved.city; pincode = saved.pincode
        }
    }

    // The pincode fills the city, the same 3-tier lookup the website uses.
    LaunchedEffect(pincode) {
        if (pincode.length == 6) {
            vm.lookupPincode(pincode)?.let { if (it.city.isNotBlank()) city = it.city }
        }
    }

    val totals = remember(cart, coupon, method) { vm.totals(cod = method.cod) }
    val cartHasNoCod = cart.any { it.book.noCod }
    val codTooSmall = totals.subtotal < Pricing.COD_MIN_SUBTOTAL
    val codBlocked = cartHasNoCod || codTooSmall
    val formOk = name.isNotBlank() && phone.filter { it.isDigit() }.length >= 10 &&
        line.isNotBlank() && pincode.length == 6
    val canPlace = formOk && !busy && cart.isNotEmpty() && !(method.cod && codBlocked)

    Box(Modifier.fillMaxSize().background(colors.bg)) {
        LazyColumn(
            contentPadding = PaddingValues(
                top = contentPadding.calculateTopPadding() + 8.dp,
                bottom = 110.dp + contentPadding.calculateBottomPadding(),
            ),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            item {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = ScreenPadding),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(
                        "←",
                        style = InkTheme.type.screenTitle,
                        color = colors.ink,
                        modifier = Modifier.clickable(onClick = onBack),
                    )
                    Text("Checkout", style = InkTheme.type.screenTitle, color = colors.ink)
                }
            }

            item {
                Column(
                    Modifier.padding(horizontal = ScreenPadding),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Field("Full name", name) { name = it }
                    Field("Phone", phone, keyboard = KeyboardType.Phone) { phone = it }
                    Field("Email (optional)", email, keyboard = KeyboardType.Email) { email = it }
                    Field("Flat, house, area, landmark", line, minHeight = 78.dp) { line = it }
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Box(Modifier.weight(1f)) { Field("City", city) { city = it } }
                        Box(Modifier.weight(1f)) {
                            Field("Pincode", pincode, keyboard = KeyboardType.Number) {
                                pincode = it.filter { c -> c.isDigit() }.take(6)
                            }
                        }
                    }
                }
            }

            item {
                Column(
                    Modifier.padding(horizontal = ScreenPadding),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Text("Payment method", style = InkTheme.type.subHeader, color = colors.ink)
                    PaymentMethod.entries.forEach { option ->
                        val disabled = option.cod && codBlocked
                        PaymentRow(
                            option = option,
                            selected = method == option,
                            disabled = disabled,
                            disabledReason = when {
                                !disabled -> null
                                cartHasNoCod -> "One of these titles is prepaid only"
                                else -> "COD needs a subtotal of at least ₹${Pricing.COD_MIN_SUBTOTAL}"
                            },
                            onSelect = { if (!disabled) method = option },
                        )
                    }
                }
            }

            item { OrderSummary(totals, Modifier.padding(horizontal = ScreenPadding), cod = method.cod) }

            item {
                Text(
                    "Prices are confirmed by Ink & Chai when the order is created. " +
                        "If a price has changed since you added the book, the amount you pay is the one shown on the confirmation.",
                    style = InkTheme.type.secondary,
                    color = colors.muted,
                    modifier = Modifier.padding(horizontal = ScreenPadding),
                )
            }
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
        ) {
            PillButton(
                label = if (busy) "Placing…" else "Place order · ₹${totals.total.rupees()}",
                onClick = onClick@{
                    if (!canPlace) return@onClick
                    busy = true
                    val address = SavedAddress(name, phone, email, line, city, pincode)
                    vm.saveAddress(address)
                    scope.launch {
                        placeOrder(
                            vm = vm,
                            context = context,
                            method = method,
                            address = address,
                            totals = totals.total,
                            shipping = totals.shipping,
                            couponCode = coupon?.code.orEmpty(),
                            onPlaced = onPlaced,
                            onError = {
                                busy = false
                                vm.showToast(it)
                            },
                        )
                    }
                },
                modifier = Modifier.fillMaxWidth(),
                enabled = canPlace,
            )
        }
    }
}

/**
 * COD writes the order and is done. Online payment hands off to the same
 * PhonePe hosted page the website uses, opened in a Custom Tab.
 *
 * Deliberately, the app never decides that a payment succeeded. The PhonePe
 * webhook and the sweep job are what move an order out of pending_phonepe, and
 * Success re-reads the order from track-order rather than assuming. Showing a
 * customer "paid" on the strength of a redirect is how you end up telling
 * someone their money arrived when it did not.
 */
private suspend fun placeOrder(
    vm: AppViewModel,
    context: Context,
    method: PaymentMethod,
    address: SavedAddress,
    totals: Int,
    shipping: Int,
    couponCode: String,
    onPlaced: (String) -> Unit,
    onError: (String) -> Unit,
) {
    val lines = vm.cart.value.map {
        CartLine(
            slug = it.book.slug,
            id = "/product/${it.book.slug}/",
            title = it.book.title,
            price = it.book.price,
            qty = it.qty,
            img = it.book.image,
        )
    }
    val fullAddress = listOf(address.line, address.city, address.pincode)
        .filter { it.isNotBlank() }
        .joinToString(", ")
    val customer = Customer(
        name = address.name,
        phone = address.phone,
        email = address.email,
        address = fullAddress,
    )

    try {
        if (method.cod) {
            val response = vm.repository.placeCod(
                CodOrderRequest(
                    cart = lines,
                    customer = customer,
                    amount = totals,
                    shipping = shipping,
                ),
            )
            if (response.orderId.isBlank()) {
                onError(response.error.ifBlank { "Could not place the order" })
                return
            }
            vm.recordOrder(
                PlacedOrder(
                    orderId = response.orderId,
                    placedAtMillis = System.currentTimeMillis(),
                    total = totals,
                    titles = lines.map { it.title },
                    covers = lines.map { it.img },
                    phone = address.phone,
                ),
            )
            vm.clearCart()
            vm.removeCoupon()
            onPlaced(response.orderId)
        } else {
            val response = vm.repository.startPhonePe(
                PhonePeOrderRequest(cart = lines, customer = customer, coupon = couponCode),
            )
            if (!response.success || response.redirectUrl.isBlank()) {
                onError(response.error.ifBlank { "Could not start the payment" })
                return
            }
            // Recorded BEFORE handing off: if the app is killed while PhonePe
            // is in the foreground, the order id must still be recoverable
            // from My Orders.
            vm.recordOrder(
                PlacedOrder(
                    orderId = response.orderId,
                    placedAtMillis = System.currentTimeMillis(),
                    total = totals,
                    titles = lines.map { it.title },
                    covers = lines.map { it.img },
                    phone = address.phone,
                ),
            )
            CustomTabsIntent.Builder()
                .setShowTitle(true)
                .build()
                .launchUrl(context, Uri.parse(response.redirectUrl))
            onPlaced(response.orderId)
        }
    } catch (e: Exception) {
        onError(e.message ?: "Network error — please try again")
    }
}

@Composable
private fun Field(
    label: String,
    value: String,
    keyboard: KeyboardType = KeyboardType.Text,
    minHeight: androidx.compose.ui.unit.Dp = 48.dp,
    onValueChange: (String) -> Unit,
) {
    val colors = InkTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
        Text(label, style = InkTheme.type.secondary, color = colors.muted)
        Box(
            Modifier
                .fillMaxWidth()
                .height(minHeight)
                .clip(RoundedCornerShape(InkShape.small))
                .background(colors.card)
                .border(1.dp, colors.line, RoundedCornerShape(InkShape.small))
                .padding(horizontal = 14.dp, vertical = 13.dp),
        ) {
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                textStyle = InkTheme.type.body.copy(color = colors.ink),
                cursorBrush = SolidColor(colors.accent),
                keyboardOptions = KeyboardOptions(keyboardType = keyboard),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun PaymentRow(
    option: PaymentMethod,
    selected: Boolean,
    disabled: Boolean,
    disabledReason: String?,
    onSelect: () -> Unit,
) {
    val colors = InkTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(InkShape.small))
            .background(if (selected) colors.accent.copy(alpha = 0.08f) else colors.card)
            .border(
                1.dp,
                if (selected) colors.accent else colors.line,
                RoundedCornerShape(InkShape.small),
            )
            .clickable(enabled = !disabled, onClick = onSelect)
            .padding(14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            Modifier
                .size(18.dp)
                .clip(CircleShape)
                .border(1.5.dp, if (selected) colors.accent else colors.line, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            if (selected) {
                Box(Modifier.size(9.dp).clip(CircleShape).background(colors.accent))
            }
        }
        Column(Modifier.weight(1f)) {
            Text(
                option.label,
                style = InkTheme.type.bodyStrong,
                color = if (disabled) colors.muted else colors.ink,
            )
            Text(
                disabledReason ?: option.note,
                style = InkTheme.type.secondary,
                color = if (disabled) colors.accent else colors.muted,
            )
        }
        if (option == PaymentMethod.UPI && !disabled) {
            Text(
                "Recommended",
                style = InkTheme.type.micro,
                color = Color.White,
                modifier = Modifier
                    .clip(RoundedCornerShape(InkShape.pill))
                    .background(colors.discount)
                    .padding(horizontal = 8.dp, vertical = 4.dp),
            )
        }
    }
}
