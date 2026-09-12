package com.inkandchai.android.ui.screens

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
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
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.inkandchai.android.AppViewModel
import com.inkandchai.android.data.Book
import com.inkandchai.android.data.rupees
import com.inkandchai.android.ui.components.AddButton
import com.inkandchai.android.ui.components.Cover
import com.inkandchai.android.ui.components.CoverFill
import com.inkandchai.android.ui.components.GhostPill
import com.inkandchai.android.ui.components.DiscountBadge
import com.inkandchai.android.ui.components.CategoryChip
import com.inkandchai.android.ui.components.InkIcons
import com.inkandchai.android.ui.components.PriceRow
import com.inkandchai.android.ui.components.SectionHeader
import com.inkandchai.android.ui.components.TruncatedTitle
import com.inkandchai.android.ui.theme.InkShape
import com.inkandchai.android.ui.theme.InkTheme
import com.inkandchai.android.ui.theme.ScreenPadding

val HomeCategories = listOf("All", "Self-Help", "Romance", "Fiction", "Thriller", "Hindi")

@Composable
fun HomeScreen(
    vm: AppViewModel,
    onOpenBook: (Book) -> Unit,
    onOpenSearch: () -> Unit,
    onPickCategory: (String) -> Unit,
    contentPadding: PaddingValues,
) {
    val state by vm.home.collectAsState()
    val colors = InkTheme.colors

    LazyColumn(
        Modifier.fillMaxSize().background(colors.bg),
        contentPadding = contentPadding,
        verticalArrangement = Arrangement.spacedBy(24.dp),
    ) {
        item { PromoMarquee() }

        item { SearchEntry(onOpenSearch) }

        if (state.loading) {
            item {
                Box(Modifier.fillMaxWidth().height(240.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = colors.accent, strokeWidth = 2.dp)
                }
            }
        }

        state.error?.let { message ->
            item {
                Column(Modifier.fillMaxWidth().padding(horizontal = ScreenPadding)) {
                    Text("Could not load books", style = InkTheme.type.subHeader, color = colors.ink)
                    Spacer(Modifier.height(6.dp))
                    Text(message, style = InkTheme.type.secondary, color = colors.muted)
                    Spacer(Modifier.height(12.dp))
                    GhostPill("Try again", { vm.loadHome() })
                }
            }
        }

        state.feed.editorsPick?.let { pick ->
            item { EditorsPick(pick, onOpenBook) }
        }

        item {
            LazyRow(
                contentPadding = PaddingValues(horizontal = ScreenPadding),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(HomeCategories) { category ->
                    CategoryChip(category, selected = false) { onPickCategory(category) }
                }
            }
        }

        if (state.feed.bestsellers.isNotEmpty()) {
            item {
                Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    SectionHeader("Trending bestsellers", Modifier.padding(horizontal = ScreenPadding))
                    LazyRow(
                        contentPadding = PaddingValues(horizontal = ScreenPadding),
                        horizontalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        items(state.feed.bestsellers, key = { it.slug }) { book ->
                            TrendingCard(book, onOpenBook) { vm.addToCart(book) }
                        }
                    }
                }
            }
        }

        if (state.feed.hindiShelf.isNotEmpty()) {
            item { HindiBand(state.feed.hindiShelf, onOpenBook) }
        }

        if (state.feed.newArrivals.isNotEmpty()) {
            item {
                SectionHeader("New arrivals", Modifier.padding(horizontal = ScreenPadding))
            }
            // A 2-column grid inside a LazyColumn: chunked rows rather than a
            // nested LazyVerticalGrid, which cannot measure inside a scrolling
            // parent without a fixed height.
            items(state.feed.newArrivals.chunked(2)) { pair ->
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = ScreenPadding),
                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    pair.forEach { book ->
                        Box(Modifier.weight(1f)) {
                            ArrivalCard(book, onOpenBook) { vm.addToCart(book) }
                        }
                    }
                    if (pair.size == 1) Spacer(Modifier.weight(1f))
                }
            }
        }

        item { TrustStrip() }
    }
}

@Composable
private fun SearchEntry(onOpenSearch: () -> Unit) {
    val colors = InkTheme.colors
    Row(
        Modifier
            .padding(horizontal = ScreenPadding)
            .fillMaxWidth()
            .clip(RoundedCornerShape(InkShape.pill))
            .background(colors.card)
            .clickable(onClick = onOpenSearch)
            .padding(horizontal = 18.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(InkIcons.Search, null, tint = colors.muted, modifier = Modifier.size(18.dp))
        Text("Search 2,300+ books", style = InkTheme.type.body, color = colors.muted)
    }
}

/**
 * The promo strip. The loop is the doubled-content trick from the prototype:
 * the same text is laid out twice and the row is translated by exactly half
 * its width, so the wrap-around is invisible. 16s, linear, no pause.
 */
@Composable
private fun PromoMarquee() {
    val colors = InkTheme.colors
    val text = "FREE SHIPPING ABOVE ₹499  ·  COD & UPI ACCEPTED  ·  2,300+ HINDI & ENGLISH TITLES  ·  "
    var halfWidthPx by remember { mutableStateOf(0) }
    val transition = rememberInfiniteTransition(label = "marquee")
    val progress by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(16_000, easing = LinearEasing), RepeatMode.Restart),
        label = "marqueeOffset",
    )

    Box(
        Modifier
            .padding(horizontal = ScreenPadding)
            .fillMaxWidth()
            .clip(RoundedCornerShape(InkShape.pill))
            .background(Color(0xFF241B15))
            .height(34.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        Row(
            Modifier
                // Unbounded, or the Row is clipped to the strip's width and
                // "half its width" becomes half the VISIBLE width -- the text
                // would jump rather than loop seamlessly.
                .wrapContentWidth(align = Alignment.Start, unbounded = true)
                .onGloballyPositioned { halfWidthPx = it.size.width / 2 }
                .offset { IntOffset(x = -(progress * halfWidthPx).toInt(), y = 0) },
        ) {
            repeat(2) {
                Text(
                    text.repeat(2),
                    style = InkTheme.type.micro,
                    color = Color(0xFFE3D6C2),
                    maxLines = 1,
                    modifier = Modifier.padding(horizontal = 4.dp),
                )
            }
        }
    }
}

