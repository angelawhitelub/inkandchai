package com.inkandchai.android.data

import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

private val Context.dataStore by preferencesDataStore(name = "inkandchai")

/**
 * Cart rows survive app restarts, so they persist a copy of the book rather
 * than a slug to look up. Prices here are display-only and can go stale
 * between sessions; the order endpoint re-resolves every line from
 * custom_products, so a stale copy can never become the charged amount.
 */
@Serializable
data class BookSnapshot(
    val slug: String,
    val title: String,
    val author: String = "",
    val price: Int = 0,
    val mrp: Int = 0,
    val image: String = "",
    val noCod: Boolean = false,
) {
    val discountPercent: Int
        get() = if (mrp > price && price > 0) ((mrp - price) * 100.0 / mrp).toInt() else 0

    companion object {
        fun of(b: Book) = BookSnapshot(b.slug, b.title, b.author, b.price, b.mrp, b.image, b.noCod)
    }
}

/** One cart line, resolved to the book so the cart renders without a refetch. */
@Serializable
data class CartEntry(val book: BookSnapshot, val qty: Int)

@Serializable
data class SavedAddress(
    val name: String = "",
    val phone: String = "",
    val email: String = "",
    val line: String = "",
    val city: String = "",
    val pincode: String = "",
)

@Serializable
data class PlacedOrder(
    val orderId: String,
    val placedAtMillis: Long,
    val total: Int,
    val titles: List<String>,
    val covers: List<String>,
    val phone: String,
)

class AppStore(private val context: Context) {

    private val json = Json { ignoreUnknownKeys = true }

    private object Keys {
        val CART = stringPreferencesKey("cart")
        val WISHLIST = stringPreferencesKey("wishlist")
        val THEME = stringPreferencesKey("theme")
        val ADDRESS = stringPreferencesKey("address")
        val ORDERS = stringPreferencesKey("orders")
    }

    private inline fun <reified T> Preferences.decode(key: Preferences.Key<String>, fallback: T): T =
        this[key]?.let { raw -> runCatching { json.decodeFromString<T>(raw) }.getOrNull() } ?: fallback

    val cart: Flow<List<CartEntry>> =
        context.dataStore.data.map { it.decode(Keys.CART, emptyList()) }

    val wishlist: Flow<Set<String>> =
        context.dataStore.data.map { it.decode<List<String>>(Keys.WISHLIST, emptyList()).toSet() }

    /** "light", "dark", or "system". The handoff's default is light. */
    val theme: Flow<String> = context.dataStore.data.map { it[Keys.THEME] ?: "light" }

    val address: Flow<SavedAddress> =
        context.dataStore.data.map { it.decode(Keys.ADDRESS, SavedAddress()) }

    val orders: Flow<List<PlacedOrder>> =
        context.dataStore.data.map { it.decode(Keys.ORDERS, emptyList()) }

    suspend fun setCart(entries: List<CartEntry>) {
        context.dataStore.edit { it[Keys.CART] = json.encodeToString(entries) }
    }

    suspend fun setWishlist(slugs: Set<String>) {
        context.dataStore.edit { it[Keys.WISHLIST] = json.encodeToString(slugs.toList()) }
    }

    suspend fun setTheme(value: String) {
        context.dataStore.edit { it[Keys.THEME] = value }
    }

    suspend fun setAddress(address: SavedAddress) {
        context.dataStore.edit { it[Keys.ADDRESS] = json.encodeToString(address) }
    }

    suspend fun addOrder(order: PlacedOrder) {
        context.dataStore.edit { prefs ->
            val existing: List<PlacedOrder> = prefs.decode(Keys.ORDERS, emptyList())
            // De-dupe on order id: a PhonePe return can deliver the same id
            // twice (deep link plus resumed activity) and two identical cards
            // in My Orders reads as a double charge.
            val merged = (listOf(order) + existing).distinctBy { it.orderId }.take(50)
            prefs[Keys.ORDERS] = json.encodeToString(merged)
        }
    }
}
