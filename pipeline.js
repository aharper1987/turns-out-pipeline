#!/usr/bin/env node
/**
 * Turns Out — Automated YouTube Pipeline
 * Channel: @TurnsOutSci | UCugairkMHQVneS7C5SbIP0g
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
  ELEVENLABS_VOICE_ID: "ptBd2v6mebIps3ZQEXD7",
  VIDEO_DURATION_TARGET: 600,
  BUMPER_DURATION: 3,
  ASSETS_DIR: path.join(__dirname, "assets"),
  MUSIC_CREDIT: `Music: "Upbeat Inspiring Corporate" by Pro Tunes - Copyright Safe Music | https://freemusicarchive.org/music/pro-tunes/single/upbeat-inspiring-corporate-1/`,
  TOPICS: [
    { label: "Cancer research",    query: "cancer+therapy+clinical+trial",        pexels: "laboratory science" },
    { label: "Brain & dementia",   query: "dementia+alzheimer+cognitive+decline", pexels: "brain neuroscience" },
    { label: "Fitness & health",   query: "exercise+health+fitness+metabolism",   pexels: "exercise fitness" },
    { label: "Child psychology",   query: "child+psychology+development+behavior",pexels: "children learning" },
    { label: "Food science",       query: "nutrition+diet+food+health+outcomes",  pexels: "healthy food" },
    { label: "Longevity & aging",  query: "longevity+aging+lifespan+senescence",  pexels: "aging health" },
    { label: "Sleep science",        query: "sleep+health+cognition+outcomes+circadian",     pexels: "sleep rest night" },
    { label: "Mental health",        query: "depression+anxiety+treatment+intervention+brain", pexels: "mental health therapy" },
    { label: "Human behavior",       query: "behavior+psychology+decision+social+cognition",  pexels: "people behavior social" },
    { label: "Animal cognition",     query: "animal+cognition+intelligence+behavior+learning", pexels: "animals wildlife nature" },
    { label: "Space & cosmology",    query: "cosmology+exoplanet+galaxy+universe+astronomy",  pexels: "space stars galaxy" },
    { label: "Psychedelics",         query: "psilocybin+psychedelic+ketamine+therapy+neural", pexels: "neuroscience brain research" },
    { label: "Gut microbiome",       query: "microbiome+gut+bacteria+health+brain+axis",      pexels: "gut health digestion" },
  ],
};

const KEYS = {
  anthropic:      process.env.ANTHROPIC_API_KEY,
  elevenlabs:     process.env.ELEVENLABS_API_KEY,
  pexels:         process.env.PEXELS_API_KEY,
  youtube:        process.env.YT_TOKEN,
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
  if (!available.length) throw new Error("All topics exhausted");
  return available[Math.floor(Math.random() * available.length)];
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
      log('PubMed failed for "' + topic.label + '": ' + e.message, "warn");
      log("Falling back to Semantic Scholar...", "info");
      try {
        const paper = await fetchPaperSemanticScholar(topic);
        return { paper, topic };
      } catch (e2) {
        log('Semantic Scholar also failed for "' + topic.label + '": ' + e2.message, "warn");
        log("Trying next topic...", "info");
      }
    }
  }
  throw new Error("All topics exhausted across PubMed and Semantic Scholar");
}

function schedulePublishTime() {
  const d = new Date();
  // Schedule for tomorrow at 11:00 UTC (7AM ET)
  d.setDate(d.getDate() + 1);
  d.setUTCHours(11, 0, 0, 0);
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
  const summary = await fetchJSON(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${id}&retmode=json`
  );
  const paper = summary.result?.[id];
  if (!paper) throw new Error("Could not fetch paper summary");
  const abstract = await new Promise((resolve) => {
    https.get(
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${id}&rettype=abstract&retmode=text`,
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(d.trim()));
      }
    );
  });
  const allAuthors = (paper.authors || []).map((a) => a.name);
  const displayAuthors = allAuthors.slice(0, 3).join(", ") + (allAuthors.length > 3 ? " et al." : "");
  const result = {
    pmid: id,
    title: paper.title || "",
    authors: displayAuthors,
    allAuthors,
    affiliation: paper.affiliations?.[0] || "",
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
  log("Fetching from Semantic Scholar for: " + topic.label);
  const query = encodeURIComponent(topic.query.replace(/\+/g, " "));
  const url =
    "https://api.semanticscholar.org/graph/v1/paper/search" +
    "?query=" + query +
    "&fields=title,abstract,authors,year,citationCount,influentialCitationCount,externalIds,publicationDate,journal" +
    "&limit=10&publicationDateOrYear=2023-2026";
  const data = await fetchJSON(url, { headers: { "User-Agent": "TurnsOutPipeline/1.0" } });
  const papers = (data.data || [])
    .filter((p) => p.abstract && p.title)
    .sort((a, b) => (b.influentialCitationCount || 0) - (a.influentialCitationCount || 0));
  if (!papers.length) throw new Error("No papers found on Semantic Scholar");
  const paper = papers.slice(0, 5)[Math.floor(Math.random() * Math.min(papers.length, 5))];
  const doi = paper.externalIds?.DOI || "";
  const pmid = paper.externalIds?.PubMed || "";
  const allAuthors = (paper.authors || []).map((a) => a.name);
  const displayAuthors = allAuthors.slice(0, 3).join(", ") + (allAuthors.length > 3 ? " et al." : "");
  const result = {
    pmid: pmid || paper.paperId,
    title: paper.title || "",
    authors: displayAuthors,
    allAuthors,
    affiliation: "",
    journal: paper.journal?.name || "",
    date: paper.publicationDate || String(paper.year || ""),
    abstract: (paper.abstract || "").slice(0, 2000),
    url: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : doi ? `https://doi.org/${doi}` : `https://www.semanticscholar.org/paper/${paper.paperId}`,
    doi,
    citationCount: paper.citationCount || 0,
    influentialCitations: paper.influentialCitationCount || 0,
    source: "Semantic Scholar",
  };
  log('Found (S2, ' + result.influentialCitations + ' influential citations): "' + result.title.slice(0, 70) + '..."', "ok");
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

1. COLD OPEN (100 words): Start mid-story with the most surprising or counterintuitive implication of this research. No "hey guys" intros. No "Did you know." End with a question that makes them need to keep watching.

2. INTRO & CONTEXT (150 words): Zoom out. Why has this topic been studied? What did we think we knew before this study?

3. THE RESEARCHERS (100 words): Introduce who did this work. Name the lead researchers, their institutions, when and where published. Make it feel human.

4. THE STUDY EXPLAINED (200 words): Break down what researchers did. Who were the subjects? What was the methodology? Use one concrete real-world analogy.

5. THE FINDINGS (250 words): What did they find? Go result by result in plain English. Use analogies and scale to make numbers feel real. Be honest about effect sizes.

6. WHAT THIS MEANS (200 words): Connect findings to everyday life. Be practical. Address skepticism and limitations honestly.

7. THE BIGGER PICTURE (200 words): Where does this fit in the wider field? What questions does it raise? What research should come next?

8. SIGN-OFF (100 words): Recap the single most mind-blowing takeaway. Raise one final provocative question. End with: "Turns out, scientists have been busy. And they're not done yet."

Write ONLY the script — no stage directions, no section labels, no markdown. Just the words to be spoken. Target 1,400 words.`;
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
  log(`Script generated (${wordCount} words / ~${Math.round(wordCount / 140)} mins)`, "ok");
  return script;
}

// ─── STEP 3: GENERATE VIDEO METADATA ─────────────────────────────────────────

async function generateMetadata(paper, script, topic) {
  assert(KEYS.anthropic, "Missing ANTHROPIC_API_KEY");
  log("Generating video title, description, and tags...");
  const doiLine  = paper.doi ? `DOI: https://doi.org/${paper.doi}` : "";
  const pmidLine = paper.pmid && /^\d+$/.test(paper.pmid) ? `PubMed: https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/` : "";
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
"title": "YouTube video title — max 60 chars, no clickbait. Use one of these proven formats: (1) Revelation: 'Turns Out [Common Belief] Is Wrong' — only when research genuinely overturns something. (2) Surprise finding: 'Scientists Just Discovered [Topic] Works Differently' (3) Curiosity gap: 'Why [Familiar Thing] Actually [Surprising Outcome]' (4) Specific + shocking stat: lead with the most counterintuitive number or finding. Capitalize ONE word for emphasis max. No exclamation marks. No 'You Won't Believe'. Front-load the most compelling word.",
  "summary": "2-3 sentence plain-English summary of the key finding. Accessible, no jargon.",
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
  const tagString = (meta.tags || []).map((t) => (t.startsWith("#") ? t : `#${t}`)).join(" ");
  const description =
    `${meta.summary}\n\n` +
    `${researchCredits}\n` +
    `${tagString}\n\n` +
    `New video every week. Subscribe: https://youtube.com/@TurnsOutSci\n\n` +
    `${CONFIG.MUSIC_CREDIT}`;
  const metadata = { title: meta.title, description, tags: meta.tags };
  log(`Title: "${metadata.title}"`, "ok");
  return metadata;
}

// ─── STEP 3B: GENERATE FOOTAGE SEARCH TERMS ──────────────────────────────────

async function generateFootageSearchTerms(paper, topic) {
  assert(KEYS.anthropic, "Missing ANTHROPIC_API_KEY");
  log("Generating footage search terms...");

  const prompt = `Given this science paper, generate 4 specific visual search terms for stock footage.

Paper title: ${paper.title}
Topic: ${topic.label}

Rules:
- Each term 2-3 words max
- Visually concrete and filmable
- Mix close-up scientific visuals with broader human/lifestyle scenes
- Varied — don't repeat the same visual theme
- Avoid generic terms like "science laboratory" every time

Respond ONLY with a JSON array of exactly 4 strings, no markdown:
["term one", "term two", "term three", "term four"]`;

  const response = await fetchJSON("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": KEYS.anthropic,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 100,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  try {
    const raw = response.content?.[0]?.text || "";
    const clean = raw.replace(/```json|```/g, "").trim();
    const terms = JSON.parse(clean);
    if (Array.isArray(terms) && terms.length > 0) {
      log(`Footage search terms: ${terms.join(", ")}`, "ok");
      return terms;
    }
  } catch (e) {
    log("Failed to parse footage terms — falling back to topic default", "warn");
  }
  return [topic.pexels];
}

// ─── STEP 4: FETCH STOCK FOOTAGE ─────────────────────────────────────────────

async function fetchFootage(topic, paper) {
  assert(KEYS.pexels, "Missing PEXELS_API_KEY");

  const searchTerms = await generateFootageSearchTerms(paper, topic);
  const clipsPerTerm = Math.ceil(12 / searchTerms.length);
  const allClips = [];

  for (const term of searchTerms) {
    log(`  Searching footage: "${term}"...`);
    try {
      const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(term)}&per_page=${clipsPerTerm + 2}&orientation=landscape&size=medium`;
      const data = await fetchJSON(url, { headers: { Authorization: KEYS.pexels } });
      const clips = (data.videos || [])
        .map((v) => {
          const file =
            v.video_files?.find((f) => f.quality === "sd" && f.width >= 1280) ||
            v.video_files?.find((f) => f.quality === "sd") ||
            v.video_files?.[0];
          return file?.link;
        })
        .filter(Boolean)
        .slice(0, clipsPerTerm);
      allClips.push(...clips);
    } catch (e) {
      log(`  Search failed for "${term}" — skipping`, "warn");
    }
  }

  if (!allClips.length) {
    log("All searches failed — falling back to topic default", "warn");
    const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(topic.pexels)}&per_page=12&orientation=landscape&size=medium`;
    const data = await fetchJSON(url, { headers: { Authorization: KEYS.pexels } });
    allClips.push(...(data.videos || []).map((v) => v.video_files?.[0]?.link).filter(Boolean));
  }

  assert(allClips.length, "No footage found");

  const paths = [];
  const toDownload = allClips.slice(0, 12);
  for (let i = 0; i < toDownload.length; i++) {
    const dest = path.join(TMP, `clip_${i}.mp4`);
    log(`  Downloading clip ${i + 1}/${toDownload.length}...`);
    await fetchBinary(toDownload[i], dest);
    paths.push(dest);
  }

  log(`Downloaded ${paths.length} clips across ${searchTerms.length} search terms`, "ok");
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
    const req = https.request(url, {
      method: "POST",
      headers: {
        "xi-api-key": KEYS.elevenlabs,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      assert(res.statusCode === 200, `ElevenLabs error: ${res.statusCode}`);
      const file = fs.createWriteStream(audioPath);
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
      file.on("error", reject);
    });
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
  const bumperPath = path.join(TMP, "bumper.mp4");
  const logoPath   = path.join(CONFIG.ASSETS_DIR, "logo.png");
  const musicPath  = path.join(CONFIG.ASSETS_DIR, "bumper_music.mp3");
  const duration   = CONFIG.BUMPER_DURATION;
  assert(fs.existsSync(logoPath),  "Missing assets/logo.png");
  assert(fs.existsSync(musicPath), "Missing assets/bumper_music.mp3");
  const fadeOut = duration - 0.5;
  const filterComplex =
    `[0:v]scale=640:360:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=#0A0E1A,` +
    `fade=t=in:st=0:d=0.5,fade=t=out:st=${fadeOut}:d=0.5[v];` +
    `[1:a]atrim=0:${duration},afade=t=in:st=0:d=0.5,afade=t=out:st=${fadeOut}:d=0.5[a]`;
  execSync(
    `ffmpeg -y -loop 1 -t ${duration} -i "${logoPath}" -i "${musicPath}" ` +
    `-filter_complex "${filterComplex}" -map "[v]" -map "[a]" ` +
    `-c:v libx264 -preset fast -crf 22 -c:a aac -b:a 128k -r 30 -pix_fmt yuv420p -t ${duration} "${bumperPath}"`,
    { stdio: "pipe" }
  );
  log(`Bumper built (${duration}s)`, "ok");
  return bumperPath;
}

// ─── STEP 7: ASSEMBLE VIDEO ───────────────────────────────────────────────────

async function assembleVideo(clipPaths, audioPath, title) {
  log("Assembling video with FFmpeg...");
  const mainPath         = path.join(TMP, "main.mp4");
  const outputPath       = path.join(TMP, "final.mp4");
  const concatList       = path.join(TMP, "concat.txt");
  const loopedFootage    = path.join(TMP, "footage_loop.mp4");
  const scaledFootage    = path.join(TMP, "footage_scaled.mp4");
  const bumperConcatList = path.join(TMP, "bumper_concat.txt");
  const audioDuration = parseFloat(
    execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`
    ).toString().trim()
  );
  log(`  Audio duration: ${audioDuration.toFixed(1)}s`);

  // Normalize each clip individually to consistent codec/fps/resolution
  // This is fast per-clip and allows instant -c copy concat afterward
  const normalizedPaths = [];
  for (let i = 0; i < clipPaths.length; i++) {
    const normPath = path.join(TMP, `norm_${i}.mp4`);
    execSync(
      `ffmpeg -y -i "${clipPaths[i]}" -vf "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=30" -c:v libx264 -preset ultrafast -crf 23 -an "${normPath}" 2>/dev/null`,
      { stdio: "pipe" }
    );
    normalizedPaths.push(normPath);
  }
  log(`  Normalized ${normalizedPaths.length} clips`);

  // Build concat list — repeat normalized clips to cover full audio duration
  let concatContent = "";
  for (const p of normalizedPaths) concatContent += `file '${p}'\n`;
  const repeats = Math.ceil(audioDuration / (normalizedPaths.length * 4)) + 2;
  let fullContent = "";
  for (let i = 0; i < repeats; i++) fullContent += concatContent;
  fs.writeFileSync(concatList, fullContent);

  // Concat with -c copy (instant) then trim to exact audio duration
  execSync(
    `ffmpeg -y -f concat -safe 0 -i "${concatList}" -t ${audioDuration} -c copy "${scaledFootage}" 2>/dev/null`,
    { stdio: "pipe" }
  );
  const ffmpegOutput = execSync(
    `ffmpeg -y \
      -i "${scaledFootage}" \
      -i "${audioPath}" \
      -map 0:v:0 -map 1:a:0 \
      -c:v libx264 -preset fast -crf 22 \
      -c:a aac -b:a 128k \
      -t ${audioDuration} \
      -shortest \
      "${mainPath}" 2>&1`,
    { stdio: "pipe" }
  ).toString();
  const mainSize = fs.existsSync(mainPath) ? fs.statSync(mainPath).size : 0;
  if (mainSize < 500000) {
    throw new Error(`Main video assembly failed (${mainSize} bytes). FFmpeg: ${ffmpegOutput.slice(-500)}`);
  }
  const bumperPath = await buildBumper();
  fs.writeFileSync(bumperConcatList, `file '${bumperPath}'\nfile '${mainPath}'\n`);
  const totalDuration = CONFIG.BUMPER_DURATION + audioDuration;
  execSync(
    `ffmpeg -y -f concat -safe 0 -i "${bumperConcatList}" -c:v libx264 -preset ultrafast -crf 23 -c:a aac -b:a 128k "${outputPath}" 2>/dev/null`,
    { stdio: "pipe" }
  );
  const outputSize = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
  if (outputSize < 500000) {
    throw new Error(`Final concat failed (${outputSize} bytes)`);
  }

  // Hard trim — guarantee final video never exceeds 12 minutes regardless of assembly drift
  const MAX_DURATION = 720; // 12 minutes
  const finalDuration = parseFloat(
    execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${outputPath}"`
    ).toString().trim()
  );

  if (finalDuration > MAX_DURATION) {
    log(`Video is ${Math.round(finalDuration)}s — trimming to ${MAX_DURATION}s...`, "warn");
    const trimmedPath = path.join(TMP, "final_trimmed.mp4");
    execSync(
      `ffmpeg -y -i "${outputPath}" -t ${MAX_DURATION} -c copy "${trimmedPath}" 2>/dev/null`,
      { stdio: "pipe" }
    );
    fs.renameSync(trimmedPath, outputPath);
    log(`Trimmed to ${MAX_DURATION}s`, "ok");
  }

  const checkedDuration = finalDuration > MAX_DURATION ? MAX_DURATION : finalDuration;
  log(`Video assembled — ${Math.round(checkedDuration)}s (${(checkedDuration / 60).toFixed(1)} mins, includes ${CONFIG.BUMPER_DURATION}s bumper)`, "ok");
  return outputPath;
}

// ─── STEP 8: GENERATE THUMBNAIL ───────────────────────────────────────────────

async function generateThumbnail(videoPath, metadata, topic) {
  log("Generating thumbnail from video frame...");
  const thumbPath = path.join(TMP, "thumbnail.jpg");
  const duration = parseFloat(
    execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`
    ).toString().trim()
  );
  const seekTo = (duration * 0.20).toFixed(2);
  const rawFrame = path.join(TMP, "raw_frame.jpg");
  execSync(`ffmpeg -y -ss ${seekTo} -i "${videoPath}" -vframes 1 -q:v 2 "${rawFrame}" 2>/dev/null`, { stdio: "pipe" });
  const darkenedFrame = path.join(TMP, "darkened_frame.jpg");
  execSync(
    `ffmpeg -y -i "${rawFrame}" -vf "eq=brightness=-0.28:contrast=0.88,colorchannelmixer=rr=0.92:gg=0.86:bb=0.78" "${darkenedFrame}" 2>/dev/null`,
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
    vf.push(`drawtext=fontfile='${font}':text='${line2}':fontsize=54:fontcolor=#F5EDD8:x=30:y=556:shadowcolor=black@0.8:shadowx=2:shadowy=2`);
  }
  execSync(`ffmpeg -y -i "${darkenedFrame}" -vf "${vf.join(",")}" -q:v 2 "${thumbPath}" 2>/dev/null`, { stdio: "pipe" });
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
  } else if (response.status === 403) {
    log("Thumbnail 403 — add 'youtube.force-ssl' scope to your OAuth token and regenerate it", "warn");
  } else {
    log(`Thumbnail upload returned ${response.status} — continuing`, "warn");
  }
}

// ─── REFRESH YOUTUBE TOKEN ────────────────────────────────────────────────────

async function refreshYouTubeToken() {
  log("Refreshing YouTube OAuth token...");
  assert(KEYS.ytRefreshToken, "Missing YT_REFRESH_TOKEN");
  assert(KEYS.ytClientId,     "Missing YT_CLIENT_ID");
  assert(KEYS.ytClientSecret, "Missing YT_CLIENT_SECRET");
  const body = new URLSearchParams({
    client_id:     KEYS.ytClientId,
    client_secret: KEYS.ytClientSecret,
    refresh_token: KEYS.ytRefreshToken,
    grant_type:    "refresh_token",
  }).toString();
  const response = await fetchJSON("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body),
    },
    body,
  });
  if (!response.access_token) {
    throw new Error("Token refresh failed: " + JSON.stringify(response));
  }
  KEYS.youtube = response.access_token;
  log("YouTube token refreshed (expires in " + response.expires_in + "s)", "ok");
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
    log("Topic selected: " + topic.label);
    const script    = await generateScript(paper, topic);
    const metadata  = await generateMetadata(paper, script, topic);
    const clips     = await fetchFootage(topic, paper);
    const audio     = await generateVoiceover(script);
    const video     = await assembleVideo(clips, audio, metadata.title);
    const thumb     = await generateThumbnail(video, metadata, topic);
    const publishAt = schedulePublishTime();
    const videoId   = await uploadToYouTube(video, metadata, publishAt);
    await uploadThumbnail(videoId, thumb);

    const runLog = {
      timestamp: new Date().toISOString(),
      topic: topic.label,
      paper: { pmid: paper.pmid, title: paper.title, authors: paper.authors, journal: paper.journal, date: paper.date, doi: paper.doi, url: paper.url },
      videoId,
      title: metadata.title,
      publishAt,
      wordCount: script.split(" ").length,
    };
    fs.writeFileSync(path.join(__dirname, `run_log_${Date.now()}.json`), JSON.stringify(runLog, null, 2));

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
