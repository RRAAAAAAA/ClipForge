# ClipForge MVP
Needs: Node 20+, ffmpeg, yt-dlp (pip install -U yt-dlp), Python 3 with numpy and OpenCV 4.x (see the Dockerfile).
Run: `npm install && GEMINI_API_KEY=... npm start` then open http://localhost:3000
Deploy on Railway: push this folder, it builds from the Dockerfile; set GEMINI_API_KEY.
YouTube links only work on videos that have an English YouTube transcript (it is used to pick clips and B-roll moments); uploaded videos are transcribed by Gemini. Use content you have permission to clip.

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

## Upload your own footage
Use the **Upload footage** tab instead of a YouTube link. The video is streamed to the server (limit `MAX_UPLOAD_MB`, default 1500), Gemini listens to the audio to get the transcript (so someone must be talking), picks the clips, and each clip is edited like this:
- 9:16 frame with your footage as a **1:1 square in the middle**; a blurred, darkened copy of it fills the top and bottom. Face-following still works inside the square (1 person = square on their face, 2 people = two stacked strips, 3+ = whoever is speaking). The Layout dropdown on each clip switches to full 9:16.
- B-roll goes **inside the same square**, never full screen.
- **No dead air**: pauses longer than 0.4 s are cut down to about 0.2 s, and the clip starts right on the first word. Untick "Cut dead air" to keep the pauses. If a recording is noisy and pauses are not found, set `DEAD_AIR_DB` to `-28` (default `-32`).
- The clip picker is told to start on a scroll-stopping hook, and the first cutaway lands on the first beat after 1 second.
Gemini's word times from audio are approximate, so the clip starts a little early and the dead-air cut trims the extra silence.

## Beat-synced B-roll and music
B-roll cuts are placed on the beats of the background music (`beats.py` finds the beats with numpy, no extra install). Each cutaway is 2 to 4 beats long, cutaways in a group share the same beat, and the crossfade is short (0.12 s) and centred on the beat. There are about twice as many cutaways as before (`BROLL_EVERY`, default 2.4 s, minimum 1.5; `BROLL_FADE`, default 0.12). Uploaded footage gets a random `upbeat` track by default.
- Two original loops are included: `upbeat-viral-house-128bpm.mp3` and `upbeat-viral-trap-140bpm.mp3`. They are simple synthesized placeholders. Drop real viral-style tracks into `music/` and start the file name with `upbeat`.
- Put the tempo in the file name when you know it (`upbeat-phonk-150bpm.mp3`) and it is trusted; without it the tempo is detected from the audio. No music = cuts on an even 120 BPM pulse.

## B-roll footage of your own (optional)
Under the buttons, upload a second video (cars, wins, money, teaching, ...). Gemini watches a small copy once, lists the scenes with tags, and the B-roll planner uses a scene whenever it fits what is being said. Everything that does not fit comes from Pixabay (needs `PIXABAY_API_KEY`). It works for YouTube clips too. Scenes are cached for the session; the footage is deleted after 90 minutes of not being used, like all files in `work/`.

## B-roll (Pixabay stock footage)
Each clip gets free Pixabay stock video cutaways that match what is being said. Gemini follows the speech: a sentence may get 1 to 4 cutaways back to back, with short breaks of the speaker in between (never in the first second or the punchline). The speaker's voice and the music keep playing. Add a free `PIXABAY_API_KEY` (pixabay.com/api/docs) as a Railway variable. Untick "Add B-roll" on a clip card to turn it off. If nothing is found for a moment, it is skipped.

Pixabay search results are cached for 24 hours (in `pixabay-cache.json`), as Pixabay's rules ask, and if Pixabay's limit of 100 requests per minute is hit the app waits and retries.

## Subtitles
The app no longer makes subtitles or captions: add them yourself in your editor. The YouTube transcript is still downloaded because it is how clips and B-roll moments are chosen.
