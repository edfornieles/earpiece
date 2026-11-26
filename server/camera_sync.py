#!/usr/bin/env python3
"""How far a Tapo recording's picture runs behind the session clock, read from the clock the camera burns into the
frame. For each sample: find the instant the seconds digit changes (frame differences), read the time just after it
(macOS text recognition), compare with the session's wall time for that frame. Median of the clean readings."""
import os, re, subprocess, statistics, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
OCR = os.environ.get('MOTHER_OCR') or os.path.join(HERE, '.cache', 'clock_ocr')

def ensure_ocr():
    """Builds the macOS text reader (tools/clock_ocr.swift) once."""
    if os.path.exists(OCR): return True
    os.makedirs(os.path.dirname(OCR), exist_ok=True)
    return subprocess.run(['swiftc', '-O', '-o', OCR, os.path.join(HERE, 'tools', 'clock_ocr.swift')], capture_output=True).returncode == 0

def _tick(f, t):
    raw = subprocess.run(['ffmpeg','-v','error','-ss',str(t),'-t','2.5','-i',f,'-vf','crop=iw*0.04:ih*0.045:iw*0.318:0,scale=64:32,format=gray','-f','rawvideo','-'],capture_output=True).stdout
    pts = subprocess.run(['ffprobe','-v','error','-read_intervals',f'{t}%+2.5','-select_streams','v:0','-show_entries','frame=pts_time','-of','csv=p=0',f],capture_output=True,text=True).stdout.split()
    fr = np.frombuffer(raw, np.uint8)
    n = len(fr) // (32*64)
    if n < 4: return None
    fr = fr[:n*32*64].reshape(n, -1).astype(float); d = np.abs(np.diff(fr, axis=0)).mean(1)
    hits = np.where(d > d.mean() + 3*d.std())[0]
    if not len(hits): return None
    times = [float(x.strip(',')) for x in pts if x.strip(',')]; times = [x for x in times if x >= t - 0.05][:n]
    return times[hits[0]+1] if len(times) == n else t + (hits[0]+1) * 2.5 / n

def _read(f, t):
    png = '/tmp/mother-osd.png'
    subprocess.run(['ffmpeg','-v','error','-y','-ss',str(t),'-i',f,'-frames:v','1','-vf',"crop=iw*0.16:ih*0.05:iw*0.205:0,format=gray,lut=y='if(gt(val\\,232)\\,0\\,255)',scale=iw*2:-1",png])
    out = subprocess.run([OCR, png], capture_output=True, text=True).stdout
    m = re.search(r'(\d)\s*$', out.strip())   # the last digit is reliable; the delay is far under 10 s
    return int(m.group(1)) if m else None

def lag(f, wall_at_file_start, duration, samples=6):
    if not ensure_ocr(): return None
    got = []
    for k in range(samples):
        t = 10 + k * max(1.0, (duration - 20) / samples)
        tk = _tick(f, t)
        if tk is None: continue
        ss = _read(f, tk + 0.2)
        if ss is None: continue
        w = wall_at_file_start + tk
        x = ((w % 10) - ss) % 10
        if 0.3 < x < 9.7: got.append(x)
    if len(got) < 2: return None
    med = statistics.median(got)
    keep = [x for x in got if abs(x - med) < 0.6]
    return round(statistics.median(keep), 2) if len(keep) >= 2 else None


def session(dir_):
    """Delays for every camera file in a session, cached in catalogue/camera-sync.json: {file: seconds}.
    The Mac camera has no burned-in clock and almost no delay: 0."""
    import json
    cache = os.path.join(dir_, 'catalogue', 'camera-sync.json')
    try: return json.load(open(cache))
    except Exception: pass
    s = json.load(open(os.path.join(dir_, 'session.json'))); st = s['start_epoch_ms'] / 1000
    out = {}
    for f in json.load(open(os.path.join(dir_, 'catalogue', 'manifest.json')))['files']:
        if f['kind'] != 'camera': continue
        out[f['file']] = 0.0 if 'mac' in f['camera'].lower() else lag(os.path.join(dir_, f['file']), st + f['offset'], f['duration'])
    by_cam = {}
    for f, v in out.items():
        if v is not None: by_cam.setdefault(f.split('/')[1], []).append(v)
    for f, v in list(out.items()):   # a file that couldn't be read takes its camera's typical delay
        if v is None:
            vs = by_cam.get(f.split('/')[1]); out[f] = round(statistics.median(vs), 2) if vs else 2.5
    json.dump(out, open(cache, 'w'), indent=1)
    return out
