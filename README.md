# ClipForge MVP
Needs: Node 20+, ffmpeg, yt-dlp (pip install -U yt-dlp).
Run: `npm install && GEMINI_API_KEY=... npm start` then open http://localhost:3000
Deploy on Railway: push this folder, it builds from the Dockerfile; set GEMINI_API_KEY.
Only works on videos with English captions. Use content you have permission to clip.

## If YouTube says "Sign in to confirm you're not a bot"
Railway's server address is often blocked by YouTube. Fix with cookies (use a throwaway Google account, not your main one):
1. On a computer, open a private window, log in to YouTube, then open youtube.com/robots.txt.
2. Export cookies with the "Get cookies.txt LOCALLY" extension, then close the private window.
3. Paste the whole exported text into a Railway variable named YT_COOKIES and redeploy.
Cookies expire after a while; repeat when the error comes back.

## Background music
Tracks live in the `music/` folder (4 original loops included: chill, upbeat, cinematic, tense). To add your own, drop royalty-free .mp3 files into `music/`. Name them starting with a mood (chill, upbeat, cinematic or tense) and the AI will auto-pick them for matching clips. Music is looped, faded in/out to the clip length, and lowered automatically while someone speaks.

## Face-following crop
`reframe.py` (keep it next to `server.js`) finds faces with OpenCV and builds the vertical video: 1 person = full screen following their face, 2 people = split screen (left person on top, right person below), 3+ people = full screen on whoever is speaking. Choose "Centre crop" in the Framing dropdown to turn it off. The Dockerfile installs OpenCV (version 4.x, because 5.x removed the built-in face detector).

## Exact caption sync (speech recognition)
YouTube's auto-captions only estimate word timing, so they drift, miss the first words of a clip and lag on fast speech. Add a free `GROQ_API_KEY` (console.groq.com) as a Railway variable and each clip's own audio is transcribed with Whisper, which gives exact word timing. Optional variables: `OPENAI_API_KEY` (used if there is no Groq key), `ASR_LANGUAGE` (default `en`) and `CAPTION_OFFSET` (seconds, e.g. `-0.1` to show captions slightly earlier). The caption box then shows the exact words that were captioned; if you edit the text, unchanged words keep their timing.
