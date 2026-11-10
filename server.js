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

const BAD = /^(fuck\w*|shit\w*|bitch\w*|asshole|dick|pussy|nigg\w*|cunt|bastard|rape\w*|kill\w*|suicide|porn\w*|sex\w*)$/i;
const censor = (w) => (BAD.test(w.replace(/[^\w]/g, '')) ? w[0] + '*'.repeat(Math.max(w.length - 1, 2)) : w);

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
  for (const ev of j.events || []) {
    const segs = (ev.segs || []).filter((sg) => (sg.utf8 || '').trim());
    if (!segs.length) continue;
    const t0 = ev.tStartMs || 0;
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
        out.push({ w, s: at / 1000, e: (at + d) / 1000 });
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

app.post('/api/analyze', async (req, res) => {
  try {
    const { url } = req.body;
    const count = Math.min(5, Math.max(1, parseInt(req.body.count) || 3));
    if (!/^https?:\/\/((www|m|music)\.)?(youtube\.com|youtu\.be)\//i.test(url || '')) throw new Error('Paste a valid YouTube link.');
    const id = crypto.createHash('md5').update(url + '|v3').digest('hex').slice(0, 10);
    try { // reuse earlier result for the same link (saves Gemini quota)
      const cached = JSON.parse(await fs.readFile(`work/${id}.clips.json`));
      await fs.access(`work/${id}.mp4`);
      if (cached.length >= count) return res.json({ id, clips: [...cached].sort((a, b) => b.score - a.score).slice(0, count) });
    } catch {}
    const files = await fs.readdir('work');
    if (!files.includes(`${id}.mp4`)) {
      await queued(() => run('yt-dlp', ['-f', 'bv*[height<=1080]+ba/b[height<=1080]', '--merge-output-format', 'mp4',
        '--js-runtimes', 'deno', '--js-runtimes', 'node', '--remote-components', 'ejs:github', '--write-auto-subs', '--sub-langs', 'en', '--sleep-subtitles', '2', '--retries', '5', ...COOKIES, '--sub-format', 'json3', '-o', `work/${id}.%(ext)s`, url],
        { maxBuffer: 1e8 }));
    }
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
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST', headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'content-type': 'application/json' }, body,
        });
        data = await r.json();
        if (!data.error) break outer;
        if ([429, 500, 503].includes(data.error.code)) { await new Promise((ok) => setTimeout(ok, 3000)); continue; }
        break; // model retired or not allowed: go to the next one
      }
    }
    if (data.error) throw new Error('Gemini: ' + data.error.message);
    const raw = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
    const arr = raw.match(/\[[\s\S]*\]/);
    if (!arr) throw new Error('Gemini returned no clips. Try again.');
    const clips = JSON.parse(arr[0]).map(fix).filter((c) => c.end - c.start >= 15).map((c) => ({
      ...c,
      text: words.filter((w) => w.s >= c.start && w.s < c.end).map((w) => w.w).join(' '),
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
});

const ts = (t) => {
  const cs = Math.round(t * 100);
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};

app.post('/api/render', async (req, res) => {
  try {
    const { id, start, end, font = 'Liberation Sans', text } = req.body;
    if (!/^[a-f0-9]{10}$/.test(id)) throw new Error('bad id');
    if (!(end > start && end - start <= 90)) throw new Error('Bad clip times.');
    await fs.utimes(`work/${id}.mp4`, new Date(), new Date()).catch(() => { throw new Error('Source video expired. Paste the link again.'); });
    const all = JSON.parse(await fs.readFile(`work/${id}.words.json`));
    let ws = all.filter((w) => w.s >= start && w.s < end).map((w) => ({ ...w, s: w.s - start, e: w.e - start }));
    if (text) {
      const t = text.trim().split(/\s+/);
      if (t.length === ws.length) ws = ws.map((w, i) => ({ ...w, w: t[i] }));
      else { // words were added or removed: share the real speech time out by word length
        const from = ws.length ? ws[0].s : 0, to = ws.length ? ws.at(-1).e : end - start;
        const tot = t.reduce((n, w) => n + w.length + 1, 0);
        let at = from;
        ws = t.map((w) => { const d = ((to - from) * (w.length + 1)) / tot; const o = { w, s: at, e: at + d }; at += d; return o; });
      }
    }
    let ass = `[Script Info]\nPlayResX: 1080\nPlayResY: 1920\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: D,${font.replace(/[^\w ]/g, '')},84,&H0000FFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,6,2,2,60,60,380,1\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n`;
    for (let i = 0; i < ws.length; i += 3) {
      const g = ws.slice(i, i + 3);
      const line = g.map((w, k) => `{\\k${Math.max(1, Math.round(((g[k + 1]?.s ?? w.e) - w.s) * 100))}}${censor(w.w).replace(/[{}\\]/g, '').toUpperCase()}`).join(' ');
      ass += `Dialogue: 0,${ts(g[0].s)},${ts(g.at(-1).e)},D,,0,0,0,,{\\fad(60,0)\\t(0,120,\\fscx110\\fscy110)\\t(120,200,\\fscx100\\fscy100)}${line}\n`;
    }
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
    let lastErr;
    for (const [W, H] of [[1080, 1920], [720, 1280]]) { // if the server runs low on memory, retry at a lighter size
      let rf = null;
      if (frame === 'auto') { // face-following crop: finds faces, follows them, shows whoever is speaking
        const f = `work/rf_${id}_${Math.round(start * 10)}_${Math.round(end * 10)}_${W}.mp4`;
        try {
          if (!existsSync(f)) await queued(() => run('python3', [path.join(here, 'reframe.py'), `work/${id}.mp4`, String(start), String(dur), f, String(W), String(H)], { maxBuffer: 1e7, timeout: 300000 }));
          rf = f;
        } catch (e) { console.error('reframe failed, using centre crop:', e.stderr || e.message); await fs.rm(f, { force: true }); }
      }
      const ass = `ass=work/${key}.ass`;
      const vf = `crop=ih*9/16:ih,scale=${W}:${H},${ass}`;
      const inArgs = rf ? ['-i', rf, '-ss', String(start), '-t', String(dur), '-i', `work/${id}.mp4`, ...mus]
        : ['-ss', String(start), '-t', String(dur), '-i', `work/${id}.mp4`, ...mus];
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
    res.json({ url: `/work/${key}.mp4` });
  } catch (e) {
    res.status(500).json({ error: friendly(e) });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('ClipForge running'));
