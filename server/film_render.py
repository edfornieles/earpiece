#!/usr/bin/env python3
"""Renders a performance-film draft (score.json, cut.json, debrief.json) to preview.mp4 for review.

  film_render.py <session dir> <version dir>

Pictures are drawn here (PIL) and piped to ffmpeg; sound is cut and mixed by ffmpeg. Writes, in the version dir:
  preview.mp4    1280x720, 25 fps, captions burnt in, the preview time stamped top-right for comments
  preview.json   which part / clip / session time each stretch of the preview comes from
"""
import json, math, os, subprocess, sys, tempfile
from datetime import datetime
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H, FPS, RATE = 1280, 720, 25, 48000
SESSION, OUT = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
load = lambda n: json.load(open(os.path.join(OUT, n)))
score, cut, deb = load('score.json'), load('cut.json'), load('debrief.json')
manifest = json.load(open(os.path.join(SESSION, 'catalogue', 'manifest.json')))
TMP = tempfile.mkdtemp(prefix='film-')


def font(size, bold=False, italic=False):
    for f, i in [('/System/Library/Fonts/HelveticaNeue.ttc', 4 if italic else (1 if bold else 0)), ('/System/Library/Fonts/Helvetica.ttc', 0)]:
        try: return ImageFont.truetype(f, size, index=i)
        except Exception: pass
    return ImageFont.load_default()


F_TITLE, F_BODY, F_SMALL, F_CAP, F_CAPI = font(40), font(26), font(18), font(30), font(30, italic=True)
WHITE, DIM, EAR = (255, 255, 255), (150, 150, 150), (154, 170, 240)

