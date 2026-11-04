package com.edfornieles.earpiece

import android.content.Context
import android.net.Uri

/** Where the control room is, the phone key, and which slot this phone is. Set once per phone. */
data class Config(val base: String, val key: String, val device: Int) {
    companion object {
        private const val PREFS = "earpiece"

        /** Accepts the phone link from the control page, e.g. https://earpiece.edfornieles.com/p?k=abcd1234&device=1 */
        fun parse(link: String): Config? {
            val u = try { Uri.parse(link.trim()) } catch (_: Exception) { return null }
            val scheme = u.scheme ?: return null
            val host = u.host ?: return null
            val key = u.getQueryParameter("k") ?: return null
            val device = u.getQueryParameter("device")?.toIntOrNull() ?: 1
            val port = if (u.port > 0) ":${u.port}" else ""
            return Config("$scheme://$host$port", key, device)
        }

        fun load(ctx: Context): Config? {
            val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val base = p.getString("base", null) ?: return null
            val key = p.getString("key", null) ?: return null
            return Config(base, key, p.getInt("device", 1))
        }

        fun save(ctx: Context, c: Config) {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("base", c.base).putString("key", c.key).putInt("device", c.device).apply()
        }
    }
    fun link() = "$base/p?k=$key&device=$device"
}
