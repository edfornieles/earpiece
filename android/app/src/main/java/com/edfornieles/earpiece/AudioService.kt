package com.edfornieles.earpiece

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.LinkedBlockingDeque
import java.util.concurrent.TimeUnit
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Runs the earpiece link in the background: one WebSocket to the control room, the mic going up,
 * the director/AI voice coming down. Keeps running with the screen off and reconnects on its own.
 * Speaks the same protocol as the web phone page: 24 kHz mono 16-bit PCM both ways, JSON for control.
 */
class AudioService : Service() {

    companion object {
        const val WIRE_RATE = 24000
        const val ACTION_STOP = "stop"
        const val ACTION_TEST = "test"           // a chime in the headset, to check the right earbuds are connected
        const val ACTION_DEVICE = "device"       // send model / battery / headset info again (e.g. after choosing the headset)

        // State the screen reads. Updated from background threads; the activity polls it.
        @Volatile var connected = false
        @Volatile var slot = 0
        @Volatile var waiting = true          // true = waiting for the desk, false = participant active
        @Volatile var status = "starting…"
        @Volatile var playLevel = 0f
        @Volatile var micLevel = 0f
        @Volatile var running = false
        @Volatile var resetCount = 0          // bumps when the control room ends a participant
        @Volatile var headset = false         // a Bluetooth / wired headset is connected
        @Volatile var headsetName = ""
        @Volatile var person = ""             // who is on this phone now ("" = nobody)
        @Volatile var next = ""               // who's assigned to it next
        @Volatile var standby = false         // the control room isn't recording a session
        @Volatile var identifyAt = 0L         // the control room asked this phone to show itself
        @Volatile var renumbered = 0L
    }

    private val main = Handler(Looper.getMainLooper())
    private lateinit var http: OkHttpClient
    private var ws: WebSocket? = null
    private var retry = 0
    private var stopping = false
    private var micOn = false                // only send the mic while a participant is active
    @Volatile private var linkProblem = false
    @Volatile private var lastError: String? = null

    private var record: AudioRecord? = null
    private var track: AudioTrack? = null
    private var micThread: Thread? = null
    private var playThread: Thread? = null
    private val playQueue = LinkedBlockingDeque<ShortArray>()
    @Volatile private var buffering = true
    @Volatile private var lastArrival = 0L
    @Volatile private var flushNow = false

