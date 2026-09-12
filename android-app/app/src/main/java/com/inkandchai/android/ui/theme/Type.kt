package com.inkandchai.android.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.googlefonts.Font
import androidx.compose.ui.text.googlefonts.GoogleFont
import androidx.compose.ui.unit.sp
import com.inkandchai.android.R

/**
 * Newsreader (display/serif) and Manrope (body/UI), as specified.
 *
 * These are pulled through the Play Services downloadable-fonts provider
 * instead of being bundled in res/font: it keeps ~700KB of TTF out of the APK
 * and the provider caches system-wide. The trade-off is that the very first
 * launch on a device that has never fetched them falls back to the platform
 * serif/sans for a frame or two. If that ever shows up in a store screenshot,
 * bundle the TTFs and swap FontFamily here -- nothing else needs to change.
 */
private val provider = GoogleFont.Provider(
    providerAuthority = "com.google.android.gms.fonts",
    providerPackage = "com.google.android.gms",
    certificates = R.array.com_google_android_gms_fonts_certs,
)

private val newsreaderFont = GoogleFont("Newsreader")
private val manropeFont = GoogleFont("Manrope")

val Newsreader = FontFamily(
    Font(googleFont = newsreaderFont, fontProvider = provider, weight = FontWeight.Normal),
    Font(googleFont = newsreaderFont, fontProvider = provider, weight = FontWeight.Medium),
    Font(googleFont = newsreaderFont, fontProvider = provider, weight = FontWeight.SemiBold),
    Font(googleFont = newsreaderFont, fontProvider = provider, weight = FontWeight.Bold),
    Font(googleFont = newsreaderFont, fontProvider = provider, weight = FontWeight.Medium, style = FontStyle.Italic),
)

val Manrope = FontFamily(
    Font(googleFont = manropeFont, fontProvider = provider, weight = FontWeight.Normal),
    Font(googleFont = manropeFont, fontProvider = provider, weight = FontWeight.Medium),
    Font(googleFont = manropeFont, fontProvider = provider, weight = FontWeight.SemiBold),
    Font(googleFont = manropeFont, fontProvider = provider, weight = FontWeight.Bold),
    Font(googleFont = manropeFont, fontProvider = provider, weight = FontWeight.ExtraBold),
)

/**
 * The handoff's scale, kept as named roles so screens never hard-code sizes:
 * 26 (detail title) / 22-23 (screen titles) / 20-21 (section headers) /
 * 17-18 (sub-headers) / 14-15 (body, buttons) / 12-13 (secondary) /
 * 10-11 (micro labels and badges).
 */
@Immutable
data class InkTypography(
    val detailTitle: TextStyle = TextStyle(fontFamily = Newsreader, fontWeight = FontWeight.SemiBold, fontSize = 26.sp, lineHeight = 32.sp),
    val screenTitle: TextStyle = TextStyle(fontFamily = Newsreader, fontWeight = FontWeight.SemiBold, fontSize = 23.sp, lineHeight = 28.sp),
    val sectionHeader: TextStyle = TextStyle(fontFamily = Newsreader, fontWeight = FontWeight.SemiBold, fontSize = 21.sp, lineHeight = 26.sp),
    val subHeader: TextStyle = TextStyle(fontFamily = Newsreader, fontWeight = FontWeight.Medium, fontSize = 18.sp, lineHeight = 23.sp),
    val bookTitle: TextStyle = TextStyle(fontFamily = Newsreader, fontWeight = FontWeight.Medium, fontSize = 15.sp, lineHeight = 19.sp),
    val price: TextStyle = TextStyle(fontFamily = Newsreader, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, lineHeight = 20.sp),
    val body: TextStyle = TextStyle(fontFamily = Manrope, fontWeight = FontWeight.Normal, fontSize = 14.sp, lineHeight = 21.sp),
    val bodyStrong: TextStyle = TextStyle(fontFamily = Manrope, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, lineHeight = 20.sp),
    val button: TextStyle = TextStyle(fontFamily = Manrope, fontWeight = FontWeight.Bold, fontSize = 15.sp, lineHeight = 18.sp),
    val label: TextStyle = TextStyle(fontFamily = Manrope, fontWeight = FontWeight.Medium, fontSize = 13.sp, lineHeight = 18.sp),
    val secondary: TextStyle = TextStyle(fontFamily = Manrope, fontWeight = FontWeight.Normal, fontSize = 12.sp, lineHeight = 17.sp),
    val micro: TextStyle = TextStyle(fontFamily = Manrope, fontWeight = FontWeight.Bold, fontSize = 10.sp, lineHeight = 13.sp),
    val navLabel: TextStyle = TextStyle(fontFamily = Manrope, fontWeight = FontWeight.SemiBold, fontSize = 11.sp, lineHeight = 14.sp),
)
