package com.inkandchai.android

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.inkandchai.android.data.Book
import com.inkandchai.android.data.BookSnapshot
import com.inkandchai.android.data.CartEntry
import com.inkandchai.android.data.HomeFeed
import com.inkandchai.android.data.PlacedOrder
import com.inkandchai.android.data.Pricing
import com.inkandchai.android.data.Repository
import com.inkandchai.android.data.SavedAddress
import com.inkandchai.android.data.Totals
import com.inkandchai.android.data.computeTotals
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

data class HomeState(
    val loading: Boolean = true,
    val feed: HomeFeed = HomeFeed(),
    val error: String? = null,
)

data class BrowseState(
    val query: String = "",
    val category: String = "All",
    val books: List<Book> = emptyList(),
    val total: Int = 0,
    val page: Int = 1,
    val loading: Boolean = false,
    val loadingMore: Boolean = false,
    val endReached: Boolean = false,
)

data class DetailState(
    val loading: Boolean = true,
    val book: Book? = null,
    val alsoLike: List<Book> = emptyList(),
)

class AppViewModel(app: Application) : AndroidViewModel(app) {

    private val store = (app as InkApp).store
    private val repo = Repository()

    val cart: StateFlow<List<CartEntry>> =
        store.cart.stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val wishlist: StateFlow<Set<String>> =
        store.wishlist.stateIn(viewModelScope, SharingStarted.Eagerly, emptySet())
    val theme: StateFlow<String> =
        store.theme.stateIn(viewModelScope, SharingStarted.Eagerly, "light")
    val savedAddress: StateFlow<SavedAddress> =
        store.address.stateIn(viewModelScope, SharingStarted.Eagerly, SavedAddress())
    val orders: StateFlow<List<PlacedOrder>> =
        store.orders.stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    private val _home = MutableStateFlow(HomeState())
    val home = _home.asStateFlow()

    private val _browse = MutableStateFlow(BrowseState())
    val browse = _browse.asStateFlow()

    private val _detail = MutableStateFlow(DetailState())
    val detail = _detail.asStateFlow()

    private val _toast = MutableStateFlow<String?>(null)
    val toast = _toast.asStateFlow()

    private val _coupon = MutableStateFlow<Pricing.Coupon?>(null)
    val coupon = _coupon.asStateFlow()

    val cartCount: Int get() = cart.value.sumOf { it.qty }

    init {
        loadHome()
    }

    // ── Home ────────────────────────────────────────────────────────────────

    fun loadHome() {
        viewModelScope.launch {
            _home.value = HomeState(loading = true)
            runCatching { repo.homeFeed() }
                .onSuccess { _home.value = HomeState(loading = false, feed = it) }
                .onFailure {
                    _home.value = HomeState(
                        loading = false,
                        error = it.message ?: "Could not reach Ink & Chai",
                    )
                }
        }
    }

    // ── Browse ──────────────────────────────────────────────────────────────

    fun setQuery(q: String) {
        _browse.value = _browse.value.copy(query = q)
        runSearch(reset = true)
    }

    fun setCategory(category: String) {
        _browse.value = _browse.value.copy(category = category)
        runSearch(reset = true)
    }

    private var searchToken = 0

    fun runSearch(reset: Boolean) {
        val token = ++searchToken
        val state = _browse.value
        val page = if (reset) 1 else state.page + 1
        // The category chips are search terms, not a filter parameter: the
        // catalogue has no category column exposed by catalog-search, and
        // "Self-Help" as a title substring is a better match than nothing.
        val term = listOfNotNull(
            state.query.takeIf { it.isNotBlank() },
            state.category.takeIf { it != "All" },
        ).joinToString(" ")

        _browse.value = state.copy(
            loading = reset,
            loadingMore = !reset,
        )
        viewModelScope.launch {
            runCatching { repo.search(term, page) }
                .onSuccess { (books, total) ->
                    // A slower earlier request must not overwrite a newer one.
                    if (token != searchToken) return@onSuccess
                    val current = _browse.value
                    val merged = if (reset) books else (current.books + books).distinctBy { it.slug }
                    _browse.value = current.copy(
                        books = merged,
                        total = total,
                        page = page,
                        loading = false,
                        loadingMore = false,
                        endReached = books.isEmpty() || merged.size >= total,
                    )
                }
                .onFailure {
                    if (token != searchToken) return@onFailure
                    _browse.value = _browse.value.copy(loading = false, loadingMore = false, endReached = true)
                }
        }
    }

