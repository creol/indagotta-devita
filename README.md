# Sing Along — Milestone 1

A mobile-friendly PWA with a single **Listen** button. Tap it, and the app
records ~10 seconds from your microphone, sends the clip to a song-recognition
service, and shows you the **title**, **artist**, and **how far into the song**
you are.

That last number is the point of the whole milestone: knowing the time offset is
what will let milestone 2 drop you into the right line of timestamped lyrics.

Then the words scroll past in time with the music, so you can actually sing
along.

> **Status:** milestones 1 and 2 complete — recognition and synced lyrics.

---

## What's in the box

| Path | What it does |
| --- | --- |
| `src/App.tsx` | The whole screen: button, states, results. Start here. |
| `src/lib/recorder.ts` | Microphone capture with `MediaRecorder` (incl. iOS quirks). |
| `src/lib/recognize.ts` | Talks to our own `/api/recognize`. |
| `src/components/ListenButton.tsx` | The big round button + countdown. |
| `src/components/SongCard.tsx` | Title / artist / time offset. |
| `src/components/LyricsView.tsx` | Timestamped lyrics that scroll with the song. |
| `src/lib/lrc.ts` | LRC parsing and "which line is playing now". |
| `api/recognize.ts` | Serverless function. Holds the API key, calls AudD. |
| `api/lyrics.ts` | Serverless function. Finds LRC lyrics via LRCLIB. |
| `public/manifest.webmanifest`, `public/sw.js` | The bits that make it a PWA. |
| `scripts/generate-icons.mjs` | Regenerates the app icons (`npm run icons`). |
| `server/index.mjs` | Production server for self-hosting (Docker). Unused on Vercel. |
| `Dockerfile`, `docker-compose.yml` | Self-hosting in one container. |
| `deploy.sh` | Rebuild + restart on the NAS. |
| `watch-deploy.sh`, `ensure-watcher.sh` | Optional auto-deploy on file save. |

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Get an AudD API token

