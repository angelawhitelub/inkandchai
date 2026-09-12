package com.inkandchai.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.inkandchai.android.AppViewModel
import com.inkandchai.android.data.Book
import com.inkandchai.android.ui.components.InkIcons
import com.inkandchai.android.ui.components.InkToast
import com.inkandchai.android.ui.screens.AccountScreen
import com.inkandchai.android.ui.screens.BrowseScreen
import com.inkandchai.android.ui.screens.CartScreen
import com.inkandchai.android.ui.screens.CheckoutScreen
import com.inkandchai.android.ui.screens.DetailScreen
import com.inkandchai.android.ui.screens.HomeScreen
import com.inkandchai.android.ui.screens.OrdersScreen
import com.inkandchai.android.ui.screens.SuccessScreen
import com.inkandchai.android.ui.screens.TrackScreen
import com.inkandchai.android.ui.screens.WishlistScreen
import com.inkandchai.android.ui.theme.InkTheme
import kotlinx.coroutines.delay

object Routes {
    const val HOME = "home"
    const val BROWSE = "browse"
    const val CART = "cart"
    const val ACCOUNT = "account"
    const val DETAIL = "detail/{slug}"
    const val CHECKOUT = "checkout"
    const val SUCCESS = "success/{orderId}"
    const val ORDERS = "orders"
    const val TRACK = "track/{orderId}"
    const val WISHLIST = "wishlist"

    fun detail(slug: String) = "detail/$slug"
    fun success(orderId: String) = "success/$orderId"
    fun track(orderId: String) = "track/$orderId"
}

private data class Tab(val route: String, val label: String, val icon: ImageVector)

private val TABS = listOf(
    Tab(Routes.HOME, "Home", InkIcons.Home),
    Tab(Routes.BROWSE, "Search", InkIcons.Search),
    Tab(Routes.CART, "Cart", InkIcons.Cart),
    Tab(Routes.ACCOUNT, "Account", InkIcons.Account),
)