    fun loadMore() {
        val s = _browse.value
        if (s.loading || s.loadingMore || s.endReached) return
        runSearch(reset = false)
    }

    // ── Detail ──────────────────────────────────────────────────────────────

    fun loadBook(slug: String, seed: Book? = null) {
        _detail.value = DetailState(loading = seed == null, book = seed)
        viewModelScope.launch {
            runCatching { repo.book(slug) }
                .onSuccess { fetched ->
                    // get-book has no description or category; if the list that
                    // opened this screen carried them, keep them rather than
                    // blanking the copy the user just saw.
                    val merged = fetched.copy(
                        author = fetched.author.ifBlank { seed?.author.orEmpty() },
                        category = seed?.category.orEmpty(),
                        description = seed?.description.orEmpty(),
                        image = fetched.image.ifBlank { seed?.image.orEmpty() },
                    )
                    _detail.value = _detail.value.copy(loading = false, book = merged)
                }
                .onFailure { _detail.value = _detail.value.copy(loading = false, book = seed) }
            _detail.value = _detail.value.copy(alsoLike = repo.alsoLike(slug))
        }
    }

    // ── Cart ────────────────────────────────────────────────────────────────

    fun addToCart(book: Book, qty: Int = 1, silent: Boolean = false) =
        addSnapshot(BookSnapshot.of(book), qty, silent)

    fun addSnapshot(snapshot: BookSnapshot, qty: Int = 1, silent: Boolean = false) {
        viewModelScope.launch {
            val current = cart.value.toMutableList()
            val index = current.indexOfFirst { it.book.slug == snapshot.slug }
            if (index >= 0) {
                current[index] = current[index].copy(qty = current[index].qty + qty)
            } else {
                current.add(CartEntry(snapshot, qty))
            }
            store.setCart(current)
            if (!silent) _toast.value = "Added to cart"
        }
    }

    fun setQty(slug: String, qty: Int) {
        viewModelScope.launch {
            val next = cart.value.mapNotNull {
                when {
                    it.book.slug != slug -> it
                    qty <= 0 -> null
                    else -> it.copy(qty = qty)
                }
            }
            store.setCart(next)
        }
    }

    fun removeFromCart(slug: String) = setQty(slug, 0)

    fun clearCart() {
        viewModelScope.launch { store.setCart(emptyList()) }
    }

    fun applyCoupon(code: String): Boolean {
        val found = Pricing.findCoupon(code)
        _coupon.value = found
        if (found == null) _toast.value = "That code is not valid"
        return found != null
    }

    fun removeCoupon() { _coupon.value = null }

    fun totals(cod: Boolean): Totals = computeTotals(cart.value, _coupon.value, cod)

    // ── Wishlist, theme, address ────────────────────────────────────────────

    fun toggleWishlist(slug: String) {
        viewModelScope.launch {
            val next = wishlist.value.toMutableSet()
            if (!next.remove(slug)) next.add(slug)
            store.setWishlist(next)
        }
    }

    fun setTheme(value: String) {
        viewModelScope.launch { store.setTheme(value) }
    }

    fun saveAddress(address: SavedAddress) {
        viewModelScope.launch { store.setAddress(address) }
    }

    fun recordOrder(order: PlacedOrder) {
        viewModelScope.launch { store.addOrder(order) }
    }

    fun showToast(message: String) { _toast.value = message }
    fun clearToast() { _toast.value = null }

    suspend fun lookupPincode(pin: String) = repo.pincode(pin)

    val repository: Repository get() = repo
}
