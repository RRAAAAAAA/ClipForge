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
  if (/Gemini:.*(quota|exhausted|rate)/i.test(m)) return 'Gemini free limit reached. Wait a minute and try again.';
  if (/Gemini:.*(not found|not supported)/i.test(m)) return 'Gemini model unavailable. Set the MODEL variable to a current model name.';
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
Each item: {"start":number,"end":number,"title":string,"description":string,"score":number,"reason":string}
- title: catchy, honest, max 70 characters, no clickbait lies, no ALL CAPS
- description: 1-2 sentences plus 3 hashtags
- score: 0-100 virality estimate (hook strength, emotion, pacing, shareability), be strict
- reason: one sentence on why it can perform
Transcript:
`;

function parseWords(j) {
  const out = [];
  for (const ev of j.events || []) {
    for (const sg of ev.segs || []) {
      const t = (sg.utf8 || '').trim();
      if (t) out.push({ w: t, s: ((ev.tStartMs || 0) + (sg.tOffsetMs || 0)) / 1000 });
    }
  }
  out.forEach((o, i) => (o.e = Math.min(out[i + 1]?.s ?? o.s + 0.4, o.s + 1)));
  return out;
}

app.post('/api/analyze', async (req, res) => {
  try {
    const { url } = req.body;
    if (!/^https?:\/\/((www|m|music)\.)?(youtube\.com|youtu\.be)\//i.test(url || '')) throw new Error('Paste a valid YouTube link.');
    const id = crypto.createHash('md5').update(url).digest('hex').slice(0, 10);
    try { // reuse earlier result for the same link (saves Gemini quota)
      const cached = JSON.parse(await fs.readFile(`work/${id}.clips.json`));
      await fs.access(`work/${id}.mp4`);
      return res.json({ id, clips: cached });
    } catch {}
    const files = await fs.readdir('work');
    if (!files.includes(`${id}.mp4`)) {
      await queued(() => run('yt-dlp', ['-f', 'bv*[height<=1080]+ba/b[height<=1080]', '--merge-output-format', 'mp4',
        '--js-runtimes', 'node', '--remote-components', 'ejs:github', '--write-auto-subs', '--sub-langs', 'en', '--sleep-subtitles', '2', '--retries', '5', ...COOKIES, '--sub-format', 'json3', '-o', `work/${id}.%(ext)s`, url],
        { maxBuffer: 1e8 }));
    }
    const sub = (await fs.readdir('work')).find((f) => f.startsWith(id) && f.endsWith('.json3'));
    if (!sub) throw new Error('No English captions found for this video.');
    const words = parseWords(JSON.parse(await fs.readFile(`work/${sub}`)));
    await fs.writeFile(`work/${id}.words.json`, JSON.stringify(words));

    let text = '';
    for (let i = 0; i < words.length; i += 12)
      text += `[${Math.round(words[i].s)}] ${words.slice(i, i + 12).map((w) => w.w).join(' ')}\n`;

    const model = process.env.MODEL || 'gemini-2.5-flash';
    const body = JSON.stringify({
      contents: [{ parts: [{ text: PROMPT + text.slice(0, 300000) }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.7 },
    });
    let data;
    for (let t = 1; t <= 3; t++) { // retry when Gemini is busy or rate-limited
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'content-type': 'application/json' }, body,
      });
      data = await r.json();
      if (!data.error || ![429, 500, 503].includes(data.error.code)) break;
      await new Promise((ok) => setTimeout(ok, 5000 * t));
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
      const d = end - start;
      ws = t.length === ws.length ? ws.map((w, i) => ({ ...w, w: t[i] }))
        : t.map((w, i) => ({ w, s: (i * d) / t.length, e: ((i + 1) * d) / t.length }));
    }
    let ass = `[Script Info]\nPlayResX: 1080\nPlayResY: 1920\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: D,${font.replace(/[^\w ]/g, '')},84,&H0000FFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,6,2,2,60,60,520,1\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n`;
    for (let i = 0; i < ws.length; i += 3) {
      const g = ws.slice(i, i + 3);
      const line = g.map((w, k) => `{\\k${Math.max(1, Math.round(((g[k + 1]?.s ?? w.e) - w.s) * 100))}}${censor(w.w).replace(/[{}\\]/g, '').toUpperCase()}`).join(' ');
      ass += `Dialogue: 0,${ts(g[0].s)},${ts(g.at(-1).e)},D,,0,0,0,,{\\fad(60,0)\\t(0,120,\\fscx110\\fscy110)\\t(120,200,\\fscx100\\fscy100)}${line}\n`;
    }
    const key = crypto.randomBytes(4).toString('hex');
    await fs.writeFile(`work/${key}.ass`, ass);
    await queued(() => run('ffmpeg', ['-y', '-ss', String(start), '-t', String(end - start), '-i', `work/${id}.mp4`,
      '-vf', `crop=ih*9/16:ih,scale=1080:1920,ass=work/${key}.ass`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-movflags', '+faststart', `work/${key}.mp4`]));
    res.json({ url: `/work/${key}.mp4` });
  } catch (e) {
    res.status(500).json({ error: friendly(e) });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('ClipForge running'));