@Composable
fun InkAndChaiApp(vm: AppViewModel, pendingOrderId: String?) {
    val nav = rememberNavController()
    val entry by nav.currentBackStackEntryAsState()
    val toast by vm.toast.collectAsState()
    val cart by vm.cart.collectAsState()
    val colors = InkTheme.colors

    // A PhonePe return arrives as a deep link while the app is already alive.
    LaunchedEffect(pendingOrderId) {
        if (!pendingOrderId.isNullOrBlank()) {
            vm.clearCart()
            vm.removeCoupon()
            nav.navigate(Routes.success(pendingOrderId))
        }
    }

    LaunchedEffect(toast) {
        if (toast != null) {
            delay(1600)
            vm.clearToast()
        }
    }

    val statusInset = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val navInset = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    val showBar = entry?.destination?.route in TABS.map { it.route }
    val barHeight = if (showBar) 64.dp else 0.dp

    val padding = PaddingValues(
        top = statusInset + 8.dp,
        bottom = barHeight + navInset + 8.dp,
    )

    Box(Modifier.fillMaxSize().background(colors.bg)) {
        NavHost(navController = nav, startDestination = Routes.HOME) {

            composable(Routes.HOME) {
                HomeScreen(
                    vm = vm,
                    onOpenBook = { nav.openBook(vm, it) },
                    onOpenSearch = { nav.navigate(Routes.BROWSE) },
                    onPickCategory = {
                        vm.setCategory(it)
                        nav.navigate(Routes.BROWSE)
                    },
                    contentPadding = padding,
                )
            }

            composable(Routes.BROWSE) {
                BrowseScreen(vm, { nav.openBook(vm, it) }, padding)
            }

            composable(Routes.CART) {
                CartScreen(
                    vm = vm,
                    onBrowse = { nav.navigate(Routes.BROWSE) },
                    onCheckout = { nav.navigate(Routes.CHECKOUT) },
                    contentPadding = padding,
                )
            }

            composable(Routes.ACCOUNT) {
                AccountScreen(
                    vm = vm,
                    onOrders = { nav.navigate(Routes.ORDERS) },
                    onWishlist = { nav.navigate(Routes.WISHLIST) },
                    contentPadding = padding,
                )
            }

            composable(Routes.DETAIL) {
                DetailScreen(
                    vm = vm,
                    onBack = { nav.popBackStack() },
                    onOpenBook = { nav.openBook(vm, it) },
                    onBuyNow = { nav.navigate(Routes.CHECKOUT) },
                    contentPadding = padding,
                )
            }

            composable(Routes.CHECKOUT) {
                CheckoutScreen(
                    vm = vm,
                    onBack = { nav.popBackStack() },
                    onPlaced = { orderId ->
                        nav.navigate(Routes.success(orderId)) {
                            popUpTo(Routes.HOME)
                        }
                    },
                    contentPadding = padding,
                )
            }

            composable(Routes.SUCCESS) { backStack ->
                SuccessScreen(
                    vm = vm,
                    orderId = backStack.arg("orderId"),
                    onTrack = { nav.navigate(Routes.track(it)) },
                    onKeepShopping = {
                        nav.navigate(Routes.HOME) { popUpTo(Routes.HOME) { inclusive = true } }
                    },
                    contentPadding = padding,
                )
            }

            composable(Routes.ORDERS) {
                OrdersScreen(
                    vm = vm,
                    onBack = { nav.popBackStack() },
                    onTrack = { nav.navigate(Routes.track(it)) },
                    contentPadding = padding,
                )
            }

            composable(Routes.TRACK) { backStack ->
                TrackScreen(vm, backStack.arg("orderId"), { nav.popBackStack() }, padding)
            }

            composable(Routes.WISHLIST) {
                WishlistScreen(vm, { nav.popBackStack() }, { nav.openBook(vm, it) }, padding)
            }
        }

        if (showBar) {
            BottomBar(
                current = entry?.destination?.route,
                cartCount = cart.sumOf { it.qty },
                bottomInset = navInset,
                onSelect = { route ->
                    nav.navigate(route) {
                        // Tabs are destinations, not a stack: re-tapping Home
                        // from three books deep should land on Home, not add a
                        // fourth entry.
                        popUpTo(Routes.HOME) { saveState = true }
                        launchSingleTop = true
                        restoreState = true
                    }
                },
                modifier = Modifier.align(Alignment.BottomCenter),
            )
        }

        InkToast(
            toast,
            Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = barHeight + navInset + 20.dp),
        )
    }
}

private fun NavBackStackEntry.arg(name: String): String =
    arguments?.getString(name).orEmpty()

private fun NavHostController.openBook(vm: AppViewModel, book: Book) {
    vm.loadBook(book.slug, seed = book)
    navigate(Routes.detail(book.slug))
}

@Composable
private fun BottomBar(
    current: String?,
    cartCount: Int,
    bottomInset: androidx.compose.ui.unit.Dp,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = InkTheme.colors
    Row(
        modifier
            .fillMaxWidth()
            .background(colors.card)
            .padding(top = 8.dp, bottom = 8.dp + bottomInset),
        horizontalArrangement = Arrangement.SpaceEvenly,
    ) {
        TABS.forEach { tab ->
            val selected = current == tab.route
            Column(
                Modifier
                    .clickable { onSelect(tab.route) }
                    .padding(horizontal = 14.dp, vertical = 6.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Box {
                    Icon(
                        tab.icon,
                        tab.label,
                        tint = if (selected) colors.accent else colors.muted,
                        modifier = Modifier.size(22.dp),
                    )
                    if (tab.route == Routes.CART && cartCount > 0) {
                        Box(
                            Modifier
                                .align(Alignment.TopEnd)
                                .padding(start = 10.dp)
                                .size(15.dp)
                                .clip(CircleShape)
                                .background(colors.accent),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                if (cartCount > 9) "9+" else "$cartCount",
                                style = InkTheme.type.micro.copy(fontSize = 8.5.sp),
                                color = Color.White,
                            )
                        }
                    }
                }
                Text(
                    tab.label,
                    style = InkTheme.type.navLabel,
                    color = if (selected) colors.accent else colors.muted,
                )
            }
        }
    }
}
