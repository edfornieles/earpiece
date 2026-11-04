package com.edfornieles.earpiece

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Shader
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.min

class MainActivity : Activity() {

    private val ui = Handler(Looper.getMainLooper())
    private lateinit var root: FrameLayout
    private lateinit var consent: LinearLayout
    private lateinit var live: LinearLayout
    private lateinit var setup: LinearLayout
    private lateinit var slotLabel: TextView
    private lateinit var nameField: EditText
    private lateinit var agree: CheckBox
    private lateinit var begin: Button
    private lateinit var statusText: TextView
    private lateinit var orb: OrbView
    private lateinit var micBar: View
    private lateinit var linkField: EditText
    private var seenReset = -1
    private var pinnedOnce = false

    private val BG = Color.rgb(11, 11, 11)
    private val FG = Color.rgb(232, 230, 225)
    private val DIM = Color.rgb(140, 137, 130)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true) }
        buildUi()
        takeLink(intent)
        route()
    }

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); takeLink(intent); route() }

    /** A link can be handed over by the setup script: am start ... --es url "<phone link>" */
    private fun takeLink(i: Intent?) {
        val link = i?.getStringExtra("url") ?: i?.dataString ?: return
        Config.parse(link)?.let { Config.save(this, it); restartService() }
    }

    private fun route() {
        if (Config.load(this) == null) { show(setup); return }
        val needed = mutableListOf(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= 33) needed += Manifest.permission.POST_NOTIFICATIONS
        val missing = needed.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) { requestPermissions(missing.toTypedArray(), 1); return }
        startService()
        show(if (AudioService.waiting) consent else live)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) route()
        else AlertDialog.Builder(this).setMessage("The earpiece needs the microphone. Allow it in Settings → Apps → Earpiece → Permissions.").setPositiveButton("OK", null).show()
    }

    private fun startService() {
        val i = Intent(this, AudioService::class.java)
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(i) else startService(i)
    }
    private fun restartService() { stopService(Intent(this, AudioService::class.java)); ui.postDelayed({ route() }, 300) }

    override fun onResume() {
        super.onResume()
        hideBars()
        ui.post(tick)
        // Pin the app so a participant can't leave it (Android asks to confirm once per launch).
        if (!pinnedOnce && Config.load(this) != null) { pinnedOnce = true; try { startLockTask() } catch (_: Exception) {} }
    }
    override fun onPause() { super.onPause(); ui.removeCallbacks(tick) }

    @Deprecated("Back does nothing on a dedicated phone")
    override fun onBackPressed() {}

    private val tick = object : Runnable {
        override fun run() {
            orb.level = min(1f, AudioService.playLevel * 6f)
            orb.invalidate()
            micBar.scaleX = min(1f, AudioService.micLevel * 8f)
            val slot = if (AudioService.slot > 0) AudioService.slot else Config.load(this@MainActivity)?.device ?: 0
            slotLabel.text = if (slot > 0) "Phone $slot" else ""
            statusText.text = when {
                !AudioService.connected -> AudioService.status
                !AudioService.headset -> "no headset — connect the earpiece"
                else -> "connected · " + AudioService.headsetName
            }
            if (AudioService.resetCount != seenReset) {
                if (seenReset != -1 && AudioService.waiting) resetConsent()
                seenReset = AudioService.resetCount
            }
            if (setup.visibility != View.VISIBLE) {
                if (AudioService.waiting && live.visibility == View.VISIBLE) resetConsent()
                if (!AudioService.waiting && consent.visibility == View.VISIBLE) show(live)
            }
            ui.postDelayed(this, 50)
        }
    }

    private fun resetConsent() {
        nameField.setText(""); agree.isChecked = false; begin.isEnabled = false
        show(consent)
    }

    private fun show(v: View) {
        for (x in listOf(consent, live, setup)) x.visibility = if (x === v) View.VISIBLE else View.GONE
    }

    private fun hideBars() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_FULLSCREEN
            or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN)
    }

    // ---------------- layout (built in code, no XML) ----------------

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()
    private fun text(s: String, size: Float, color: Int = FG) = TextView(this).apply { text = s; textSize = size; setTextColor(color) }
    private fun column() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; setPadding(dp(28), dp(28), dp(28), dp(28)); gravity = Gravity.CENTER_VERTICAL
    }
    private fun bigButton(s: String) = Button(this).apply {
        text = s; textSize = 19f; isAllCaps = false; setTextColor(BG); setBackgroundColor(FG); setPadding(0, dp(18), 0, dp(18))
    }
    private fun field(hint: String) = EditText(this).apply {
        this.hint = hint; setHintTextColor(DIM); setTextColor(FG); textSize = 17f; setBackgroundColor(Color.rgb(22, 22, 22))
        setPadding(dp(14), dp(12), dp(14), dp(12)); isSingleLine = true
    }
    private fun gap(h: Int) = View(this).apply { layoutParams = LinearLayout.LayoutParams(1, dp(h)) }

    private fun buildUi() {
        root = FrameLayout(this).apply { setBackgroundColor(BG) }

        // consent screen, shown for every new participant
        consent = column().apply {
            addView(text("Before you begin", 22f))
            addView(gap(18))
            addView(text("•  Put the earphones in.\n•  Keep the phone with you.\n•  You can stop at any time — just say so.", 16f, DIM))
            addView(gap(22))
            nameField = field("Your first name (optional)").apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_WORDS }
            addView(nameField)
            addView(gap(18))
            agree = CheckBox(this@MainActivity).apply {
                text = "I agree that what I say, and what is said to me, will be recorded as part of this work."
                setTextColor(DIM); textSize = 15f
                setOnCheckedChangeListener { _, c -> begin.isEnabled = c; begin.alpha = if (c) 1f else 0.35f }
            }
            addView(agree)
            addView(gap(22))
            begin = bigButton("Begin").apply {
                isEnabled = false; alpha = 0.35f
                setOnClickListener {
                    (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(nameField.windowToken, 0)
                    AudioService.waiting = false
                    startService(Intent(this@MainActivity, AudioService::class.java)
                        .setAction(AudioService.ACTION_BEGIN).putExtra(AudioService.EXTRA_NAME, nameField.text.toString().trim()))
                    show(live)
                }
            }
            addView(begin)
        }

        // live screen: an orb that glows while the voice speaks
        live = column().apply {
            gravity = Gravity.CENTER
            orb = OrbView(this@MainActivity)
            addView(orb, LinearLayout.LayoutParams(dp(220), dp(220)))
            addView(gap(18))
            statusText = text("connecting…", 15f, DIM).apply { gravity = Gravity.CENTER }
            addView(statusText)
            addView(gap(14))
            val track = FrameLayout(this@MainActivity).apply { setBackgroundColor(Color.rgb(26, 26, 26)) }
            micBar = View(this@MainActivity).apply { setBackgroundColor(Color.rgb(60, 110, 71)); pivotX = 0f; scaleX = 0f }
            track.addView(micBar, FrameLayout.LayoutParams(dp(120), dp(4)))
            addView(track, LinearLayout.LayoutParams(dp(120), dp(4)))
        }

        // first-time setup: paste the phone link from the control page
        setup = column().apply {
            addView(text("Set up this phone", 22f))
            addView(gap(12))
            addView(text("Paste the phone link from the control room (Phones panel), e.g.\nhttps://earpiece.edfornieles.com/p?k=…&device=1", 14f, DIM))
            addView(gap(16))
            linkField = field("Phone link").apply { inputType = InputType.TYPE_TEXT_VARIATION_URI; setText(Config.load(this@MainActivity)?.link() ?: "") }
            addView(linkField)
            addView(gap(16))
            addView(bigButton("Save").apply {
                setOnClickListener {
                    val c = Config.parse(linkField.text.toString())
                    if (c == null) linkField.error = "That doesn't look like the phone link"
                    else { Config.save(this@MainActivity, c); restartService() }
                }
            })
            addView(gap(12))
            addView(Button(this@MainActivity).apply {
                text = "Unpin and exit"; isAllCaps = false; setTextColor(DIM); setBackgroundColor(BG)
                setOnClickListener {
                    try { stopLockTask() } catch (_: Exception) {}
                    stopService(Intent(this@MainActivity, AudioService::class.java)); finishAndRemoveTask()
                }
            })
        }

        root.addView(consent, FrameLayout.LayoutParams(-1, -1))
        root.addView(live, FrameLayout.LayoutParams(-1, -1))
        root.addView(setup, FrameLayout.LayoutParams(-1, -1))

        // "Phone N" in the corner. Hold it for 3 seconds to reach setup (for you, not participants).
        slotLabel = text("", 12f, Color.rgb(70, 70, 70)).apply {
            setPadding(dp(16), dp(12), dp(16), dp(12)); typeface = Typeface.DEFAULT
            var downAt = 0L
            setOnTouchListener { _, e ->
                when (e.action) {
                    android.view.MotionEvent.ACTION_DOWN -> downAt = System.currentTimeMillis()
                    android.view.MotionEvent.ACTION_UP -> if (System.currentTimeMillis() - downAt > 3000) show(setup)
                }
                true
            }
        }
        root.addView(slotLabel, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.END))
        setContentView(root)
        show(consent)
    }

    /** The glowing orb from the web page, drawn natively. */
    class OrbView(ctx: Context) : View(ctx) {
        var level = 0f
        private val p = Paint(Paint.ANTI_ALIAS_FLAG)
        override fun onDraw(c: Canvas) {
            val cx = width / 2f; val cy = height / 2f; val r = min(width, height) * 0.30f
            val glow = r * (1.25f + level * 0.6f)
            p.shader = RadialGradient(cx, cy, glow, intArrayOf(Color.argb((40 + level * 150).toInt(), 232, 230, 225), Color.TRANSPARENT), null, Shader.TileMode.CLAMP)
            c.drawCircle(cx, cy, glow, p)
            p.shader = RadialGradient(cx - r * 0.25f, cy - r * 0.3f, r * 1.3f, intArrayOf(Color.rgb(64, 64, 64), Color.rgb(18, 18, 18)), null, Shader.TileMode.CLAMP)
            c.drawCircle(cx, cy, r * (1f + level * 0.08f), p)
        }
    }
}
