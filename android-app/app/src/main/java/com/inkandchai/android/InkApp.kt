package com.inkandchai.android

import android.app.Application
import com.inkandchai.android.data.AppStore

class InkApp : Application() {
    lateinit var store: AppStore
        private set

    override fun onCreate() {
        super.onCreate()
        store = AppStore(this)
    }
}