    private var wake: PowerManager.WakeLock? = null
    private var wifi: WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        http = OkHttpClient.Builder()
            .pingInterval(10, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .connectTimeout(8, TimeUnit.SECONDS)
            .build()
        goForeground()
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "earpiece:audio").apply { acquire() }
        val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        @Suppress("DEPRECATION")
        val mode = if (Build.VERSION.SDK_INT >= 29) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else WifiManager.WIFI_MODE_FULL_HIGH_PERF
        wifi = wm.createWifiLock(mode, "earpiece:wifi").apply { acquire() }
        startAudio()
        watchHeadset()
        running = true
        connect()
        main.postDelayed(object : Runnable { override fun run() { if (!stopping) { if (connected) sendDevice(); main.postDelayed(this, 60000) } } }, 60000)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_TEST -> chime()
            ACTION_DEVICE -> sendDevice()
            ACTION_STOP -> { stopSelf(); return START_NOT_STICKY }
        }
        return START_STICKY
    }

    // ---------------- this phone: model, battery, its headset ----------------

    private fun sendDevice() {
        val bm = getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val version = try { packageManager.getPackageInfo(packageName, 0).versionName ?: "" } catch (_: Exception) { "" }
        sendJson(JSONObject().put("type", "device")
            .put("model", (Build.MANUFACTURER.replaceFirstChar { it.uppercase() } + " " + Build.MODEL).trim())
            .put("battery", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY))
            .put("charging", Build.VERSION.SDK_INT >= 23 && bm.isCharging)
            .put("version", version)
            .put("expected", Config.expectedHeadset(this)))
    }

    /** Two soft notes through whatever is playing the voice (the earbuds, if connected). */
    private fun chime() {
        for ((f, ms) in listOf(880.0 to 180, 1320.0 to 260)) {
            val n = WIRE_RATE * ms / 1000
            val s = ShortArray(n) { i ->
                val env = kotlin.math.min(1.0, kotlin.math.min(i / 240.0, (n - i) / 2400.0))
                (kotlin.math.sin(2 * Math.PI * f * i / WIRE_RATE) * 9000 * env).toInt().toShort()
            }
            playQueue.add(s)
        }
    }

    private fun identify() {
        identifyAt = System.currentTimeMillis()
        chime(); main.postDelayed({ chime() }, 900)
        try {
            val v = getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
            if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 300, 200, 300, 200, 300), -1))
            else @Suppress("DEPRECATION") v.vibrate(longArrayOf(0, 300, 200, 300, 200, 300), -1)
        } catch (_: Exception) {}
    }

    override fun onDestroy() {
        stopping = true
        running = false
        ws?.close(1000, "bye")
        micThread?.interrupt(); playThread?.interrupt()
        try { record?.stop(); record?.release() } catch (_: Exception) {}
        try { track?.stop(); track?.release() } catch (_: Exception) {}
        (getSystemService(Context.AUDIO_SERVICE) as AudioManager).mode = AudioManager.MODE_NORMAL
        wake?.let { if (it.isHeld) it.release() }
        wifi?.let { if (it.isHeld) it.release() }
        http.dispatcher.executorService.shutdown()
        super.onDestroy()
    }

    // ---------------- connection ----------------

    private fun connect() {
        if (stopping) return
        val cfg = Config.load(this) ?: run { status = "not set up"; return }
        val url = cfg.base.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://") +
            "/ws?role=phone&k=${cfg.key}&device=${cfg.device}&did=${Config.deviceId(this)}"
        status = "connecting…"
        ws = http.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                retry = 0; connected = true; status = "connected"
                sendJson(JSONObject().put("type", "caps").put("jitterBuffer", true))   // lets the server send speech further ahead
                sendJson(JSONObject().put("type", "headset").put("connected", headset).put("name", headsetName))
                sendDevice()
                if (record?.recordingState == AudioRecord.RECORDSTATE_RECORDING) sendJson(JSONObject().put("type", "hello"))
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                val m = try { JSONObject(text) } catch (_: Exception) { return }
                when (m.optString("type")) {
                    "welcome" -> {
                        slot = m.optInt("id")
                        // the server may give a different number (e.g. this one was taken): remember it
                        if (slot > 0 && Config.load(this@AudioService)?.device != slot) Config.setDevice(this@AudioService, slot)
                        readWho(m)
                        // the server remembers whether a participant was mid-session when we dropped
                        val serverWaiting = m.optBoolean("waiting", true)
                        if (!serverWaiting && waiting) { waiting = false; micOn = true }
                        if (serverWaiting && !waiting) { waiting = true; micOn = false; resetCount++ }
                    }
                    "flush" -> flush()
                    "who" -> {
                        readWho(m)
                        if (person.isNotEmpty() && waiting) { waiting = false; micOn = true }
                        if (person.isEmpty() && !waiting) { waiting = true; micOn = false; flush(); resetCount++ }
                    }
                    "identify" -> main.post { identify() }
                    "setSlot" -> { val n = m.optInt("slot"); if (n > 0) { Config.setDevice(this@AudioService, n); slot = n; renumbered = System.currentTimeMillis() } }
                    "reset" -> { flush(); waiting = true; micOn = false; resetCount++ }
                    "full" -> status = "all phone slots are in use"
                    "error" -> { status = m.optString("text"); linkProblem = true }
                }
            }
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                val bb = bytes.asByteBuffer().order(ByteOrder.LITTLE_ENDIAN)
                val s = ShortArray(bb.remaining() / 2)
                bb.asShortBuffer().get(s)
                var sum = 0.0
                for (v in s) sum += (v * v).toDouble()
                playLevel = max(playLevel * 0.7f, (sqrt(sum / max(1, s.size)) / 32768.0).toFloat())
                playQueue.add(s); lastArrival = System.currentTimeMillis()
                // the server sends up to 0.8 s ahead; never fall more than 1.5 s behind
                var queued = playQueue.sumOf { it.size }
                while (queued > WIRE_RATE * 1.5 && playQueue.size > 1) queued -= playQueue.removeFirst().size
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(1000, null) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                dropped(when (code) { 4000 -> "this slot was taken by another phone"; 4001 -> status; else -> null })
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                lastError = (t.message ?: t.javaClass.simpleName).take(80)
                dropped(null)
            }
        })
    }

    private fun dropped(msg: String?) {
        connected = false
        if (stopping) return
        status = msg ?: ("reconnecting… " + (lastError ?: ""))
        if (msg != null) return
        retry++
        main.postDelayed({ connect() }, min(5000L, 500L * retry))
    }

    private fun sendJson(o: JSONObject) { ws?.send(o.toString()) }

    private fun readWho(m: JSONObject) {
        fun label(o: JSONObject?) = if (o == null) "" else ((if (o.has("number") && !o.isNull("number")) "#${o.optInt("number")} " else "") + o.optString("name"))
        person = label(m.optJSONObject("person")).ifEmpty { m.optString("name", "") }
        next = label(m.optJSONObject("next"))
        standby = m.optBoolean("standby", false)
    }

    // ---------------- audio ----------------

    private fun startAudio() {
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        am.mode = AudioManager.MODE_IN_COMMUNICATION

        // Playback: what the director / AI says, into the earphones.
        val outRate = WIRE_RATE
        val minOut = AudioTrack.getMinBufferSize(outRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        track = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setAudioFormat(AudioFormat.Builder().setSampleRate(outRate)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
            .setBufferSizeInBytes(max(minOut, outRate / 5 * 2))
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build().also { it.play() }

        playThread = Thread {
            val silence = ShortArray(WIRE_RATE / 50)   // 20 ms
            while (!Thread.currentThread().isInterrupted) {
                if (flushNow) {
                    flushNow = false
                    playQueue.clear(); buffering = true
                    try { track?.pause(); track?.flush(); track?.play() } catch (_: Exception) {}
                }
                // Jitter buffer: hold ~0.25 s before starting a line (or less if the line is short and
                // nothing more is coming), and refill after a gap instead of stuttering through it.
                val t = track ?: break
                if (buffering) {
                    val queued = playQueue.sumOf { it.size }
                    val quiet = System.currentTimeMillis() - lastArrival > 150
                    if (queued >= WIRE_RATE / 4 || (queued > 0 && quiet)) buffering = false
                    else { t.write(silence, 0, silence.size); continue }
                }
                val chunk = try { playQueue.pollFirst(20, TimeUnit.MILLISECONDS) } catch (_: InterruptedException) { break }
                if (chunk == null) buffering = true
                t.write(chunk ?: silence, 0, (chunk ?: silence).size)
                playLevel *= 0.92f
            }
        }.apply { name = "earpiece-play"; start() }

        // Mic: what the participant says. Voice-communication source gives echo cancelling on most phones.
        val inRate = listOf(48000, 16000, 44100, 24000).firstOrNull {
            AudioRecord.getMinBufferSize(it, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT) > 0
        } ?: 16000
        val minIn = AudioRecord.getMinBufferSize(inRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val rec = try {
            AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, inRate,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, max(minIn, inRate / 5 * 2))
        } catch (e: SecurityException) { status = "microphone permission missing"; return }
        record = rec
        val sid = rec.audioSessionId
        if (AcousticEchoCanceler.isAvailable()) AcousticEchoCanceler.create(sid)?.enabled = true
        if (NoiseSuppressor.isAvailable()) NoiseSuppressor.create(sid)?.enabled = true
        if (AutomaticGainControl.isAvailable()) AutomaticGainControl.create(sid)?.enabled = true
        rec.startRecording()

        micThread = Thread {
            val frame = inRate / 50                     // 20 ms
            val buf = ShortArray(frame)
            val rs = Resampler(inRate, WIRE_RATE)
            while (!Thread.currentThread().isInterrupted) {
                val n = rec.read(buf, 0, frame)
                if (n <= 0) continue
                val out = rs.process(buf, n)
                var sum = 0.0
                for (v in out) sum += (v * v).toDouble()
                micLevel = max(micLevel * 0.8f, (sqrt(sum / max(1, out.size)) / 32768.0).toFloat())
                if (!micOn || !connected) continue
                val bb = ByteBuffer.allocate(out.size * 2).order(ByteOrder.LITTLE_ENDIAN)
                bb.asShortBuffer().put(out)
                ws?.send(bb.array().toByteString())
            }
        }.apply { name = "earpiece-mic"; priority = Thread.MAX_PRIORITY; start() }
    }

    private fun flush() { flushNow = true; playQueue.clear() }

    // ---------------- headset: route audio to it, and tell the control room when it comes and goes ----------------

    private val headsetTypes = setOf(AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_WIRED_HEADSET,
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_USB_HEADSET)

    private fun watchHeadset() {
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val check = Runnable {
            val outs = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
            val bt = outs.firstOrNull { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
            val any = bt ?: outs.firstOrNull { it.type in headsetTypes }
            if (bt != null) routeTo(am, bt) else if (any != null) routeWired(am) else routeSpeaker(am)
            val now = any != null
            val name = any?.productName?.toString() ?: ""
            if (now != headset || name != headsetName) {
                headset = now; headsetName = name
                sendJson(JSONObject().put("type", "headset").put("connected", now).put("name", name))
                if (!now) flush()
            }
        }
        am.registerAudioDeviceCallback(object : AudioDeviceCallback() {
            override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>?) { main.postDelayed(check, 300) }
            override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>?) { main.postDelayed(check, 300) }
        }, main)
        main.post(check)
        // Bluetooth call audio sometimes drops back to the phone speaker; keep pulling it back.
        main.postDelayed(object : Runnable { override fun run() { if (!stopping) { check.run(); main.postDelayed(this, 5000) } } }, 5000)
    }

    /** No headset: play through the phone's loudspeaker and listen with its own microphone. */
    private fun routeSpeaker(am: AudioManager) {
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                val spk = am.availableCommunicationDevices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
                if (spk != null && am.communicationDevice?.id != spk.id) am.setCommunicationDevice(spk)
            } else {
                @Suppress("DEPRECATION")
                run { if (am.isBluetoothScoOn) { am.stopBluetoothSco(); am.isBluetoothScoOn = false }; if (!am.isSpeakerphoneOn) am.isSpeakerphoneOn = true }
            }
        } catch (_: Exception) {}
    }

    /** Wired earphones: let Android route to them (and their mic, if they have one). */
    private fun routeWired(am: AudioManager) {
        try {
            if (Build.VERSION.SDK_INT >= 31) am.clearCommunicationDevice()
            else @Suppress("DEPRECATION") run { if (am.isSpeakerphoneOn) am.isSpeakerphoneOn = false; if (am.isBluetoothScoOn) { am.stopBluetoothSco(); am.isBluetoothScoOn = false } }
        } catch (_: Exception) {}
    }

    private fun routeTo(am: AudioManager, dev: AudioDeviceInfo) {
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                if (am.communicationDevice?.id != dev.id) am.setCommunicationDevice(dev)
            } else {
                @Suppress("DEPRECATION")
                if (am.isSpeakerphoneOn) am.isSpeakerphoneOn = false
                if (!am.isBluetoothScoOn) { am.startBluetoothSco(); am.isBluetoothScoOn = true }
            }
        } catch (_: Exception) {}
    }

    /** Linear resampler that keeps its position across chunks. */
    private class Resampler(from: Int, to: Int) {
        private val r = from.toDouble() / to
        private var pos = 0.0
        private var last = 0
        fun process(input: ShortArray, n: Int): ShortArray {
            if (r == 1.0) return input.copyOf(n)
            val out = ArrayList<Short>((n / r).toInt() + 2)
            var p = pos
            val len = n + 1
            while (p < len - 1) {
                val i = p.toInt(); val f = p - i
                val a = if (i == 0) last else input[i - 1].toInt()
                val b = input[i].toInt()
                out.add((a + (b - a) * f).toInt().toShort())
                p += r
            }
            pos = p - (len - 1)
            if (n > 0) last = input[n - 1].toInt()
            return out.toShortArray()
        }
    }

    // ---------------- foreground notification ----------------

    private fun goForeground() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(NotificationChannel("earpiece", "Mother", NotificationManager.IMPORTANCE_LOW))
        }
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n: Notification = (if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, "earpiece") else @Suppress("DEPRECATION") Notification.Builder(this))
            .setContentTitle("Mother")
            .setContentText("Connected to the control room")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 29) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        else startForeground(1, n)
    }
}
