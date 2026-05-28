package com.superproductivity.superproductivity.service

import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * Regression guard for #7818 ("app cannot run in the background").
 *
 * Both foreground services used to override `onTaskRemoved` to stop themselves
 * when the app was swiped from recents, which killed the native countdown and
 * the ongoing notification — defeating the purpose of a foreground service.
 * Re-introducing such an override would re-break background timing/tracking, so
 * we assert the override stays absent. The default [android.app.Service]
 * implementation is a no-op, which is exactly what keeps the service alive.
 *
 * This is a structural (reflection-only) check on purpose: it loads the class
 * but never instantiates the service or calls any framework method, so it runs
 * as a plain JVM unit test with no Robolectric/device dependency.
 */
class ForegroundServiceTaskRemovalTest {

    private fun declaresOnTaskRemoved(serviceClass: Class<*>): Boolean =
        serviceClass.declaredMethods.any { it.name == "onTaskRemoved" }

    @Test
    fun `FocusModeForegroundService does not override onTaskRemoved (must survive app swipe)`() {
        assertFalse(
            "FocusModeForegroundService must NOT override onTaskRemoved — a self-stopping " +
                "override re-breaks #7818 (focus timer dies when app is swiped from recents).",
            declaresOnTaskRemoved(FocusModeForegroundService::class.java),
        )
    }

    @Test
    fun `TrackingForegroundService does not override onTaskRemoved (must survive app swipe)`() {
        assertFalse(
            "TrackingForegroundService must NOT override onTaskRemoved — a self-stopping " +
                "override re-breaks #7818 (time tracking dies when app is swiped from recents).",
            declaresOnTaskRemoved(TrackingForegroundService::class.java),
        )
    }
}
