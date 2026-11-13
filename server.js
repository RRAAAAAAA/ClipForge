import express from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { existsSync, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const run = promisify(execFile);
const app = express();
app.use(express.json());
const here = import.meta.dirname;
const page = existsSync(path.join(here, 'public', 'index.html')) ? path.join(here, 'public', 'index.html') : path.join(here, 'index.html');
app.get('/', (req, res) => res.sendFile(page));
// music lives in the music/ folder, but audio files uploaded to the repo's top level work too
const MUSIC_DIRS = [path.join(here, 'music'), here];
const listMusic = async () => {
  const out = new Map();
  for (const d of MUSIC_DIRS) {
    try { for (const f of await fs.readdir(d)) if (/\.(mp3|m4a|wav|ogg)$/i.test(f) && !out.has(f)) out.set(f, path.join(d, f)); } catch {}
  }
  return out;
};
app.get('/api/music', async (req, res) => res.json([...(await listMusic()).keys()].sort()));
app.use('/work', express.static('work'));
await fs.mkdir('work', { recursive: true });

// Optional: paste a Netscape-format cookies.txt into the YT_COOKIES variable to avoid YouTube blocks
if (process.env.YT_COOKIES) await fs.writeFile('work/cookies.txt', process.env.YT_COOKIES);
const COOKIES = process.env.YT_COOKIES ? ['--cookies', 'work/cookies.txt'] : [];
const MAXH = parseInt(process.env.MAX_HEIGHT) || 1080; // set MAX_HEIGHT=720 in Railway if memory is still tight
const YT = ['--js-runtimes', 'deno', '--js-runtimes', 'node', '--remote-components', 'ejs:github', '--retries', '5', ...COOKIES];

let chain = Promise.resolve(); // one heavy job (download/ffmpeg) at a time so the server never runs out of memory
const queued = (fn) => { const p = chain.then(() => fn()); chain = p.catch(() => {}); return p; };

// delete files older than 90 minutes so the disk never fills up
setInterval(async () => {
  try {
    for (const f of await fs.readdir('work')) {
      if (f === 'cookies.txt') continue;
      const st = await fs.stat(`work/${f}`);
      if (Date.now() - st.mtimeMs > 90 * 60e3) await fs.rm(`work/${f}`, { force: true });
    }
  } catch {}
}, 10 * 60e3);

const friendly = (e) => {
  const m = String(e.stderr || e.message || e);
  if (/not a bot|Sign in to confirm/i.test(m)) return 'YouTube blocked the server. Add fresh YouTube cookies in the YT_COOKIES variable (see README), then try again.';
  if (/Video unavailable|Private video|members-only/i.test(m)) return 'That video is private or unavailable.';
  if (/Gemini:.*(high demand|overloaded|unavailable)/i.test(m)) return 'Gemini is busy right now. Wait a minute and try again.';
  if (/Gemini:.*(quota|exhausted|rate)/i.test(m)) return 'Gemini free limit reached. Wait a minute and try again.';
  if (/Gemini:.*(not found|not supported)/i.test(m)) return 'Gemini model unavailable. Set the MODEL variable to a current model name.';
  if (e.signal || e.killed) return 'The server ran out of memory while rendering. Try again, or give the Railway service more memory.';
  const bad = m.split('\n').filter((l) => /error|invalid|failed|cannot|no such|unable/i.test(l));
  if (bad.length) return bad.slice(-2).join(' ').slice(-400);
  return m.trim().split('\n').slice(-3).join(' ').slice(-400);
};

const fix = (c) => {
  const start = Math.max(0, Number(c.start) || 0);
  let end = Number(c.end) || 0;
  if (end - start > 60) end = start + 60;
  return { ...c, start, end, score: Math.min(100, Math.max(0, Math.round(Number(c.score) || 0))),
    title: String(c.title || 'Untitled').slice(0, 100), description: String(c.description || ''), reason: String(c.reason || '') };
};

// Move a clip's start/end to whole words so it never begins or ends in the middle of one.
const snap = (c, words, padS = 0.15, padE = 0.25) => {
  const first = words.find((w) => w.e > c.start + 0.05);
  const last = [...words].reverse().find((w) => w.s < c.end);
  if (!first || !last) return c;
  const start = Math.max(0, first.s - padS);
  let end = last.e + padE;
  if (end - start > 60.01) {
    const l2 = [...words].reverse().find((w) => w.s < c.end && w.e + padE - start <= 60.01);
    end = l2 ? l2.e + padE : start + 60;
  }
  return { ...c, start, end };
};

const PROMPT = `You pick short-form clips from a video transcript. Lines look like "[seconds] text".
Return ONLY a JSON array of 3-6 clips, each 30-60 seconds long, that start on a strong hook and end on a complete thought.
The first sentence (the first 2 seconds) decides everything: it must be a scroll-stopping hook (a bold claim, a question, a surprising fact, a strong emotion). Start exactly on that sentence: never on a greeting, an intro or filler words (so, um, yeah, and, but, like). Pick fast, dense moments with no rambling, long pauses or dead air.
Each item: {"start":number,"end":number,"title":string,"description":string,"score":number,"reason":string,"mood":string}
- title: catchy, honest, max 70 characters, no clickbait lies, no ALL CAPS
- description: 1-2 sentences plus 3 hashtags
- score: 0-100 virality estimate (hook strength, emotion, pacing, shareability), be strict
- reason: one sentence on why it can perform
- mood: one of chill, upbeat, cinematic, tense (the background music that fits the clip best)
Transcript:
`;

function parseWords(j) {
  // Some caption tracks hold a whole phrase in one piece instead of one word per piece. Each piece is split
  // into words and the time is shared out by word length, so every word has its own start and end.
  const out = [];
  let evi = 0;
  for (const ev of j.events || []) {
    const segs = (ev.segs || []).filter((sg) => (sg.utf8 || '').trim());
    if (!segs.length) continue;
    const t0 = ev.tStartMs || 0;
    evi++;
    const tEnd = t0 + (ev.dDurationMs || 0);
    segs.forEach((sg, i) => {
      const s = t0 + (sg.tOffsetMs || 0);
      const nextS = i + 1 < segs.length ? t0 + (segs[i + 1].tOffsetMs || 0) : tEnd;
      const words = sg.utf8.trim().split(/\s+/);
      const chars = words.reduce((n, w) => n + w.length + 1, 0);
      const avail = Math.max(120, nextS - s);
      const span = words.length > 1 ? Math.min(avail, 90 * chars + 300) : Math.min(avail, 700);
      let at = s;
      for (const w of words) {
        const d = (span * (w.length + 1)) / chars;
        out.push({ w, s: at / 1000, e: (at + d) / 1000, c: evi });
        at += d;
      }
    });
  }
  out.sort((x, y) => x.s - y.s);
  const clean = []; // drop repeats and make sure words never overlap
  for (const o of out) {
    const last = clean.at(-1);
    if (last && last.w === o.w && Math.abs(last.s - o.s) < 0.15) continue;
    if (last && o.s < last.e) last.e = Math.max(last.s + 0.05, o.s);
    clean.push(o);
  }
  return clean;
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));


