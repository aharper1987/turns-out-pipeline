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
 *   5. Assemble video via FFmpeg (with bumper)
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
  VIDEO_DURATION_TARGET: 600, // seconds (10 minutes)
  BUMPER_DURATION: 3, // seconds
  ASSETS_DIR: path.join(__dirname, "assets"),
  TOPICS: [
    { label: "Cancer research",    query: "cancer+therapy+clinical+trial",       pexels: "laboratory science" },
    { label: "Brain & dementia",   query: "dementia+alzheimer+cognitive+decline", pexels: "brain neuroscience" },
    { label: "Fitness & health",   query: "exercise+health+fitness+metabolism",   pexels: "exercise fitness" },
    { label: "Child psychology",   query: "child+psychology+development+behavior",pexels: "children learning" },
    { label: "Food science",       query: "nutrition+diet+food+health+outcomes",  pexels: "healthy food" },
    { label: "Longevity & aging",  query: "longevity+aging+lifespan+senescence",  pexels: "aging health" },
  ],
  MUSIC_CREDIT: `Music: "Upbeat Inspiring Corporate" by Pro Tunes - Copyright Safe Music | https://freemusicarchive.org/music/pro-tunes/single/upbeat-inspiring-corporate-1/`,
};

// API keys from environment variables (set as GitHub Secrets)
const KEYS = {
  anthropic:      process.env.ANTHROPIC_API_KEY,
  elevenlabs:     process.env.ELEVENLABS_API_KEY,
  pexels:         process.env.PEXELS_API_KEY,
  youtube:        process.env.YT_TOKEN, // overwritten at runtime by refreshYouTubeToken()
  ytRefreshToken: process.env.YT_REFRESH_TOKEN,
  ytClientId:     process.env.YT_CLIENT_ID,
  ytClientSecret: process.env.YT_CLIENT_SECRET,
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
      log('PubMed failed for "' + topic.label + '": ' + e.message, 'warn');
      log('Falling back to Semantic Scholar...', 'info');
      try {
        const paper = await fetchPaperSemanticScholar(topic);
        return { paper, topic };
      } catch (e2) {
        log('Semantic Scholar also failed for "' + topic.label + '": ' + e2.message, 'warn');
        log('Trying next topic...', 'info');
      }
    }
  }
  throw new Error('All topics exhausted across PubMed and Semantic Scholar');
}

function schedulePublishTime() {
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
    `&mindate=2023&maxdate=2026`;

  const search = await fetchJSON(searchUrl);
  const ids = search.esearchresult?.idlist;
  if (!ids?.length) throw new Error("No papers found for topic");

  const id = ids[Math.floor(Math.random() * Math.min(ids.length, 5))];

  const summaryUrl =
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi` +
    `?db=pubmed&id=${id}&retmode=json`;

  const summary = await fetchJSON(summaryUrl);
  const paper = summary.result?.[id];
  if (!paper) throw new Error("Could not fetch paper summary");

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

  // Extract all authors for credits (not just first 3)
  const allAuthors = (paper.authors || []).map((a) => a.name);
  const displayAuthors = allAuthors.slice(0, 3).join(", ") +
    (allAuthors.length > 3 ? ` et al.` : "");

  // Extract affiliation if available
  const affiliation = paper.affiliations?.[0] || "";

  const result = {
    pmid: id,
    title: paper.title || "",
    authors: displayAuthors,
    allAuthors,
    affiliation,
    journal: paper.source || "",
    date: paper.pubdate || "",
    abstract: abstract.slice(0, 2000),
    url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
    doi: paper.elocationid?.startsWith("doi:") ? paper.elocationid.replace("doi: ", "") : "",
    source: "PubMed",
  };

  log(`Found: "${result.title.slice(0, 70)}..."`, "ok");
  return result;
}

// ─── STEP 1B: FETCH FROM SEMANTIC SCHOLAR ────────────────────────────────────

async function fetchPaperSemanticScholar(topic) {
  log('Fetching from Semantic Scholar for: ' + topic.label);

  const query = encodeURIComponent(topic.query.replace(/\+/g, ' '));
  const url =
    'https://api.semanticscholar.org/graph/v1/paper/search' +
    '?query=' + query +
    '&fields=title,abstract,authors,year,citationCount,influentialCitationCount,externalIds,publicationDate,journal' +
    '&limit=10' +
    '&publicationDateOrYear=2023-2026';

  const data = await fetchJSON(url, {
    headers: { 'User-Agent': 'TurnsOutPipeline/1.0' }
  });

  const papers = (data.data || [])
    .filter(p => p.abstract && p.title)
    .sort((a, b) => (b.influentialCitationCount || 0) - (a.influentialCitationCount || 0));

  if (!papers.length) throw new Error('No papers found on Semantic Scholar');

  const pool = papers.slice(0, 5);
  const paper = pool[Math.floor(Math.random() * pool.length)];
  const doi = paper.externalIds?.DOI || "";
  const pmid = paper.externalIds?.PubMed || "";

  const allAuthors = (paper.authors || []).map((a) => a.name);
  const displayAuthors = allAuthors.slice(0, 3).join(", ") +
    (allAuthors.length > 3 ? ` et al.` : "");

  const result = {
    pmid: pmid || paper.paperId,
    title: paper.title || '',
    authors: displayAuthors,
    allAuthors,
    affiliation: "",
    journal: paper.journal?.name || "",
    date: paper.publicationDate || String(paper.year || ''),
    abstract: (paper.abstract || '').slice(0, 2000),
    url: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : (doi ? `https://doi.org/${doi}` : `https://www.semanticscholar.org/paper/${paper.paperId}`),
    doi,
    citationCount: paper.citationCount || 0,
    influentialCitations: paper.influentialCitationCount || 0,
    source: 'Semantic Scholar',
  };

  log('Found (S2, ' + result.influentialCitations + ' influential citations): "' + result.title.slice(0, 70) + '..."', 'ok');
  return result;
}

