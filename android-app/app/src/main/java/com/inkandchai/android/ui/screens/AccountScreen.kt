package com.inkandchai.android.ui.screens

import androidx.compose.animation.core.animateDpAsState
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
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import com.inkandchai.android.AppViewModel
import com.inkandchai.android.ui.components.Divider
import com.inkandchai.android.ui.components.InkIcons
import com.inkandchai.android.ui.theme.InkShape
import com.inkandchai.android.ui.theme.InkTheme
import com.inkandchai.android.ui.theme.ScreenPadding

@Composable
fun AccountScreen(
    vm: AppViewModel,
    onOrders: () -> Unit,
    onWishlist: () -> Unit,
    contentPadding: PaddingValues,
) {
    val colors = InkTheme.colors
    val address by vm.savedAddress.collectAsState()
    val theme by vm.theme.collectAsState()
    val wishlist by vm.wishlist.collectAsState()
    val dark = theme == "dark"

    Column(
        Modifier
            .fillMaxSize()
            .background(colors.bg)
            .verticalScroll(rememberScrollState())
            .padding(contentPadding)
            .padding(horizontal = ScreenPadding),
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        Spacer(Modifier.height(8.dp))

        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Box(
                Modifier.size(56.dp).clip(CircleShape).background(colors.accent),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    address.name.trim().firstOrNull()?.uppercase() ?: "👤",
                    style = InkTheme.type.screenTitle,
                    color = androidx.compose.ui.graphics.Color.White,
                )
            }
            Column {
                Text(
                    address.name.ifBlank { "Guest reader" },
                    style = InkTheme.type.subHeader,
                    color = colors.ink,
                )
                Text(
                    address.phone.ifBlank { "Your details are saved after your first order" },
                    style = InkTheme.type.secondary,
                    color = colors.muted,
                )
            }
        }

        Column(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(InkShape.medium))
                .background(colors.card)
                .border(1.dp, colors.line, RoundedCornerShape(InkShape.medium)),
        ) {
            AccountRow("📦", "My orders", onOrders)
            Divider()
            AccountRow("♡", "Wishlist", onWishlist, trailing = "${wishlist.size}")
            Divider()
            AccountRow("📍", "Addresses", { })
            Divider()
            ThemeRow(dark) { vm.setTheme(if (dark) "light" else "dark") }
            Divider()
            AccountRow("🎧", "Help & support", { })
        }

        Spacer(Modifier.height(4.dp))
        Text(
            "Ink & Chai · v1.0 · Made in Delhi",
            style = InkTheme.type.secondary,
            color = colors.muted,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(20.dp))
    }
}

@Composable
private fun AccountRow(
    emoji: String,
    label: String,
    onClick: () -> Unit,
    trailing: String? = null,
) {
    val colors = InkTheme.colors
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text(emoji, style = InkTheme.type.body)
        Text(label, style = InkTheme.type.bodyStrong, color = colors.ink, modifier = Modifier.weight(1f))
        if (trailing != null) {
            Text(trailing, style = InkTheme.type.secondary, color = colors.muted)
        }
        Icon(InkIcons.Chevron, null, tint = colors.muted, modifier = Modifier.size(16.dp))
    }
}

/** The animated pill switch from the Account screen in the handoff. */
@Composable
private fun ThemeRow(dark: Boolean, onToggle: () -> Unit) {
    val colors = InkTheme.colors
    val knobOffset by animateDpAsState(if (dark) 22.dp else 2.dp, label = "themeKnob")
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onToggle).padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Icon(
            if (dark) InkIcons.Moon else InkIcons.Sun,
            null,
            tint = colors.ink,
            modifier = Modifier.size(19.dp),
        )
        Text(
            if (dark) "Dark theme" else "Light theme",
            style = InkTheme.type.bodyStrong,
            color = colors.ink,
            modifier = Modifier.weight(1f),
        )
        Box(
            Modifier
                .width(46.dp)
                .height(26.dp)
                .clip(RoundedCornerShape(InkShape.pill))
                .background(if (dark) colors.accent else colors.line),
            contentAlignment = Alignment.CenterStart,
        ) {
            Box(
                Modifier
                    .offset(x = knobOffset)
                    .size(22.dp)
                    .clip(CircleShape)
                    .background(colors.card),
            )
        }
    }
}