// ---------- uploads (your own footage, and optional B-roll footage) ----------
const MAX_UP = (parseInt(process.env.MAX_UPLOAD_MB) || 1500) * 1048576;
const findFile = async (id, tag) => (await fs.readdir('work')).find((f) => f.startsWith(`${id}.${tag}.`));
const touch = (f) => fs.utimes(f, new Date(), new Date()).catch(() => {});
const probeDuration = async (f) => {
  try { const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]); return parseFloat(stdout) || 0; } catch { return 0; }
};
const toSec = (v) => (typeof v === 'string' && v.includes(':') ? v.split(':').reduce((a, x) => a * 60 + Number(x), 0) : Number(v));

// B-roll library space: all uploaded B-roll files share one budget (BROLL_QUOTA_MB), and the page shows how much is left
const BR_QUOTA = (parseInt(process.env.BROLL_QUOTA_MB) || 2000) * 1048576;
const brollUsed = async () => {
  let n = 0;
  for (const f of await fs.readdir('work')) if (/^[a-f0-9]{10}\.bsrc\./.test(f)) n += (await fs.stat(`work/${f}`).catch(() => ({ size: 0 }))).size;
  return n;
};
const mb = (n) => +(n / 1048576).toFixed(1);
const space = async () => { const used = await brollUsed(); return { quotaMB: mb(BR_QUOTA), usedMB: mb(used), leftMB: mb(Math.max(0, BR_QUOTA - used)) }; };
app.get('/api/broll-space', async (_req, res) => res.json(await space()));
app.delete('/api/broll/:id', async (req, res) => {
  const id = req.params.id;
  if (!/^[a-f0-9]{10}$/.test(id)) return res.status(400).json({ error: 'bad id' });
  for (const f of await fs.readdir('work')) if (f.startsWith(`${id}.`) || f.startsWith(`bks_${id}_`)) await fs.rm(`work/${f}`, { force: true });
  res.json(await space());
});

// the video is streamed straight to disk (never held in memory), so big files are fine
app.post('/api/upload', async (req, res) => {
  let file;
  try {
    const isB = req.query.kind === 'broll';
    const kind = isB ? 'bsrc' : 'upload';
    const left = isB ? BR_QUOTA - (await brollUsed()) : Infinity;
    const limit = Math.min(MAX_UP, left);
    const size = Number(req.headers['content-length']) || 0;
    if (size > limit) throw new Error(isB && left < MAX_UP
      ? `Not enough B-roll space: this file is ${mb(size)} MB and only ${mb(Math.max(0, left))} MB is left. Remove a file below or upload a smaller one.`
      : `That file is too big. The limit is ${Math.round(MAX_UP / 1048576)} MB.`);
    const ext = (path.extname(String(req.query.name || '')).toLowerCase().match(/^\.(mp4|mov|mkv|webm|m4v|avi)$/) || ['.mp4'])[0];
    const id = crypto.randomBytes(5).toString('hex');
    file = `work/${id}.${kind}${ext}`;
    let got = 0;
    const cap = new Transform({ transform(chunk, _e, cb) { got += chunk.length; cb(got > limit ? new Error('That file is too big, or there is not enough B-roll space left.') : null, chunk); } });
    await pipeline(req, cap, createWriteStream(file));
    if (!got) throw new Error('The upload was empty.');
    res.json({ id, sizeMB: mb(got), ...(isB ? await space() : {}) });
  } catch (e) {
    if (file) await fs.rm(file, { force: true });
    if (!res.headersSent) res.status(500).json({ error: friendly(e) });
  }
});