Sign up at **[dashboard.audd.io](https://dashboard.audd.io/)** and copy your API
token. There's a free trial tier, which is plenty for development.

### 3. Create your `.env`

```bash
cp .env.example .env
```

Then open `.env` and paste your token in:

```
AUDD_API_TOKEN=your_real_token_here
```

`.env` is git-ignored, so your key stays on your machine.

### 4. Run it

```bash
npm run dev
```

Open **http://localhost:5173**. That's it — one command runs both the React app
and the `/api/recognize` function (see [How local dev works](#how-local-dev-works)).

### Testing on your phone

Microphone access requires a **secure context**: `https://`, or `localhost`.
Opening `http://192.168.x.x:5173` on your phone will *not* work — the mic button
will report that recording isn't available.

The easiest fix is a tunnel that gives you a public HTTPS URL:

```bash
npx localtunnel --port 5173
# or: ngrok http 5173
```

Then open the `https://…` URL it prints on your phone.

---

## Available commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with hot reload, including `/api`. |
| `npm run build` | Type-check, then build to `dist/`. |
| `npm run preview` | Serve the production build locally.¹ |
| `npm run typecheck` | Type-check only. |
| `npm run build:server` | Bundle the self-hosting server to `server-dist/`. |
| `npm start` | Run the built self-hosting server (needs both builds first). |
| `npm run icons` | Regenerate the PWA icons in `public/`. |

¹ `vite preview` serves static files only — `/api/recognize` won't exist, so
recognition returns an error. Use `npm run dev` to exercise the full flow.

---

## How it works

### The recognition round-trip

```
 ┌──────────┐   1. tap        ┌──────────────┐  3. POST JSON   ┌───────────────┐
 │  Listen  │ ──────────────► │  MediaRecorder│ ──────────────► │/api/recognize │
 │  button  │                 │  ~10s of audio│  {audioBase64}  │ (server-side) │
 └──────────┘                 └──────────────┘                 └───────┬───────┘
                                                                       │ 4. audio
      ┌────────────────────────────────────────────────────┐           │  + API key
      │  title · artist · timecode ("01:24")               │ ◄─────────┤
      └────────────────────────────────────────────────────┘  5. match  ▼
                                                                 ┌───────────┐
                                                                 │  audd.io  │
                                                                 └───────────┘
```

The browser sends the clip as **base64 inside plain JSON**. That's ~33% larger
than a raw upload, but it keeps both ends trivially simple — no multipart
parsing anywhere — and a 10-second clip is small enough that it doesn't matter.

### Keeping the API key secret

The token is **only ever read on the server**, inside `api/recognize.ts`, via
`process.env.AUDD_API_TOKEN`.

Two things enforce this:

1. The variable has **no `VITE_` prefix**. Vite only exposes `VITE_*` variables
   to browser code, so this one is structurally incapable of reaching the bundle.
2. The browser never calls `audd.io` directly — it only ever calls our own
   `/api/recognize`.

You can verify it yourself after a build:

```bash
npm run build
grep -r "AUDD_API_TOKEN" dist/     # finds nothing
```

### How local dev works

On Vercel, every file in `/api` automatically becomes a serverless function.
The plain Vite dev server knows nothing about that convention, so
`vite.config.ts` contains a small plugin (`devApiRoutes`) that recreates it:
it intercepts `/api/*`, loads the matching `.ts` file, and calls its default
export with the same `(req, res)` shape Vercel provides.

The practical benefit: **`npm run dev` runs everything**, with no Vercel CLI and
no Vercel account needed to develop locally.

### The iOS Safari catch

Safari on iOS only grants microphone access to code that runs as a *direct
result of a user's tap*. If anything slow happens first — a `fetch`, a settling
state update, a permission pre-check — Safari no longer associates the request
with the tap and rejects it with `NotAllowedError`, even for users who already
granted permission.

So `recordClip()` calls `getUserMedia` as its very first statement, and
`App.tsx` calls `recordClip()` with nothing awaited before it. If you add setup
logic to the Listen flow later, put it *after* the `getUserMedia` call.

Three other iOS details handled in `src/lib/recorder.ts`:

- **Format.** iOS Safari can't record WebM; it produces MP4/AAC. We ask
  `MediaRecorder.isTypeSupported` rather than hard-coding a format, and we send
  the *actual* recorded MIME type to the server.
- **Chunking.** We call `recorder.start(250)` so audio arrives in slices. Some
  Safari versions produce nothing at all if you only ask for one blob at the end.
- **Releasing the mic.** We always call `track.stop()` in a `finally` block.
  Skip it and the recording indicator stays lit and the audio session stays
  captured.

---

## Deploying

The app needs a server for `/api/recognize`, so a static-file host alone is not
enough. Two supported ways to run it:

### Option A — Self-hosting with Docker (NAS, VPS, homelab)

One container serves both the React app and the API. It listens on **8080**
inside the container, published on host port **3300** — QNAP's own admin UI
owns 8080, so publishing there would clash.

```bash
# 1. Put your token in .env next to docker-compose.yml
echo "AUDD_API_TOKEN=your_real_token_here" > .env

# 2. Build and start
docker compose up -d --build

# 3. Check it
curl http://localhost:3300/healthz     # -> ok
```

**QNAP workflow (chonk):**

There is **no push step and no copy step.** `Y:\` is a mapped network drive to
`\\CHONK\docker_containers` -> `/share/ZFS21_DATA/docker_containers` on the NAS,
so the working directory *is* the server. Editing a file in `Y:\indagotta-devita`
edits it in production. The GitHub remote is for version history only; nothing
pulls from it to deploy.

Set up once, from Windows:

```
git clone https://github.com/creol/indagotta-devita.git Y:\indagotta-devita
```

Then on chonk, over SSH:

```bash
cd /share/ZFS21_DATA/docker_containers/indagotta-devita
echo 'AUDD_API_TOKEN=your_token_here' > .env   # create it HERE, not on Windows
bash deploy.sh                                 # build and start
sudo bash ensure-watcher.sh --install-cron     # optional: auto-deploy on save
```

> **Create `.env` from the SSH session, not from Windows.** `echo x > file` in
> Windows PowerShell 5.1 writes **UTF-16 with a byte-order mark**, which Docker
> cannot parse at all; and even a plain ASCII file saved on Windows carries CRLF
> endings, which silently append a carriage return to the token so AudD rejects
> it while the file looks perfectly correct. `deploy.sh` detects both and tells
> you how to fix them, but creating the file on the NAS avoids the problem
> entirely.

With the watcher installed, saving a file under `src/`, `api/`, `server/`,
`public/`, or any of the root build files triggers a rebuild automatically;
output goes to `deploy.log`. Without it, run `bash deploy.sh` by hand.
`deploy.sh --clean` forces a `--no-cache` rebuild.

`ensure-watcher.sh` is copied verbatim from `campaign_app` — same cron safety
net, same lock and version checks. **A QNAP firmware update wipes
`/etc/config/crontab` and reboots**, so re-run `sudo bash ensure-watcher.sh
--install-cron` afterwards or the watcher loses its safety net. Check it with
`bash ensure-watcher.sh --status`.

> Unlike `campaign_app`, this project has no bind-mounted `data/` and no
> watcher-liveness API, so a dead watcher is not reported anywhere. It is
> checked by hand with `--status`. Nothing here is stateful, so a stale
> container serves old code but loses no data.

**Putting it behind nginx Proxy Manager:**

| Field | Value |
| --- | --- |
| Scheme | `http` (TLS is terminated by NPM, not the container) |
| Forward Hostname / IP | your host's LAN IP, or the container name on a shared Docker network |
| Forward Port | `3300` |
| Block Common Exploits | on |
| SSL | request a certificate and enable **Force SSL** |

Three things worth knowing:

- **HTTPS is not optional.** Browsers only allow microphone access on a secure
  origin. Once NPM serves the site over `https://`, the browser is happy — the
  proxy talking plain HTTP to the container behind it is fine.
- **Use a subdomain, not a subpath.** The app is built for the root path
  (`https://sing.example.com/`, not `https://example.com/sing/`). A subpath
  needs Vite's `base` option set at build time.
- **If Listen fails with a 413,** the proxy is rejecting the upload. Add
  `client_max_body_size 10m;` to the proxy host's *Advanced* tab. A 10-second
  clip is usually 100–250 KB, so this only bites if a default is unusually low.

To update after pulling new code: `docker compose up -d --build`.

**Running without Compose:**

```bash
docker build -t singalong .
docker run -d --name singalong -p 8080:8080 \
  -e AUDD_API_TOKEN=your_real_token_here \
  --restart unless-stopped singalong
```

### Option B — Vercel

1. Push this repo to GitHub and import it at
   [vercel.com/new](https://vercel.com/new). The Vite preset is detected
   automatically.
2. In **Project → Settings → Environment Variables**, add
   `AUDD_API_TOKEN` with your token, for all environments you plan to use.
3. Deploy. `api/recognize.ts` becomes a serverless function at
   `/api/recognize`, and the app is served over HTTPS — so the microphone
   works and the PWA is installable.

> Re-deploy after adding the environment variable; it isn't applied to existing
> builds.

On Vercel, `server/index.mjs` and the Dockerfile are unused — Vercel serves
`dist/` itself and turns `api/recognize.ts` into a serverless function.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| "Server is missing AUDD_API_TOKEN" | No `.env` file, or you didn't restart `npm run dev` after creating it. On Vercel, add the env var and re-deploy. |
| "Recording isn't available" | Not a secure context. Use `localhost` or an `https://` tunnel — not a bare LAN IP. |
| Mic prompt never appears on iOS | Something async ran before `getUserMedia`. See [The iOS Safari catch](#the-ios-safari-catch). |
| "No match found" every time | Play the music louder / closer, and aim for a section with vocals. Instrumental and live recordings match poorly. |
| "Wrong API token" | AudD rejected the token — check for stray whitespace or quotes in `.env`. |
| Recognition fails only in `npm run preview` | Expected: `preview` serves static files with no `/api`. Use `npm run dev`. |
| Self-hosted: Listen fails with 413 | The reverse proxy is rejecting the upload. Add `client_max_body_size 10m;` to the proxy host's Advanced tab. |
| Self-hosted: mic button says unavailable | The site is being served over plain `http://`. Terminate TLS at the proxy and force SSL. |
| `.env` error: `unexpected character` in variable name | The file is UTF-16/BOM — written by Windows PowerShell. Recreate it on the NAS: `echo 'AUDD_API_TOKEN=...' > .env` |
| Token looks right but AudD says it's invalid | `.env` has CRLF endings, so the token carries a trailing carriage return. `sed -i 's/
$//' .env` |
| Self-hosted: page loads but `/api/recognize` 404s | The container is serving only static files. Make sure you built with the provided `Dockerfile`, not a bare nginx image. |

---

## How the lyrics stay in time

We never hear the song, so we cannot follow it. Instead we work out where it
must be by now:

```
position = offsetWhenRecordingStarted + (now - whenRecordingStarted)
```

The subtle part is the anchor. Recording takes 10 seconds, and recognition and
the lyrics lookup add a couple more — so a clock started when the lyrics finish
loading would sit **twelve or more seconds behind the music**. Anchoring instead
to the moment the microphone went live, paired with AudD's timecode for that
moment, puts the first highlighted line in the right place.

Small errors survive that — exactly which point AudD matched, network jitter —
so there are **−1s / +1s** buttons. A second out is very noticeable when you are
trying to sing.

Lyrics come from [LRCLIB](https://lrclib.net): free, open, no API key. Because
recognition returns *release* titles, `api/lyrics.ts` retries with progressively
cleaner variants — `Mystify (Remastered 2011)` → `Mystify`, and the medley
`Head Over Heels / Broken` → `Head Over Heels` — and prefers the result whose
duration is closest to the recognised track, since a live cut's timings drift
further out of step the longer it runs.

Three outcomes besides success, all handled in the UI: a track with words but no
timings shows them unhighlighted, an instrumental says so, and an unknown track
says nothing was found rather than failing.

## What's next

- Cache lyrics lookups server-side so repeat plays skip the round trip.
- Let the user correct a wrong match by searching manually.
- A bigger nudge control (±0.1s) for fine sync.
