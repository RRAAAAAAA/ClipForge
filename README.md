# ClipForge MVP
Needs: Node 20+, ffmpeg, yt-dlp (pip install -U yt-dlp).
Run: `npm install && GEMINI_API_KEY=... npm start` then open http://localhost:3000
Deploy on Railway: push this folder, it builds from the Dockerfile; set GEMINI_API_KEY.
Only works on videos that have an English YouTube transcript (it is used to pick clips and B-roll moments). Use content you have permission to clip.

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

## B-roll (full-screen stock footage)
Each clip gets free Pixabay stock video cutaways that match what is being said. Gemini reads the clip's transcript timing (from YouTube) and follows the speech: a sentence may get 1, 2, or 3-4 cutaways back to back, with short breaks of the speaker in between (never in the first 2 s or the punchline). Each cutaway is 1-3 s, cut to 9:16 and laid over the video; the speaker's voice and the music keep playing. Cutaways crossfade in and out, and back-to-back cutaways crossfade into each other. Add a free `PIXABAY_API_KEY` (pixabay.com/api/docs) as a Railway variable. Untick "Add B-roll" on a clip card to turn it off. If nothing is found for a moment, it is skipped.

Optional variables: `BROLL_EVERY` (seconds, default 4, minimum 2.5; lower = more B-roll) and `BROLL_FADE` (crossfade seconds, default 0.25; 0.4 is softer, 0.15 is snappier).

Pixabay search results are cached for 24 hours (in `pixabay-cache.json`), as Pixabay's rules ask, and if Pixabay's limit of 100 requests per minute is hit the app waits and retries.

## Subtitles
The app no longer makes subtitles or captions: add them yourself in your editor. The YouTube transcript is still downloaded because it is how clips and B-roll moments are chosen.