// ---------- B-roll (cutaways inside the video, cut on the beat of the music) ----------
const PIXABAY = process.env.PIXABAY_API_KEY;
const BR_EVERY = Math.max(1.5, parseFloat(process.env.BROLL_EVERY) || 2.4); // on average one cutaway every N seconds (lower = more B-roll)
const BR_FADE = Math.min(0.5, Math.max(0.05, parseFloat(process.env.BROLL_FADE) || 0.12)); // crossfade seconds: short, so cuts feel snappy on the beat
const BR_TAIL = 1.2; // no cutaway in the last seconds (the punchline)
const BR_MODELS = [...new Set([process.env.MODEL, 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'].filter(Boolean))];
const GL = 'https://generativelanguage.googleapis.com';

async function askGeminiParts(parts, { temp = 0.4, timeout = 45000 } = {}) {
  let data;
  outer: for (const model of BR_MODELS) {
    for (let t = 1; t <= 2; t++) {
      try {
        const r = await fetch(`${GL}/v1beta/models/${model}:generateContent`, {
          method: 'POST', headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'content-type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: 'application/json', temperature: temp } }),
          signal: AbortSignal.timeout(timeout),
        });
        data = await r.json();
      } catch (e) { data = { error: { code: 504, message: `${model} did not answer in time` } }; break; }
      if (!data.error) break outer;
      if ([429, 500, 503].includes(data.error.code)) { await sleep(2000); continue; }
      break;
    }
  }
  if (data?.error) throw new Error('Gemini: ' + data.error.message);
  return data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
}
const askGemini = (text) => askGeminiParts([{ text }]);
const jsonArray = (raw) => { const m = raw.match(/\[[\s\S]*\]/); try { return m ? JSON.parse(m[0]) : []; } catch { return []; } };

// ---------- speech to text for uploaded videos (Gemini listens to the audio) ----------
const TRANSCRIBE = `Transcribe the speech in this audio exactly as spoken, in the language spoken. Return ONLY a JSON array of items {"s":number,"t":string}.
s = start time in seconds from the beginning of this audio (decimal), t = what is said: a phrase of about 5 to 12 words. Start a new item every 2 to 4 seconds. No speaker names, no sound descriptions. If nobody speaks, return [].`;

function segsToWords(segs, off, endAt) { // turn phrases with a start time into words with their own start and end (time shared out by word length)
  const out = [];
  segs.forEach((g, i) => {
    const s = off + g.s, nextS = i + 1 < segs.length ? off + segs[i + 1].s : endAt;
    const words = String(g.t).trim().split(/\s+/).filter(Boolean);
    if (!words.length) return;
    const chars = words.reduce((n, w) => n + w.length + 1, 0);
    const span = Math.max(0.3, Math.min(nextS - s, words.length * 0.42));
    let at = s;
    for (const w of words) { const d = (span * (w.length + 1)) / chars; out.push({ w, s: at, e: at + d, c: i }); at += d; }
  });
  return out;
}

async function transcribeUpload(id, file) {
  const dur = await probeDuration(`work/${file}`);
  if (!dur) throw new Error('Could not read that video. Try an MP4 or MOV file.');
  const CH = 600, words = []; // ten minutes of audio at a time keeps every request small
  for (let c = 0; c * CH < dur; c++) {
    const part = `work/${id}.a${c}.mp3`;
    await queued(() => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(c * CH), '-t', String(CH), '-threads', '2', '-i', `work/${file}`,
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '32k', part], { maxBuffer: 1e7 }));
    const b64 = (await fs.readFile(part)).toString('base64');
    await fs.rm(part, { force: true });
    const raw = await askGeminiParts([{ inlineData: { mimeType: 'audio/mpeg', data: b64 } }, { text: TRANSCRIBE }], { temp: 0, timeout: 120000 });
    const segs = jsonArray(raw).map((g) => ({ s: toSec(g.s), t: g.t })).filter((g) => Number.isFinite(g.s) && g.t).sort((a, b) => a.s - b.s);
    words.push(...segsToWords(segs, c * CH, Math.min(dur, (c + 1) * CH)));
  }
  if (words.length < 20) throw new Error('No speech found in this video. ClipForge needs someone talking to pick clips.');
  return words;
}

// ---------- your own B-roll footage: Gemini watches it once and lists the scenes ----------
const SCENE_PROMPT = `Watch this footage and split it into separate visual scenes (a new scene starts when the shot or subject clearly changes).
Return ONLY a JSON array of up to 120 items: {"start":number,"end":number,"tags":string}
- start and end are decimal seconds from the start of the video; every scene lasts at least 2 seconds
- tags: 3 to 7 plain English keywords separated by commas that name the concrete things shown or the idea they illustrate, for example "cars, supercar, driving, speed" or "money, cash, rich" or "winning, trophy, celebration" or "teaching, classroom, whiteboard"`;

async function geminiFile(file, mime) {
  const key = { 'x-goog-api-key': process.env.GEMINI_API_KEY };
  const size = (await fs.stat(file)).size;
  const st = await fetch(`${GL}/upload/v1beta/files`, {
    method: 'POST', signal: AbortSignal.timeout(30000),
    headers: { ...key, 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start', 'X-Goog-Upload-Header-Content-Length': String(size), 'X-Goog-Upload-Header-Content-Type': mime, 'content-type': 'application/json' },
    body: JSON.stringify({ file: { display_name: 'clipforge-broll' } }),
  });
  const url = st.headers.get('x-goog-upload-url');
  if (!url) throw new Error('Gemini: could not start the footage upload.');
  const up = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(300000), headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' }, body: await fs.readFile(file) });
  let info = (await up.json()).file;
  if (!info) throw new Error('Gemini: the footage upload failed.');
  for (let i = 0; i < 60 && info.state === 'PROCESSING'; i++) { await sleep(3000); info = await (await fetch(`${GL}/v1beta/${info.name}`, { headers: key })).json(); }
  if (info.state !== 'ACTIVE') throw new Error('Gemini: could not read the B-roll footage.');
  return info;
}

const brollIndexJob = async (req, res) => {
  try {
    const { id } = req.body;
    if (!/^[a-f0-9]{10}$/.test(id)) throw new Error('bad id');
    const f = await findFile(id, 'bsrc');
    if (!f) throw new Error('Upload expired. Please upload the B-roll footage again.');
    const sf = `work/${id}.scenes.json`;
    let scenes = JSON.parse(await fs.readFile(sf, 'utf8').catch(() => 'null'));
    if (!scenes) {
      // a small low-resolution copy is what Gemini watches (fast to upload, and Gemini only samples about 1 frame per second anyway)
      const proxy = `work/${id}.proxy.mp4`;
      await queued(() => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-t', '2400', '-threads', '2', '-i', `work/${f}`, '-vf', 'scale=-2:360,fps=2', '-an',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '32', '-pix_fmt', 'yuv420p', '-threads', '2', proxy], { maxBuffer: 1e7, timeout: 900000 }));
      const info = await geminiFile(proxy, 'video/mp4');
      let raw;
      try { raw = await askGeminiParts([{ fileData: { mimeType: 'video/mp4', fileUri: info.uri } }, { text: SCENE_PROMPT }], { temp: 0.2, timeout: 180000 }); }
      finally { fetch(`${GL}/v1beta/${info.name}`, { method: 'DELETE', headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY } }).catch(() => {}); await fs.rm(proxy, { force: true }); }
      scenes = jsonArray(raw).map((x) => ({ start: toSec(x.start), end: toSec(x.end), tags: String(x.tags || '').replace(/[^\w ,'-]/g, '').slice(0, 120) }))
        .filter((x) => x.tags && Number.isFinite(x.start) && Number.isFinite(x.end) && x.end - x.start >= 1.6).slice(0, 150).map((x, i) => ({ id: 'S' + (i + 1), ...x }));
      if (!scenes.length) throw new Error('No usable scenes found in the B-roll footage.');
      await fs.writeFile(sf, JSON.stringify(scenes));
    }
    await touch(`work/${f}`);
    res.json({ scenes: scenes.length });
  } catch (e) {
    console.error(e.stderr || e);
    res.status(500).json({ error: friendly(e) });
  }
};

// ---------- beats of the background music ----------
const beatCache = new Map();
async function getBeats(file) {
  const k = file + (await fs.stat(file)).mtimeMs;
  if (beatCache.has(k)) return beatCache.get(k);
  const { stdout } = await queued(() => run('python3', [path.join(here, 'beats.py'), file], { maxBuffer: 1e7, timeout: 120000 }));
  const j = JSON.parse(stdout);
  beatCache.set(k, j);
  return j;
}
// the track is looped under the clip, so its beats repeat every `dur` seconds
const loopBeats = (info, total) => {
  const out = [];
  for (let k = 0; k * info.dur < total + info.dur; k++) for (const b of info.beats) { const t = b + k * info.dur; if (t > total) return out; out.push(+t.toFixed(3)); }
  return out;
};

// ---------- dead air: find pauses in the speech and keep only the talking ----------
const DA_DB = parseFloat(process.env.DEAD_AIR_DB) || -32; // quieter than this counts as silence (raise towards -28 for noisy recordings)
const DA_MIN = 0.4, DA_GAP = 0.2; // pauses longer than DA_MIN are shortened to about DA_GAP seconds
async function findKeep(seg, off, dur) {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostats', '-ss', String(off), '-t', String(dur), '-threads', '2', '-i', seg, '-vn',
    '-af', `silencedetect=noise=${DA_DB}dB:d=${DA_MIN}`, '-f', 'null', '-'], { maxBuffer: 1e7 });
  const sil = [];
  let st = null;
  for (const l of stderr.split('\n')) {
    let m;
    if ((m = l.match(/silence_start: (-?[\d.]+)/))) st = Math.max(0, +m[1]);
    else if ((m = l.match(/silence_end: ([\d.]+)/)) && st != null) { sil.push([st, Math.min(dur, +m[1])]); st = null; }
  }
  if (st != null) sil.push([st, dur]);
  const cuts = []; // removed ranges, on the 30 fps frame grid so picture and sound stay exactly in step
  for (const [s, e] of sil) {
    if (e - s < DA_MIN) continue;
    const lead = s < 0.05, tail = e > dur - 0.05;
    const a = lead ? 0 : tail ? s + 0.25 : s + DA_GAP / 2; // the clip starts right on the first word; the end keeps a short tail
    const b = tail ? dur : lead ? e - 0.06 : e - DA_GAP / 2;
    const fa = Math.ceil(a * 30 - 1e-6) / 30, fb = tail ? dur : Math.floor(b * 30 + 1e-6) / 30;
    if (fb - fa >= 0.1) cuts.push([fa, fb]);
  }
  const keep = [];
  let cur = 0;
  for (const [a, b] of cuts) { if (a - cur >= 0.05) keep.push([cur, a]); cur = b; }
  if (dur - cur >= 0.05) keep.push([cur, dur]);
  const total = keep.reduce((n, [a, b]) => n + b - a, 0);
  return keep.length && total >= dur * 0.4 ? keep : [[0, dur]]; // if almost everything looks silent the threshold is wrong: leave the clip alone
}

// ---------- B-roll plan: Gemini says what to show, the cuts are snapped to the beat ----------
async function planBroll(ws, dur, beats, scenes) {
  const max = Math.min(24, Math.floor(dur / BR_EVERY));
  if (max < 2 || !ws.length) return [];
  let text = '';
  for (let i = 0; i < ws.length; i += 8) text += `[${ws[i].s.toFixed(1)}] ${ws.slice(i, i + 8).map((w) => w.w).join(' ')}\n`;
  scenes = scenes.slice(0, 200);
  const sceneTxt = scenes.map((s) => `${s.id} (${Math.round(s.end - s.start)}s): ${s.tags}`).join('\n');
  const cacheFile = `work/br3_${crypto.createHash('md5').update(`${dur.toFixed(1)}|${sceneTxt}|${text}`).digest('hex').slice(0, 12)}.json`;
  let arr = null;
  try { arr = JSON.parse(await fs.readFile(cacheFile, 'utf8')); } catch {} // "Apply edits" keeps the same picks; only the beat timing changes with the music
  if (!arr) {
    const raw = await askGemini(`You pick B-roll cutaways for a very fast-paced short vertical video, in the style of viral TikTok / Reels clippers. Transcript lines look like "[seconds] text".
Return ONLY a JSON array of ${Math.max(3, max - 5)} to ${max} items: {"start":number,"end":number,"query":string,"scene":string or null}
- the cuts are snapped to the music beat afterwards, so only say roughly when. Each cutaway lasts 1 to 2 seconds.
- keep the pace high: a cutaway about every 2 to 3 seconds. Put 2 to 4 cutaways back to back (the end of one is the start of the next, no gap), then leave 0.5 to 1.5 seconds of the speaker before the next group.
- the first cutaway starts at about 1 second and matches the hook (the first sentence). The speaker is on screen before that.
- put a cutaway on every concrete thing, place, object, activity, number or feeling that the speaker mentions, as it is said
- query: 1 to 3 plain English words naming something concrete and filmable (for example "stock market", "city traffic", "doctor hospital"). Never abstract words or people's names. Use a different query for every item.
${scenes.length ? `- the creator uploaded their own footage, listed below by id (for example F1S1, F1S2, F2S1) with tags. Whenever a scene fits what is being said (cars, wins, money, teaching, and so on) set "scene" to its id and use its main tag as the query. Prefer the creator's scenes whenever they fit; otherwise set "scene" to null. Do not use one scene more than 4 times.
Creator's scenes:
${sceneTxt}` : '- set "scene" to null for every item'}
- the cutaways must stop ${BR_TAIL} seconds before the end (leave the punchline)
Video length: ${dur.toFixed(0)} seconds.
Transcript:
${text}`);
    arr = jsonArray(raw).map((x) => ({ start: Number(x.start), end: Number(x.end), query: String(x.query || '').replace(/[^\w ]/g, '').trim().slice(0, 40), scene: scenes.some((s) => s.id === x.scene) ? x.scene : null }))
      .filter((x) => (x.query || x.scene) && Number.isFinite(x.start) && Number.isFinite(x.end)).sort((p, q) => p.start - q.start);
    await fs.writeFile(cacheFile, JSON.stringify(arr));
  }
  return snapSlots(arr, dur, beats);
}

// Move every cutaway so it starts and ends on a beat: 2 to 4 beats long, back-to-back ones share the same beat, nothing before 1 s or in the last seconds.
function snapSlots(arr, dur, beats) {
  if (beats.length < 4) return [];
  const gaps = beats.slice(1).map((b, i) => b - beats[i]).sort((a, b) => a - b);
  const p = gaps[gaps.length >> 1] || 0.5;
  const near = (t) => { let lo = 0, hi = beats.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (beats[m] < t) lo = m; else hi = m; } return Math.abs(beats[lo] - t) <= Math.abs(beats[hi] - t) ? lo : hi; };
  let lastOk = beats.length - 1;
  while (lastOk > 0 && beats[lastOk] > dur - BR_TAIL) lastOk--;
  const firstOk = Math.max(0, beats.findIndex((b) => b >= 1.0));
  const out = [];
  let prevEnd = -1;
  for (const a of arr) {
    let si = Math.max(near(a.start), firstOk);
    if (si < prevEnd) si = prevEnd;
    const L = Math.min(4, Math.max(2, Math.round((a.end - a.start) / p)));
    const ei = Math.min(si + L, lastOk);
    if (ei - si < 2) continue;
    // centre the short crossfade on the beat so the change of picture lands with the hit
    out.push({ start: Math.max(0, +(beats[si] - BR_FADE / 2).toFixed(3)), end: +(beats[ei] - BR_FADE / 2).toFixed(3), query: a.query, scene: a.scene });
    prevEnd = ei;
  }
  return out;
}

// Pixabay asks that search results be cached for 24 hours and allows 100 requests per 60 seconds per key.
// Results are kept in memory and in pixabay-cache.json (so a restart does not lose them).
const PX_FILE = path.join(here, 'pixabay-cache.json');
const PX_TTL = 24 * 3600e3;
const pxCache = new Map();
try { for (const [k, v] of Object.entries(JSON.parse(await fs.readFile(PX_FILE, 'utf8')))) if (Date.now() - v.t < PX_TTL) pxCache.set(k, v); } catch {}
const pxSave = () => fs.writeFile(PX_FILE, JSON.stringify(Object.fromEntries(pxCache))).catch(() => {});

async function pxSearch(query) {
  const k = query.toLowerCase();
  const c = pxCache.get(k);
  if (c && Date.now() - c.t < PX_TTL) return c.hits;
  for (let t = 0; t < 3; t++) {
    const r = await fetch(`https://pixabay.com/api/videos/?key=${PIXABAY}&q=${encodeURIComponent(query)}&per_page=20&safesearch=true`, { signal: AbortSignal.timeout(15000) });
    if (r.status === 429) { // over the limit: wait for the window to reset, then try again
      const wait = Math.min(30, Math.max(2, Number(r.headers.get('x-ratelimit-reset')) || 10));
      console.error(`Pixabay rate limit reached, waiting ${wait}s`);
      await sleep(wait * 1000);
      continue;
    }
    if (!r.ok) throw new Error(`Pixabay error ${r.status}`);
    const hits = ((await r.json()).hits || []).map((h) => ({ id: h.id, duration: h.duration,
      medium: h.videos?.medium ? { url: h.videos.medium.url, size: h.videos.medium.size } : null,
      small: h.videos?.small ? { url: h.videos.small.url, size: h.videos.small.size } : null }));
    if (pxCache.size >= 500) pxCache.delete(pxCache.keys().next().value);
    pxCache.set(k, { t: Date.now(), hits });
    pxSave();
    return hits;
  }
  throw new Error('Pixabay rate limit reached, try again in a minute');
}

// Pick a video at least `need` seconds long that was not already used in this clip.
async function findClip(q, need, used) {
  for (const query of [...new Set([q, q.split(' ').slice(0, 2).join(' ')])]) {
    const hits = (await pxSearch(query)).filter((h) => h.duration >= need && !used.has(h.id));
    for (const h of hits) {
      const v = [h.medium?.size < 12e6 ? h.medium : null, h.small].find((x) => x?.url && (x.size || 0) < 30e6);
      if (v) return { id: h.id, url: v.url };
    }
  }
  return null;
}

async function fetchClip(hit) {
  const f = `work/bk_${hit.id}.mp4`;
  if (existsSync(f)) return f;
  const r = await fetch(hit.url, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`footage download failed ${r.status}`);
  await fs.writeFile(f, Buffer.from(await r.arrayBuffer()));
  return f;
}

// Cut each slot's footage to the slot length at the size it will be shown (square or 9:16): small files = low memory.
// Footage comes from the creator's own B-roll upload when a scene fits, and from Pixabay otherwise.
const SQ_CROP = "crop='min(iw,ih)':'min(iw,ih)'";
const TALL_CROP = "crop='min(iw,ih*9/16)':'min(ih,iw*16/9)'";
async function prepBroll(slots, W, FH, square, src) {
  const out = [], used = new Set(), cursor = new Map();
  const tag = (square ? 'sq' : 'v') + W;
  const vf = `${square ? SQ_CROP : TALL_CROP},scale=${W}:${FH},fps=30,setsar=1`;
  const enc = ['-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-pix_fmt', 'yuv420p', '-threads', '2'];
  for (const s of slots) {
    try {
      const len = s.end - s.start, need = len + BR_FADE + 0.1;
      const sc = s.scene && src?.scenes.find((x) => x.id === s.scene);
      if (sc) { // the creator's own footage: take the next unused piece of that scene (scene edges are trimmed, Gemini's times are not frame exact)
        const lo = sc.start + 0.4, hi = sc.end - 0.4;
        if (hi - lo >= need) {
          let o = cursor.get(sc.id) || 0;
          if (lo + o + need > hi) o = 0;
          cursor.set(sc.id, o + len + 0.3);
          const f = `work/bks_${sc.srcId}_${sc.id}_${o.toFixed(1)}_${len.toFixed(2)}_${tag}.mp4`;
          if (!existsSync(f)) await queued(() => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', (lo + o).toFixed(2), '-t', need.toFixed(2), '-threads', '2', '-i', sc.file, '-vf', vf, ...enc, f], { maxBuffer: 1e7 }));
          out.push({ ...s, file: f });
          continue;
        }
      }
      if (!PIXABAY || !s.query) continue;
      const hit = await findClip(s.query, need + 0.3, used);
      if (!hit) { console.error('B-roll: nothing found for', s.query); continue; }
      used.add(hit.id);
      const raw = await fetchClip(hit);
      const f = `work/bkd_${hit.id}_${len.toFixed(2)}_${tag}.mp4`;
      if (!existsSync(f)) await queued(() => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-t', need.toFixed(2), '-threads', '2', '-i', raw, '-vf', vf, ...enc, f], { maxBuffer: 1e7 }));
      out.push({ ...s, file: f });
    } catch (e) {
      console.error('B-roll skipped:', s.query, e.stderr || e.message);
      if (/download failed/.test(String(e.message)) && s.query) { pxCache.delete(s.query.toLowerCase()); pxCache.delete(s.query.split(' ').slice(0, 2).join(' ').toLowerCase()); }
    }
  }
  return out;
}

const analyzeJob = async (req, res) => {
  try {
    const count = Math.min(5, Math.max(1, parseInt(req.body.count) || 3));
    const cachedClips = async (id) => {
      try {
        const cached = JSON.parse(await fs.readFile(`work/${id}.clips.json`));
        if (cached.length >= count) return [...cached].sort((a, b) => b.score - a.score).slice(0, count);
      } catch {}
      return null;
    };
    let id, words, padS = 0.15, padE = 0.25;
    if (req.body.upload) { // ----- your own video: Gemini listens to the audio instead of reading a YouTube transcript
      id = String(req.body.upload);
      if (!/^[a-f0-9]{10}$/.test(id)) throw new Error('bad id');
      const f = await findFile(id, 'upload');
      if (!f) throw new Error('Upload expired. Please upload the video again.');
      await touch(`work/${f}`);
      const hit = await cachedClips(id);
      if (hit) return res.json({ id, clips: hit });
      words = JSON.parse(await fs.readFile(`work/${id}.words.json`, 'utf8').catch(() => 'null'));
      if (!words) { words = await transcribeUpload(id, f); await fs.writeFile(`work/${id}.words.json`, JSON.stringify(words)); }
      padS = 0.7; padE = 0.6; // spoken times from audio are approximate, so start a little early; the dead-air trim removes any silence this adds
    } else { // ----- YouTube link
      const { url } = req.body;
      if (!/^https?:\/\/((www|m|music)\.)?(youtube\.com|youtu\.be)\//i.test(url || '')) throw new Error('Paste a valid YouTube link.');
      id = crypto.createHash('md5').update(url + '|v5').digest('hex').slice(0, 10);
      const hit = await cachedClips(id); // reuse earlier result for the same link (saves Gemini quota)
      if (hit) return res.json({ id, clips: hit });
      await fs.writeFile(`work/${id}.url`, url); // remembered so each clip can be downloaded later
      // only the transcript is fetched here (fast, and the whole video never has to fit in memory)
      if (!(await fs.readdir('work')).some((f) => f.startsWith(`${id}.`) && f.endsWith('.json3')))
        await queued(() => run('yt-dlp', ['--skip-download', ...YT, '--write-auto-subs', '--sub-langs', 'en', '--sleep-subtitles', '2',
          '--sub-format', 'json3', '-o', `work/${id}.%(ext)s`, url], { maxBuffer: 1e8 }));
      const sub = (await fs.readdir('work')).find((f) => f.startsWith(id) && f.endsWith('.json3'));
      if (!sub) throw new Error('No English captions found for this video.');
      words = parseWords(JSON.parse(await fs.readFile(`work/${sub}`)));
      await fs.writeFile(`work/${id}.words.json`, JSON.stringify(words));
    }

    let text = '';
    for (let i = 0; i < words.length; i += 12)
      text += `[${Math.round(words[i].s)}] ${words.slice(i, i + 12).map((w) => w.w).join(' ')}\n`;

    // try your MODEL first, then other free models, so one busy model doesn't stop the app
    const models = [...new Set([process.env.MODEL, 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'].filter(Boolean))];
    const body = JSON.stringify({
      contents: [{ parts: [{ text: PROMPT.replace('3-6 clips', `the ${count} best clips (best first)`) + text.slice(0, 300000) }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.7 },
    });
    let data;
    outer: for (const model of models) {
      for (let t = 1; t <= 2; t++) {
        // a hung model must not freeze the job (Node gives up silently after 5 minutes): wait 60 s, then try the next model
        try {
          const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
            method: 'POST', headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'content-type': 'application/json' }, body,
            signal: AbortSignal.timeout(60000),
          });
          data = await r.json();
        } catch (e) {
          console.error(`Gemini ${model} attempt ${t} failed:`, e.name === 'TimeoutError' ? 'no answer in 60 s' : e.message);
          data = { error: { code: 504, message: `${model} did not answer in time` } };
          break; // slow or unreachable: go straight to the next model
        }
        if (!data.error) break outer;
        console.error(`Gemini ${model} attempt ${t}:`, data.error.code, data.error.message);
        if ([429, 500, 503].includes(data.error.code)) { await new Promise((ok) => setTimeout(ok, 3000)); continue; }
        break; // model retired or not allowed: go to the next one
      }
    }
    if (data.error) throw new Error('Gemini: ' + data.error.message);
    const raw = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
    const arr = raw.match(/\[[\s\S]*\]/);
    if (!arr) throw new Error('Gemini returned no clips. Try again.');
    const clips = JSON.parse(arr[0]).map(fix).map((c) => snap(c, words, padS, padE)).filter((c) => c.end - c.start >= 15);
    if (!clips.length) throw new Error('No usable clips found in this video.');
    clips.sort((a, b) => b.score - a.score);
    clips.splice(count);
    await fs.writeFile(`work/${id}.clips.json`, JSON.stringify(clips));
    res.json({ id, clips });
  } catch (e) {
    console.error(e.stderr || e);
    res.status(500).json({ error: friendly(e) });
  }
};

const renderJob = async (req, res) => {
  try {
    const { id, start, end } = req.body;
    if (!/^[a-f0-9]{10}$/.test(id)) throw new Error('bad id');
    if (!(end > start && end - start <= 90)) throw new Error('Bad clip times.');
    const up = await findFile(id, 'upload'); // an uploaded video, or else a YouTube link
    const ytUrl = up ? '' : (await fs.readFile(`work/${id}.url`, 'utf8').catch(() => '')).trim();
    if (!up && !ytUrl) throw new Error('Source expired. Paste the link or upload the video again.');
    for (const f of [`work/${id}.url`, `work/${id}.words.json`, up && `work/${up}`]) if (f) await touch(f);

    // optional: the creator's own B-roll footage (one or many files, each already indexed into scenes)
    let src = null;
    const bScenes = [];
    const bids = [...new Set([].concat(req.body.brollSrc || []).map(String).filter((x) => /^[a-f0-9]{10}$/.test(x)))].slice(0, 30);
    for (const [k, bid] of bids.entries()) {
      const bf = await findFile(bid, 'bsrc');
      const sc = JSON.parse(await fs.readFile(`work/${bid}.scenes.json`, 'utf8').catch(() => 'null'));
      if (!bf || !sc?.length) continue;
      await touch(`work/${bf}`); await touch(`work/${bid}.scenes.json`);
      for (const x of sc) bScenes.push({ ...x, id: `F${k + 1}${x.id}`, file: `work/${bf}`, srcId: bid });
    }
    if (bScenes.length) src = { scenes: bScenes };

    // work on only this clip (plus a second of padding each side) instead of the whole video
    const S = Math.max(0, Math.floor(start) - 1), E = Math.ceil(end) + 1;
    const seg = `work/seg_${id}_${S}_${E}.mp4`;
    if (!existsSync(seg)) {
      if (up) await queued(() => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(S), '-t', String(E - S), '-threads', '2', '-i', `work/${up}`,
        '-vf', `scale=-2:'min(ih,${MAXH})'`, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-threads', '2', '-x264-params', 'rc-lookahead=0:ref=1',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', seg], { maxBuffer: 1e7, timeout: 900000 }));
      else await queued(() => run('yt-dlp', ['-f', `bv*[height<=${MAXH}]+ba/b[height<=${MAXH}]`, '--merge-output-format', 'mp4',
        // keep ffmpeg light: few threads and a fast, low-memory encode (the host reports many more CPU cores than we may use)
        '--downloader-args', 'ffmpeg_i:-threads 2',
        '--downloader-args', 'ffmpeg_o:-c:v libx264 -preset ultrafast -crf 20 -threads 2 -x264-params rc-lookahead=0:ref=1 -pix_fmt yuv420p -c:a aac -b:a 128k',
        '--download-sections', `*${S}-${E}`, '--force-keyframes-at-cuts', ...YT, '-o', `work/seg_${id}_${S}_${E}.%(ext)s`, ytUrl],
        { maxBuffer: 1e8, timeout: 900000 }));
    }
    const off = start - S; // where the clip starts inside the downloaded piece
    const clipLen = end - start;
    const square = req.body.layout === 'square'; // 9:16 canvas with the footage as a 1:1 square in the middle
    const frame = req.body.frame === 'center' ? 'center' : 'auto';

    // ----- dead air: keep only the talking (list of [from, to] in clip seconds)
    let keep = [[0, clipLen]];
    if (req.body.trim !== false) {
      try { keep = await queued(() => findKeep(seg, off, clipLen)); } catch (e) { console.error('dead-air scan failed:', e.stderr || e.message); }
    }
    const D2 = keep.reduce((n, [a, b]) => n + b - a, 0); // length after the cuts
    const cut = keep.length > 1 || keep[0][0] > 0.001 || keep[0][1] < clipLen - 0.001;
    const keepMap = (t) => { let acc = 0; for (const [a, b] of keep) { if (t < a) return acc; if (t <= b) return acc + (t - a); acc += b - a; } return acc; };
    const selExpr = keep.map(([a, b]) => `between(t,${a.toFixed(4)},${(b - 0.0005).toFixed(4)})`).join('+');
    const vSel = cut ? `,select='${selExpr}',setpts=N/(30*TB)` : '';
    // audio is cut in 3 ms pieces so it lines up with the picture to the millisecond
    const aSel = cut ? `aresample=48000,asetnsamples=n=160:p=0,aselect='${selExpr}',asetpts=N/SR/TB` : 'anull';

    // ----- music, and where its beats fall (after the cuts)
    const music = (await listMusic()).get(String(req.body.music || '')) || null;
    const vol = req.body.volume != null && req.body.volume !== '' && Number.isFinite(+req.body.volume) ? Math.min(3, Math.max(0, +req.body.volume)) : 0.7;
    let beats = [], bpm = 0;
    if (music) {
      try { const info = await getBeats(music); bpm = info.bpm; beats = loopBeats(info, D2 + 1); } catch (e) { console.error('beat detection failed:', e.stderr || e.message); }
    }
    if (beats.length < 4) { bpm = 0; beats = Array.from({ length: Math.floor(D2 / 0.5) + 3 }, (_, i) => i * 0.5); } // no music: an even 120 BPM pulse

    // ----- B-roll plan on the cut timeline
    const all = JSON.parse(await fs.readFile(`work/${id}.words.json`, 'utf8').catch(() => '[]'));
    const ws = all.filter((w) => w.e > start + 0.05 && w.s < end).map((w) => ({ ...w, s: keepMap(Math.max(0, w.s - start)), e: keepMap(w.e - start) }));
    let slots = [], brNote = '';
    if (req.body.broll !== false) {
      if (!PIXABAY && !src) brNote = 'B-roll skipped: add PIXABAY_API_KEY or upload B-roll footage.';
      else if (!ws.length) brNote = 'B-roll skipped: no transcript found for this clip.';
      else {
        try { slots = await planBroll(ws, D2, beats, src?.scenes || []); }
        catch (e) { console.error('B-roll planning failed:', e.message); brNote = 'B-roll planning failed, so none was added.'; }
      }
    }

    const key = crypto.randomBytes(4).toString('hex');
    const fadeOut = Math.max(0, D2 - 1.5).toFixed(2);
    // music is looped, faded in/out, and gently lowered while someone is speaking
    const duck = (m) => `[sa]asplit=2[va][vs];[${m}:a]volume=${vol},afade=t=in:d=1,afade=t=out:st=${fadeOut}:d=1.5[m];[m][vs]sidechaincompress=threshold=0.05:ratio=2.5:attack=20:release=400:makeup=1[mc];[va][mc]amix=inputs=2:duration=first:normalize=0[a]`;
    const mus = music ? ['-stream_loop', '-1', '-i', music] : [];
    let lastErr, note = '';
    // if the server runs low on memory, retry at a lighter size; the last try drops B-roll
    for (const [W, H, useB] of [[1080, 1920, 1], [720, 1280, 1], ...(slots.length ? [[720, 1280, 0]] : [])]) {
      const VH = square ? W : H; // height of the speaker video: a square, or the whole 9:16 frame
      let rf = null;
      if (frame === 'auto') { // face-following crop: finds faces, follows them, shows whoever is speaking
        const f = `work/rf_${id}_${Math.round(start * 10)}_${Math.round(end * 10)}_${W}${square ? 'sq' : ''}.mp4`;
        try {
          if (!existsSync(f)) await queued(() => run('python3', [path.join(here, 'reframe.py'), seg, String(off), String(clipLen), f, String(W), String(VH), ...(square ? ['square'] : [])], { maxBuffer: 1e7, timeout: 300000 }));
          rf = f;
        } catch (e) { console.error('reframe failed, using centre crop:', e.stderr || e.message); await fs.rm(f, { force: true }); }
      }
      if (frame === 'auto') note = rf ? '' : 'Face tracking was unavailable, so the centre crop was used.';
      if (rf) { // tell the person what the face tracking found
        try {
          const j = JSON.parse(await fs.readFile(rf + '.json', 'utf8')), sc = j.seconds;
          const part = (n, t) => (sc[n] > 0.4 ? `${t} ${Math.round(sc[n])}s` : '');
          note = sc.center >= clipLen * 0.6 ? 'No faces were found, so the centre crop was used.'
            : 'Framing: ' + [part('split', 'split screen'), part('full', 'one person in view'), part('center', 'centre crop')].filter(Boolean).join(', ');
          if (j.detector) note += ` (${j.detector} face detector)`;
        } catch {}
      }
      const inArgs = rf ? ['-threads', '2', '-i', rf, '-ss', String(off), '-t', String(clipLen), '-threads', '2', '-i', seg, ...mus]
        : ['-ss', String(off), '-t', String(clipLen), '-threads', '2', '-i', seg, ...mus];
      let bl = [];
      if (useB && slots.length) { try { bl = await prepBroll(slots, W, VH, square, src); } catch (e) { console.error('B-roll prep failed:', e.message); } }
      brNote = !useB && slots.length ? 'B-roll could not be rendered on this server, so it was left out.'
        : bl.length ? `B-roll: ${bl.length} cutaway${bl.length > 1 ? 's' : ''}${bpm ? `, cut on the beat (${Math.round(bpm)} BPM)` : ''}${src && bl.some((b) => b.scene) ? `, ${bl.filter((b) => b.scene).length} from your footage` : ''}` : (brNote || '');

      const aIn = rf ? 1 : 0, mIn = music ? (rf ? 2 : 1) : null, base = (rf ? 2 : 1) + (music ? 1 : 0);
      // speaker video on the cut timeline (30 fps)
      let fc = rf ? `[0:v]fps=30${vSel}[b0]` : `[0:v]${square ? SQ_CROP : TALL_CROP},scale=${W}:${VH},fps=30,setsar=1${vSel}[b0]`;
      // Cutaways go inside the same frame as the speaker (the square, or the full 9:16 frame). Every cutaway fades in over what is on screen.
      // It fades out too, unless another cutaway follows right away: then the next one fades in over it and this one stays until it is covered.
      const D = BR_FADE;
      bl.forEach((b, i) => {
        const len = b.end - b.start, next = bl[i + 1], chained = next && next.start - b.end < 0.05;
        const until = chained ? b.end + D : b.end;
        const fo = chained ? '' : `,fade=t=out:st=${Math.max(0, len - D).toFixed(2)}:d=${D}:alpha=1`;
        fc += `;[${base + i}:v]format=yuva420p,fade=t=in:st=0:d=${D}:alpha=1${fo},setpts=PTS-STARTPTS+${b.start.toFixed(2)}/TB[k${i}];[b${i}][k${i}]overlay=enable='between(t,${b.start.toFixed(2)},${until.toFixed(2)})':eof_action=pass[b${i + 1}]`;
      });
      if (square) { // 1:1 square in the middle, a blurred and darkened copy of it fills the rest of the 9:16 frame
        const BW = W / 4, BH = H / 4, Y = (H - W) / 2;
        fc += `;[b${bl.length}]split=2[qa][qb];[qa]scale=${BW}:${BH}:force_original_aspect_ratio=increase,crop=${BW}:${BH},gblur=sigma=5,eq=brightness=-0.18:saturation=1.15,scale=${W}:${H}:flags=bilinear,setsar=1[bg];[bg][qb]overlay=0:${Y}:format=auto[v]`;
      } else fc += `;[b${bl.length}]null[v]`;
      fc += `;[${aIn}:a]${aSel}[sa];` + (music ? duck(mIn) : '[sa]anull[a]');
      inArgs.push(...bl.flatMap((b) => ['-threads', '1', '-i', b.file]));
      try {
        await queued(() => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostats', '-y', ...inArgs, '-filter_complex', fc, '-map', '[v]', '-map', '[a]', '-t', D2.toFixed(3),
          '-c:v', 'libx264', '-preset', 'veryfast', '-threads', '2', '-x264-params', 'rc-lookahead=8:ref=2:bframes=1', '-pix_fmt', 'yuv420p',
          '-crf', '23', '-c:a', 'aac', '-movflags', '+faststart', `work/${key}.mp4`], { maxBuffer: 1e7 }));
        lastErr = null;
        break;
      } catch (e) { lastErr = e; console.error('ffmpeg failed at', W, e.signal || '', e.stderr || e.message); }
    }
    if (lastErr) throw lastErr;
    const cutNote = cut ? `Dead air cut: ${(clipLen - D2).toFixed(1)}s removed` : '';
    res.json({ url: `/work/${key}.mp4`, note: [note, cutNote, brNote].filter(Boolean).join(' · ') });
  } catch (e) {
    console.error(e.stderr || e);
    res.status(500).json({ error: friendly(e) });
  }
};

// Long jobs run in the background and the page checks on them every couple of seconds, so a slow render
// can never fail because a phone, VPN or proxy drops a long-open connection.
const jobs = new Map();
const startJob = (handler) => (req, res) => {
  const job = crypto.randomBytes(6).toString('hex');
  jobs.set(job, { status: 'working' });
  res.json({ job });
  const fake = {
    json: (o) => jobs.set(job, { status: 'done', ...o }),
    status: () => ({ json: (o) => jobs.set(job, { status: 'error', error: o.error }) }),
  };
  Promise.resolve(handler({ body: req.body }, fake)).catch((e) => jobs.set(job, { status: 'error', error: friendly(e) }));
  setTimeout(() => jobs.delete(job), 60 * 60e3);
};
app.post('/api/analyze', startJob(analyzeJob));
app.post('/api/render', startJob(renderJob));
app.post('/api/broll-index', startJob(brollIndexJob));
app.get('/api/job/:id', (req, res) => res.json(jobs.get(req.params.id) || { status: 'error', error: 'The server restarted while working. Please try again.' }));

const server = app.listen(process.env.PORT || 3000, () => console.log('ClipForge running'));
server.requestTimeout = 0; // big uploads can take longer than Node's default 5 minute limit
