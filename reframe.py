#!/usr/bin/env python3
"""Renders a vertical video that follows the people in a clip.
Usage: reframe.py <video> <start_sec> <duration_sec> <out.mp4> <width> <height>
1 person  -> full screen, camera follows their face smoothly
2 people  -> split screen: left person on top, right person below (each follows their face)
3+ people -> full screen on whoever is speaking (hard cut when the speaker changes)
No faces  -> centre crop. The output has no audio; the server adds audio, music and captions."""
import sys, subprocess
import numpy as np, cv2

src, start, dur, out = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), sys.argv[4]
OW, OH = int(sys.argv[5]), int(sys.argv[6])
OUTFPS, FPS, AW = 30, 6, 640  # output fps, analysis fps, analysis width

cap = cv2.VideoCapture(src)
sw, sh = int(cap.get(3)), int(cap.get(4))
cap.release()
AH = int(round(sh * AW / sw / 2) * 2)
S = sw / AW  # analysis pixels -> source pixels
casc = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')

# ---------- 1. find faces (and mouth movement) at a low frame rate ----------
p = subprocess.Popen(['ffmpeg', '-v', 'error', '-ss', str(start), '-t', str(dur), '-i', src,
                      '-vf', f'fps={FPS},scale={AW}:{AH}', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
                     stdout=subprocess.PIPE)
frames, prev = [], None  # frames[i] = faces left->right: (cx, cy, w, h, mouth_motion), analysis pixels
while True:
    b = p.stdout.read(AW * AH)
    if len(b) < AW * AH:
        break
    g = np.frombuffer(b, np.uint8).reshape(AH, AW)
    found = sorted((tuple(int(v) for v in f) for f in casc.detectMultiScale(g, 1.15, 6, minSize=(AW // 22, AW // 22))),
                   key=lambda f: -f[2])
    keep = []
    for f in found:  # drop duplicate detections of one face
        if all(abs((f[0] + f[2] / 2) - (k[0] + k[2] / 2)) > max(f[2], k[2]) * 0.7 for k in keep):
            keep.append(f)
    row = []
    for x, y, w, h in sorted(keep[:4], key=lambda f: f[0]):
        mot = 0.0
        if prev is not None:  # change in the mouth area since the last frame = talking
            ya, yb, xa, xb = int(y + .62 * h), int(y + .95 * h), int(x + .2 * w), int(x + .8 * w)
            a, c = g[ya:yb, xa:xb].astype(np.float32), prev[ya:yb, xa:xb].astype(np.float32)
            if a.size:
                mot = float(np.abs(a - c).mean())
        row.append((x + w / 2, y + h / 2, w, h, mot))
    frames.append(row)
    prev = g
p.wait()
if not frames:
    frames = [[]]
N = len(frames)

# ---------- 2. plan the layout over time ----------
cnt = np.array([len(r) for r in frames])
ns = [int(round(np.median(cnt[max(0, i - 3):i + 4]))) for i in range(N)]  # ignore one-frame flicker
segs, s0 = [], 0
for i in range(1, N + 1):  # new segment when the number of people changes or the camera cuts
    cut_ = i == N or ns[i] != ns[i - 1]
    if not cut_ and len(frames[i]) == len(frames[i - 1]) and len(frames[i]):
        cut_ = np.mean([abs(a[0] - b[0]) for a, b in zip(frames[i], frames[i - 1])]) > 0.12 * AW
    if cut_:
        segs.append([s0, i])
        s0 = i
k = 0
while k < len(segs):  # absorb blips shorter than about one second
    if segs[k][1] - segs[k][0] < FPS and len(segs) > 1:
        if k > 0:
            segs[k - 1][1] = segs[k][1]
            del segs[k]
        else:
            segs[1][0] = segs[0][0]
            del segs[0]
    else:
        k += 1


def smooth(series):
    """Fill gaps, then average over ~1.2 s so the camera glides with the person instead of jittering."""
    arr = np.array([s if s is not None else (np.nan, np.nan) for s in series], dtype=float)
    for c in (0, 1):
        v = arr[:, c]
        ok = ~np.isnan(v)
        if not ok.any():
            return None
        arr[:, c] = np.interp(np.arange(len(v)), np.flatnonzero(ok), v[ok])
        arr[:, c] = np.convolve(np.pad(arr[:, c], 3, mode='edge'), np.ones(7) / 7, mode='valid')
    return arr


plan = [None] * N  # per analysis frame: (key, mode, [(cx, cy, h) per slot] in source pixels)
for sid, (a, b) in enumerate(segs):
    n = ns[a]
    if n == 0:
        for i in range(a, b):
            plan[i] = ((sid, 0), 'center', [])
        continue
    ser = [smooth([(f[idx][0], f[idx][1]) if len(f) == n else None for f in frames[a:b]]) for idx in range(n)]
    hs = [float(np.median([f[idx][3] for f in frames[a:b] if len(f) == n] or [AW / 8])) for idx in range(n)]
    if any(s is None for s in ser):
        for i in range(a, b):
            plan[i] = ((sid, 0), 'center', [])
        continue
    if n <= 2:
        for i in range(a, b):
            plan[i] = ((sid, 0), 'full' if n == 1 else 'split',
                       [(ser[j][i - a][0] * S, ser[j][i - a][1] * S, hs[j] * S) for j in range(n)])
    else:  # 3+ people: follow whoever is speaking
        ms, cur, hold, run = np.zeros(n), 0, 99, 0
        for i in range(a, b):
            if len(frames[i]) == n:
                ms = 0.6 * ms + 0.4 * np.array([f[4] for f in frames[i]])
            best = int(ms.argmax())
            if best != cur and ms[best] > ms[cur] * 1.3 + 0.3 and hold >= FPS:
                cur, hold, run = best, 0, run + 1
            hold += 1
            plan[i] = ((sid, run), 'full', [(ser[cur][i - a][0] * S, ser[cur][i - a][1] * S, hs[cur] * S)])


def rect(cx, cy, h, aspect, zoom, lo, ytop):
    ch = min(sh, max(sh * lo, h * zoom))
    cw = ch * aspect
    if cw > sw:
        cw, ch = sw, sw / aspect
    x, y = min(max(cx - cw / 2, 0), sw - cw), min(max(cy - ch * ytop, 0), sh - ch)
    return int(x), int(y), max(2, int(cw)), max(2, int(ch))


def crop(fr, r, w, h):
    x, y, cw, ch = r
    return cv2.resize(fr[y:y + ch, x:x + cw], (w, h), interpolation=cv2.INTER_CUBIC)


def at(t):
    """Layout for output time t, gliding between analysis frames while the shot is unchanged."""
    f = min(t * FPS, N - 1)
    i0 = int(f)
    i1 = min(i0 + 1, N - 1)
    (k0, m0, a0), (k1, m1, a1) = plan[i0], plan[i1]
    if k0 != k1 or len(a0) != len(a1):
        return m0, a0
    w = f - i0
    return m0, [tuple(x + (y - x) * w for x, y in zip(u, v)) for u, v in zip(a0, a1)]


def compose(fr, t):
    mode, slots = at(t)
    if mode == 'split':
        hh = OH // 2
        return np.vstack([crop(fr, rect(*s, OW / hh, 3.4, 0.45, 0.42), OW, hh) for s in slots])
    if mode == 'full':
        return crop(fr, rect(*slots[0], 9 / 16, 5.0, 0.7, 0.40), OW, OH)
    cw = min(sw, int(sh * 9 / 16))
    return crop(fr, ((sw - cw) // 2, 0, cw, sh), OW, OH)


# ---------- 3. render ----------
rd = subprocess.Popen(['ffmpeg', '-v', 'error', '-ss', str(start), '-t', str(dur), '-i', src, '-vf', f'fps={OUTFPS}',
                       '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'], stdout=subprocess.PIPE, bufsize=sw * sh * 6)
wr = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{OW}x{OH}',
                       '-r', str(OUTFPS), '-i', '-', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '17',
                       '-pix_fmt', 'yuv420p', '-threads', '2', out], stdin=subprocess.PIPE)
size, n = sw * sh * 3, 0
while True:
    b = rd.stdout.read(size)
    if len(b) < size:
        break
    wr.stdin.write(compose(np.frombuffer(b, np.uint8).reshape(sh, sw, 3), n / OUTFPS).tobytes())
    n += 1
wr.stdin.close()
rd.wait()
sys.exit(0 if wr.wait() == 0 and n > 0 else 1)
