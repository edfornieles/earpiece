package com.edfornieles.earpiece

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import android.provider.Settings

/** Where the control room is, the phone key, and which phone number this is (0 = take the next free one). */
data class Config(val base: String, val key: String, val device: Int) {
    companion object {
        private const val PREFS = "earpiece"

        /** Accepts the "Connect this phone" link (earpiece://connect?server=…&k=…) or the phone link
         *  from the control room (https://…/p?k=…&device=N). */
        fun parse(link: String): Config? {
            val u = try { Uri.parse(link.trim()) } catch (_: Exception) { return null }
            val key = u.getQueryParameter("k") ?: return null
            val device = u.getQueryParameter("device")?.toIntOrNull() ?: 0
            if (u.scheme == "earpiece") {
                val server = u.getQueryParameter("server")?.trimEnd('/') ?: return null
                if (!server.startsWith("http")) return null
                return Config(server, key, device)
            }
            val scheme = u.scheme ?: return null
            val host = u.host ?: return null
            val port = if (u.port > 0) ":${u.port}" else ""
            return Config("$scheme://$host$port", key, device)
        }

        fun load(ctx: Context): Config? {
            val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val base = p.getString("base", null) ?: return null
            val key = p.getString("key", null) ?: return null
            return Config(base, key, p.getInt("device", 0))
        }

        fun save(ctx: Context, c: Config) {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("base", c.base).putString("key", c.key).putInt("device", c.device).apply()
        }

        fun setDevice(ctx: Context, n: Int) {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putInt("device", n).apply()
        }

        /** The earbuds that belong to this phone (by name), so a mix-up shows. */
        fun expectedHeadset(ctx: Context): String = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("headset", "") ?: ""
        fun setExpectedHeadset(ctx: Context, name: String) {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("headset", name).apply()
        }

        /** Tells this phone apart from the others when it reconnects. */
        @SuppressLint("HardwareIds")
        fun deviceId(ctx: Context): String = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ANDROID_ID) ?: "unknown"

        /** One colour per phone number, matching the control room. Stick the same colour on the phone and its earbuds. */
        val COLORS = intArrayOf(0xFF8A8780.toInt(), 0xFFE5533A.toInt(), 0xFF3D7BE0.toInt(), 0xFFE8C33A.toInt(), 0xFF4CAF6A.toInt(),
            0xFF9B5DE5.toInt(), 0xFFF08A3C.toInt(), 0xFF2CB5B5.toInt(), 0xFFE05FA8.toInt())
        val COLOR_NAMES = arrayOf("", "red", "blue", "yellow", "green", "purple", "orange", "teal", "pink")
        fun color(n: Int) = COLORS[if (n in 1..8) n else 0]
    }
    fun link() = "$base/p?k=$key&device=$device"
}
