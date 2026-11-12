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

// Risky words get censored in captions (edit freely)
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

// Risky words keep their spelling; only the first vowel becomes an asterisk (fuck -> f*ck, shit -> sh*t)
const STRONG = /(fuck|shit|bitch|cunt|nigg|pussy|asshole|bastard|whore)/i;
const WEAK = /^(dick|rape\w*|kill\w*|suicid\w*|porn\w*|sex\w*|murder\w*)$/i;
const censor = (w) => {
  const core = w.replace(/[^\p{L}\p{N}]/gu, '');
  if (!STRONG.test(core) && !WEAK.test(core)) return w;
  const m = STRONG.exec(w); // start looking for the vowel inside the risky part, e.g. bullshit -> bullsh*t
  const from = m ? m.index : 0;
  const i = w.slice(from).search(/[aeiou]/i);
  if (i >= 0) return w.slice(0, from + i) + '*' + w.slice(from + i + 1);
  return w.length > 1 ? w[0] + '*' + w.slice(2) : '*';
};

// Group words into short caption phrases using the transcript timing: break at sentence ends, pauses,
// transcript line changes, or when a line would get too long.
function cluster(ws) {
  const out = [];
  let cur = [];
  for (const w of ws) {
    const prev = cur.at(-1);
    if (prev) {
      const len = cur.reduce((n, x) => n + x.w.length + 1, 0) + w.w.length;
      const newLine = prev.c !== undefined && w.c !== undefined && prev.c !== w.c && cur.length >= 2;
      if (cur.length >= 3 || len > 18 && cur.length >= 2 || w.s - prev.e >= 0.4 || /[.!?…,;:]["')\]]?$/.test(prev.w) || newLine) {
        out.push(cur);
        cur = [];
      }
    }
    cur.push(w);
  }
  if (cur.length) out.push(cur);
  return out;
}

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
const CAP_OFFSET = parseFloat(process.env.CAPTION_OFFSET) || 0; // seconds; nudge captions earlier (negative) or later (positive)

// Speech recognition (Whisper) on the clip's own audio gives exact word timings. YouTube's auto-captions are only
// estimates that drift and often miss the first words of a clip. Set GROQ_API_KEY (free) or OPENAI_API_KEY.
const ASR = process.env.GROQ_API_KEY
  ? { url: 'https://api.groq.com/openai/v1/audio/transcriptions', key: process.env.GROQ_API_KEY, model: 'whisper-large-v3-turbo' }
  : process.env.OPENAI_API_KEY ? { url: 'https://api.openai.com/v1/audio/transcriptions', key: process.env.OPENAI_API_KEY, model: 'whisper-1' }
  // Cloudflare Workers AI: free daily allowance (no card), Whisper large-v3-turbo with word timings. Needs CF_ACCOUNT_ID + CF_API_TOKEN.
  : process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN ? { cf: true, key: process.env.CF_API_TOKEN, model: '@cf/openai/whisper-large-v3-turbo',
    url: `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/run/@cf/openai/whisper-large-v3-turbo` } : null;
if (ASR && !ASR.cf && process.env.ASR_URL) ASR.url = process.env.ASR_URL;
if (ASR && !ASR.cf && process.env.ASR_MODEL) ASR.model = process.env.ASR_MODEL;

async function transcribe(seg, off, dur) {
  const mp3 = `work/asr_${crypto.randomBytes(4).toString('hex')}.mp3`;
  await queued(() => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(off), '-t', String(dur), '-threads', '2',
    '-i', seg, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', mp3]));
  const audio = await fs.readFile(mp3);
  await fs.rm(mp3, { force: true });
  let r, data;
  if (ASR.cf) { // Cloudflare takes base64 audio as JSON and answers { result: { words: [{ word, start, end }] } }
    for (let t = 1; t <= 3; t++) {
      r = await fetch(ASR.url, { method: 'POST', headers: { Authorization: `Bearer ${ASR.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ audio: audio.toString('base64'), language: process.env.ASR_LANGUAGE || 'en' }) });
      data = await r.json().catch(() => ({}));
      if (r.ok && data.success !== false) break;
      if (![429, 500, 502, 503].includes(r.status)) break;
      await sleep(4000 * t);
    }
    if (!r.ok || data.success === false) throw new Error(data.errors?.[0]?.message || `speech recognition error ${r.status}`);
    const cw = (data.result?.words || []).map((w) => ({ w: String(w.word).trim(), s: Number(w.start), e: Number(w.end) })).filter((w) => w.w && w.e >= w.s);
    if (!cw.length) throw new Error('speech recognition returned no words');
    return cw;
  }
  for (let t = 1; t <= 3; t++) {
    const fd = new FormData();
    fd.append('file', new Blob([audio], { type: 'audio/mpeg' }), 'clip.mp3');
    fd.append('model', ASR.model);
    fd.append('response_format', 'verbose_json');
    fd.append('timestamp_granularities[]', 'word');
    fd.append('language', process.env.ASR_LANGUAGE || 'en');
    fd.append('temperature', '0');
    r = await fetch(ASR.url, { method: 'POST', headers: { Authorization: `Bearer ${ASR.key}` }, body: fd });
    data = await r.json().catch(() => ({}));
    if (r.ok) break;
    if (![429, 500, 503].includes(r.status)) break;
    await sleep(4000 * t);
  }
  if (!r.ok) throw new Error(data.error?.message || `speech recognition error ${r.status}`);
  const words = (data.words || []).map((w) => ({ w: String(w.word).trim(), s: Number(w.start), e: Number(w.end) })).filter((w) => w.w && w.e >= w.s);
  if (!words.length) throw new Error('speech recognition returned no words');
  return words;
}

// Map edited caption text onto the known word timings: unchanged words keep their exact time, new words are
// spread between their neighbours.
function alignText(t, ws) {
  const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const A = t.map(norm), B = ws.map((w) => norm(w.w));
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = A[i] && A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = new Array(n).fill(null);
  for (let i = 0, j = 0; i < n && j < m;) {
    if (A[i] && A[i] === B[j]) { out[i] = { w: t[i], s: ws[j].s, e: ws[j].e }; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  const lo = ws.length ? ws[0].s : 0, hi = ws.length ? ws.at(-1).e : 1;
  for (let i = 0; i < n;) {
    if (out[i]) { i++; continue; }
    let k = i;
    while (k < n && !out[k]) k++;
    const a = i > 0 ? out[i - 1].e : lo, b = k < n ? out[k].s : hi;
    const tot = t.slice(i, k).reduce((x, w) => x + w.length + 1, 0);
    let at = a;
    for (let q = i; q < k; q++) { const d = (Math.max(0.05 * (k - i), b - a) * (t[q].length + 1)) / tot; out[q] = { w: t[q], s: at, e: at + d }; at += d; }
    i = k;
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
    // only the captions are fetched here (fast, and the whole video never has to fit in memory)
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
    const clips = JSON.parse(arr[0]).map(fix).map((c) => snap(c, words)).filter((c) => c.end - c.start >= 15).map((c) => ({
      ...c,
      text: words.filter((w) => w.e > c.start + 0.05 && w.s < c.end).map((w) => w.w).join(' '),
    }));
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

const ts = (t) => {
  const cs = Math.round(t * 100);
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};

const renderJob = async (req, res) => {
  try {
    const { id, start, end, font = 'Liberation Sans', text } = req.body;
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
    let ws = null, asrNote = ASR ? '' : 'Captions use YouTube timing. Add a GROQ_API_KEY (or CF_ACCOUNT_ID + CF_API_TOKEN) for exact sync.';
    if (ASR) { // real speech recognition on this clip's own audio = exact word timing, including the first words
      const tf = `work/tr_${id}_${Math.round(start * 10)}_${Math.round(end * 10)}.json`;
      try { ws = JSON.parse(await fs.readFile(tf, 'utf8')); } catch {
        try { ws = await transcribe(seg, off, clipLen); await fs.writeFile(tf, JSON.stringify(ws)); }
        catch (e) { console.error('speech recognition failed:', e.message); asrNote = 'Speech recognition failed, so YouTube timing was used.'; }
      }
      if (ws) asrNote = 'Captions synced with speech recognition.';
    }
    if (!ws) {
      const all = JSON.parse(await fs.readFile(`work/${id}.words.json`));
      ws = all.filter((w) => w.e > start + 0.05 && w.s < end).map((w) => ({ ...w, s: Math.max(0, w.s - start), e: w.e - start }));
    }
    if (req.body.edited === true && text && String(text).trim()) ws = alignText(String(text).trim().split(/\s+/), ws);
    if (CAP_OFFSET) ws = ws.map((w) => ({ ...w, s: Math.max(0, w.s + CAP_OFFSET), e: Math.max(0.05, w.e + CAP_OFFSET) }));
    const capText = ws.map((w) => w.w).join(' ');
    // CapCut-style captions: bold white text with a thick outline, 1-3 words at a time, and the word being spoken
    // lights up. Every word gets its own short event, so the highlight changes exactly when the word starts.
    const HI = /^[0-9a-f]{6}$/i.test(process.env.CAPTION_COLOR || '') ? process.env.CAPTION_COLOR.replace(/(..)(..)(..)/, '$3$2$1') : '00FFFF'; // BGR; default yellow
    let ass = `[Script Info]\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: D,${font.replace(/[^\w ]/g, '')},80,&H00FFFFFF,&H00FFFFFF,&H00000000,&H90000000,1,0,0,0,100,100,1,0,1,7,3,2,70,70,520,1\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n`;
    const groups = cluster(ws);
    const LEAD = 0.03; // show a word a hair early so it never feels late
    groups.forEach((g, gi) => {
      const nxt = groups[gi + 1];
      const groupEnd = Math.max(g.at(-1).e, Math.min(nxt ? nxt[0].s - 0.02 : Infinity, g.at(-1).e + 0.6)); // hold until the next phrase, at most 0.6 s
      const words = g.map((w) => censor(w.w).replace(/[{}\\]/g, '').toUpperCase());
      g.forEach((w, k) => {
        const t0 = Math.max(0, (k === 0 ? w.s : w.s) - LEAD);
        const t1 = k + 1 < g.length ? Math.max(t0 + 0.05, g[k + 1].s - LEAD) : groupEnd; // no gap between words of a phrase
        const line = words.map((x, j) => (j === k ? `{\\c&H${HI}&}${x}{\\c&HFFFFFF&}` : x)).join(' ');
        const pop = k === 0 ? '{\\fad(50,0)\\fscx88\\fscy88\\t(0,110,\\fscx106\\fscy106)\\t(110,190,\\fscx100\\fscy100)}' : '';
        ass += `Dialogue: 0,${ts(t0)},${ts(t1)},D,,0,0,0,,${pop}${line}\n`;
      });
    });
    const key = crypto.randomBytes(4).toString('hex');
    await fs.writeFile(`work/${key}.ass`, ass);
    const dur = end - start;
    const music = (await listMusic()).get(String(req.body.music || '')) || null;
    const vol = req.body.volume != null && req.body.volume !== '' && Number.isFinite(+req.body.volume) ? Math.min(3, Math.max(0, +req.body.volume)) : 0.7;
    const frame = req.body.frame === 'center' ? 'center' : 'auto';
    const fo = Math.max(0, dur - 1.5).toFixed(2);
    // music is looped, faded in/out, and gently lowered while someone is speaking
    const duck = (v, m) => `[${v}:a]asplit=2[va][vs];[${m}:a]volume=${vol},afade=t=in:d=1,afade=t=out:st=${fo}:d=1.5[m];[m][vs]sidechaincompress=threshold=0.05:ratio=2.5:attack=20:release=400:makeup=1[mc];[va][mc]amix=inputs=2:duration=first:normalize=0[a]`;
    const mus = music ? ['-stream_loop', '-1', '-i', music] : [];
    let lastErr, note = '';
    for (const [W, H] of [[1080, 1920], [720, 1280]]) { // if the server runs low on memory, retry at a lighter size
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
      const ass = `ass=work/${key}.ass`;
      const vf = `crop=ih*9/16:ih,scale=${W}:${H},${ass}`;
      const inArgs = rf ? ['-threads', '2', '-i', rf, '-ss', String(off), '-t', String(dur), '-threads', '2', '-i', seg, ...mus]
        : ['-ss', String(off), '-t', String(dur), '-threads', '2', '-i', seg, ...mus];
      let mixArgs;
      if (rf) mixArgs = ['-filter_complex', `[0:v]${ass}[v];` + (music ? duck(1, 2) : '[1:a]anull[a]'), '-map', '[v]', '-map', '[a]', '-t', String(dur)];
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
    res.json({ url: `/work/${key}.mp4`, note: [note, asrNote].filter(Boolean).join(' · '), text: capText });
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
