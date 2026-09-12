package com.inkandchai.android.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonElement

/**
 * One normalised book for the whole UI.
 *
 * The three catalogue endpoints disagree about field names and types --
 * catalog-search returns price as the string "799", homepage-merchandising as
 * "549.00" under price_inr, get-book as the number 799 -- so every wire type
 * below converts into this and nothing above the data layer ever sees the
 * difference.
 */
data class Book(
    val slug: String,
    val title: String,
    val author: String = "",
    val category: String = "",
    val description: String = "",
    val price: Int = 0,
    val mrp: Int = 0,
    val image: String = "",
    val noCod: Boolean = false,
) {
    /** Whole-rupee percentage, matching how the site renders the badge. */
    val discountPercent: Int
        get() = if (mrp > price && price > 0) ((mrp - price) * 100.0 / mrp).toInt() else 0

    val hasDiscount: Boolean get() = discountPercent > 0
}

/** Prices arrive as "799", "549.00" or 799 depending on the endpoint. */
internal fun JsonElement?.asRupees(): Int {
    val p = this as? JsonPrimitive ?: return 0
    val raw = p.contentOrNullSafe() ?: return 0
    return raw.trim().toDoubleOrNull()?.toInt() ?: 0
}

private fun JsonPrimitive.contentOrNullSafe(): String? = try { content } catch (e: Exception) { null }

@Serializable
data class CatalogSearchResponse(
    val books: List<CatalogBook> = emptyList(),
    val total: Int = 0,
    val page: Int = 1,
    val pages: Int = 0,
)

@Serializable
data class CatalogBook(
    val slug: String = "",
    val title: String = "",
    val price: JsonElement? = null,
    @SerialName("original_price") val originalPrice: JsonElement? = null,
    val img: String = "",
    @SerialName("no_cod") val noCod: Boolean = false,
) {
    fun toBook() = Book(
        slug = slug,
        title = title,
        price = price.asRupees(),
        mrp = originalPrice.asRupees(),
        image = img,
        noCod = noCod,
    )
}

@Serializable
data class MerchandisingResponse(
    @SerialName("new_arrivals") val newArrivals: List<MerchBook> = emptyList(),
    val bestsellers: List<MerchBook> = emptyList(),
)

@Serializable
data class MerchBook(
    val slug: String = "",
    val title: String = "",
    val author: String = "",
    val category: String = "",
    val description: String = "",
    @SerialName("price_inr") val priceInr: JsonElement? = null,
    @SerialName("original_price_inr") val mrpInr: JsonElement? = null,
    @SerialName("image_url") val imageUrl: String = "",
) {
    fun toBook() = Book(
        slug = slug,
        title = title,
        author = author,
        category = category,
        description = description,
        price = priceInr.asRupees(),
        mrp = mrpInr.asRupees(),
        image = imageUrl,
    )
}

@Serializable
data class GetBookResponse(
    val slug: String = "",
    val title: String = "",
    val author: String = "",
    val price: JsonElement? = null,
    @SerialName("orig_price") val origPrice: JsonElement? = null,
    val img: String = "",
) {
    fun toBook() = Book(
        slug = slug,
        title = title,
        author = author,
        price = price.asRupees(),
        mrp = origPrice.asRupees(),
        image = img,
    )
}

@Serializable
data class FrequentlyBoughtResponse(
    val recommendations: List<CatalogBook> = emptyList(),
)

// ── Checkout ────────────────────────────────────────────────────────────────

/**
 * The cart line the server expects. Only slug and qty are load-bearing:
 * netlify/functions/utils/pricing.js re-resolves every price from
 * custom_products server-side, so a tampered or stale client price can never
 * become the charged amount. Title and price ride along for the order record.
 */
@Serializable
data class CartLine(
    val slug: String,
    val id: String,
    val title: String,
    val price: Int,
    val qty: Int,
    val img: String = "",
)

@Serializable
data class Customer(
    val name: String,
    val phone: String,
    val email: String = "",
    val address: String,
    @SerialName("whatsapp_optin") val whatsappOptin: Boolean = true,
)

@Serializable
data class CodOrderRequest(
    val cart: List<CartLine>,
    val customer: Customer,
    val amount: Int,
    val shipping: Int,
    @SerialName("order_source") val orderSource: String = "android",
)

@Serializable
data class PhonePeOrderRequest(
    val cart: List<CartLine>,
    val customer: Customer,
    @SerialName("payment_mode") val paymentMode: String = "online",
    val coupon: String = "",
    @SerialName("order_source") val orderSource: String = "android",
)

@Serializable
data class OrderResponse(
    val success: Boolean = false,
    @SerialName("order_id") val orderId: String = "",
    @SerialName("redirect_url") val redirectUrl: String = "",
    val error: String = "",
)

@Serializable
data class PincodeResponse(
    val city: String = "",
    val state: String = "",
    val ok: Boolean = true,
)

// ── Tracking ────────────────────────────────────────────────────────────────

@Serializable
data class TrackOrderResponse(
    val found: Boolean = false,
    @SerialName("order_id") val orderId: String = "",
    val status: String = "",
    @SerialName("created_at") val createdAt: String = "",
    val total: JsonElement? = null,
    val courier: String = "",
    @SerialName("tracking_id") val trackingId: String = "",
    @SerialName("tracking_url") val trackingUrl: String = "",
    @SerialName("cart_items") val items: List<TrackItem> = emptyList(),
    val address: String = "",
    val error: String = "",
)

@Serializable
data class TrackItem(
    val title: String = "",
    val slug: String = "",
    val img: String = "",
    val price: JsonElement? = null,
    val qty: Int = 1,
)
