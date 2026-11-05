package com.edfornieles.earpiece

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.GridLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import kotlin.math.min

/**
 * The phone's own screen. Participants never see it: the phones are hardware kept at the desk, and
 * this screen is for you — which phone this is, whether it's connected, which earbuds it's using,
 * battery, and who's on it. Participants are started from the control room.
 */
class MainActivity : Activity() {

    private val ui = Handler(Looper.getMainLooper())
    private lateinit var status: LinearLayout
    private lateinit var settings: LinearLayout
    private lateinit var settingsScroll: ScrollView
    private lateinit var number: TextView
    private lateinit var colourName: TextView
    private lateinit var linkLine: TextView
    private lateinit var headsetLine: TextView
    private lateinit var batteryLine: TextView
    private lateinit var whoLine: TextView
    private lateinit var playBar: View
    private lateinit var micBar: View
    private lateinit var thisHeadset: Button
    private lateinit var linkField: EditText
    private lateinit var slotGrid: GridLayout
    private var lastTouch = System.currentTimeMillis()
    private var pinnedOnce = false

    private val BG = Color.rgb(11, 11, 11)
    private val FG = Color.rgb(232, 230, 225)
    private val DIM = Color.rgb(140, 137, 130)
    private val OK = Color.rgb(95, 190, 115)
    private val WARN = Color.rgb(240, 170, 80)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true) }
        buildUi()
        takeLink(intent)
        route()
    }

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); takeLink(intent); route() }

    /** "Connect this phone" (earpiece://connect…) or the setup script's link (am start … --es url "<link>"). */
    private fun takeLink(i: Intent?) {
        val link = i?.getStringExtra("url") ?: i?.dataString ?: return
        Config.parse(link)?.let { Config.save(this, it); restartService() }
    }

    private fun route() {
        if (Config.load(this) == null) { show(settings); return }
        val needed = mutableListOf(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= 33) needed += Manifest.permission.POST_NOTIFICATIONS
        val missing = needed.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) { requestPermissions(missing.toTypedArray(), 1); return }
        startService()
        if (!inSettings()) show(status)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) route()
        else AlertDialog.Builder(this).setMessage("The earpiece needs the microphone. Allow it in Settings → Apps → Mother → Permissions.").setPositiveButton("OK", null).show()
    }

    private fun startService(action: String? = null) {
        val i = Intent(this, AudioService::class.java).apply { if (action != null) setAction(action) }
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(i) else startService(i)
    }
    private fun restartService() { stopService(Intent(this, AudioService::class.java)); ui.postDelayed({ route() }, 300) }

    override fun onResume() {
        super.onResume()
        hideBars(); wake()
        ui.post(tick)
        if (!pinnedOnce && lockdown()) { pinnedOnce = true; try { startLockTask() } catch (_: Exception) {} }
    }
    override fun onPause() { super.onPause(); ui.removeCallbacks(tick) }

    // Gallery mode (in settings): pins the app and ignores Back. Off by default.
    private fun lockdown() = getSharedPreferences("earpiece", Context.MODE_PRIVATE).getBoolean("lockdown", false)
    @Deprecated("Back does nothing in gallery mode")
    override fun onBackPressed() {
        if (inSettings() && Config.load(this) != null) { show(status); return }
        if (!lockdown()) @Suppress("DEPRECATION") super.onBackPressed()
    }

    // The screen dims after two minutes untouched (phones sit at the desk), and wakes on a touch or Identify.
    override fun dispatchTouchEvent(ev: MotionEvent): Boolean { if (ev.action == MotionEvent.ACTION_DOWN) wake(); return super.dispatchTouchEvent(ev) }
    private fun wake() { lastTouch = System.currentTimeMillis(); setBrightness(-1f) }
    private fun setBrightness(b: Float) {
        val lp = window.attributes
        if (lp.screenBrightness != b) { lp.screenBrightness = b; window.attributes = lp }
    }

    private val tick = object : Runnable {
        override fun run() {
            val slot = if (AudioService.slot > 0) AudioService.slot else Config.load(this@MainActivity)?.device ?: 0
            val col = Config.color(slot)
            number.text = if (slot > 0) "$slot" else "–"
            colourName.text = if (slot in 1..8) "PHONE $slot · ${Config.COLOR_NAMES[slot].uppercase()}" else if (slot > 0) "PHONE $slot" else "PHONE"
            colourName.setTextColor(col)

            // Identify: flash the phone's colour for 6 seconds
            val since = System.currentTimeMillis() - AudioService.identifyAt
            val flashing = since < 6000
            if (flashing) { lastTouch = System.currentTimeMillis(); setBrightness(1f) }
            status.setBackgroundColor(if (flashing && (since / 250) % 2 == 0L) col else BG)
            number.setTextColor(if (flashing && (since / 250) % 2 == 0L) BG else col)
            if (!flashing && System.currentTimeMillis() - lastTouch > 120_000) setBrightness(0.02f)
            else if (!flashing && window.attributes.screenBrightness == 1f) setBrightness(-1f)

            line(linkLine, when {
                AudioService.connected -> "● Connected to the control room"
                else -> "○ " + AudioService.status.replaceFirstChar { it.uppercase() }
            }, if (AudioService.connected) OK else WARN)

            val expected = Config.expectedHeadset(this@MainActivity)
            when {
                !AudioService.headset -> line(headsetLine, "No headset — sound comes from the phone itself", WARN)
                expected.isNotEmpty() && AudioService.headsetName != expected -> line(headsetLine, "${AudioService.headsetName} — not this phone's earbuds ($expected)", WARN)
                else -> line(headsetLine, "${AudioService.headsetName}${if (expected.isNotEmpty()) " ✓" else ""}", if (expected.isNotEmpty()) OK else FG)
            }
            thisHeadset.visibility = if (AudioService.headset && AudioService.headsetName != expected) View.VISIBLE else View.GONE
            thisHeadset.text = "Make “${AudioService.headsetName}” this phone's headset"

            val bm = getSystemService(Context.BATTERY_SERVICE) as android.os.BatteryManager
            val pct = bm.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY)
            val charging = Build.VERSION.SDK_INT >= 23 && bm.isCharging
            line(batteryLine, "Battery $pct%${if (charging) " · charging" else ""}", if (pct in 0..19 && !charging) WARN else DIM)

            line(whoLine, when {
                AudioService.person.isNotEmpty() -> "On it now: ${AudioService.person}"
                AudioService.next.isNotEmpty() -> "Free · next: ${AudioService.next}${if (AudioService.standby) " (after Start session)" else ""}"
                else -> "Free"
            }, if (AudioService.person.isNotEmpty()) OK else DIM)

            playBar.scaleX = min(1f, AudioService.playLevel * 6f)
            micBar.scaleX = min(1f, AudioService.micLevel * 8f)
            if (slotGrid.tag != slot) { slotGrid.tag = slot; paintSlots(slot) }
            ui.postDelayed(this, 60)
        }
    }

    private fun line(t: TextView, s: String, c: Int) { if (t.text != s) t.text = s; t.setTextColor(c) }

    private fun show(v: View) {
        val showSettings = v === settings
        status.visibility = if (showSettings) View.GONE else View.VISIBLE
        settingsScroll.visibility = if (showSettings) View.VISIBLE else View.GONE
        if (showSettings) linkField.setText(Config.load(this)?.link() ?: "")
    }
    private fun inSettings() = settingsScroll.visibility == View.VISIBLE

    private fun hideBars() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_FULLSCREEN
            or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN)
    }

    // ---------------- layout (built in code, no XML) ----------------

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()
    private fun text(s: String, size: Float, color: Int = FG) = TextView(this).apply { text = s; textSize = size; setTextColor(color) }
    private fun gap(h: Int) = View(this).apply { layoutParams = LinearLayout.LayoutParams(1, dp(h)) }
    private fun button(s: String, primary: Boolean = false) = Button(this).apply {
        text = s; textSize = 16f; isAllCaps = false
        setTextColor(if (primary) BG else FG)
        background = GradientDrawable().apply { cornerRadius = dp(12).toFloat(); setColor(if (primary) FG else Color.rgb(30, 30, 30)) }
        setPadding(dp(12), dp(14), dp(12), dp(14))
    }
    private fun meter(label: String, colour: Int): Pair<LinearLayout, View> {
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        row.addView(text(label, 13f, DIM), LinearLayout.LayoutParams(dp(56), -2))
        val track = FrameLayout(this).apply { setBackgroundColor(Color.rgb(28, 28, 28)) }
        val bar = View(this).apply { setBackgroundColor(colour); pivotX = 0f; scaleX = 0f }
        track.addView(bar, FrameLayout.LayoutParams(-1, -1))
        row.addView(track, LinearLayout.LayoutParams(0, dp(6), 1f))
        return row to bar
    }

    private fun buildUi() {
        val root = FrameLayout(this).apply { setBackgroundColor(BG) }

        // ---- status: what this phone is and how it's doing ----
        status = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(24), dp(20), dp(24), dp(24)); gravity = Gravity.CENTER_HORIZONTAL }
        number = text("–", 150f).apply {
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD); gravity = Gravity.CENTER; includeFontPadding = false
            // hold the number for 1.5 s for settings (phone number, server link)
            var downAt = 0L
            setOnTouchListener { _, e ->
                when (e.action) {
                    MotionEvent.ACTION_DOWN -> downAt = System.currentTimeMillis()
                    MotionEvent.ACTION_UP -> if (System.currentTimeMillis() - downAt > 1500) show(settings)
                }
                true
            }
        }
        status.addView(number, LinearLayout.LayoutParams(-1, -2))
        colourName = text("PHONE", 13f, DIM).apply { gravity = Gravity.CENTER; letterSpacing = 0.15f }
        status.addView(colourName)
        status.addView(gap(26))
        linkLine = text("", 16f); status.addView(linkLine, LinearLayout.LayoutParams(-1, -2))
        status.addView(gap(10))
        headsetLine = text("", 16f); status.addView(headsetLine, LinearLayout.LayoutParams(-1, -2))
        status.addView(gap(10))
        whoLine = text("", 16f); status.addView(whoLine, LinearLayout.LayoutParams(-1, -2))
        status.addView(gap(10))
        batteryLine = text("", 14f, DIM); status.addView(batteryLine, LinearLayout.LayoutParams(-1, -2))
        status.addView(gap(18))
        val (pr, pb) = meter("Sound", Color.rgb(122, 143, 214)); playBar = pb; status.addView(pr, LinearLayout.LayoutParams(-1, -2))
        status.addView(gap(8))
        val (mr, mb) = meter("Mic", Color.rgb(95, 163, 106)); micBar = mb; status.addView(mr, LinearLayout.LayoutParams(-1, -2))
        status.addView(gap(22))
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        row.addView(button("Connect headset", true).apply {
            setOnClickListener { try { startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS)) } catch (_: Exception) { startActivity(Intent(Settings.ACTION_SETTINGS)) } }
        }, LinearLayout.LayoutParams(0, -2, 1f).apply { marginEnd = dp(8) })
        row.addView(button("Test sound").apply { setOnClickListener { startService(AudioService.ACTION_TEST) } }, LinearLayout.LayoutParams(0, -2, 1f))
        status.addView(row, LinearLayout.LayoutParams(-1, -2))
        status.addView(gap(8))
        thisHeadset = button("").apply {
            visibility = View.GONE
            setOnClickListener { Config.setExpectedHeadset(this@MainActivity, AudioService.headsetName); startService(AudioService.ACTION_DEVICE) }
        }
        status.addView(thisHeadset, LinearLayout.LayoutParams(-1, -2))
        status.addView(gap(14))
        status.addView(text("Hold the number for settings", 12f, Color.rgb(70, 70, 70)).apply { gravity = Gravity.CENTER }, LinearLayout.LayoutParams(-1, -2))

        // ---- settings: which number this phone is, where the control room is ----
        settings = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(24), dp(28), dp(24), dp(28)) }
        settings.addView(text("This phone", 22f))
        settings.addView(gap(6))
        settings.addView(text("Choose its number. Stick the matching colour on the phone and its earbuds. You can also change it from the control room.", 14f, DIM))
        settings.addView(gap(14))
        slotGrid = GridLayout(this).apply { columnCount = 4 }
        settings.addView(slotGrid)
        settings.addView(gap(22))
        settings.addView(text("Control room link", 16f))
        settings.addView(gap(4))
        settings.addView(text("Set automatically by “Connect this phone” (Add a phone, in the control room). Paste a link here only if that didn't work.", 13f, DIM))
        settings.addView(gap(8))
        linkField = EditText(this).apply {
            hint = "https://…/p?k=…"; setHintTextColor(DIM); setTextColor(FG); textSize = 15f; setBackgroundColor(Color.rgb(22, 22, 22))
            setPadding(dp(12), dp(10), dp(12), dp(10)); isSingleLine = true; inputType = InputType.TYPE_TEXT_VARIATION_URI
        }
        settings.addView(linkField)
        settings.addView(gap(8))
        settings.addView(button("Save link").apply {
            setOnClickListener {
                val c = Config.parse(linkField.text.toString())
                if (c == null) linkField.error = "That doesn't look like the link"
                else { Config.save(this@MainActivity, c.copy(device = if (c.device > 0) c.device else Config.load(this@MainActivity)?.device ?: 0)); restartService(); show(status) }
            }
        }, LinearLayout.LayoutParams(-1, -2))
        settings.addView(gap(20))
        settings.addView(CheckBox(this).apply {
            text = "Gallery mode: pin the app so nobody can leave it"; setTextColor(DIM); textSize = 14f; isChecked = lockdown()
            setOnCheckedChangeListener { _, c ->
                getSharedPreferences("earpiece", Context.MODE_PRIVATE).edit().putBoolean("lockdown", c).apply()
                if (c) { try { startLockTask() } catch (_: Exception) {} } else { try { stopLockTask() } catch (_: Exception) {} }
            }
        })
        settings.addView(gap(16))
        val r2 = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        r2.addView(button("Done", true).apply { setOnClickListener { if (Config.load(this@MainActivity) != null) show(status) } }, LinearLayout.LayoutParams(0, -2, 1f).apply { marginEnd = dp(8) })
        r2.addView(button("Exit app").apply {
            setOnClickListener {
                try { stopLockTask() } catch (_: Exception) {}
                stopService(Intent(this@MainActivity, AudioService::class.java)); finishAndRemoveTask()
            }
        }, LinearLayout.LayoutParams(0, -2, 1f))
        settings.addView(r2, LinearLayout.LayoutParams(-1, -2))

        root.addView(status, FrameLayout.LayoutParams(-1, -1))
        settingsScroll = ScrollView(this).apply { setBackgroundColor(BG); addView(settings) }
        root.addView(settingsScroll, FrameLayout.LayoutParams(-1, -1))
        setContentView(root)
        show(status)
    }

    private fun paintSlots(current: Int) {
        slotGrid.removeAllViews()
        for (n in 1..8) {
            slotGrid.addView(Button(this).apply {
                text = "$n"; textSize = 22f; typeface = Typeface.DEFAULT_BOLD
                setTextColor(if (n == current) BG else Config.color(n))
                background = GradientDrawable().apply {
                    cornerRadius = dp(10).toFloat()
                    setColor(if (n == current) Config.color(n) else Color.rgb(24, 24, 24)); setStroke(dp(2), Config.color(n))
                }
                setOnClickListener {
                    val c = Config.load(this@MainActivity) ?: return@setOnClickListener
                    Config.save(this@MainActivity, c.copy(device = n)); AudioService.slot = n; restartService()
                }
            }, GridLayout.LayoutParams().apply { width = dp(64); height = dp(64); setMargins(dp(4), dp(4), dp(4), dp(4)) })
        }
    }
}