// ─── STEP 2: GENERATE SCRIPT ─────────────────────────────────────────────────

async function generateScript(paper, topic) {
  assert(KEYS.anthropic, "Missing ANTHROPIC_API_KEY");
  log("Generating script via Claude Haiku...");

  const prompt = `You are writing a YouTube script for "Turns Out" — a science channel that explains real research in plain English for a general audience. The tone is witty, slightly quirky, and genuinely curious. Never dumbed down, never dry.

Study title: ${paper.title}
Authors: ${paper.authors}${paper.affiliation ? `\nInstitution: ${paper.affiliation}` : ""}
Journal: ${paper.journal || "not specified"}
Published: ${paper.date}
Abstract: ${paper.abstract}
Topic category: ${topic.label}

Write a detailed 10-minute video script (approximately 1,400 words) that follows this exact structure:

1. COLD OPEN (100 words): Start mid-story with the most surprising or counterintuitive implication of this research. Drop the viewer into a vivid scenario or provocative claim. No "hey guys" intros. No "Did you know." End with a question that makes them need to keep watching.

2. INTRO & CONTEXT (150 words): Zoom out. Why has this topic been studied at all? What's the broader problem or mystery scientists were trying to solve? Give a brief history of what we thought we knew before this study — specifically call out any prior theories, consensus views, or previous findings that this research challenges, confirms, or overturns.

3. THE RESEARCHERS (100 words): Introduce who did this work. Name the lead researchers, their institutional affiliations, when the study was published, and where. Make it feel human — these are real scientists at real institutions, not just "a new study." Weave this in naturally, not as a list.

4. THE STUDY EXPLAINED (200 words): Break down exactly what researchers did. Who were the subjects? What was the methodology? How long did it run? What were they measuring and why? Make it feel like you're walking the viewer through the lab. Use one concrete real-world analogy to explain the method.

5. THE FINDINGS (250 words): What did they actually find? Go result by result. Explain each finding in plain English. Use comparisons, analogies, and scale to make numbers feel real. Be honest about effect sizes.

6. WHAT THIS MEANS (200 words): Connect findings to everyday life. Be practical and specific. Address likely skepticism or limitations honestly.

7. THE BIGGER PICTURE (200 words): Where does this fit in the wider field? What prior conclusions does it confirm, challenge, or overturn? What questions does it raise? What research should come next?

8. SIGN-OFF (100 words): Recap the single most mind-blowing takeaway. Raise one final provocative question. End with: "Turns out, scientists have been busy. And they're not done yet."

Write ONLY the script — no stage directions, no section labels, no markdown, no headers. Just the words to be spoken out loud, flowing naturally from section to section. Target 1,400 words.`;

  const response = await fetchJSON("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": KEYS.anthropic,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const script = response.content?.[0]?.text;
  assert(script, "Script generation failed");
  const wordCount = script.split(" ").length;
  log(`Script generated (${wordCount} words / ~${Math.round(wordCount/140)} mins)`, "ok");
  return script;
}

// ─── STEP 3: GENERATE VIDEO METADATA ─────────────────────────────────────────

async function generateMetadata(paper, script, topic) {
  assert(KEYS.anthropic, "Missing ANTHROPIC_API_KEY");
  log("Generating video title, description, and tags...");

  // Build research credits block
  const doiLine   = paper.doi  ? `DOI: https://doi.org/${paper.doi}`                          : "";
  const pmidLine  = paper.pmid && /^\d+$/.test(paper.pmid)
                                ? `PubMed: https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/`    : "";
  const linkLines = [doiLine, pmidLine].filter(Boolean).join("\n");

  const researchCredits =
    `Research & Credits:\n` +
    `${paper.title} — ${paper.authors}${paper.affiliation ? `, ${paper.affiliation}` : ""}\n` +
    `Published: ${paper.date}${paper.journal ? ` | ${paper.journal}` : ""}\n` +
    (linkLines ? `${linkLines}\n` : "");

  const prompt = `Given this YouTube script for the channel "Turns Out" (@TurnsOutSci), generate video metadata.

Script: ${script}
Study: ${paper.title}
Topic: ${topic.label}

Respond ONLY with valid JSON, no markdown, no explanation:
{
  "title": "YouTube video title — punchy, under 60 chars, no clickbait, hint at the finding",
  "summary": "2-3 sentence plain-English summary of the key finding for the video description. Accessible, no jargon.",
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
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const raw = response.content?.[0]?.text || "";
  const clean = raw.replace(/```json|```/g, "").trim();
  const meta = JSON.parse(clean);

  // Assemble description using the mandatory template
  const tagString = (meta.tags || []).map(t => t.startsWith("#") ? t : `#${t}`).join(" ");

  const description =
    `${meta.summary}\n\n` +
    `${researchCredits}\n` +
    `${tagString}\n\n` +
    `New video every week. Subscribe: https://youtube.com/@TurnsOutSci\n\n` +
    `${CONFIG.MUSIC_CREDIT}`;

  const metadata = {
    title: meta.title,
    description,
    tags: meta.tags,
  };

  log(`Title: "${metadata.title}"`, "ok");
  return metadata;
}

// ─── STEP 4: FETCH STOCK FOOTAGE ─────────────────────────────────────────────

async function fetchFootage(topic) {
  assert(KEYS.pexels, "Missing PEXELS_API_KEY");
  log(`Fetching stock footage for: "${topic.pexels}"...`);

  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(topic.pexels)}&per_page=15&orientation=landscape&size=medium`;
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
    .slice(0, 12);

  assert(clips.length, "No footage found");

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

// ─── STEP 6: BUILD BUMPER ────────────────────────────────────────────────────

async function buildBumper() {
  log("Building intro bumper...");

  const bumperPath  = path.join(TMP, "bumper.mp4");
  const logoPath    = path.join(CONFIG.ASSETS_DIR, "logo.png");
  const musicPath   = path.join(CONFIG.ASSETS_DIR, "bumper_music.mp3");
  const duration    = CONFIG.BUMPER_DURATION;

  assert(fs.existsSync(logoPath),  `Missing assets/logo.png — add your logo to the assets/ folder`);
  assert(fs.existsSync(musicPath), `Missing assets/bumper_music.mp3 — add the bumper track to the assets/ folder`);

  // Fade-in 0.5s, hold, fade-out 0.5s on dark navy background
  // Logo centred, scaled to fit within safe area
  execSync(
    `ffmpeg -y \
      -loop 1 -t ${duration} -i "${logoPath}" \
      -i "${musicPath}" \
      -filter_complex "\
        [0:v]scale=640:360:force_original_aspect_ratio=decrease,\
        pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=#0A0E1A,\
        fade=t=in:st=0:d=0.5,\
        fade=t=out:st=${duration - 0.5}:d=0.5[v];\
        [1:a]atrim=0:${duration},afade=t=in:st=0:d=0.5,afade=t=out:st=${duration - 0.5}:d=0.5[a]" \
      -map "[v]" -map "[a]" \
      -c:v libx264 -preset fast -crf 22 \
      -c:a aac -b:a 128k \
      -r 30 -pix_fmt yuv420p \
      -t ${duration} \
      "${bumperPath}" 2>/dev/null`,
    { stdio: "pipe" }
  );

  log(`Bumper built (${duration}s)`, "ok");
  return bumperPath;
}

// ─── STEP 7: ASSEMBLE VIDEO ───────────────────────────────────────────────────

async function assembleVideo(clipPaths, audioPath, title) {
  log("Assembling video with FFmpeg...");

  const mainPath    = path.join(TMP, "main.mp4");
  const outputPath  = path.join(TMP, "final.mp4");
  const concatList  = path.join(TMP, "concat.txt");
  const loopedFootage  = path.join(TMP, "footage_loop.mp4");
  const scaledFootage  = path.join(TMP, "footage_scaled.mp4");
  const bumperConcatList = path.join(TMP, "bumper_concat.txt");

  // Get audio duration
  const audioDuration = parseFloat(
    execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`
    ).toString().trim()
  );
  log(`  Audio duration: ${audioDuration.toFixed(1)}s`);

  // Write concat list — repeat clips to fill audio duration
  let concatContent = "";
  for (const p of clipPaths) {
    concatContent += `file '${p}'\n`;
  }
  const repeats = Math.ceil(audioDuration / (clipPaths.length * 5)) + 1;
  let fullContent = "";
  for (let i = 0; i < repeats; i++) fullContent += concatContent;
  fs.writeFileSync(concatList, fullContent);

  // Concatenate and loop footage
  execSync(
    `ffmpeg -y -f concat -safe 0 -i "${concatList}" -t ${audioDuration + 1} -c copy "${loopedFootage}" 2>/dev/null`,
    { stdio: "pipe" }
  );

  // Scale to 1920x1080
  execSync(
    `ffmpeg -y -i "${loopedFootage}" -vf "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080" -c:v libx264 -preset fast -crf 23 "${scaledFootage}" 2>/dev/null`,
    { stdio: "pipe" }
  );

  // Generate captions with Whisper
  const captionPath = await generateCaptions(audioPath);
  const escapedCaption = captionPath.replace(/\\/g, "/").replace(/:/g, "\\:");

  // Assemble main video (footage + voiceover + captions)
  const ffmpegOutput = execSync(
    `ffmpeg -y \
      -i "${scaledFootage}" \
      -i "${audioPath}" \
      -map 0:v:0 -map 1:a:0 \
      -vf "subtitles='${escapedCaption}':force_style='FontName=Arial,FontSize=16,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H80000000,BorderStyle=4,Outline=1,Shadow=0,Bold=1,Alignment=2,MarginV=35'" \
      -c:v libx264 -preset fast -crf 22 \
      -c:a aac -b:a 128k \
      -shortest \
      "${mainPath}" 2>&1`,
    { stdio: "pipe" }
  ).toString();

  const mainSize = fs.existsSync(mainPath) ? fs.statSync(mainPath).size : 0;
  if (mainSize < 500000) {
    throw new Error(`Main video assembly produced invalid file (${mainSize} bytes). FFmpeg: ${ffmpegOutput.slice(-500)}`);
  }

  // Build bumper
  const bumperPath = await buildBumper();

  // Concatenate bumper + main video
  fs.writeFileSync(
    bumperConcatList,
    `file '${bumperPath}'\nfile '${mainPath}'\n`
  );

  execSync(
    `ffmpeg -y -f concat -safe 0 -i "${bumperConcatList}" -c copy "${outputPath}" 2>/dev/null`,
    { stdio: "pipe" }
  );

  const outputSize = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
  if (outputSize < 500000) {
    throw new Error(`Final video concat produced invalid file (${outputSize} bytes)`);
  }

  const finalDuration = parseFloat(
    execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${outputPath}"`
    ).toString().trim()
  );
  log(`Video assembled — ${Math.round(finalDuration)}s (${(finalDuration/60).toFixed(1)} mins, includes ${CONFIG.BUMPER_DURATION}s bumper)`, "ok");
  return outputPath;
}