@Composable
private fun EditorsPick(book: Book, onOpen: (Book) -> Unit) {
    val colors = InkTheme.colors
    Row(
        Modifier
            .padding(horizontal = ScreenPadding)
            .fillMaxWidth()
            .clip(RoundedCornerShape(InkShape.large))
            .background(Brush.verticalGradient(listOf(colors.heroTop, colors.heroBottom)))
            .clickable { onOpen(book) }
            .padding(18.dp),
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Cover(book.image, 96.dp, 144.dp, elevation = 10.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("EDITOR'S PICK", style = InkTheme.type.micro, color = colors.accent)
            Text(
                book.title,
                style = InkTheme.type.subHeader,
                color = colors.onHero,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
            if (book.author.isNotBlank()) {
                Text(book.author, style = InkTheme.type.secondary, color = colors.onHeroMuted)
            }
            Spacer(Modifier.height(2.dp))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("₹${book.price.rupees()}", style = InkTheme.type.price, color = colors.onHero)
                if (book.mrp > book.price) {
                    Text(
                        "₹${book.mrp.rupees()}",
                        style = InkTheme.type.secondary.copy(
                            textDecoration = androidx.compose.ui.text.style.TextDecoration.LineThrough,
                        ),
                        color = colors.onHeroMuted,
                    )
                }
            }
            Spacer(Modifier.height(6.dp))
            Box(
                Modifier
                    .clip(RoundedCornerShape(InkShape.pill))
                    .background(colors.accent)
                    .clickable { onOpen(book) }
                    .padding(horizontal = 16.dp, vertical = 9.dp),
            ) {
                Text("View book →", style = InkTheme.type.label, color = Color.White)
            }
        }
    }
}

@Composable
private fun TrendingCard(book: Book, onOpen: (Book) -> Unit, onAdd: () -> Unit) {
    Column(
        Modifier.width(126.dp).clickable { onOpen(book) },
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box {
            Cover(book.image, 126.dp, 186.dp, elevation = 6.dp)
            DiscountBadge(book.discountPercent, Modifier.align(Alignment.TopStart))
            AddButton(onAdd, Modifier.align(Alignment.BottomEnd).padding(6.dp))
        }
        TruncatedTitle(book.title)
        PriceRow(book.price, book.mrp, showDiscount = false)
    }
}

@Composable
private fun ArrivalCard(book: Book, onOpen: (Book) -> Unit, onAdd: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().clickable { onOpen(book) },
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box {
            CoverFill(book.image, 222.dp, elevation = 6.dp)
            DiscountBadge(book.discountPercent, Modifier.align(Alignment.TopStart))
            AddButton(onAdd, Modifier.align(Alignment.BottomEnd).padding(6.dp))
        }
        TruncatedTitle(book.title)
        PriceRow(book.price, book.mrp, showDiscount = false)
    }
}

@Composable
private fun HindiBand(books: List<Book>, onOpen: (Book) -> Unit) {
    val colors = InkTheme.colors
    Column(
        Modifier
            .padding(horizontal = ScreenPadding)
            .fillMaxWidth()
            .clip(RoundedCornerShape(InkShape.large))
            .background(colors.band)
            .padding(vertical = 18.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text(
            "Hindi self-help",
            style = InkTheme.type.sectionHeader,
            color = colors.ink,
            modifier = Modifier.padding(horizontal = 18.dp),
        )
        LazyRow(
            contentPadding = PaddingValues(horizontal = 18.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            items(books, key = { it.slug }) { book ->
                Column(
                    Modifier.width(96.dp).clickable { onOpen(book) },
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Cover(book.image, 96.dp, 142.dp, elevation = 4.dp)
                    Text("₹${book.price.rupees()}", style = InkTheme.type.bodyStrong, color = colors.ink)
                }
            }
        }
    }
}

@Composable
private fun TrustStrip() {
    val colors = InkTheme.colors
    Row(
        Modifier.padding(horizontal = ScreenPadding).fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        listOf(
            "🚚" to "Free ship ₹499+",
            "↺" to "7-day returns",
            "₹" to "COD & UPI",
        ).forEach { (emoji, label) ->
            Column(
                Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(InkShape.small))
                    .background(colors.card)
                    .padding(vertical = 14.dp, horizontal = 8.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(emoji, style = InkTheme.type.subHeader, color = colors.ink)
                Text(
                    label,
                    style = InkTheme.type.micro,
                    color = colors.muted,
                    maxLines = 1,
                )
            }
        }
    }
}
