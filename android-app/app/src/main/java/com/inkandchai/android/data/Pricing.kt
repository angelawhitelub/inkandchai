package com.inkandchai.android.data

/**
 * A mirror of the storefront's checkout arithmetic.
 *
 * These constants MUST stay in step with public/checkout/index.html and
 * netlify/functions/cod-order.js. They exist here only so the cart can show a
 * total before the order is placed -- the server recomputes everything from
 * custom_products when the order is created, and the server's number is the
 * one that is charged. If the two ever disagree, the server is right and this
 * file is the bug.
 */
object Pricing {
    const val FREE_SHIPPING_THRESHOLD = 499
    const val SHIPPING_FEE = 40
    const val COD_HANDLING_FEE = 20
    const val COD_FEE_WAIVER_THRESHOLD = 999
    const val COD_MIN_SUBTOTAL = 199

    data class Coupon(
        val code: String,
        val percent: Int,
        val minSubtotal: Int,
        val onlineOnly: Boolean,
        val label: String,
    )

    /** Live codes only -- the expired seasonal ones are deliberately absent. */
    val coupons = listOf(
        Coupon("INKLOVE10", 10, 499, true, "10% prepaid discount"),
        Coupon("499HIT", 10, 499, true, "10% prepaid discount"),
        Coupon("SAVE12", 12, 999, true, "12% prepaid discount"),
        Coupon("SAVE15", 15, 1499, true, "15% prepaid discount"),
    )

    fun findCoupon(code: String): Coupon? =
        coupons.firstOrNull { it.code.equals(code.trim(), ignoreCase = true) }

    fun shipping(subtotalAfterDiscount: Int): Int =
        if (subtotalAfterDiscount >= FREE_SHIPPING_THRESHOLD) 0 else SHIPPING_FEE

    fun codFee(subtotal: Int): Int =
        if (subtotal >= COD_FEE_WAIVER_THRESHOLD) 0 else COD_HANDLING_FEE
}

data class Totals(
    val subtotal: Int,
    val discount: Int,
    val shipping: Int,
    val codFee: Int,
) {
    val total: Int get() = subtotal - discount + shipping + codFee
    val freeShipping: Boolean get() = shipping == 0 && subtotal > 0
}

fun computeTotals(
    lines: List<CartEntry>,
    coupon: Pricing.Coupon?,
    cod: Boolean,
): Totals {
    val subtotal = lines.sumOf { it.book.price * it.qty }
    // A prepaid-only coupon must not quietly discount a COD basket: the server
    // rejects it, so showing it here would under-quote what is collected at
    // the door.
    val usable = coupon != null && subtotal >= coupon.minSubtotal && !(coupon.onlineOnly && cod)
    val discount = if (usable && coupon != null) subtotal * coupon.percent / 100 else 0
    return Totals(
        subtotal = subtotal,
        discount = discount,
        shipping = Pricing.shipping(subtotal - discount),
        codFee = if (cod) Pricing.codFee(subtotal) else 0,
    )
}

/** Indian digit grouping, e.g. 1,23,456 -- not the Western 123,456. */
fun Int.rupees(): String {
    val s = this.toString()
    if (s.length <= 3) return s
    val last3 = s.takeLast(3)
    val rest = s.dropLast(3)
    val grouped = rest.reversed().chunked(2).joinToString(",").reversed()
    return "$grouped,$last3"
}
