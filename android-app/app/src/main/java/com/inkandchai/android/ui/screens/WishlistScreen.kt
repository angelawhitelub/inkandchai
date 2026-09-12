package com.inkandchai.android.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import androidx.compose.ui.unit.dp
import com.inkandchai.android.AppViewModel
import com.inkandchai.android.data.Book
import com.inkandchai.android.data.rupees
import com.inkandchai.android.ui.components.Cover
import com.inkandchai.android.ui.components.GhostPill
import com.inkandchai.android.ui.theme.InkTheme
import com.inkandchai.android.ui.theme.ScreenPadding

@Composable
fun WishlistScreen(
    vm: AppViewModel,
    onBack: () -> Unit,
    onOpenBook: (Book) -> Unit,
    contentPadding: PaddingValues,
) {
    val colors = InkTheme.colors
    val slugs by vm.wishlist.collectAsState()
    var books by remember { mutableStateOf<List<Book>>(emptyList()) }

    // The wishlist stores slugs only, so the books are re-read on open. That
    // keeps a saved price from going stale on a screen people come back to
    // weeks later.
    LaunchedEffect(slugs) {
        books = slugs.mapNotNull { slug -> runCatching { vm.repository.book(slug) }.getOrNull() }
    }

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
            Text("Wishlist", style = InkTheme.type.screenTitle, color = colors.ink)
        }

        if (slugs.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(
                    "Nothing saved yet — tap the heart on any book.",
                    style = InkTheme.type.body,
                    color = colors.muted,
                )
            }
            return@Column
        }

        LazyColumn(
            contentPadding = PaddingValues(
                start = ScreenPadding,
                end = ScreenPadding,
                bottom = contentPadding.calculateBottomPadding() + 16.dp,
            ),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            items(books, key = { it.slug }) { book ->
                Row(
                    Modifier.fillMaxWidth().clickable { onOpenBook(book) },
                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    Cover(book.image, 60.dp, 90.dp, elevation = 4.dp)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(
                            book.title,
                            style = InkTheme.type.bookTitle,
                            color = colors.ink,
                            maxLines = 2,
                            overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                        )
                        Text(
                            "₹${book.price.rupees()}",
                            style = InkTheme.type.price,
                            color = colors.ink,
                        )
                        GhostPill("Add to cart", { vm.addToCart(book) })
                    }
                }
            }
        }
    }
}
