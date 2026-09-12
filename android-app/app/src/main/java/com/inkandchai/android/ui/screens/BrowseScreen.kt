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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.inkandchai.android.AppViewModel
import com.inkandchai.android.data.Book
import com.inkandchai.android.ui.components.AddButton
import com.inkandchai.android.ui.components.CategoryChip
import com.inkandchai.android.ui.components.CoverFill
import com.inkandchai.android.ui.components.DiscountBadge
import com.inkandchai.android.ui.components.InkIcons
import com.inkandchai.android.ui.components.LoadingRow
import com.inkandchai.android.ui.components.PriceRow
import com.inkandchai.android.ui.components.TruncatedTitle
import com.inkandchai.android.ui.theme.InkShape
import com.inkandchai.android.ui.theme.InkTheme
import com.inkandchai.android.ui.theme.ScreenPadding
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter

@OptIn(FlowPreview::class)
@Composable
fun BrowseScreen(
    vm: AppViewModel,
    onOpenBook: (Book) -> Unit,
    contentPadding: PaddingValues,
) {
    val state by vm.browse.collectAsState()
    val colors = InkTheme.colors
    val listState = rememberLazyListState()
    var typed by remember { mutableStateOf(state.query) }

    // Debounce the field rather than the network call: firing a request per
    // keystroke on an Indian mobile connection queues four slow responses that
    // then arrive out of order.
    LaunchedEffect(Unit) {
        snapshotFlow { typed }
            .debounce(250)
            .distinctUntilChanged()
            .collect { vm.setQuery(it) }
    }

    // Infinite scroll: append when the last visible item is within ~4 rows of
    // the end, which is roughly the 300px the prototype used.
    val shouldLoadMore by remember {
        derivedStateOf {
            val last = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            val total = listState.layoutInfo.totalItemsCount
            total > 0 && last >= total - 4
        }
    }
    LaunchedEffect(listState) {
        snapshotFlow { shouldLoadMore }.filter { it }.collect { vm.loadMore() }
    }

    Column(Modifier.fillMaxSize().background(colors.bg)) {
        Column(
            Modifier
                .background(colors.bg)
                .padding(top = contentPadding.calculateTopPadding())
                .padding(bottom = 10.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            SearchField(
                value = typed,
                onValueChange = { typed = it },
                modifier = Modifier.padding(horizontal = ScreenPadding),
            )
            LazyRow(
                contentPadding = PaddingValues(horizontal = ScreenPadding),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(HomeCategories) { category ->
                    CategoryChip(category, selected = state.category == category) {
                        vm.setCategory(category)
                    }
                }
            }
        }

        if (state.loading) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = colors.accent, strokeWidth = 2.dp)
            }
            return@Column
        }

        if (state.books.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(
                    "No matches — try another search.",
                    style = InkTheme.type.body,
                    color = colors.muted,
                )
            }
            return@Column
        }

        LazyColumn(
            state = listState,
            contentPadding = PaddingValues(bottom = contentPadding.calculateBottomPadding()),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            item {
                Text(
                    "${state.total} book${if (state.total == 1) "" else "s"}",
                    style = InkTheme.type.secondary,
                    color = colors.muted,
                    modifier = Modifier.padding(horizontal = ScreenPadding),
                )
            }
            items(state.books.chunked(2), key = { it.first().slug }) { pair ->
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = ScreenPadding),
                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    pair.forEach { book ->
                        Box(Modifier.weight(1f)) {
                            ResultCard(book, onOpenBook) { vm.addToCart(book) }
                        }
                    }
                    if (pair.size == 1) Spacer(Modifier.weight(1f))
                }
            }
            if (state.loadingMore) item { LoadingRow() }
        }
    }
}

@Composable
private fun SearchField(value: String, onValueChange: (String) -> Unit, modifier: Modifier = Modifier) {
    val colors = InkTheme.colors
    Row(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(InkShape.pill))
            .background(colors.card)
            .padding(horizontal = 18.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(InkIcons.Search, null, tint = colors.muted, modifier = Modifier.size(18.dp))
        Box(Modifier.weight(1f)) {
            if (value.isEmpty()) {
                Text("Search by title or author", style = InkTheme.type.body, color = colors.muted)
            }
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                singleLine = true,
                textStyle = InkTheme.type.body.copy(color = colors.ink),
                cursorBrush = SolidColor(colors.accent),
                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = ImeAction.Search),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (value.isNotEmpty()) {
            Text(
                "Clear",
                style = InkTheme.type.label,
                color = colors.accent,
                modifier = Modifier.clickable { onValueChange("") },
            )
        }
    }
}

@Composable
private fun ResultCard(book: Book, onOpen: (Book) -> Unit, onAdd: () -> Unit) {
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
