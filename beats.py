#!/usr/bin/env python3
"""Finds the beats of a music file so B-roll cuts can land on them.
Usage: beats.py <audio file>   ->  prints JSON {"bpm":float,"dur":float,"beats":[seconds...]}
Needs only numpy and ffmpeg. A tempo written in the file name (for example upbeat-trap-140bpm.mp3) is trusted."""
import sys, re, os, json, subprocess
import numpy as np

SR, HOP, N = 22050, 256, 1024
src = sys.argv[1]
raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', src, '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'],
                     stdout=subprocess.PIPE, check=True).stdout
y = np.frombuffer(raw, np.float32)
dur = len(y) / SR
if dur < 3:
    print(json.dumps({'bpm': 120.0, 'dur': dur, 'beats': [round(i * 0.5, 3) for i in range(int(dur / 0.5))]}))
    sys.exit(0)

# onset strength: positive change of the log spectrum; bass and low-mids weigh most (kick, snare, bass)
win = np.hanning(N).astype(np.float32)
nf = 1 + (len(y) - N) // HOP
idx = np.arange(N)[None, :] + HOP * np.arange(nf)[:, None]
mag = np.abs(np.fft.rfft(y[idx] * win, axis=1))
freqs = np.fft.rfftfreq(N, 1 / SR)
band = (freqs > 30) & (freqs < 4000)
spec = np.log1p(30 * mag[:, band])
w = np.interp(freqs[band], [30, 100, 200, 800, 4000], [1.0, 1.0, 0.4, 0.15, 0.08])


def onset(sp, wt):
    f = np.concatenate([[0], (np.maximum(0, np.diff(sp, axis=0)) * wt).sum(axis=1)])
    f = np.maximum(0, f - np.convolve(f, np.ones(43) / 43, mode='same'))
    return f / (f.max() or 1)


kb = (freqs > 30) & (freqs < 95)  # the kick drum alone: the main beat is where the kick lands
flux = 0.5 * onset(spec, w) + onset(np.log1p(30 * mag[:, kb]), np.ones(kb.sum()))
FPS = SR / HOP  # envelope frames per second


def comb(bpm, phase):
    per = 60.0 / bpm
    t = np.arange(phase, dur - 0.05, per)
    return np.interp(t * FPS, np.arange(len(flux)), flux).sum() / max(1, len(t))


m = re.search(r'(\d{2,3})\s?bpm', os.path.basename(src), re.I)
if m and 70 <= int(m.group(1)) <= 200:
    center, span, step = float(m.group(1)), 0.015, 0.05  # trust the name, only fine-tune
else:
    ac = np.correlate(flux, flux, 'full')[len(flux) - 1:]
    lo, hi = int(FPS * 60 / 190), int(FPS * 60 / 70)
    lags = np.arange(lo, hi)
    bpms = 60 * FPS / lags
    pref = np.exp(-0.5 * (np.log2(bpms / 125) / 0.6) ** 2)  # people favour tempos around 125
    center, span, step = float(bpms[np.argmax(ac[lo:hi] * pref)]), 0.03, 0.1

best = (-1.0, center, 0.0)
for bpm in np.arange(center * (1 - span), center * (1 + span), step):
    per = 60.0 / bpm
    for ph in np.arange(0, per, 0.01):
        s = comb(bpm, ph)
        if s > best[0]:
            best = (s, float(bpm), float(ph))
_, bpm, phase = best
while bpm < 95:
    bpm *= 2
while bpm > 175:
    bpm /= 2
per = 60.0 / bpm
LAG = 0.03  # the spectrum jump is seen when the window reaches the hit, which is slightly after it starts
phase += LAG
while phase - per >= 0:
    phase -= per
beats = [round(float(t), 3) for t in np.arange(phase, dur - 0.08, per)]
print(json.dumps({'bpm': round(bpm, 2), 'dur': round(dur, 3), 'beats': beats}))