async function generateCaptions(audioPath) {
  log("Transcribing audio with Whisper for word-level captions...");
  const srtPath = path.join(TMP, "captions.srt");
  const whisperOut = path.join(TMP, "whisper_out");

  try {
    if (!fs.existsSync(whisperOut)) fs.mkdirSync(whisperOut, { recursive: true });

    const whisperResult = execSync(
      `whisper "${audioPath}" --model small --output_format srt --output_dir "${whisperOut}" --language en 2>&1`,
      { stdio: "pipe", timeout: 300000 }
    ).toString();
    log("Whisper output: " + whisperResult.slice(-200), "info");

    const allFiles = fs.readdirSync(whisperOut);
    log("Whisper output dir contents: " + allFiles.join(", "), "info");

    const srtFile = allFiles.find(f => f.endsWith(".srt"));
    const finalSrtPath = srtFile ? path.join(whisperOut, srtFile) : null;

    if (finalSrtPath && fs.existsSync(finalSrtPath)) {
      const raw = fs.readFileSync(finalSrtPath, "utf8");
      const processed = processWhisperSrt(raw);
      fs.writeFileSync(srtPath, processed);
      log("Whisper captions generated (" + processed.split("\n\n").length + " blocks)", "ok");
    } else {
      throw new Error("No SRT file found in whisper output dir. Files: " + allFiles.join(", "));
    }
  } catch (e) {
    log("Whisper failed (" + e.message.slice(0, 200) + ") — falling back to placeholder captions", "warn");
    const duration = parseFloat(
      execSync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`
      ).toString().trim()
    );
    fs.writeFileSync(
      srtPath,
      `1\n00:00:00,000 --> 00:00:${Math.floor(duration)},000\n[Captions unavailable]\n`
    );
  }

  return srtPath;
}

function processWhisperSrt(raw) {
  const blocks = raw.trim().split(/\n\n+/);
  const output = [];
  let idx = 1;

  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.length < 3) continue;

    const timeLine = lines[1];
    const text = lines.slice(2).join(" ").trim();
    const words = text.split(" ").filter(Boolean);

    if (words.length <= 8) {
      output.push(`${idx}\n${timeLine}\n${text}`);
      idx++;
    } else {
      const timeMatch = timeLine.match(/(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})/);
      if (!timeMatch) continue;

      const startMs = srtTimeToMs(timeMatch[1]);
      const endMs = srtTimeToMs(timeMatch[2]);
      const chunkSize = 7;
      const chunks = [];

      for (let i = 0; i < words.length; i += chunkSize) {
        chunks.push(words.slice(i, i + chunkSize).join(" "));
      }

      const msDuration = (endMs - startMs) / chunks.length;
      for (let i = 0; i < chunks.length; i++) {
        const cStart = msToSrtTime(startMs + i * msDuration);
        const cEnd = msToSrtTime(startMs + (i + 1) * msDuration);
        output.push(`${idx}\n${cStart} --> ${cEnd}\n${chunks[i]}`);
        idx++;
      }
    }
  }

  return output.join("\n\n") + "\n";
}

function srtTimeToMs(t) {
  const [h, m, rest] = t.split(":");
  const [s, ms] = rest.split(",");
  return (+h * 3600 + +m * 60 + +s) * 1000 + +ms;
}

function msToSrtTime(ms) {
  const h = Math.floor(ms / 3600000).toString().padStart(2, "0");
  const m = Math.floor((ms % 3600000) / 60000).toString().padStart(2, "0");
  const s = Math.floor((ms % 60000) / 1000).toString().padStart(2, "0");
  const f = Math.floor(ms % 1000).toString().padStart(3, "0");
  return `${h}:${m}:${s},${f}`;
}

// ─── STEP 8: GENERATE THUMBNAIL ───────────────────────────────────────────────

async function generateThumbnail(videoPath, metadata, topic) {
  log("Generating thumbnail from video frame...");

  const thumbPath = path.join(TMP, "thumbnail.jpg");

  const duration = parseFloat(
    execSync(
      `ffprobe -v error -show_entries format=duration \
       -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`
    ).toString().trim()
  );

  const seekTo = (duration * 0.20).toFixed(2);
  const rawFrame = path.join(TMP, "raw_frame.jpg");
  execSync(
    `ffmpeg -y -ss ${seekTo} -i "${videoPath}" -vframes 1 -q:v 2 "${rawFrame}" 2>/dev/null`,
    { stdio: "pipe" }
  );

  const darkenedFrame = path.join(TMP, "darkened_frame.jpg");
  execSync(
    `ffmpeg -y -i "${rawFrame}" \
     -vf "eq=brightness=-0.28:contrast=0.88,colorchannelmixer=rr=0.92:gg=0.86:bb=0.78" \
     "${darkenedFrame}" 2>/dev/null`,
    { stdio: "pipe" }
  );

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

  const font = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

  let vf = [
    `drawbox=x=0:y=480:w=iw:h=240:color=#1A1610@0.72:t=fill`,
    `drawbox=x=30:y=30:w=230:h=40:color=#C17B2F@1.0:t=fill`,
    `drawtext=fontfile='${font}':text='${topicLabel}':fontsize=18:fontcolor=#1A1610:x=42:y=41`,
    `drawtext=fontfile='${font}':text='TURNS OUT':fontsize=15:fontcolor=#8A7F6B:x=w-tw-30:y=42`,
    `drawtext=fontfile='${font}':text='${line1}':fontsize=54:fontcolor=#F5EDD8:x=30:y=492:shadowcolor=black@0.8:shadowx=2:shadowy=2`,
  ];

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

// ─── STEP 9: UPLOAD TO YOUTUBE ────────────────────────────────────────────────

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
          categoryId: "28",
          defaultLanguage: "en",
        },
        status: {
          privacyStatus: "private",
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
    log(`Thumbnail upload returned ${response.status} — continuing`, "warn");
  }
}

