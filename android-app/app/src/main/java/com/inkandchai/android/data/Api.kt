package com.inkandchai.android.data

import com.jakewharton.retrofit2.converter.kotlinx.serialization.asConverterFactory
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import retrofit2.Retrofit
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Query
import java.util.concurrent.TimeUnit

/**
 * The app talks to the SAME serverless endpoints the website does.
 *
 * This is deliberate and worth stating plainly: pricing, coupons, the Freedom
 * Sale, COD eligibility, pincode serviceability, PhonePe and the order record
 * all live behind these functions and are already reconciled against real
 * money. Reimplementing any of that natively would mean two implementations
 * that have to agree forever, and the one in the app would be the untested
 * one. So the app owns the UI and nothing else.
 */
object Api {
    const val BASE = "https://inkandchai.in/"
    private const val FN = ".netlify/functions/"

    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        explicitNulls = false
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    val service: InkService by lazy {
        Retrofit.Builder()
            .baseUrl(BASE)
            .client(client)
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
            .create(InkService::class.java)
    }

    /**
     * Supabase-hosted covers are served through the site's own image proxy;
     * absolute CDN URLs (Shopify etc.) are already fine. A bare path needs the
     * origin prefixed or Coil gets a relative URL it cannot resolve.
     */
    fun imageUrl(raw: String): String = when {
        raw.isBlank() -> ""
        raw.startsWith("http") -> raw
        raw.startsWith("/") -> "https://inkandchai.in$raw"
        else -> "https://inkandchai.in/$raw"
    }

    const val FN_PATH = FN
}

interface InkService {

    @GET(Api.FN_PATH + "catalog-search")
    suspend fun search(
        @Query("q") q: String = "",
        @Query("page") page: Int = 1,
        @Query("per_page") perPage: Int = 24,
        @Query("sort") sort: String = "new",
    ): CatalogSearchResponse

    @GET(Api.FN_PATH + "homepage-merchandising")
    suspend fun merchandising(): MerchandisingResponse

    @GET(Api.FN_PATH + "get-book")
    suspend fun book(@Query("id") slug: String): GetBookResponse

    @GET(Api.FN_PATH + "frequently-bought")
    suspend fun alsoLike(@Query("slug") slug: String): FrequentlyBoughtResponse

    @GET(Api.FN_PATH + "pincode-lookup")
    suspend fun pincode(@Query("pin") pin: String): PincodeResponse

    @POST(Api.FN_PATH + "cod-order")
    suspend fun placeCodOrder(@Body body: CodOrderRequest): OrderResponse

    @POST(Api.FN_PATH + "phonepe-create-order")
    suspend fun startPhonePe(@Body body: PhonePeOrderRequest): OrderResponse

    @GET(Api.FN_PATH + "track-order")
    suspend fun track(
        @Query("id") orderId: String,
        @Query("q") emailOrPhone: String,
    ): TrackOrderResponse
}
