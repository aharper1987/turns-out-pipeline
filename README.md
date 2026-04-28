# Turns Out — Automated YouTube Pipeline
**Channel:** [@TurnsOutSci](https://youtube.com/@TurnsOutSci)
**Runs:** Every Tuesday & Friday at 6am UTC via GitHub Actions

---

## What this does

1. Pulls a trending peer-reviewed paper from PubMed
2. Generates a 90-second ELI5 script via Claude Haiku
3. Fetches matching stock footage from Pexels
4. Generates a voiceover via ElevenLabs (voice: Adam)
5. Assembles the final MP4 with captions via FFmpeg
6. Uploads and schedules the video to YouTube (@TurnsOutSci)
7. Saves a run log with paper details + thumbnail prompt

**Cost per video: ~$0.31**

---

## Setup (do this once)

### 1. Fork or push this repo to GitHub

### 2. Get a YouTube OAuth token

You need an OAuth 2.0 token with `youtube.upload` scope.

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project (or use an existing one)
3. Enable **YouTube Data API v3**
4. Go to **APIs & Services → Credentials → Create credentials → OAuth 2.0 Client ID**
5. Application type: **Desktop app**
6. Download the credentials JSON
7. Go to [OAuth 2.0 Playground](https://developers.google.com/oauthplayground)
8. Click the gear icon → check "Use your own OAuth credentials" → paste your Client ID and Secret
9. In Step 1, find **YouTube Data API v3** → select `https://www.googleapis.com/auth/youtube.upload`
10. Click "Authorize APIs" → sign in as the Google account that owns @TurnsOutSci
11. Click "Exchange authorization code for tokens"
12. Copy the **Access token** (starts with `ya29.`)

> ⚠️ Access tokens expire after 1 hour. For long-term automation, use the **Refresh token** flow.
> See `oauth_refresh.md` for the refresh token setup (recommended for production).

### 3. Add GitHub Secrets

In your GitHub repo: **Settings → Secrets and variables → Actions → New repository secret**

Add these four secrets:

| Secret name | Where to get it |
|---|---|
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) |
| `ELEVENLABS_API_KEY` | [elevenlabs.io/profile](https://elevenlabs.io/profile) |
| `PEXELS_API_KEY` | [pexels.com/api](https://www.pexels.com/api/) |
| `YOUTUBE_OAUTH_TOKEN` | From OAuth Playground (step above) |

### 4. Enable GitHub Actions

Go to the **Actions** tab in your repo and click "Enable Actions" if prompted.

### 5. Test it manually

Go to **Actions → Turns Out — Auto Pipeline → Run workflow** to trigger a manual run and verify everything works before the scheduled runs kick in.

---

## Schedule

The pipeline runs automatically on:
- **Every Tuesday** at 6:00 AM UTC (2:00 AM EDT)
- **Every Friday** at 6:00 AM UTC (2:00 AM EDT)

Videos are scheduled to publish **3 days after the run** at 9:00 AM EST — so Tuesday runs publish Friday, Friday runs publish Monday.

To change the schedule, edit `.github/workflows/schedule.yml` and update the cron expressions.

---

## Run logs

After each run, a `run_log_[timestamp].json` file is saved containing:
- Paper title, PMID, and URL
- Video ID and publish time
- DALL-E thumbnail prompt (paste into DALL-E, then upload manually to YouTube Studio)
- Word count

Run logs are also uploaded as GitHub Actions artifacts (retained 30 days).

---

## Costs

| Service | Cost per video |
|---|---|
| PubMed API | Free |
| Claude Haiku (script + metadata) | ~$0.012 |
| Pexels API | Free |
| ElevenLabs Turbo v2.5 | ~$0.30 |
| FFmpeg | Free |
| YouTube API | Free |
| GitHub Actions | Free (within 2,000 min/month) |
| **Total** | **~$0.31** |

At 2 videos/week: ~$2.50/month.

---

## Folder structure

```
turns-out-pipeline/
├── pipeline.js              # Main pipeline script
├── package.json
├── .github/
│   └── workflows/
│       └── schedule.yml     # GitHub Actions cron
├── tmp/                     # Temp files (auto-cleaned after each run)
└── run_log_*.json           # Run logs (one per run)
```

---

## Troubleshooting

**YouTube upload fails with 401:** Your OAuth token has expired. Generate a new one from OAuth Playground and update the GitHub Secret.

**No papers found:** PubMed's API occasionally returns empty results. The pipeline will retry on the next scheduled run automatically.

**FFmpeg not found locally:** Install with `brew install ffmpeg` (Mac) or `sudo apt install ffmpeg` (Linux).

**ElevenLabs 401:** Check your API key. Free tier has a monthly character limit — upgrade if you hit it.
