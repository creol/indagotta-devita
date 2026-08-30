# Sing Along — Milestone 1

A mobile-friendly PWA with a single **Listen** button. Tap it, and the app
records ~10 seconds from your microphone, sends the clip to a song-recognition
service, and shows you the **title**, **artist**, and **how far into the song**
you are.

That last number is the point of the whole milestone: knowing the time offset is
what will let milestone 2 drop you into the right line of timestamped lyrics.

> **Status:** milestone 1 of the sing-along app. Lyrics are a placeholder for now.

---

## What's in the box

| Path | What it does |
| --- | --- |
| `src/App.tsx` | The whole screen: button, states, results. Start here. |
| `src/lib/recorder.ts` | Microphone capture with `MediaRecorder` (incl. iOS quirks). |
| `src/lib/recognize.ts` | Talks to our own `/api/recognize`. |
| `src/components/ListenButton.tsx` | The big round button + countdown. |
| `src/components/SongCard.tsx` | Title / artist / time offset. |
| `src/components/LyricsView.tsx` | **Placeholder** — wired up in milestone 2. |
| `api/recognize.ts` | Serverless function. Holds the API key, calls AudD. |
| `public/manifest.webmanifest`, `public/sw.js` | The bits that make it a PWA. |
| `scripts/generate-icons.mjs` | Regenerates the app icons (`npm run icons`). |
| `server/index.mjs` | Production server for self-hosting (Docker). Unused on Vercel. |
| `Dockerfile`, `docker-compose.yml` | Self-hosting in one container. |

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

One container serves both the React app and the API, on port **8080**.

```bash
# 1. Put your token in .env next to docker-compose.yml
echo "AUDD_API_TOKEN=your_real_token_here" > .env

# 2. Build and start
docker compose up -d --build

# 3. Check it
curl http://localhost:8080/healthz     # -> ok
```

The token is read from the environment at run time, so it is **never baked into
the image** — the image is safe to rebuild, copy between machines, or push to a
private registry.

**Putting it behind nginx Proxy Manager:**

| Field | Value |
| --- | --- |
| Scheme | `http` (TLS is terminated by NPM, not the container) |
| Forward Hostname / IP | your host's LAN IP, or the container name on a shared Docker network |
| Forward Port | `8080` |
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
| Self-hosted: page loads but `/api/recognize` 404s | The container is serving only static files. Make sure you built with the provided `Dockerfile`, not a bare nginx image. |

---

## What's next (milestone 2)

`src/components/LyricsView.tsx` is a placeholder that already receives the props
the real thing needs — the matched `song` and `startOffsetSec`. The plan:

1. Fetch timestamped lyrics (LRC format) for the matched song via a new
   `/api` route.
2. Parse the LRC into `{ timeSec, text }` lines.
3. Start a clock from `startOffsetSec`, highlight the current line, and
   auto-scroll.

`timecodeToSeconds()` in `src/lib/recognize.ts` already converts AudD's
`"01:24"` into the `84` that step 3 needs.
