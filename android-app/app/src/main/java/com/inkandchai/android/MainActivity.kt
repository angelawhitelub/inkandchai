package com.inkandchai.android

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.lifecycle.viewmodel.compose.viewModel
import com.inkandchai.android.ui.InkAndChaiApp
import com.inkandchai.android.ui.theme.InkAndChaiTheme

class MainActivity : ComponentActivity() {

    private var pendingOrderId by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        pendingOrderId = orderIdFrom(intent)

        setContent {
            val vm: AppViewModel = viewModel()
            val themePref by vm.theme.collectAsState()
            val dark = when (themePref) {
                "dark" -> true
                "light" -> false
                else -> isSystemInDarkTheme()
            }
            InkAndChaiTheme(darkTheme = dark) {
                InkAndChaiApp(vm = vm, pendingOrderId = pendingOrderId)
            }
        }
    }

    /**
     * singleTask, so the PhonePe return lands here rather than in a new
     * instance. Clearing the field after reading it stops the same order id
     * re-navigating to Success on every configuration change.
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        pendingOrderId = orderIdFrom(intent)
    }

    private fun orderIdFrom(intent: Intent?): String? =
        intent?.data?.takeIf { it.path?.startsWith("/app/paid") == true }?.getQueryParameter("id")
}
