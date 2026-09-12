package com.inkandchai.android.ui.screens

import androidx.compose.foundation.background
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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.inkandchai.android.AppViewModel
import com.inkandchai.android.data.Book
import com.inkandchai.android.data.rupees
import com.inkandchai.android.ui.components.Cover
import com.inkandchai.android.ui.components.InkIcons
import com.inkandchai.android.ui.components.PillButton
import com.inkandchai.android.ui.components.TruncatedTitle
import com.inkandchai.android.ui.theme.InkShape
import com.inkandchai.android.ui.theme.InkTheme
import com.inkandchai.android.ui.theme.ScreenPadding

@Composable
fun DetailScreen(
    vm: AppViewModel,
    onBack: () -> Unit,
    onOpenBook: (Book) -> Unit,
    onBuyNow: () -> Unit,
    contentPadding: PaddingValues,
) {
    val state by vm.detail.collectAsState()
    val wishlist by vm.wishlist.collectAsState()
    val colors = InkTheme.colors
    val book = state.book

    Box(Modifier.fillMaxSize().background(colors.bg)) {
        LazyColumn(
            contentPadding = PaddingValues(bottom = 96.dp + contentPadding.calculateBottomPadding()),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            item {
                DetailHero(
                    book = book,
                    wished = book != null && wishlist.contains(book.slug),
                    topInset = contentPadding.calculateTopPadding(),
                    onBack = onBack,
                    onWish = { book?.let { vm.toggleWishlist(it.slug) } },
                )
            }

            if (book == null) return@LazyColumn

            item {
                Column(
                    Modifier.padding(horizontal = ScreenPadding),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    if (book.category.isNotBlank()) {
                        Text(
                            book.category.uppercase(),
                            style = InkTheme.type.micro.copy(letterSpacing = 1.6.sp),
                            color = colors.accent,
                        )
                    }
                    Text(book.title, style = InkTheme.type.detailTitle, color = colors.ink)
                    if (book.author.isNotBlank()) {
                        Text(book.author, style = InkTheme.type.body, color = colors.muted)
                    }
                    Spacer(Modifier.height(2.dp))
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Text("₹${book.price.rupees()}", style = InkTheme.type.detailTitle, color = colors.ink)
                        if (book.mrp > book.price) {
                            Text(
                                "₹${book.mrp.rupees()}",
                                style = InkTheme.type.body.copy(
                                    textDecoration = androidx.compose.ui.text.style.TextDecoration.LineThrough,
                                ),
                                color = colors.muted,
                            )
                            Text(
                                "${book.discountPercent}% off",
                                style = InkTheme.type.bodyStrong,
                                color = colors.discount,
                            )
                        }
                    }
                }
            }

            item {
                Row(
                    Modifier.padding(horizontal = ScreenPadding).fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    listOf(
                        "🚚" to "Free ship ₹499+",
                        "💵" to if (book.noCod) "Prepaid only" else "COD available",
                        "📦" to "2–5 days",
                    ).forEach { (emoji, label) ->
                        Column(
                            Modifier
                                .weight(1f)
                                .clip(RoundedCornerShape(InkShape.small))
                                .background(colors.card)
                                .padding(vertical = 12.dp, horizontal = 8.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(5.dp),
                        ) {
                            Text(emoji, style = InkTheme.type.body)
                            Text(label, style = InkTheme.type.micro, color = colors.muted, maxLines = 1)
                        }
                    }
                }
            }

            if (book.description.isNotBlank()) {
                item {
                    Column(
                        Modifier.padding(horizontal = ScreenPadding),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text("About this book", style = InkTheme.type.subHeader, color = colors.ink)
                        Text(
                            // Descriptions come out of the CMS as markdown; the
                            // detail screen wants prose, not "## Heading".
                            book.description.replace(Regex("(?m)^#+\\s*"), "").trim(),
                            style = InkTheme.type.body,
                            color = colors.muted,
                        )
                    }
                }
            }

            if (state.alsoLike.isNotEmpty()) {
                item {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(
                            "You may also like",
                            style = InkTheme.type.subHeader,
                            color = colors.ink,
                            modifier = Modifier.padding(horizontal = ScreenPadding),
                        )
                        LazyRow(
                            contentPadding = PaddingValues(horizontal = ScreenPadding),
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            items(state.alsoLike, key = { it.slug }) { other ->
                                Column(
                                    Modifier.width(110.dp).clickable { onOpenBook(other) },
                                    verticalArrangement = Arrangement.spacedBy(6.dp),
                                ) {
                                    Cover(other.image, 110.dp, 164.dp, elevation = 5.dp)
                                    TruncatedTitle(other.title)
                                    Text(
                                        "₹${other.price.rupees()}",
                                        style = InkTheme.type.bodyStrong,
                                        color = colors.ink,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }

        if (book != null) {
            Row(
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
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                PillButton("Add to cart", { vm.addToCart(book) }, Modifier.weight(1f), ink = true)
                PillButton(
                    "Buy now",
                    {
                        vm.addToCart(book, silent = true)
                        onBuyNow()
                    },
                    Modifier.weight(1f),
                )
            }
        }
    }
}

@Composable
private fun DetailHero(
    book: Book?,
    wished: Boolean,
    topInset: androidx.compose.ui.unit.Dp,
    onBack: () -> Unit,
    onWish: () -> Unit,
) {
    val colors = InkTheme.colors
    Box(
        Modifier
            .fillMaxWidth()
            .background(Brush.verticalGradient(listOf(Color(0xFF33271F), Color(0xFF2A211B))))
            .padding(top = topInset),
    ) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = ScreenPadding, vertical = 14.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                HeroIcon(InkIcons.Back, "Back", onBack, Color(0xFFF6EEE1))
                HeroIcon(
                    InkIcons.Heart,
                    if (wished) "Remove from wishlist" else "Add to wishlist",
                    onWish,
                    if (wished) colors.accent else Color(0xFFF6EEE1),
                )
            }
            Spacer(Modifier.height(14.dp))
            Cover(book?.image.orEmpty(), 168.dp, 250.dp, elevation = 18.dp, radius = 12.dp)
            Spacer(Modifier.height(20.dp))
        }
    }
}

@Composable
private fun HeroIcon(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    description: String,
    onClick: () -> Unit,
    tint: Color,
) {
    Box(
        Modifier
            .size(38.dp)
            .clip(CircleShape)
            .background(Color(0x22FFFFFF))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, description, tint = tint, modifier = Modifier.size(19.dp))
    }
}
