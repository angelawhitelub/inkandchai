package com.inkandchai.android.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext

data class HomeFeed(
    val editorsPick: Book? = null,
    val bestsellers: List<Book> = emptyList(),
    val hindiShelf: List<Book> = emptyList(),
    val newArrivals: List<Book> = emptyList(),
)

class Repository(private val service: InkService = Api.service) {

    /**
     * Home pulls three requests in parallel rather than in sequence -- on a
     * 3G connection in India the difference is the whole screen appearing at
     * once instead of section by section over four seconds.
     *
     * The Hindi shelf has no dedicated endpoint, so it is a catalogue search;
     * if it fails the band is simply omitted rather than failing the screen.
     */
    suspend fun homeFeed(): HomeFeed = withContext(Dispatchers.IO) {
        coroutineScope {
            val merchDeferred = async { runCatching { service.merchandising() }.getOrNull() }
            val hindiDeferred = async {
                runCatching { service.search(q = "hindi", perPage = 12).books.map { it.toBook() } }
                    .getOrDefault(emptyList())
            }

            val merch = merchDeferred.await()
            val bestsellers = merch?.bestsellers.orEmpty().map { it.toBook() }.filter { it.price > 0 }
            val arrivals = merch?.newArrivals.orEmpty().map { it.toBook() }.filter { it.price > 0 }

            HomeFeed(
                // The editor's pick is the first new arrival with real cover
                // art; the hero card is 96x144 and a missing image there is
                // the most visible possible empty state.
                editorsPick = arrivals.firstOrNull { it.image.isNotBlank() } ?: bestsellers.firstOrNull(),
                bestsellers = bestsellers,
                hindiShelf = hindiDeferred.await().filter { it.price > 0 },
                newArrivals = arrivals.drop(1),
            )
        }
    }

    suspend fun search(q: String, page: Int, perPage: Int = 24): Pair<List<Book>, Int> =
        withContext(Dispatchers.IO) {
            val res = service.search(q = q, page = page, perPage = perPage)
            res.books.map { it.toBook() }.filter { it.price > 0 } to res.total
        }

    suspend fun book(slug: String): Book = withContext(Dispatchers.IO) {
        service.book(slug).toBook()
    }

    suspend fun alsoLike(slug: String): List<Book> = withContext(Dispatchers.IO) {
        runCatching { service.alsoLike(slug).recommendations.map { it.toBook() } }
            .getOrDefault(emptyList())
            .filter { it.price > 0 && it.slug != slug }
            .take(10)
    }

    suspend fun pincode(pin: String): PincodeResponse? = withContext(Dispatchers.IO) {
        runCatching { service.pincode(pin) }.getOrNull()
    }

    suspend fun placeCod(request: CodOrderRequest): OrderResponse = withContext(Dispatchers.IO) {
        service.placeCodOrder(request)
    }

    suspend fun startPhonePe(request: PhonePeOrderRequest): OrderResponse = withContext(Dispatchers.IO) {
        service.startPhonePe(request)
    }

    suspend fun track(orderId: String, emailOrPhone: String): TrackOrderResponse =
        withContext(Dispatchers.IO) { service.track(orderId, emailOrPhone) }
}
