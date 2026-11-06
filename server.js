import express from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const run = promisify(execFile);
const app = express();
app.use(express.json());
app.use(express.static('public'));
app.use('/work', express.static('work'));
await fs.mkdir('work', { recursive: true });

// Risky words get censored in captions (edit freely)
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
    const id = crypto.createHash('md5').update(url).digest('hex').slice(0, 10);
    const files = await fs.readdir('work');
    if (!files.includes(`${id}.mp4`)) {
      await run('yt-dlp', ['-f', 'bv*[height<=720]+ba/b[height<=720]', '--merge-output-format', 'mp4',
        '--write-auto-subs', '--sub-langs', 'en.*', '--sub-format', 'json3', '-o', `work/${id}.%(ext)s`, url],
        { maxBuffer: 1e8 });
    }
    const sub = (await fs.readdir('work')).find((f) => f.startsWith(id) && f.endsWith('.json3'));
    if (!sub) throw new Error('No English captions found for this video.');
    const words = parseWords(JSON.parse(await fs.readFile(`work/${sub}`)));
    await fs.writeFile(`work/${id}.words.json`, JSON.stringify(words));

    let text = '';
    for (let i = 0; i < words.length; i += 12)
      text += `[${Math.round(words[i].s)}] ${words.slice(i, i + 12).map((w) => w.w).join(' ')}\n`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.MODEL || 'claude-sonnet-4-6', max_tokens: 3000,
        messages: [{ role: 'user', content: PROMPT + text.slice(0, 120000) }] }),
    });
    const data = await r.json();
    if (data.error) throw new Error(data.error.message);
    const clips = JSON.parse(data.content[0].text.match(/\[[\s\S]*\]/)[0]).map((c) => ({
      ...c,
      text: words.filter((w) => w.s >= c.start && w.s < c.end).map((w) => w.w).join(' '),
    }));
    res.json({ id, clips });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 300) });
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
      const line = g.map((w, k) => `{\\k${Math.max(1, Math.round(((g[k + 1]?.s ?? w.e) - w.s) * 100))}}${censor(w.w).toUpperCase()}`).join(' ');
      ass += `Dialogue: 0,${ts(g[0].s)},${ts(g.at(-1).e)},D,,0,0,0,,{\\fad(60,0)\\t(0,120,\\fscx110\\fscy110)\\t(120,200,\\fscx100\\fscy100)}${line}\n`;
    }
    const key = crypto.randomBytes(4).toString('hex');
    await fs.writeFile(`work/${key}.ass`, ass);
    await run('ffmpeg', ['-y', '-ss', String(start), '-t', String(end - start), '-i', `work/${id}.mp4`,
      '-vf', `crop=ih*9/16:ih,scale=1080:1920,ass=work/${key}.ass`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-movflags', '+faststart', `work/${key}.mp4`]);
    res.json({ url: `/work/${key}.mp4` });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('ClipForge running'));