# ---------- video out ----------
video = subprocess.Popen(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
                          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', os.path.join(TMP, 'video.mp4')], stdin=subprocess.PIPE)
frames_out = 0
timeline = []   # {from, to, part, clip?, session_in?}
audio_parts = []


def stamp(img):
    s = frames_out / FPS
    d = ImageDraw.Draw(img)
    d.text((W - 16, 12), f"v{os.path.basename(OUT)[1:]}  {int(s // 60):02d}:{s % 60:05.2f}", font=F_SMALL, fill=(200, 200, 200), anchor='ra')


def put(img):
    global frames_out
    img = img.convert('RGB'); stamp(img)
    video.stdin.write(img.tobytes()); frames_out += 1


def silence(seconds):
    f = os.path.join(TMP, f'a{len(audio_parts):04d}.wav')
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', f'anullsrc=r={RATE}:cl=stereo', '-t', f'{seconds:.3f}', f], check=True)
    audio_parts.append(f)


def wrap(text, f, width):
    lines, line = [], ''
    for w in str(text).split():
        t = (line + ' ' + w).strip()
        if f.getlength(t) <= width: line = t
        else: lines.append(line); line = w
    return lines + ([line] if line else [])


def card(lines, seconds, part):
    """A still card: [(text, font, colour)], centred block, left-aligned like a programme."""
    t0 = frames_out / FPS
    img = Image.new('RGB', (W, H), 'black'); d = ImageDraw.Draw(img)
    y = 120
    for text, f, c in lines:
        for l in wrap(text, f, W - 240) or ['']:
            d.text((120, y), l, font=f, fill=c); y += int(f.size * 1.45)
    for _ in range(int(seconds * FPS)): put(img.copy())
    silence(seconds); timeline.append({'from': round(t0, 2), 'to': round(frames_out / FPS, 2), 'part': part})


# ---------- 1. the score ----------
def when(iso):
    try: return datetime.fromisoformat(iso.replace('Z', '+00:00')).astimezone()
    except Exception: return None


def render_score():
    a, b = when(score['date']), when(score.get('end') or '')
    date = a.strftime('%-d %B %Y') if a else ''
    times = f"{a.strftime('%H:%M')}–{b.strftime('%H:%M')}" if a and b else ''
    lines = [('MOTHER', F_TITLE, WHITE), ('', F_BODY, WHITE), (f'{date}   {times}', F_BODY, WHITE), ('', F_BODY, WHITE),
             ('In the booth: ' + ', '.join(score['booth']), F_BODY, DIM), ('Participants: ' + ', '.join(score['participants']), F_BODY, DIM)]
    if score.get('title'): lines.insert(1, (score['title'], F_BODY, DIM))
    card(lines, 6, 'score')
    # the instructions as performed, scrolling
    if not score['instructions']: return
    rows = []
    for x in score['instructions']:
        m = f"{int(x['t'] // 60):02d}:{int(x['t'] % 60):02d}"
        rows.append((m, f"to {x['to']} · {x['how']}", wrap(x['text'], F_BODY, W - 360)))
    tall = sum(30 + 36 * len(r[2]) + 18 for r in rows)
    page = Image.new('RGB', (W, tall + H * 2), 'black'); d = ImageDraw.Draw(page)
    d.text((120, H // 2 - 70), 'THE SCORE, AS PERFORMED', font=F_SMALL, fill=DIM)
    y = H // 2
    for m, who, lines in rows:
        d.text((120, y), m, font=F_SMALL, fill=DIM); d.text((200, y), who, font=F_SMALL, fill=DIM); y += 30
        for l in lines: d.text((200, y), l, font=F_BODY, fill=WHITE); y += 36
        y += 18
    speed = 70   # pixels a second
    t0, n = frames_out / FPS, int((y - H // 2 + H // 2) / speed * FPS)
    for i in range(n):
        top = int(i * speed / FPS)
        put(page.crop((0, top, W, top + H)))
    silence(n / FPS); timeline.append({'from': round(t0, 2), 'to': round(frames_out / FPS, 2), 'part': 'score'})


# ---------- 2. the footage ----------
cam_files = [f for f in manifest['files'] if f['kind'] == 'camera']
proxy_of = {p['original']: p['proxy'] for p in manifest.get('proxies', [])}
mixes = {int(''.join(c for c in os.path.basename(m['file']) if c.isdigit()) or 0): m['file'] for m in manifest.get('mixes', [])}
room = next((f for f in manifest['files'] if f['kind'] == 'room_mic'), None)


sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    import camera_sync
    DELAY = camera_sync.session(SESSION)   # seconds each camera file's picture runs behind the session clock
except Exception as e:
    print('  camera sync not measured:', e, file=sys.stderr); DELAY = {}


def pieces(camera, t_in, t_out):
    """(file, seek, seconds) covering [t_in, t_out) on the session clock for one camera; black where it has none."""
    out, t = [], t_in
    files = sorted([f for f in cam_files if f['camera'] == camera], key=lambda f: f['offset'])
    while t < t_out - 0.02:
        f = next((f for f in files if f['offset'] <= t < f['offset'] + f['duration']), None)
        if not f:
            nxt = min([g['offset'] for g in files if g['offset'] > t] + [t_out])
            out.append((None, 0, nxt - t)); t = nxt; continue
        end = min(t_out, f['offset'] + f['duration'])
        src = proxy_of.get(f['file'], f['file'])
        # the moment t is shown DELAY seconds later in the file: the camera's picture arrives late
        out.append((os.path.join(SESSION, src), t - f['offset'] + DELAY.get(f['file'], 0.0), end - t)); t = end
    return out


def caption_layer(caps, t):
    now = [c for c in caps if c['start'] - 0.2 <= t <= c['end'] + 0.6]
    if not now: return None
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(img)
    y = H - 40
    for c in reversed(now[-2:]):
        ear = c['layer'] == 'earpiece'
        f, col = (F_CAPI, EAR) if ear else (F_CAP, WHITE)
        label = ('IN THE EARPIECE — ' if ear else '') + c['speaker'].upper()
        lines = wrap(c['text'], f, W - 200)[-3:]
        block = 26 + len(lines) * 38
        y -= block + 10
        d.rectangle((80, y - 8, W - 80, y + block), fill=(0, 0, 0, 150))
        d.text((100, y), label, font=F_SMALL, fill=col)
        for i, l in enumerate(lines): d.text((100, y + 26 + i * 38), l, font=f, fill=col)
    return img


def render_clip(c):
    t0 = frames_out / FPS
    frames = []
    for src, seek, secs in pieces(c['camera'], c['in'], c['out']):
        n = int(round(secs * FPS))
        if not src:
            frames += [None] * n; continue
        p = subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-ss', f'{seek:.3f}', '-i', src, '-t', f'{secs:.3f}', '-an',
                            '-vf', f'fps={FPS},scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2',
                            '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True)
        raw, size = p.stdout, W * H * 3
        got = [raw[i:i + size] for i in range(0, len(raw) - size + 1, size)][:n]
        frames += got + [got[-1] if got else None] * (n - len(got))
    for i, fr in enumerate(frames):
        img = Image.frombytes('RGB', (W, H), fr) if fr else Image.new('RGB', (W, H), 'black')
        cap = caption_layer(c['captions'], c['in'] + i / FPS)
        if cap: img = Image.alpha_composite(img.convert('RGBA'), cap)
        put(img)
    # sound: each phone's conversation (participant + what they heard), plus the room quietly
    inputs, labels = [], []
    for ph in c['sound']['earpiece']:
        if ph in mixes: inputs += ['-i', os.path.join(SESSION, mixes[ph])]; labels.append(f'[{len(labels)}:a]atrim={c["in"]}:{c["out"]},asetpts=N/SR/TB,pan=stereo|c0=c0+c1|c1=c0+c1[s{len(labels)}]')
    if room and c['sound'].get('room'):
        k = len(labels); off = room.get('offset') or 0
        inputs += ['-i', os.path.join(SESSION, room['file'])]
        labels.append(f'[{k}:a]atrim={max(0, c["in"] - off)}:{max(0, c["out"] - off)},asetpts=N/SR/TB,volume={c["sound"]["room"]},aformat=channel_layouts=stereo[s{k}]')
    dur = len(frames) / FPS
    f = os.path.join(TMP, f'a{len(audio_parts):04d}.wav')
    if labels:
        mix = ';'.join(labels) + ';' + ''.join(f'[s{i}]' for i in range(len(labels))) + f'amix=inputs={len(labels)}:normalize=0,aresample={RATE},apad,atrim=0:{dur:.3f}[a]'
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *inputs, '-filter_complex', mix, '-map', '[a]', '-ac', '2', f], check=True)
        audio_parts.append(f)
    else: silence(dur)
    timeline.append({'from': round(t0, 2), 'to': round(frames_out / FPS, 2), 'part': 'footage', 'clip': c['n'], 'session_in': c['in'], 'session_out': c['out'], 'camera': c['camera']})


# ---------- 3. the debrief carousel (or a closing card) ----------
def portrait(path):
    try: im = Image.open(os.path.join(SESSION, path) if not os.path.isabs(path) else path).convert('RGB')
    except Exception: im = Image.new('RGB', (600, 600), (40, 40, 40))
    box = face_square(im)
    if not box:
        s = min(im.size); box = ((im.width - s) // 2, (im.height - s) // 2, (im.width + s) // 2, (im.height + s) // 2)
    return im.crop(box).resize((420, 420))


def face_square(im):
    """Registration photos without a studio portrait: frame them like portrait_crop.py does, if a face is found."""
    try:
        import cv2, numpy as np
        a = cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR)
        det = cv2.FaceDetectorYN.create(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'models', 'face_detection_yunet_2023mar.onnx'), '', (a.shape[1], a.shape[0]), 0.7)
        _, f = det.detect(a)
        if f is None or not len(f): return None
        x, y, w, h = max(f, key=lambda f: f[2] * f[3])[:4]
        size = min(h / 0.38, im.width, im.height); cx, cy = x + w / 2, y + h / 2 + h * 0.22
        x0 = int(max(0, min(im.width - size, cx - size / 2))); y0 = int(max(0, min(im.height - size, cy - size / 2)))
        return (x0, y0, x0 + int(size), y0 + int(size))
    except Exception:
        return None


def carousel_frame(faces, angle, title):
    """faces on a ring seen from the front: angle 0 is front-centre. Near = big and sharp; far = small, blurred, behind."""
    img = Image.new('RGB', (W, H), 'black')
    n = len(faces); placed = []
    for i, im in enumerate(faces):
        a = (i * 2 * math.pi / n) - angle
        depth = (math.cos(a) + 1) / 2                       # 1 front, 0 back
        x = W / 2 + math.sin(a) * W * 0.40
        size = int(150 + 260 * depth ** 1.4)
        placed.append((depth, x, size, im))
    for depth, x, size, im in sorted(placed, key=lambda p: p[0]):
        face = im.resize((size, size))
        blur = (1 - depth) * 6
        if blur > 0.6: face = face.filter(ImageFilter.GaussianBlur(blur))
        img.paste(face, (int(x - size / 2), int(H * 0.55 - size / 2)))
    ImageDraw.Draw(img).text((40, 30), title, font=F_TITLE, fill=WHITE)
    return img


def render_debrief():
    if not deb.get('included'):
        card([('MOTHER', F_TITLE, WHITE), ('', F_BODY, WHITE), (when(score['date']).strftime('%-d %B %Y') if when(score['date']) else '', F_BODY, DIM)], 4, 'closing')
        return
    ring = deb['ring']; faces = [portrait(r['photo']) if r.get('photo') else portrait('') for r in ring]
    title = 'DEBRIEF: ' + (when(score['date']).strftime('%-d %B').upper() if when(score['date']) else '')
    angle = 0.0
    for c in deb['clips']:
        t0 = frames_out / FPS
        idx = next((i for i, r in enumerate(ring) if r['pid'] == c['pid']), 0)
        start, end = c['in'], c['out']
        n = int((end - start) * FPS)
        for i in range(n):
            t = start + i / FPS
            speaking = any(x['who'] == 'participant' and x['start'] <= t <= x['end'] for x in c['turns'])
            target = idx * 2 * math.pi / len(ring)
            diff = (target - angle + math.pi) % (2 * math.pi) - math.pi
            angle += diff * (0.06 if speaking or i < FPS * 2 else 0.0)    # turn to them, then hold
            put(carousel_frame(faces, angle, title))
        f = os.path.join(TMP, f'a{len(audio_parts):04d}.wav')
        mix = os.path.join(os.path.dirname(SESSION), c['session'], 'catalogue', 'mixes', f"phone{c['phone']}-conversation.wav")
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', mix, '-af', f'atrim={start}:{end},asetpts=N/SR/TB,pan=stereo|c0=c0+c1|c1=c0+c1,aresample={RATE}', f], check=True)
        audio_parts.append(f)
        timeline.append({'from': round(t0, 2), 'to': round(frames_out / FPS, 2), 'part': 'debrief', 'pid': c['pid'], 'session': c['session']})


render_score()
for i, c in enumerate(cut['clips']):
    render_clip(c)
    print(f'  footage {i + 1}/{len(cut["clips"])}', file=sys.stderr, flush=True)
render_debrief()
video.stdin.close(); video.wait()

with open(os.path.join(TMP, 'audio.txt'), 'w') as f:
    for a in audio_parts: f.write(f"file '{a}'\n")
subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', os.path.join(TMP, 'audio.txt'), '-c', 'copy', os.path.join(TMP, 'audio.wav')], check=True)
subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', os.path.join(TMP, 'video.mp4'), '-i', os.path.join(TMP, 'audio.wav'),
                '-c:v', 'copy', '-af', 'loudnorm=I=-18:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', os.path.join(OUT, 'preview.mp4')], check=True)
json.dump({'length': round(frames_out / FPS, 2), 'fps': FPS, 'timeline': timeline}, open(os.path.join(OUT, 'preview.json'), 'w'), indent=1)
print(os.path.join(OUT, 'preview.mp4'))
