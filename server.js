import express from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { existsSync } from 'node:fs';

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
const snap = (c, words) => {
  const first = words.find((w) => w.e > c.start + 0.05);
  const last = [...words].reverse().find((w) => w.s < c.end);
  if (!first || !last) return c;
  const start = Math.max(0, first.s - 0.15);
  let end = last.e + 0.25;
  if (end - start > 60.01) {
    const l2 = [...words].reverse().find((w) => w.s < c.end && w.e + 0.25 - start <= 60.01);
    end = l2 ? l2.e + 0.25 : start + 60;
  }
  return { ...c, start, end };
};

const PROMPT = `You pick short-form clips from a video transcript. Lines look like "[seconds] text".
Return ONLY a JSON array of 3-6 clips, each 30-60 seconds long, that start on a strong hook and end on a complete thought.
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

// ---------- B-roll (full-frame stock footage cutaways from Pixabay) ----------
const PIXABAY = process.env.PIXABAY_API_KEY;
const BR_EVERY = Math.max(2.5, parseFloat(process.env.BROLL_EVERY) || 4); // on average one cutaway every N seconds (lower = more B-roll)
const BR_FADE = Math.min(0.5, Math.max(0.1, parseFloat(process.env.BROLL_FADE) || 0.25)); // crossfade length in seconds (higher = softer)
const BR_MODELS = [...new Set([process.env.MODEL, 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'].filter(Boolean))];

async function askGemini(text) {
  let data;
  outer: for (const model of BR_MODELS) {
    for (let t = 1; t <= 2; t++) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST', headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'content-type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.4 } }),
          signal: AbortSignal.timeout(45000),
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

// Ask Gemini where cutaways fit (1-3 s each, sometimes in bursts) and what to search for. Cached per clip so "Apply edits" keeps the same plan.
async function planBroll(ws, dur, cacheFile) {
  try { return JSON.parse(await fs.readFile(cacheFile, 'utf8')); } catch {}
  const max = Math.min(16, Math.floor(dur / BR_EVERY));
  if (max < 1 || !ws.length) return [];
  let text = '';
  for (let i = 0; i < ws.length; i += 8) text += `[${ws[i].s.toFixed(1)}] ${ws.slice(i, i + 8).map((w) => w.w).join(' ')}\n`;
  const raw = await askGemini(`You pick B-roll cutaways for a fast-paced short vertical video (TikTok / Reels style). Transcript lines look like "[seconds] text".