// ─── REFRESH YOUTUBE TOKEN ────────────────────────────────────────────────────

async function refreshYouTubeToken() {
  log('Refreshing YouTube OAuth token...');
  assert(KEYS.ytRefreshToken, 'Missing YT_REFRESH_TOKEN');
  assert(KEYS.ytClientId,     'Missing YT_CLIENT_ID');
  assert(KEYS.ytClientSecret, 'Missing YT_CLIENT_SECRET');

  const body = new URLSearchParams({
    client_id:     KEYS.ytClientId,
    client_secret: KEYS.ytClientSecret,
    refresh_token: KEYS.ytRefreshToken,
    grant_type:    'refresh_token',
  }).toString();

  const response = await fetchJSON('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
    body,
  });

  if (!response.access_token) {
    throw new Error('Token refresh failed: ' + JSON.stringify(response));
  }

  KEYS.youtube = response.access_token;
  log('YouTube token refreshed (expires in ' + response.expires_in + 's)', 'ok');
}

// ─── CLEANUP ──────────────────────────────────────────────────────────────────

function cleanup() {
  log("Cleaning up temp files...");
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n╔════════════════════════════════════════╗");
  console.log("║     Turns Out — Pipeline v2.0          ║");
  console.log("║     @TurnsOutSci                       ║");
  console.log(`║     ${new Date().toISOString().slice(0, 10)}                       ║`);
  console.log("╚════════════════════════════════════════╝\n");

  const missing = Object.entries(KEYS).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    log(`Missing API keys: ${missing.join(", ")}`, "err");
    log("Set them as environment variables or GitHub Secrets.", "warn");
    process.exit(1);
  }

  try {
    await refreshYouTubeToken();
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

    const runLog = {
      timestamp: new Date().toISOString(),
      topic: topic.label,
      paper: {
        pmid:    paper.pmid,
        title:   paper.title,
        authors: paper.authors,
        journal: paper.journal,
        date:    paper.date,
        doi:     paper.doi,
        url:     paper.url,
      },
      videoId,
      title:     metadata.title,
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
