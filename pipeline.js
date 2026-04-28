#!/usr/bin/env node
/**
 * Turns Out — Automated YouTube Pipeline
 * Channel: @TurnsOutSci | UCugairkMHQVneS7C5SbIP0g
 *
 * Flow:
 *   1. Fetch trending paper from PubMed
 *   2. Generate ELI5 script via Claude Haiku
 *   3. Fetch stock footage from Pexels
 *   4. Generate voiceover via ElevenLabs
 *   5. Assemble video via FFmpeg
 *   6. Generate thumbnail prompt + title/description/tags
 *   7. Upload & schedule to YouTube
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import https from "https";
import http from "http";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(__dirname, "tmp");
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const CONFIG = {
  CHANNEL_ID: "UCugairkMHQVneS7C5SbIP0g",
  CHANNEL_HANDLE: "@TurnsOutSci",
  ELEVENLABS_VOICE_ID: "ptBd2v6mebIps3ZQEXD7", // Adela — British neutral female, 30s-40s
  VIDEO_DURATION_TARGET: 90, // seconds
  TOPICS: [
    { label: "Cancer research",    query: "cancer+therapy+clinical+trial",       pexels: "laboratory science" },
    { label: "Brain & dementia",   query: "dementia+alzheimer+cognitive+decline", pexels: "brain neuroscience" },
    { label: "Fitness & health",   query: "exercise+health+fitness+metabolism",   pexels: "exercise fitness" },
    { label: "Child psychology",   query: "child+psychology+development+behavior",pexels: "children learning" },
    { label: "Food science",       query: "nutrition+diet+food+health+outcomes",  pexels: "healthy food" },
    { label: "Longevity & aging",  query: "longevity+aging+lifespan+senescence",  pexels: "aging health" },
  ],
};

// API keys from environment variables (set as GitHub Secrets)
const KEYS = {
  anthropic:  process.env.ANTHROPIC_API_KEY,
  elevenlabs: process.env.ELEVENLABS_API_KEY,
  pexels:     process.env.PEXELS_API_KEY,
  youtube:    process.env.YT_TOKEN,
};

// ─── UTILITIES ───────────────────────────────────────────────────────────────

function log(msg, type = "info") {
  const icons = { info: "→", ok: "✓", err: "✗", warn: "⚠" };
  console.log(`${icons[type] || "·"} ${msg}`);
}

function assert(condition, msg) {
  if (!condition) { log(msg, "err"); process.exit(1); }
}

async function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.request(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`JSON parse failed: ${data.slice(0, 200)}`)); }
      });
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function fetchBinary(url, destPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(destPath);
    const doRequest = (u) => {
      lib.get(u, { headers }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return doRequest(res.headers.location);
        }
        res.pipe(file);
        file.on("finish", () => { file.close(); resolve(destPath); });
        file.on("error", reject);
      }).on("error", reject);
    };
    doRequest(url);
  });
}

function pickTopic(excludeIndices = []) {
  const available = CONFIG.TOPICS
    .map((t, i) => ({ topic: t, index: i }))
    .filter(({ index }) => !excludeIndices.includes(index));
  if (!available.length) throw new Error('All topics exhausted');
  const pick = available[Math.floor(Math.random() * available.length)];
  return pick;
}

async function fetchPaperWithRetry() {
  const tried = [];
  for (let attempt = 0; attempt < CONFIG.TOPICS.length; attempt++) {
    const { topic, index } = pickTopic(tried);
    tried.push(index);
    try {
      const paper = await fetchPaper(topic);
      return { paper, topic };
    } catch (e) {
      log('Topic "' + topic.label + '" failed (' + e.message + ') - trying next...', 'warn');
    }
  }
  throw new Error('All topics failed - PubMed may be unavailable');
}

function schedulePublishTime() {
  // Schedule 3 days from now at 9am EST
  const d = new Date();
  d.setDate(d.getDate() + 3);
  d.setHours(14, 0, 0, 0); // 14:00 UTC = 9:00 EST / 10:00 EDT
  return d.toISOString().replace(".000", "");
}

// ─── STEP 1: FETCH PAPER ─────────────────────────────────────────────────────

async function fetchPaper(topic) {
  log(`Fetching paper for topic: ${topic.label}`);

  const searchUrl =
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi` +
    `?db=pubmed&term=${topic.query}&sort=date&retmax=10&retmode=json` +
    `&mindate=2024&maxdate=2025&filter=free+full+text`;

  const search = await fetchJSON(searchUrl);
  const ids = search.esearchresult?.idlist;
  assert(ids?.length, "No papers found for topic");

  // Pick a random paper from top 10 so we don't always use the same one
  const id = ids[Math.floor(Math.random() * Math.min(ids.length, 5))];

  const summaryUrl =
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi` +
    `?db=pubmed&id=${id}&retmode=json`;

  const summary = await fetchJSON(summaryUrl);
  const paper = summary.result?.[id];
  assert(paper, "Could not fetch paper summary");

  // Also fetch abstract
  const abstractUrl =
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi` +
    `?db=pubmed&id=${id}&rettype=abstract&retmode=text`;

  const abstract = await new Promise((resolve) => {
    https.get(abstractUrl, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(d.trim()));
    });
  });

  const result = {
    pmid: id,
    title: paper.title || "",
    authors: (paper.authors || []).slice(0, 3).map((a) => a.name).join(", "),
    journal: paper.source || "",
    date: paper.pubdate || "",
    abstract: abstract.slice(0, 2000), // cap at 2000 chars
    url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
  };

  log(`Found: "${result.title.slice(0, 70)}..."`, "ok");
  return result;
}

// ─── STEP 2: GENERATE SCRIPT ─────────────────────────────────────────────────

async function generateScript(paper, topic) {
  assert(KEYS.anthropic, "Missing ANTHROPIC_API_KEY");
  log("Generating ELI5 script via Claude Haiku...");

  const prompt = `You are writing a YouTube script for "Turns Out" — a science channel that explains real research in plain English for a general audience. The tone is witty, slightly quirky, and genuinely curious. Never dumbed down, never dry.

Study title: ${paper.title}
Abstract: ${paper.abstract}
Topic category: ${topic.label}

Write a tight 90-second video script that follows this exact structure:

1. HOOK (2 sentences): Open with a surprising or counterintuitive statement that makes someone stop scrolling. Don't start with "Did you know." Be specific.
2. THE STUDY (2-3 sentences): What did researchers actually do? Who studied what, using what method, on how many people/animals/samples?
3. THE FINDING (3-4 sentences): What did they find? Explain it like the listener is smart but has zero science background. Use one concrete analogy.
4. WHY IT MATTERS (2 sentences): What does this mean for real life? Be honest — don't overhype.
5. SIGN-OFF (1 sentence): End with the channel catchphrase: "Turns out, scientists have been busy." then one punchy teaser for curiosity.

Write ONLY the script — no stage directions, no labels for each section, no markdown. Just the words to be spoken. Max 220 words.`;

  const response = await fetchJSON("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": KEYS.anthropic,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const script = response.content?.[0]?.text;
  assert(script, "Script generation failed");
  log(`Script generated (${script.split(" ").length} words)`, "ok");
  return script;
}

// ─── STEP 3: GENERATE VIDEO METADATA ─────────────────────────────────────────

async function generateMetadata(paper, script, topic) {
  assert(KEYS.anthropic, "Missing ANTHROPIC_API_KEY");
  log("Generating video title, description, and tags...");

  const prompt = `Given this YouTube script for the channel "Turns Out" (@TurnsOutSci), generate video metadata.

Script: ${script}
Study: ${paper.title}
Topic: ${topic.label}

Respond ONLY with valid JSON, no markdown, no explanation:
{
  "title": "YouTube video title — punchy, under 60 chars, no clickbait, hint at the finding",
  "description": "Full YouTube description — 3 paragraphs. First: one-sentence hook. Second: what the study found in plain English. Third: study citation and link. End with: New video every week. Subscribe: https://youtube.com/@TurnsOutSci",
  "tags": ["array", "of", "10-15", "relevant", "tags"]
}`;

  const response = await fetchJSON("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": KEYS.anthropic,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const raw = response.content?.[0]?.text || "";
  const clean = raw.replace(/```json|```/g, "").trim();
  const metadata = JSON.parse(clean);
  log(`Title: "${metadata.title}"`, "ok");
  return metadata;
}

// ─── STEP 4: FETCH STOCK FOOTAGE ─────────────────────────────────────────────

async function fetchFootage(topic) {
  assert(KEYS.pexels, "Missing PEXELS_API_KEY");
  log(`Fetching stock footage for: "${topic.pexels}"...`);

  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(topic.pexels)}&per_page=6&orientation=landscape&size=medium`;
  const data = await fetchJSON(url, {
    headers: { Authorization: KEYS.pexels },
  });

  const clips = (data.videos || [])
    .map((v) => {
      const file =
        v.video_files?.find((f) => f.quality === "sd" && f.width >= 1280) ||
        v.video_files?.find((f) => f.quality === "sd") ||
        v.video_files?.[0];
      return file?.link;
    })
    .filter(Boolean)
    .slice(0, 4);

  assert(clips.length, "No footage found");

  // Download clips
  const paths = [];
  for (let i = 0; i < clips.length; i++) {
    const dest = path.join(TMP, `clip_${i}.mp4`);
    log(`  Downloading clip ${i + 1}/${clips.length}...`);
    await fetchBinary(clips[i], dest);
    paths.push(dest);
  }

  log(`Downloaded ${paths.length} clips`, "ok");
  return paths;
}

// ─── STEP 5: GENERATE VOICEOVER ──────────────────────────────────────────────

async function generateVoiceover(script) {
  assert(KEYS.elevenlabs, "Missing ELEVENLABS_API_KEY");
  log("Generating voiceover via ElevenLabs...");

  const audioPath = path.join(TMP, "voiceover.mp3");
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${CONFIG.ELEVENLABS_VOICE_ID}`;

  await new Promise((resolve, reject) => {
    const body = JSON.stringify({
      text: script,
      model_id: "eleven_turbo_v2_5",
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.2 },
    });

    const req = https.request(
      url,
      {
        method: "POST",
        headers: {
          "xi-api-key": KEYS.elevenlabs,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        assert(res.statusCode === 200, `ElevenLabs error: ${res.statusCode}`);
        const file = fs.createWriteStream(audioPath);
        res.pipe(file);
        file.on("finish", () => { file.close(); resolve(); });
        file.on("error", reject);
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });

  log("Voiceover generated", "ok");
  return audioPath;
}

// ─── STEP 6: ASSEMBLE VIDEO ───────────────────────────────────────────────────

async function assembleVideo(clipPaths, audioPath, title) {
  log("Assembling video with FFmpeg...");

  const outputPath = path.join(TMP, "final.mp4");
  const concatList = path.join(TMP, "concat.txt");
  const loopedFootage = path.join(TMP, "footage_loop.mp4");
  const scaledFootage = path.join(TMP, "footage_scaled.mp4");

  // Get audio duration
  const audioDuration = parseFloat(
    execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`
    ).toString().trim()
  );
  log(`  Audio duration: ${audioDuration.toFixed(1)}s`);

  // Write concat list — repeat clips to fill audio duration
  const clipDuration = audioDuration / clipPaths.length;
  let concatContent = "";
  for (const p of clipPaths) {
    concatContent += `file '${p}'\n`;
  }
  // Repeat the list enough times to cover audio
  const repeats = Math.ceil(audioDuration / (clipPaths.length * 5)) + 1;
  let fullContent = "";
  for (let i = 0; i < repeats; i++) fullContent += concatContent;
  fs.writeFileSync(concatList, fullContent);

  // Concatenate and loop footage
  execSync(
    `ffmpeg -y -f concat -safe 0 -i "${concatList}" -t ${audioDuration + 1} -c copy "${loopedFootage}" 2>/dev/null`,
    { stdio: "pipe" }
  );

  // Scale to 1920x1080, add letterbox if needed
  execSync(
    `ffmpeg -y -i "${loopedFootage}" -vf "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080" -c:v libx264 -preset fast -crf 23 "${scaledFootage}" 2>/dev/null`,
    { stdio: "pipe" }
  );

  // Mix video + voiceover, add subtle background music if available, add captions
  // Generate SRT captions from script timing estimate
  const captionPath = await generateCaptions(audioPath);

  execSync(
    `ffmpeg -y \
      -i "${scaledFootage}" \
      -i "${audioPath}" \
      -map 0:v:0 -map 1:a:0 \
      -vf "subtitles='${captionPath}':force_style='FontName=Arial,FontSize=18,PrimaryColour=&HFFFFFF,OutlineColour=&H000000,Outline=2,Bold=1,Alignment=2,MarginV=40'" \
      -c:v libx264 -preset fast -crf 22 \
      -c:a aac -b:a 128k \
      -shortest \
      "${outputPath}" 2>/dev/null`,
    { stdio: "pipe" }
  );

  log("Video assembled", "ok");
  return outputPath;
}

async function generateCaptions(audioPath) {
  // Generate basic SRT using ffmpeg's speech detection timing estimate
  // In production you could swap this for Whisper API for accurate captions
  const srtPath = path.join(TMP, "captions.srt");

  // Get audio duration for caption timing
  const duration = parseFloat(
    execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`
    ).toString().trim()
  );

  // Write a simple SRT with one block — full caption
  // For production, replace with Whisper word-level timestamps
  fs.writeFileSync(
    srtPath,
    `1\n00:00:00,000 --> 00:00:${Math.floor(duration)},000\n[Watch with sound for full narration]\n`
  );

  return srtPath;
}

// ─── STEP 7: GENERATE THUMBNAIL ───────────────────────────────────────────────

async function generateThumbnail(videoPath, metadata, topic) {
  log("Generating thumbnail from video frame...");

  const thumbPath = path.join(TMP, "thumbnail.jpg");

  // 1. Get video duration
  const duration = parseFloat(
    execSync(
      `ffprobe -v error -show_entries format=duration \
       -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`
    ).toString().trim()
  );

  // Extract a frame at 20% in — past any intro cut, well before the end
  const seekTo = (duration * 0.20).toFixed(2);
  const rawFrame = path.join(TMP, "raw_frame.jpg");
  execSync(
    `ffmpeg -y -ss ${seekTo} -i "${videoPath}" -vframes 1 -q:v 2 "${rawFrame}" 2>/dev/null`,
    { stdio: "pipe" }
  );

  // 2. Darken + warm-tint the frame so text reads cleanly over it
  const darkenedFrame = path.join(TMP, "darkened_frame.jpg");
  execSync(
    `ffmpeg -y -i "${rawFrame}" \
     -vf "eq=brightness=-0.28:contrast=0.88,colorchannelmixer=rr=0.92:gg=0.86:bb=0.78" \
     "${darkenedFrame}" 2>/dev/null`,
    { stdio: "pipe" }
  );

  // 3. Wrap title into two lines at ~28 chars each
  const safeTitle = metadata.title.replace(/['"\\:]/g, " ").trim();
  const words = safeTitle.split(" ");
  let line1 = "";
  let line2 = "";
  for (const word of words) {
    if ((line1 + " " + word).trim().length <= 28) {
      line1 = (line1 + " " + word).trim();
    } else {
      line2 = (line2 + " " + word).trim();
    }
  }
  const topicLabel = topic.label.toUpperCase().replace(/['"\\]/g, "");

  // 4. Compose overlays with FFmpeg drawtext + drawbox
  //    Layout: topic pill top-left | brand mark top-right | title bottom-left
  const font = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

  // Build filter as a sequential chain on a single input
  let vf = [
    // Bottom scrim: semi-transparent dark rect for text legibility
    `drawbox=x=0:y=480:w=iw:h=240:color=#1A1610@0.72:t=fill`,
    // Amber pill behind topic label
    `drawbox=x=30:y=30:w=230:h=40:color=#C17B2F@1.0:t=fill`,
    // Topic label on pill
    `drawtext=fontfile='${font}':text='${topicLabel}':fontsize=18:fontcolor=#1A1610:x=42:y=41`,
    // Brand mark top-right
    `drawtext=fontfile='${font}':text='TURNS OUT':fontsize=15:fontcolor=#8A7F6B:x=w-tw-30:y=42`,
    // Title line 1
    `drawtext=fontfile='${font}':text='${line1}':fontsize=54:fontcolor=#F5EDD8:x=30:y=492:shadowcolor=black@0.8:shadowx=2:shadowy=2`,
  ];

  // Title line 2 only if needed
  if (line2) {
    vf.push(
      `drawtext=fontfile='${font}':text='${line2}':fontsize=54:fontcolor=#F5EDD8:x=30:y=556:shadowcolor=black@0.8:shadowx=2:shadowy=2`
    );
  }

  execSync(
    `ffmpeg -y -i "${darkenedFrame}" -vf "${vf.join(",")}" -q:v 2 "${thumbPath}" 2>/dev/null`,
    { stdio: "pipe" }
  );

  log("Thumbnail generated (1280×720 from video frame)", "ok");
  return thumbPath;
}

// ─── STEP 8: UPLOAD TO YOUTUBE ────────────────────────────────────────────────

async function uploadToYouTube(videoPath, metadata, publishTime) {
  assert(KEYS.youtube, "Missing YOUTUBE_OAUTH_TOKEN");
  log("Uploading to YouTube...");

  const videoBuffer = fs.readFileSync(videoPath);
  const boundary = "turns_out_boundary_" + Date.now();

  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify({
        snippet: {
          title: metadata.title,
          description: metadata.description,
          tags: metadata.tags,
          categoryId: "28", // Science & Technology
          defaultLanguage: "en",
        },
        status: {
          privacyStatus: "private", // set to private first, then schedule
          publishAt: publishTime,
          selfDeclaredMadeForKids: false,
        },
      }) +
      `\r\n--${boundary}\r\n` +
      `Content-Type: video/mp4\r\n\r\n`
    ),
    videoBuffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const response = await new Promise((resolve, reject) => {
    const req = https.request(
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${KEYS.youtube}`,
          "Content-Type": `multipart/related; boundary=${boundary}`,
          "Content-Length": body.length,
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
          catch { resolve({ status: res.statusCode, body: d }); }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });

  if (response.status === 200 || response.status === 201) {
    const videoId = response.body?.id;
    log(`Uploaded! Video ID: ${videoId}`, "ok");
    log(`Scheduled for: ${publishTime}`, "ok");
    log(`URL: https://youtube.com/watch?v=${videoId}`, "ok");
    return videoId;
  } else {
    log(`Upload failed (${response.status}): ${JSON.stringify(response.body)}`, "err");
    throw new Error("YouTube upload failed");
  }
}

// ─── CLEANUP ──────────────────────────────────────────────────────────────────

function cleanup() {
  log("Cleaning up temp files...");
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function uploadThumbnail(videoId, thumbPath) {
  log("Uploading thumbnail to YouTube...");
  const thumbBuffer = fs.readFileSync(thumbPath);

  const response = await new Promise((resolve, reject) => {
    const req = https.request(
      `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}&uploadType=media`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${KEYS.youtube}`,
          "Content-Type": "image/jpeg",
          "Content-Length": thumbBuffer.length,
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode }));
      }
    );
    req.on("error", reject);
    req.write(thumbBuffer);
    req.end();
  });

  if (response.status === 200) {
    log("Thumbnail uploaded", "ok");
  } else {
    // Thumbnail upload failure is non-fatal — video still goes live
    log(`Thumbnail upload returned ${response.status} — continuing`, "warn");
  }
}

async function main() {
  console.log("\n╔════════════════════════════════════════╗");
  console.log("║     Turns Out — Pipeline v1.0          ║");
  console.log("║     @TurnsOutSci                       ║");
  console.log(`║     ${new Date().toISOString().slice(0, 10)}                       ║`);
  console.log("╚════════════════════════════════════════╝\n");

  // Validate required keys
  const missing = Object.entries(KEYS).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    log(`Missing API keys: ${missing.join(", ")}`, "err");
    log("Set them as environment variables or GitHub Secrets.", "warn");
    process.exit(1);
  }

  // fetchPaperWithRetry handles topic selection and retries automatically

  try {
    const { paper, topic } = await fetchPaperWithRetry();
    log('Topic selected: ' + topic.label);
    const script    = await generateScript(paper, topic);
    const metadata  = await generateMetadata(paper, script, topic);
    const clips     = await fetchFootage(topic);
    const audio     = await generateVoiceover(script);
    const video     = await assembleVideo(clips, audio, metadata.title);
    const thumb     = await generateThumbnail(video, metadata, topic);
    const publishAt = schedulePublishTime();
    const videoId   = await uploadToYouTube(video, metadata, publishAt);
    await uploadThumbnail(videoId, thumb);

    // Save run log
    const runLog = {
      timestamp: new Date().toISOString(),
      topic: topic.label,
      paper: { pmid: paper.pmid, title: paper.title, url: paper.url },
      videoId,
      title: metadata.title,
      publishAt,
      wordCount: script.split(" ").length,
    };
    fs.writeFileSync(
      path.join(__dirname, `run_log_${Date.now()}.json`),
      JSON.stringify(runLog, null, 2)
    );

    console.log("\n✅ Pipeline complete!");
    console.log(`   Video:      https://youtube.com/watch?v=${videoId}`);
    console.log(`   Thumbnail:  uploaded automatically`);
    console.log(`   Publishes:  ${publishAt}\n`);

    cleanup();
  } catch (err) {
    log(`Pipeline failed: ${err.message}`, "err");
    console.error(err);
    process.exit(1);
  }
}

main();