Return ONLY a JSON array of ${Math.max(2, max - 3)} to ${max} items: {"start":number,"end":number,"query":string}
- follow the speech. When the speaker lists things, tells a fast story or describes a scene, put 3 or 4 cutaways back to back (the end of one is the start of the next, no gap). A sentence with one clear picture gets 1 cutaway, others get 2. Vary it so it never feels mechanical.
- between these groups leave 1 to 4 seconds of the speaker on screen so the video can breathe
- each cutaway lasts 1 to 3 seconds (vary the lengths) and starts between 2 and ${Math.floor(dur - 2.5)} seconds
- put a cutaway on every concrete thing, place, object, activity or number that the speaker mentions
- query: 1 to 3 plain English words naming something concrete and filmable that matches what is being said (for example "stock market", "city traffic", "doctor hospital"). Never abstract words or people's names. Use a different query for every item.
- keep the first 2 seconds free, and skip the final punchline
Video length: ${dur.toFixed(0)} seconds.
Transcript:
${text}`);
  const m = raw.match(/\[[\s\S]*\]/);
  let arr = [];
  try { arr = m ? JSON.parse(m[0]) : []; } catch {}
  const slots = [];
  for (const a of arr.map((x) => ({ start: Number(x.start), end: Number(x.end), query: String(x.query || '').replace(/[^\w ]/g, '').trim().slice(0, 40) }))
    .filter((x) => x.query && Number.isFinite(x.start) && Number.isFinite(x.end)).sort((p, q) => p.start - q.start)) {
    const start = Math.max(2, a.start, slots.length ? slots.at(-1).end : 0); // overlapping picks become back-to-back
    const end = Math.min(dur - 1.5, start + Math.min(3, Math.max(1, a.end - a.start)));
    if (end - start < 1) continue;
    slots.push({ start: +start.toFixed(2), end: +end.toFixed(2), query: a.query });
    if (slots.length >= max) break;
  }
  await fs.writeFile(cacheFile, JSON.stringify(slots));
  return slots;
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

// Download each slot's footage and pre-cut it to the slot length, 9:16, at the render size (small files = low memory).
async function prepBroll(slots, W, H) {
  const out = [], used = new Set();
  for (const s of slots) {
    try {
      const len = s.end - s.start;
      const hit = await findClip(s.query, len + BR_FADE + 0.4, used);
      if (!hit) { console.error('B-roll: nothing found for', s.query); continue; }
      used.add(hit.id);
      const raw = await fetchClip(hit);
      const f = `work/bkd_${hit.id}_${len.toFixed(2)}_${W}.mp4`;
      if (!existsSync(f)) await queued(() => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-t', (len + BR_FADE + 0.1).toFixed(2), '-threads', '2', '-i', raw,
        '-vf', `crop='min(iw,ih*9/16)':'min(ih,iw*16/9)',scale=${W}:${H},fps=30,setsar=1`, '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24',
        '-pix_fmt', 'yuv420p', '-threads', '2', f], { maxBuffer: 1e7 }));
      out.push({ ...s, file: f });
    } catch (e) {
      console.error('B-roll skipped:', s.query, e.stderr || e.message);
      if (/download failed/.test(String(e.message))) { pxCache.delete(s.query.toLowerCase()); pxCache.delete(s.query.split(' ').slice(0, 2).join(' ').toLowerCase()); }
    }
  }
  return out;
}

const analyzeJob = async (req, res) => {
  try {
    const { url } = req.body;
    const count = Math.min(5, Math.max(1, parseInt(req.body.count) || 3));
    if (!/^https?:\/\/((www|m|music)\.)?(youtube\.com|youtu\.be)\//i.test(url || '')) throw new Error('Paste a valid YouTube link.');
    const id = crypto.createHash('md5').update(url + '|v4').digest('hex').slice(0, 10);
    try { // reuse earlier result for the same link (saves Gemini quota)
      const cached = JSON.parse(await fs.readFile(`work/${id}.clips.json`));
      if (cached.length >= count) return res.json({ id, clips: [...cached].sort((a, b) => b.score - a.score).slice(0, count) });
    } catch {}
    await fs.writeFile(`work/${id}.url`, url); // remembered so each clip can be downloaded later
    // only the transcript is fetched here (fast, and the whole video never has to fit in memory)
    if (!(await fs.readdir('work')).some((f) => f.startsWith(`${id}.`) && f.endsWith('.json3')))
      await queued(() => run('yt-dlp', ['--skip-download', ...YT, '--write-auto-subs', '--sub-langs', 'en', '--sleep-subtitles', '2',
        '--sub-format', 'json3', '-o', `work/${id}.%(ext)s`, url], { maxBuffer: 1e8 }));
    const sub = (await fs.readdir('work')).find((f) => f.startsWith(id) && f.endsWith('.json3'));
    if (!sub) throw new Error('No English captions found for this video.');
    const words = parseWords(JSON.parse(await fs.readFile(`work/${sub}`)));
    await fs.writeFile(`work/${id}.words.json`, JSON.stringify(words));

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
    const clips = JSON.parse(arr[0]).map(fix).map((c) => snap(c, words)).filter((c) => c.end - c.start >= 15);
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
    const ytUrl = (await fs.readFile(`work/${id}.url`, 'utf8').catch(() => '')).trim();
    if (!ytUrl) throw new Error('Source expired. Paste the link again.');
    for (const f of [`work/${id}.url`, `work/${id}.words.json`]) await fs.utimes(f, new Date(), new Date()).catch(() => {});
    // download only this clip (plus a second of padding each side) instead of the whole video
    const S = Math.max(0, Math.floor(start) - 1), E = Math.ceil(end) + 1;
    const seg = `work/seg_${id}_${S}_${E}.mp4`;
    if (!existsSync(seg)) await queued(() => run('yt-dlp', ['-f', `bv*[height<=${MAXH}]+ba/b[height<=${MAXH}]`, '--merge-output-format', 'mp4',
      // keep ffmpeg light: few threads and a fast, low-memory encode (the host reports many more CPU cores than we may use)
      '--downloader-args', 'ffmpeg_i:-threads 2',
      '--downloader-args', 'ffmpeg_o:-c:v libx264 -preset ultrafast -crf 20 -threads 2 -x264-params rc-lookahead=0:ref=1 -pix_fmt yuv420p -c:a aac -b:a 128k',
      '--download-sections', `*${S}-${E}`, '--force-keyframes-at-cuts', ...YT, '-o', `work/seg_${id}_${S}_${E}.%(ext)s`, ytUrl],
      { maxBuffer: 1e8, timeout: 900000 }));
    const off = start - S; // where the clip starts inside the downloaded piece
    const clipLen = end - start;
    // YouTube's transcript timing is enough to choose B-roll moments (cutaways are short and forgiving)
    const all = JSON.parse(await fs.readFile(`work/${id}.words.json`, 'utf8').catch(() => '[]'));
    const ws = all.filter((w) => w.e > start + 0.05 && w.s < end).map((w) => ({ ...w, s: Math.max(0, w.s - start), e: w.e - start }));
    let slots = [], brNote = '';
    if (req.body.broll !== false) {
      if (!PIXABAY) brNote = 'B-roll skipped: add PIXABAY_API_KEY.';
      else if (!ws.length) brNote = 'B-roll skipped: no transcript found for this clip.';
      else {
        try { slots = await planBroll(ws, clipLen, `work/br2_${id}_${Math.round(start * 10)}_${Math.round(end * 10)}.json`); }
        catch (e) { console.error('B-roll planning failed:', e.message); brNote = 'B-roll planning failed, so none was added.'; }
      }
    }
    const key = crypto.randomBytes(4).toString('hex');
    const dur = end - start;
    const music = (await listMusic()).get(String(req.body.music || '')) || null;
    const vol = req.body.volume != null && req.body.volume !== '' && Number.isFinite(+req.body.volume) ? Math.min(3, Math.max(0, +req.body.volume)) : 0.7;
    const frame = req.body.frame === 'center' ? 'center' : 'auto';
    const fo = Math.max(0, dur - 1.5).toFixed(2);
    // music is looped, faded in/out, and gently lowered while someone is speaking
    const duck = (v, m) => `[${v}:a]asplit=2[va][vs];[${m}:a]volume=${vol},afade=t=in:d=1,afade=t=out:st=${fo}:d=1.5[m];[m][vs]sidechaincompress=threshold=0.05:ratio=2.5:attack=20:release=400:makeup=1[mc];[va][mc]amix=inputs=2:duration=first:normalize=0[a]`;
    const mus = music ? ['-stream_loop', '-1', '-i', music] : [];
    let lastErr, note = '';
    // if the server runs low on memory, retry at a lighter size; the last try drops B-roll
    for (const [W, H, useB] of [[1080, 1920, 1], [720, 1280, 1], ...(slots.length ? [[720, 1280, 0]] : [])]) {
      let rf = null;
      if (frame === 'auto') { // face-following crop: finds faces, follows them, shows whoever is speaking
        const f = `work/rf_${id}_${Math.round(start * 10)}_${Math.round(end * 10)}_${W}.mp4`;
        try {
          if (!existsSync(f)) await queued(() => run('python3', [path.join(here, 'reframe.py'), seg, String(off), String(dur), f, String(W), String(H)], { maxBuffer: 1e7, timeout: 300000 }));
          rf = f;
        } catch (e) { console.error('reframe failed, using centre crop:', e.stderr || e.message); await fs.rm(f, { force: true }); }
      }
      if (frame === 'auto') note = rf ? '' : 'Face tracking was unavailable, so the centre crop was used.';
      if (rf) { // tell the person what the face tracking found
        try {
          const sc = JSON.parse(await fs.readFile(rf + '.json', 'utf8')).seconds;
          const part = (n, t) => (sc[n] > 0.4 ? `${t} ${Math.round(sc[n])}s` : '');
          note = sc.center >= dur * 0.6 ? 'No faces were found, so the centre crop was used.'
            : 'Framing: ' + [part('split', 'split screen'), part('full', 'one person in view'), part('center', 'centre crop')].filter(Boolean).join(', ');
          const det = JSON.parse(await fs.readFile(rf + '.json', 'utf8')).detector;
          if (det) note += ` (${det} face detector)`;
        } catch {}
      }
      const vf = `crop=ih*9/16:ih,scale=${W}:${H}`;
      const inArgs = rf ? ['-threads', '2', '-i', rf, '-ss', String(off), '-t', String(dur), '-threads', '2', '-i', seg, ...mus]
        : ['-ss', String(off), '-t', String(dur), '-threads', '2', '-i', seg, ...mus];
      let bl = [];
      if (useB && slots.length) { try { bl = await prepBroll(slots, W, H); } catch (e) { console.error('B-roll prep failed:', e.message); } }
      brNote = !useB && slots.length ? 'B-roll could not be rendered on this server, so it was left out.' : (bl.length ? `B-roll: ${bl.length} cutaway${bl.length > 1 ? 's' : ''}` : (brNote || ''));
      let mixArgs;
      if (bl.length) { // full-frame cutaways: the speaker's audio and music keep running
        const aIn = rf ? 1 : 0, mIn = music ? (rf ? 2 : 1) : null, base = (rf ? 2 : 1) + (music ? 1 : 0);
        let fc = rf ? '[0:v]null[b0]' : `[0:v]crop=ih*9/16:ih,scale=${W}:${H}[b0]`;
        // Smooth transitions: every cutaway fades in over what is on screen. It fades out too, unless another cutaway follows
        // right away: then the next one fades in over it (cutaway-to-cutaway crossfade) and this one stays until it is covered.
        const D = BR_FADE;
        bl.forEach((b, i) => {
          const len = b.end - b.start, next = bl[i + 1], chained = next && next.start - b.end < 0.05;
          const until = chained ? b.end + D : b.end;
          const fo = chained ? '' : `,fade=t=out:st=${Math.max(0, len - D).toFixed(2)}:d=${D}:alpha=1`;
          fc += `;[${base + i}:v]format=yuva420p,fade=t=in:st=0:d=${D}:alpha=1${fo},setpts=PTS-STARTPTS+${b.start.toFixed(2)}/TB[k${i}];[b${i}][k${i}]overlay=enable='between(t,${b.start.toFixed(2)},${until.toFixed(2)})':eof_action=pass[b${i + 1}]`;
        });
        fc += `;[b${bl.length}]null[v];` + (music ? duck(aIn, mIn) : `[${aIn}:a]anull[a]`);
        inArgs.push(...bl.flatMap((b) => ['-threads', '1', '-i', b.file]));
        mixArgs = ['-filter_complex', fc, '-map', '[v]', '-map', '[a]', '-t', String(dur)];
      } else if (rf) mixArgs = ['-filter_complex', '[0:v]null[v];' + (music ? duck(1, 2) : '[1:a]anull[a]'), '-map', '[v]', '-map', '[a]', '-t', String(dur)];
      else if (music) mixArgs = ['-filter_complex', `[0:v]${vf}[v];` + duck(0, 1), '-map', '[v]', '-map', '[a]', '-t', String(dur)];
      else mixArgs = ['-vf', vf];
      try {
        await queued(() => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostats', '-y', ...inArgs, ...mixArgs,
          '-c:v', 'libx264', '-preset', 'veryfast', '-threads', '2', '-x264-params', 'rc-lookahead=8:ref=2:bframes=1',
          '-crf', '23', '-c:a', 'aac', '-movflags', '+faststart', `work/${key}.mp4`], { maxBuffer: 1e7 }));
        lastErr = null;
        break;
      } catch (e) { lastErr = e; console.error('ffmpeg failed at', W, e.signal || '', e.stderr || e.message); }
    }
    if (lastErr) throw lastErr;
    res.json({ url: `/work/${key}.mp4`, note: [note, brNote].filter(Boolean).join(' · ') });
  } catch (e) {
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
app.get('/api/job/:id', (req, res) => res.json(jobs.get(req.params.id) || { status: 'error', error: 'The server restarted while working. Please try again.' }));

app.listen(process.env.PORT || 3000, () => console.log('ClipForge running'));
