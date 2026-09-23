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

// ─── DRY RUN ─────────────────────────────────────────────────────────────────
// `npm test` (package.json) runs `node pipeline.js --dry-run`. Previously this
// flag was never read anywhere in this file, so "the test command" silently
// ran the ENTIRE real pipeline: real Haiku calls, a real ElevenLabs voiceover,
// a real YouTube upload (privacy: private, but still a real upload against
// your quota and a real video sitting in your channel), and then deleted all
// the local output in cleanup() before you could look at it. That's the
// opposite of what a dry run is for. Fixed below: DRY_RUN now actually skips
// every YouTube-touching call and skips cleanup so you can inspect output.
const DRY_RUN = process.argv.includes("--dry-run") || process.env.DRY_RUN === "true";

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
    { label: "Cancer research",        query: "cancer+therapy+clinical+trial",              pexels: "laboratory science",    source: "pubmed" },
    { label: "Brain & dementia",       query: "dementia+alzheimer+cognitive+decline",       pexels: "brain neuroscience",    source: "pubmed" },
    { label: "Fitness & health",       query: "exercise+health+fitness+metabolism",         pexels: "exercise fitness",      source: "pubmed" },
    { label: "Child psychology",       query: "child+psychology+development+behavior",      pexels: "children learning",     source: "pubmed" },
    { label: "Food science",           query: "nutrition+diet+food+health+outcomes",        pexels: "healthy food",          source: "pubmed" },
    { label: "Longevity & aging",      query: "longevity+aging+lifespan+senescence",        pexels: "aging health",          source: "pubmed" },
    { label: "Behavioral economics",   query: "behavioral+economics+decision+bias",         pexels: "business decision",     source: "semantic" },
    { label: "AI & machine learning",  query: "artificial+intelligence+machine+learning",   pexels: "computer technology",   source: "arxiv" },
    { label: "Education science",      query: "learning+cognition+education+memory",        pexels: "classroom learning",    source: "semantic" },
    { label: "Climate & environment",  query: "climate+change+environment+health+impact",   pexels: "nature environment",    source: "pubmed" },
    { label: "Sleep science",          query: "sleep+circadian+rest+cognitive+performance", pexels: "sleeping person",       source: "pubmed" },
    { label: "Mental health",          query: "anxiety+depression+mental+health+treatment", pexels: "mental wellness",       source: "pubmed" },
  ],
  PLAYLIST_IDS: null,
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

// ─── TOPIC COOLDOWN + TITLE ANTI-REPEAT ──────────────────────────────────────
//
// The pipeline has zero state persisted between runs (nothing is committed
// back to the repo), so pickTopic() previously chose uniformly at random
// every single day with no memory of what ran yesterday. That's how two
// back-to-back uploads (Sept 16 + 17) both ended up covering "detect memory
// decline/loss before you notice" — pure chance, not a malfunction, but bad
// for anyone watching two days in a row.
//
// Fix: read history back from YouTube itself instead of committing new
// state. Every upload gets an invisible `topic:<slug>` tag (added at the
// bottom of generateMetadata) — a normal video tag, never shown to viewers.
// Next run, fetchRecentUploadHistory() pulls the last few uploads' tags via
// the channel's uploads playlist (cheap, ~3 quota units total) to find which
// topics were just used, and pulls their raw titles too so the metadata
// prompt can see — and explicitly avoid repeating — recent phrasing.

const TOPIC_COOLDOWN_UPLOADS = 4; // don't repeat a topic within this many uploads

const TITLE_FORMULAS = [
  "a direct, confident claim stated as fact (no question mark)",
  "a question the video goes on to answer",
  "a surprising number or statistic leading the sentence",
  "a \"why\" framing (e.g. \"Why X Does Y\")",
  "a second-person 'you/your' framing that speaks directly to the viewer",
  "a reversal of a common belief (e.g. \"X Isn't Y — Here's Why\")",
];

// Deterministic, not left up to the model's mood — guarantees consecutive
// days can't land on the same title shape even when the underlying research
// is similar. offset shifts the long-form title and Short title formulas
// apart from each other on the same day.
function dayFormula(offset = 0) {
  const dayOfYear = Math.floor(
    (Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000
  );
  return TITLE_FORMULAS[(dayOfYear + offset + TITLE_FORMULAS.length) % TITLE_FORMULAS.length];
}

function topicSlug(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function fetchRecentUploadHistory(maxResults = TOPIC_COOLDOWN_UPLOADS) {
  if (!KEYS.youtube) return { recentTopicIndices: [], recentTitles: [] };
  try {
    const channelData = await fetchJSON(
      `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${CONFIG.CHANNEL_ID}`,
      { headers: { Authorization: `Bearer ${KEYS.youtube}` } }
    );
    const uploadsPlaylistId = channelData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylistId) return { recentTopicIndices: [], recentTitles: [] };

    const items = await fetchJSON(
      `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=${maxResults}`,
      { headers: { Authorization: `Bearer ${KEYS.youtube}` } }
    );
    const videoIds = (items.items || []).map((i) => i.snippet?.resourceId?.videoId).filter(Boolean);
    const recentTitles = (items.items || []).map((i) => i.snippet?.title).filter(Boolean);
    if (!videoIds.length) return { recentTopicIndices: [], recentTitles };

    const videosData = await fetchJSON(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoIds.join(",")}`,
      { headers: { Authorization: `Bearer ${KEYS.youtube}` } }
    );
    const usedSlugs = new Set();
    for (const v of videosData.items || []) {
      for (const tag of v.snippet?.tags || []) {
        const m = /^topic:(.+)$/.exec(tag);
        if (m) usedSlugs.add(m[1]);
      }
    }
    const recentTopicIndices = CONFIG.TOPICS
      .map((t, i) => ({ i, slug: topicSlug(t.label) }))
      .filter(({ slug }) => usedSlugs.has(slug))
      .map(({ i }) => i)
      .slice(0, CONFIG.TOPICS.length - 3); // always leave at least 3 topics free so fetchPaperWithRetry can never run dry

    log(`Recent upload history: ${recentTopicIndices.length} topic(s) on cooldown, ${recentTitles.length} recent title(s) loaded`, "ok");
    return { recentTopicIndices, recentTitles };
  } catch (e) {
    log(`Could not fetch recent upload history (non-fatal — topic cooldown/anti-repeat skipped this run): ${e.message}`, "warn");
    return { recentTopicIndices: [], recentTitles: [] };
  }
}

// ─── TEXT WRAPPING + SAFE FFMPEG DRAWTEXT ────────────────────────────────────
//
// Root cause of the clipped/garbled Shorts title text: two separate bugs.
//
// Bug 1 — character stripping instead of escaping. `safeTitle.replace(/['"\\:]/g, " ")`
// replaces every apostrophe with a SPACE, so "Doctor's" becomes "Doctor s" and
// "Memory's" becomes "Memory s" — that's the exact garbled pattern seen on the
// live channel. Fixed by writing each line to a small text file and using
// ffmpeg's `textfile=` option instead of inline `text='...'` — ffmpeg reads the
// file's raw bytes, so apostrophes/colons/quotes render correctly with no
// escaping gymnastics needed at all.
//
// Bug 2 — unbounded overflow line. The old wrap loop capped line1 and line2 at
// a max character count, but any words left over after that were dumped into
// a final line with NO cap at all. When a title/shortTitle ran even a little
// over budget (which LLM outputs do constantly despite length instructions),
// that overflow line rendered wider than the canvas and got cut off on both
// edges once centered — exactly what showed up as clipped mid-word text.
// wrapTextLines() below caps EVERY line and truncates with an ellipsis if the
// text still doesn't fit within maxLines, instead of ever overflowing.

function wrapTextLines(text, maxCharsPerLine, maxLines) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  let i = 0;

  while (i < words.length) {
    const word = words[i];
    const trial = current ? `${current} ${word}` : word;
    if (trial.length <= maxCharsPerLine) {
      current = trial;
      i++;
      continue;
    }
    // Word doesn't fit on the current line. If we're already ON the last
    // available line, stop here instead of starting a line we can't finish —
    // the leftover words get picked up by the ellipsis-truncation step below.
    // (Bug fixed here: this used to break as soon as the FIRST word of the
    // final line was placed, so a line like "Blaming" got truncated to
    // "Blaming…" even though "Blaming Wrong" would have fit easily — it
    // never got the chance to keep filling. Now the last line keeps
    // accepting words exactly like every other line, right up to the point
    // one genuinely doesn't fit.)
    if (lines.length >= maxLines - 1) break;
    if (current) lines.push(current);
    current = word.length <= maxCharsPerLine
      ? word
      : word.slice(0, maxCharsPerLine - 1) + "…"; // single word longer than a whole line
    i++;
  }
  if (current && lines.length < maxLines) lines.push(current);

  // If words remain unplaced because we hit maxLines, mark the last line
  // truncated rather than silently dropping content or overflowing.
  const placedWordCount = lines.join(" ").split(/\s+/).length;
  if (placedWordCount < words.length && lines.length) {
    const last = lines[lines.length - 1];
    const trimmed = last.length > maxCharsPerLine - 1
      ? last.slice(0, maxCharsPerLine - 1)
      : last;
    lines[lines.length - 1] = trimmed.replace(/[.,;:\s]+$/, "") + "…";
  }

  return lines;
}

let _textFileCounter = 0;
function writeDrawtextFile(text) {
  const filePath = path.join(TMP, `drawtext_${Date.now()}_${_textFileCounter++}.txt`);
  fs.writeFileSync(filePath, text, "utf8");
  // Only the FILE PATH goes inside the ffmpeg filter string, and paths on the
  // Linux runner never contain the characters that break filter parsing
  // (':' , "'"), so no escaping is needed here — that's the whole point of
  // using textfile= instead of text=.
  return filePath;
}

function drawtextLine(font, filePath, opts) {
  const { fontsize, fontcolor, x, y, shadow } = opts;
  let f = `drawtext=fontfile='${font}':textfile='${filePath}':fontsize=${fontsize}:fontcolor=${fontcolor}:x=${x}:y=${y}`;
  if (shadow) f += `:shadowcolor=black@0.8:shadowx=2:shadowy=2`;
  return f;
}

async function fetchPaperWithRetry(coolDownIndices = []) {
  const tried = [...coolDownIndices]; // start the exclude-list with recently-used topics
  for (let attempt = 0; attempt < CONFIG.TOPICS.length; attempt++) {
    const { topic, index } = pickTopic(tried);
    tried.push(index);
    const preferredSource = topic.source || 'pubmed';

    try {
      let paper;
      if (preferredSource === 'arxiv') {
        paper = await fetchPaperArxiv(topic);
      } else if (preferredSource === 'semantic') {
        paper = await fetchPaperSemanticScholar(topic);
      } else {
        paper = await fetchPaper(topic);
      }
      return { paper, topic };
    } catch (e) {
      log('Primary source failed for "' + topic.label + '": ' + e.message, "warn");
      const fallbacks = ['pubmed', 'semantic', 'arxiv'].filter(s => s !== preferredSource);
      for (const fallback of fallbacks) {
        try {
          log('Trying ' + fallback + ' for "' + topic.label + '"...', "info");
          let paper;
          if (fallback === 'arxiv')    paper = await fetchPaperArxiv(topic);
          else if (fallback === 'semantic') paper = await fetchPaperSemanticScholar(topic);
          else                          paper = await fetchPaper(topic);
          return { paper, topic };
        } catch (e2) {
          log(fallback + ' also failed: ' + e2.message, "warn");
        }
      }
      log('All sources failed for "' + topic.label + '" — trying next topic...', "warn");
    }
  }
  throw new Error("All topics exhausted across all sources");
}

function schedulePublishTime() {
  const d = new Date();
  d.setDate(d.getDate() + 3);
  d.setHours(14, 0, 0, 0);
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

// ─── STEP 1C: FETCH FROM ARXIV ────────────────────────────────────────────────

async function fetchPaperArxiv(topic) {
  log('Fetching from arXiv for: ' + topic.label);

  const query = encodeURIComponent(topic.query.replace(/\+/g, ' '));
  const url =
    'http://export.arxiv.org/api/query' +
    '?search_query=all:' + query +
    '&sortBy=submittedDate&sortOrder=descending' +
    '&max_results=10';

  const xmlData = await new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });

  const entries = xmlData.match(/<entry>([\s\S]*?)<\/entry>/g) || [];
  if (!entries.length) throw new Error('No papers found on arXiv');

  const entry = entries[Math.floor(Math.random() * Math.min(entries.length, 5))];

  const getTag = (tag) => {
    const match = entry.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>'));
    return match ? match[1].replace(/<[^>]+>/g, '').trim() : '';
  };

  const title   = getTag('title');
  const summary = getTag('summary');
  const id      = getTag('id');
  const published = getTag('published');

  const authors = [...entry.matchAll(/<name>([^<]+)<\/name>/g)]
    .slice(0, 3)
    .map(m => m[1])
    .join(', ');

  if (!title || !summary) throw new Error('Could not parse arXiv entry');

  const result = {
    pmid: id.split('/abs/').pop() || id,
    title,
    authors,
    allAuthors: [],
    affiliation: '',
    journal: 'arXiv',
    date: published.slice(0, 10),
    abstract: summary.slice(0, 2000),
    url: id,
    doi: '',
    source: 'arXiv',
  };

  log('Found (arXiv): "' + result.title.slice(0, 70) + '..."', 'ok');
  return result;
}

// ─── STEP 2: GENERATE SCRIPT ─────────────────────────────────────────────────

async function generateScript(paper, topic) {
  assert(KEYS.anthropic, "Missing ANTHROPIC_API_KEY");
  log("Generating script via Claude Haiku...");
  const prompt = `You are writing a YouTube script for "Turns Out" — a science channel that explains real research in plain, energetic English for a general audience. The tone is sharp, curious, and a little irreverent. Never dry. Never slow. Never boring.

Study title: ${paper.title}
Authors: ${paper.authors}${paper.affiliation ? `\nInstitution: ${paper.affiliation}` : ""}
Journal: ${paper.journal || "not specified"}
Published: ${paper.date}
Abstract: ${paper.abstract}
Topic category: ${topic.label}

Write a punchy 10-minute video script (approximately 1,400 words). Follow this structure exactly:

1. COLD OPEN (100 words): Drop the audience into the most surprising or unsettling implication of this research — no setup, no "today we're covering," no "did you know." Start mid-thought, like a story already in progress. The first sentence must be a statement that makes someone stop scrolling. End the cold open with a single sharp question that makes them need to keep watching. No "hey guys." No preamble. Just the most interesting thing first.

2. CONTEXT (150 words): Now zoom out. What problem was science trying to solve here? What did we assume before this study existed? Keep it brisk — one short paragraph establishing stakes, one short paragraph on prior thinking. End with a one-sentence bridge that pulls them into the next section.

3. RE-HOOK #1 — THE RESEARCHERS (100 words): Introduce who ran this study. Name the lead researchers, their institutions, when and where it was published. Make it feel human and interesting — these are real people who spent years on this. End this section with a forward-pull line: tease what they were about to find.

4. THE STUDY (200 words): Break down the methodology in plain language. Who were the subjects? What did researchers actually do? Use one concrete real-world analogy to make the method click. Keep sentences short. Keep it moving.

5. RE-HOOK #2 — THE FINDINGS (250 words): The results. Go through them one by one in plain English. Use scale and analogy to make numbers feel real — don't just say "thirty percent higher," say what that actually means in a person's life. Be honest about effect sizes and what the study can and can't claim. End this section with a short punchy line that pivots toward implications.

6. WHAT THIS MEANS (200 words): Connect findings to real everyday life. Be specific and practical. Then honestly address one or two limitations or reasons to be skeptical — this builds trust. End with a line that opens the door to the bigger picture.

7. RE-HOOK #3 — THE BIGGER PICTURE (200 words): Where does this sit in the wider field? What assumptions does it challenge? What important question does it raise that nobody has answered yet? Keep this section energetic — this is where curiosity peaks, not where it winds down.

8. SIGN-OFF (100 words): Land on the single most mind-blowing takeaway from the whole video. One short punchy sentence. Then raise one final provocative question the viewer will be thinking about after they close the tab. End with exactly this line: "Turns out, scientists have been busy. And they're not done yet."

CRITICAL FORMATTING RULES:
- Write ONLY the spoken words — no section labels, no stage directions, no markdown, no headers
- Sentences must be short to medium length — maximum 20 words per sentence, aim for 12-15
- Vary sentence length deliberately — short punchy sentences after longer ones create rhythm
- Spell out all numbers and symbols for spoken audio: "twenty-three percent" not "23%", "and" not "&"
- No bullet points, no lists — continuous flowing prose only
- The re-hooks at sections 3, 5, and 7 should feel like natural pivots, not jarring interruptions
- Target exactly 1,400 words — do not go below 1,100 or above 1,600`;

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

async function generateMetadata(paper, script, topic, recentTitles = []) {
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

  // Force structural variety instead of leaving title "shape" up to chance —
  // this is what actually stops two similar studies producing two similar-
  // *sounding* titles even when fetchRecentUploadHistory() has no history yet.
  const titleFormula = dayFormula(0);
  const shortFormula  = dayFormula(3); // offset so the long-form and Short titles don't land on the same shape
  const avoidBlock = recentTitles.length
    ? `\n\nThe channel's last ${recentTitles.length} video titles were:\n${recentTitles.map((t) => `- ${t}`).join("\n")}\nDo NOT reuse similar wording, sentence structure, or opening phrase from any of these — this title must read as clearly different.`
    : "";

  const prompt = `Given this YouTube script for the channel "Turns Out" (@TurnsOutSci), generate video metadata.

Script: ${script}
Study: ${paper.title}
Topic: ${topic.label}${avoidBlock}

Respond ONLY with valid JSON, no markdown, no explanation:
{
  "title": "YouTube video title — punchy, under 60 chars, no clickbait, hint at the finding. Write it as: ${titleFormula}.",
  "short_title": "YouTube Shorts title — under 40 chars, hook-first. Write it as: ${shortFormula}.",
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
  // The topic:<slug> tag is appended AFTER the description's visible hashtag
  // line is built above, so it never shows up in the description — it only
  // lives in the video's real tags field, where fetchRecentUploadHistory()
  // reads it back on the next run to drive the topic cooldown.
  const tagsWithTopicMarker = [...(meta.tags || []), `topic:${topicSlug(topic.label)}`];
  const metadata = { title: meta.title, shortTitle: meta.short_title || meta.title, description, tags: tagsWithTopicMarker, summary: meta.summary };
  log(`Title: "${metadata.title}"`, "ok");
  return metadata;
}

// ─── STEP 3B: GENERATE FOOTAGE SEARCH TERMS ──────────────────────────────────

async function generateFootageSearchTerms(paper, topic) {
  assert(KEYS.anthropic, "Missing ANTHROPIC_API_KEY");
  log("Generating footage search terms...");

  // Was 6 terms / 24 total clips for a ~10-minute video — each clip repeated
  // roughly 6 times, which is the core of the "dry, repetitive b-roll"
  // complaint. More distinct search terms means more distinct clips means
  // fewer repeats over the same runtime (fetchFootage's repeat math scales
  // automatically with pool size — no change needed there).
  const prompt = `Given this science paper, generate 8 specific visual search terms for stock footage.

Paper title: ${paper.title}
Topic: ${topic.label}

Rules:
- Each term 2-3 words max
- Visually concrete and filmable
- Mix of: close-up scientific visuals, human lifestyle scenes, nature/environment, abstract/conceptual
- Every term must be distinctly different — no two terms should produce similar footage
- Avoid generic terms like "science laboratory" or "medical research" unless highly specific
- Think about the full arc of the video — terms should cover the topic from multiple visual angles

Respond ONLY with a JSON array of exactly 8 strings, no markdown:
["term one", "term two", "term three", "term four", "term five", "term six", "term seven", "term eight"]`;

  const response = await fetchJSON("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": KEYS.anthropic,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 150,
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

// ─── STEP 4A: FETCH FROM PIXABAY ─────────────────────────────────────────────

async function fetchPixabayClips(searchTerm, count = 6) {
  const apiKey = process.env.PIXABAY_API_KEY;
  if (!apiKey) {
    log("PIXABAY_API_KEY not set — skipping Pixabay", "warn");
    return [];
  }
  try {
    const url =
      `https://pixabay.com/api/videos/?key=${apiKey}` +
      `&q=${encodeURIComponent(searchTerm)}` +
      `&video_type=film&per_page=${count + 3}&safesearch=true`;
    const data = await fetchJSON(url);
    const clips = (data.hits || [])
      .map((v) => {
        const file =
          v.videos?.medium?.url ||
          v.videos?.small?.url ||
          v.videos?.large?.url;
        return file;
      })
      .filter(Boolean)
      .slice(0, count);
    log(`  Pixabay: found ${clips.length} clips for "${searchTerm}"`, clips.length ? "ok" : "warn");
    return clips;
  } catch (e) {
    log(`  Pixabay fetch failed for "${searchTerm}": ${e.message}`, "warn");
    return [];
  }
}

// ─── STEP 4: FETCH STOCK FOOTAGE ─────────────────────────────────────────────

async function fetchFootage(topic, paper) {
  assert(KEYS.pexels, "Missing PEXELS_API_KEY");

  const searchTerms = await generateFootageSearchTerms(paper, topic);
  const TARGET_CLIPS = 36; // was 24 — bigger pool means fewer repeats over a ~10-minute video
  const clipsPerTerm = Math.ceil(TARGET_CLIPS / 2 / searchTerms.length);
  const allClipUrls = [];

  for (const term of searchTerms) {
    log(`  Pexels: searching "${term}"...`);
    try {
      const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(term)}&per_page=${clipsPerTerm + 3}&orientation=landscape&size=medium`;
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
      allClipUrls.push(...clips);
      log(`  Pexels: ${clips.length} clips for "${term}"`, "ok");
    } catch (e) {
      log(`  Pexels failed for "${term}": ${e.message}`, "warn");
    }
  }

  for (const term of searchTerms) {
    const pixabayClips = await fetchPixabayClips(term, clipsPerTerm);
    allClipUrls.push(...pixabayClips);
  }

  if (allClipUrls.length < 12) {
    log("Combined sources returned fewer than 12 clips — running fallback on topic default", "warn");
    const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(topic.pexels)}&per_page=12&orientation=landscape&size=medium`;
    const data = await fetchJSON(url, { headers: { Authorization: KEYS.pexels } });
    allClipUrls.push(...(data.videos || []).map((v) => v.video_files?.[0]?.link).filter(Boolean));
  }

  assert(allClipUrls.length, "No footage found from any source");

  const uniqueUrls = [...new Set(allClipUrls)].slice(0, TARGET_CLIPS);
  const paths = [];

  for (let i = 0; i < uniqueUrls.length; i++) {
    const dest = path.join(TMP, `clip_${i}.mp4`);
    log(`  Downloading clip ${i + 1}/${uniqueUrls.length}...`);
    try {
      await fetchBinary(uniqueUrls[i], dest);
      paths.push(dest);
    } catch (e) {
      log(`  Clip ${i + 1} download failed — skipping`, "warn");
    }
  }

  log(`Downloaded ${paths.length} clips across ${searchTerms.length} search terms (Pexels + Pixabay)`, "ok");
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
  const scaledFootage    = path.join(TMP, "footage_scaled.mp4");
  const bumperConcatList = path.join(TMP, "bumper_concat.txt");
  const audioDuration = parseFloat(
    execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`
    ).toString().trim()
  );
  log(`  Audio duration: ${audioDuration.toFixed(1)}s`);

  // Subtle continuous zoom-in on every clip (was a flat scale/crop with zero
  // motion beyond whatever the stock clip itself had) — a slow, constant
  // zoompan reads as intentional cinematography instead of a static loop,
  // which was a big part of the "dry" complaint. d=1 makes zoompan advance
  // one zoom-step per INPUT frame rather than freezing on a single frame —
  // the mode meant for real video rather than animating a still image.
  const ZOOM_FILTER = "zoompan=z='min(zoom+0.0012,1.18)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=30";
  const normalizedPaths = [];
  for (let i = 0; i < clipPaths.length; i++) {
    const normPath = path.join(TMP, `norm_${i}.mp4`);
    execSync(
      `ffmpeg -y -i "${clipPaths[i]}" -vf "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,scale=3840:2160,${ZOOM_FILTER}" -c:v libx264 -preset ultrafast -crf 23 -an "${normPath}" 2>/dev/null`,
      { stdio: "pipe" }
    );
    normalizedPaths.push(normPath);
  }
  log(`  Normalized ${normalizedPaths.length} clips`);

  let concatContent = "";
  for (const p of normalizedPaths) concatContent += `file '${p}'\n`;
  const repeats = Math.ceil(audioDuration / (normalizedPaths.length * 4)) + 2;
  let fullContent = "";
  for (let i = 0; i < repeats; i++) fullContent += concatContent;
  fs.writeFileSync(concatList, fullContent);

  execSync(
    `ffmpeg -y -f concat -safe 0 -i "${concatList}" -t ${audioDuration} -c copy "${scaledFootage}" 2>/dev/null`,
    { stdio: "pipe" }
  );
  // Music bed under the narration — the body of the video previously had
  // ZERO music (only the 3s intro bumper had any), which was a big part of
  // the "dry" feel next to comparable channels that run a bed the whole
  // way through. Reusing assets/bumper_music.mp3 rather than requiring a
  // second licensed track right now — loop it under the voiceover at low
  // volume with a fade-out near the very end, mixed via amix so it never
  // competes with the narration. Falls back to voice-only (previous
  // behavior, unchanged) if that asset is missing so this can never break
  // a run over a missing file.
  const musicBedPath = path.join(CONFIG.ASSETS_DIR, "bumper_music.mp3");
  const hasMusicBed = fs.existsSync(musicBedPath);
  if (!hasMusicBed) {
    log("assets/bumper_music.mp3 not found — rendering main video without a music bed", "warn");
  }
  const fadeStart = Math.max(0, audioDuration - 2.5);
  const audioMixArgs = hasMusicBed
    ? `-i "${audioPath}" -stream_loop -1 -i "${musicBedPath}" ` +
      `-filter_complex "[2:a]volume=0.12,afade=t=out:st=${fadeStart.toFixed(2)}:d=2.5[music];[1:a][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]" ` +
      `-map 0:v:0 -map "[aout]"`
    : `-i "${audioPath}" -map 0:v:0 -map 1:a:0`;
  const ffmpegOutput = execSync(
    `ffmpeg -y \
      -i "${scaledFootage}" \
      ${audioMixArgs} \
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
  const endCardPath = await buildEndCard();
  const bumperPath  = await buildBumper();
  fs.writeFileSync(bumperConcatList, `file '${bumperPath}'\nfile '${mainPath}'\nfile '${endCardPath}'\n`);
  execSync(
    `ffmpeg -y -f concat -safe 0 -i "${bumperConcatList}" -c:v libx264 -preset ultrafast -crf 23 -c:a aac -b:a 128k "${outputPath}" 2>/dev/null`,
    { stdio: "pipe" }
  );
  const outputSize = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
  if (outputSize < 500000) {
    throw new Error(`Final concat failed (${outputSize} bytes)`);
  }

  const MAX_DURATION = 720;
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

  // Fixed: was a naive 2-line split with an unbounded second line and a
  // character-stripping regex that ate apostrophes (see notes above
  // wrapTextLines). Now every line is capped and safely rendered via
  // textfile=.
  const lines = wrapTextLines(metadata.title, 28, 2);
  const topicLabel = topic.label.toUpperCase();
  const font = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

  const topicFile = writeDrawtextFile(topicLabel);
  const brandFile = writeDrawtextFile("TURNS OUT");
  const lineFiles = lines.map(writeDrawtextFile);

  let vf = [
    `drawbox=x=0:y=480:w=iw:h=240:color=#1A1610@0.72:t=fill`,
    `drawbox=x=30:y=30:w=230:h=40:color=#C17B2F@1.0:t=fill`,
    drawtextLine(font, topicFile, { fontsize: 18, fontcolor: "#1A1610", x: 42, y: 41 }),
    drawtextLine(font, brandFile, { fontsize: 15, fontcolor: "#8A7F6B", x: "w-tw-30", y: 42 }),
    drawtextLine(font, lineFiles[0], { fontsize: 54, fontcolor: "#F5EDD8", x: 30, y: 492, shadow: true }),
  ];
  if (lineFiles[1]) {
    vf.push(drawtextLine(font, lineFiles[1], { fontsize: 54, fontcolor: "#F5EDD8", x: 30, y: 556, shadow: true }));
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

// ─── END CARD ─────────────────────────────────────────────────────────────────

async function buildEndCard() {
  log("Building end card (20s)...");

  const endCardPath = path.join(TMP, "end_card.mp4");
  const font        = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
  const duration    = 20;

  const vf = [
    `drawbox=x=0:y=0:w=iw:h=ih:color=#0A0E1A:t=fill`,
    `drawtext=fontfile='${font}':text='turns out':fontsize=80:fontcolor=#F5EDD8:x=(w-tw)/2:y=(h/2)-120:shadowcolor=black@0.5:shadowx=2:shadowy=2`,
    `drawtext=fontfile='${font}':text='out':fontsize=80:fontcolor=#C17B2F:x=(w-tw)/2+230:y=(h/2)-120:shadowcolor=black@0.5:shadowx=2:shadowy=2`,
    `drawtext=fontfile='${font}':text='Scientists have been busy.':fontsize=32:fontcolor=#8A7F6B:x=(w-tw)/2:y=(h/2)`,
    `drawtext=fontfile='${font}':text='Subscribe for more.':fontsize=28:fontcolor=#C17B2F:x=(w-tw)/2:y=(h/2)+50`,
  ].join(",");

  execSync(
    `ffmpeg -y -f lavfi -i "color=c=#0A0E1A:size=1920x1080:rate=30" -t ${duration} ` +
    `-vf "${vf}" ` +
    `-c:v libx264 -preset ultrafast -crf 23 ` +
    `-af "anullsrc=r=44100:cl=stereo,atrim=duration=${duration}" ` +
    `-c:a aac -b:a 128k "${endCardPath}" 2>/dev/null`,
    { stdio: "pipe" }
  );

  log("End card built (20s)", "ok");
  return endCardPath;
}

// ─── PLAYLISTS ────────────────────────────────────────────────────────────────

async function getOrCreatePlaylist(topicLabel) {
  const playlistTitle = `Turns Out: ${topicLabel}`;

  const searchUrl = `https://www.googleapis.com/youtube/v3/playlists?part=snippet&mine=true&maxResults=50`;
  try {
    const existing = await fetchJSON(searchUrl, {
      headers: { Authorization: `Bearer ${KEYS.youtube}` },
    });
    const match = (existing.items || []).find(p => p.snippet?.title === playlistTitle);
    if (match) {
      log(`Playlist found for "${topicLabel}": ${match.id}`, "ok");
      return match.id;
    }
  } catch (e) {
    log(`Playlist search failed: ${e.message}`, "warn");
  }

  log(`Creating playlist for "${topicLabel}"...`);
  const body = JSON.stringify({
    snippet: {
      title: `Turns Out: ${topicLabel}`,
      description: `All Turns Out videos on ${topicLabel}. Real research, plain English. New video every day.`,
      defaultLanguage: "en",
    },
    status: { privacyStatus: "public" },
  });

  const response = await fetchJSON(
    "https://www.googleapis.com/youtube/v3/playlists?part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KEYS.youtube}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      body,
    }
  );

  if (!response.id) {
    log(`Playlist creation failed: ${JSON.stringify(response)}`, "warn");
    return null;
  }

  log(`Playlist created: ${response.id}`, "ok");
  return response.id;
}

async function addVideoToPlaylist(videoId, playlistId) {
  if (!playlistId) return;
  log(`Adding video to playlist ${playlistId}...`);

  const body = JSON.stringify({
    snippet: {
      playlistId,
      resourceId: { kind: "youtube#video", videoId },
    },
  });

  const response = await fetchJSON(
    "https://www.googleapis.com/youtube/v3/playlistItems?part=snippet",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KEYS.youtube}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      body,
    }
  );

  if (response.id) {
    log("Video added to playlist", "ok");
  } else {
    log(`Playlist insert failed: ${JSON.stringify(response)}`, "warn");
  }
}

// ─── SHORT: GENERATE SCRIPT ───────────────────────────────────────────────────

async function generateShortScript(paper, topic) {
  assert(KEYS.anthropic, "Missing ANTHROPIC_API_KEY");
  log("Generating Short script...");

  const prompt = `You are writing a YouTube Shorts script for "Turns Out" — a science channel. The tone is sharp, fast, and irreverent.

Study title: ${paper.title}
Topic: ${topic.label}
Abstract: ${paper.abstract}

Write a self-contained, punchy script of approximately 130 words that:
- Opens with the single most surprising finding — no setup, no "today we're talking about"
- Delivers 2-3 concrete details from the study in plain English
- Must work as a STANDALONE piece — the viewer has not seen the long-form video
- Ends with exactly this line as the final sentence: "Full breakdown is one tap away."

CRITICAL FORMATTING RULES:
- Write ONLY the spoken words — no labels, no markdown
- Short, punchy sentences — max 15 words each
- Spell out numbers and symbols for spoken audio
- Target exactly 130 words — do not go below 110 or above 150`;

  const response = await fetchJSON("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": KEYS.anthropic,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const script = response.content?.[0]?.text;
  assert(script, "Short script generation failed");
  const wordCount = script.split(" ").length;
  log(`Short script generated (${wordCount} words)`, "ok");
  return script;
}

// ─── SHORT: ASSEMBLE ─────────────────────────────────────────────────────────

async function assembleShort(clipPaths, metadata, topic, paper) {
  log("Assembling Short (vertical 9:16)...");

  const shortAudio     = path.join(TMP, "short_audio.aac");
  const shortConcat    = path.join(TMP, "short_concat.txt");
  const shortFootage   = path.join(TMP, "short_footage.mp4");
  const shortOutput    = path.join(TMP, "short_final.mp4");
  const font           = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

  // Step 1: Generate dedicated short script + voiceover
  const shortScript = await generateShortScript(paper, topic);
  assert(KEYS.elevenlabs, "Missing ELEVENLABS_API_KEY");
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${CONFIG.ELEVENLABS_VOICE_ID}`;
  await new Promise((resolve, reject) => {
    const body = JSON.stringify({
      text: shortScript,
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
      const file = fs.createWriteStream(shortAudio);
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
      file.on("error", reject);
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });

  const audioDuration = parseFloat(
    execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${shortAudio}"`
    ).toString().trim()
  );
  log(`  Short audio duration: ${audioDuration.toFixed(1)}s`);

  // Step 2: Build vertical clips, looped to cover full audio
  const verticalClips = [];
  for (let i = 0; i < clipPaths.length; i++) {
    const vPath = path.join(TMP, `short_clip_${i}.mp4`);
    try {
      // Same subtle zoompan as the long-form normalization step (see notes
      // there) — output size matches the vertical 1080x1920 canvas.
      execSync(
        `ffmpeg -y -i "${clipPaths[i]}" -vf "scale=1920:1080:force_original_aspect_ratio=increase,crop=608:1080:656:0,scale=2160:3840,zoompan=z='min(zoom+0.0012,1.18)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920:fps=30" -c:v libx264 -preset ultrafast -crf 23 -an "${vPath}" 2>/dev/null`,
        { stdio: "pipe" }
      );
      verticalClips.push(vPath);
    } catch (e) {
      log(`  Skipping clip ${i} for Short (conversion failed)`, "warn");
    }
  }
  assert(verticalClips.length, "No usable clips for Short");

  let concatContent = "";
  for (const p of verticalClips) concatContent += `file '${p}'\n`;
  const repeats = Math.ceil(audioDuration / (verticalClips.length * 4)) + 2;
  let fullContent = "";
  for (let i = 0; i < repeats; i++) fullContent += concatContent;
  fs.writeFileSync(shortConcat, fullContent);

  execSync(
    `ffmpeg -y -f concat -safe 0 -i "${shortConcat}" -t ${audioDuration} -c copy "${shortFootage}" 2>/dev/null`,
    { stdio: "pipe" }
  );

  // Step 3: Title overlay + end-screen callout
  // Fixed: was a 3-line wrap where the 3rd line had no character cap at all,
  // so any shortTitle over ~39 chars (which the LLM overshoots constantly
  // despite the "under 40 chars" instruction) produced an unbounded final
  // line that rendered wider than the 1080px canvas and got clipped on both
  // edges once horizontally centered — that's the exact garbled/cut-off text
  // seen on live Shorts thumbnails. Also fixed the apostrophe-eating regex
  // (see wrapTextLines/writeDrawtextFile notes above generateThumbnail).
  //
  // Black-field size fix: the old 13-chars/2-line-usable-content-in-3-slots
  // wrap forced narrow columns that needed 3 stacked lines, which is why the
  // translucent title field had to be 700px (~36% of the 1920-tall frame) —
  // roughly the "1/3 of the screen" that read as too much. Widening the wrap
  // to 20 chars/line means a ~40-char shortTitle fits in 2 lines instead of
  // 3 (this uses more of the 1080px width, which was sitting mostly empty),
  // so the field behind it can drop to 380px (~20%) without clipping text.
  const lines = wrapTextLines(metadata.shortTitle, 20, 2);
  const topicLabel = topic.label.toUpperCase();

  const topicFile = writeDrawtextFile(topicLabel);
  const brandFile = writeDrawtextFile("TURNS OUT");
  const calloutFile = writeDrawtextFile("Full video on channel");
  const lineFiles = lines.map(writeDrawtextFile);

  let vf = [
    `drawbox=x=0:y=0:w=iw:h=380:color=#1A1610@0.75:t=fill`,
    `drawbox=x=(iw-240)/2:y=20:w=240:h=40:color=#C17B2F@1.0:t=fill`,
    drawtextLine(font, topicFile, { fontsize: 18, fontcolor: "#1A1610", x: "(w-tw)/2", y: 28 }),
    drawtextLine(font, lineFiles[0], { fontsize: 64, fontcolor: "#F5EDD8", x: "(w-tw)/2", y: 104, shadow: true }),
  ];
  if (lineFiles[1]) vf.push(drawtextLine(font, lineFiles[1], { fontsize: 64, fontcolor: "#F5EDD8", x: "(w-tw)/2", y: 184, shadow: true }));
  // Safe-zone fix: these two were previously anchored at h-60 and h-110 —
  // only 3-6% of frame height off the bottom edge. On the actual YouTube
  // Shorts player (mobile app especially), that exact zone is reserved for
  // YOUTUBE'S OWN overlay: the channel handle, video title, sound name, and
  // "...more" description toggle, which YouTube renders on top of the video
  // itself and which we cannot move or remove. Anything we burn in that low
  // gets hidden behind or crowded against that native chrome. Moved both up
  // above YouTube's reserved bottom band (roughly the bottom 300-350px on a
  // 1920-tall frame) so they stay visible above it instead of fighting it.
  vf.push(drawtextLine(font, brandFile, { fontsize: 22, fontcolor: "#8A7F6B", x: "(w-tw)/2", y: "h-300" }));
  vf.push(drawtextLine(font, calloutFile, { fontsize: 24, fontcolor: "#C17B2F", x: "(w-tw)/2", y: "h-360" }) + `:enable='gte(t,${(audioDuration - 4).toFixed(1)})'`);

  // Same music-bed treatment as the long-form video (see notes in
  // assembleVideo) — reuses the same asset, falls back to voice-only if it's
  // missing, mixed low enough to stay under the narration and faded out
  // just before the "Full video on channel" callout appears.
  const musicBedPath = path.join(CONFIG.ASSETS_DIR, "bumper_music.mp3");
  const hasMusicBed = fs.existsSync(musicBedPath);
  if (!hasMusicBed) {
    log("assets/bumper_music.mp3 not found — rendering Short without a music bed", "warn");
  }
  const shortFadeStart = Math.max(0, audioDuration - 1.5);
  const shortAudioArgs = hasMusicBed
    ? `-i "${shortAudio}" -stream_loop -1 -i "${musicBedPath}" ` +
      `-filter_complex "[2:a]volume=0.12,afade=t=out:st=${shortFadeStart.toFixed(2)}:d=1.5[music];[1:a][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]" ` +
      `-map 0:v:0 -map "[aout]"`
    : `-i "${shortAudio}" -map 0:v:0 -map 1:a:0`;

  try {
    execSync(
      `ffmpeg -y \
        -i "${shortFootage}" \
        ${shortAudioArgs} \
        -vf "${vf.join(",")}" \
        -c:v libx264 -preset ultrafast -crf 22 \
        -c:a aac -b:a 128k \
        -shortest \
        "${shortOutput}"`,
      { stdio: "pipe" }
    );
  } catch (e) {
    log(`FFmpeg stderr (final short assembly): ${e.stderr?.toString().slice(-1000)}`, "warn");
    throw e;
  }

  const outputSize = fs.existsSync(shortOutput) ? fs.statSync(shortOutput).size : 0;
  if (outputSize < 100000) throw new Error(`Short assembly failed (${outputSize} bytes)`);

  log(`Short assembled (${audioDuration.toFixed(1)}s vertical)`, "ok");
  return { shortPath: shortOutput, shortScript };
}
// ─── SHORT: UPLOAD ────────────────────────────────────────────────────────────

async function uploadShort(shortPath, metadata, longFormVideoId, publishTime) {
  assert(KEYS.youtube, "Missing YT token for Short upload");
  log("Uploading Short to YouTube...");

  const shortDescription =
    `${metadata.summary || ""}\n\n` +
    `Watch the full video: https://youtube.com/watch?v=${longFormVideoId}\n\n` +
    `New videos every day. Subscribe: https://youtube.com/@TurnsOutSci\n\n` +
    `#Shorts #Science #${metadata.tags?.[0] || "ScienceShorts"}`;

  const shortTags = [...(metadata.tags || []), "Shorts", "ScienceShorts", "LearnOnYouTube"];

  const videoBuffer = fs.readFileSync(shortPath);
  const boundary = "turns_out_short_boundary_" + Date.now();

  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify({
        snippet: {
          title: metadata.shortTitle + " #Shorts",
          description: shortDescription,
          tags: shortTags,
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
    const shortId = response.body?.id;
    log(`Short uploaded! ID: ${shortId}`, "ok");
    log(`Short URL: https://youtube.com/shorts/${shortId}`, "ok");
    return shortId;
  } else {
    log(`Short upload failed (${response.status}): ${JSON.stringify(response.body)}`, "err");
    throw new Error("Short upload failed");
  }
}

async function main() {
  console.log("\n╔════════════════════════════════════════╗");
  console.log("║     Turns Out — Pipeline v2.1          ║");
  console.log("║     @TurnsOutSci                       ║");
  console.log(`║     ${new Date().toISOString().slice(0, 10)}                       ║`);
  console.log("╚════════════════════════════════════════╝\n");

  if (DRY_RUN) {
    log("DRY RUN — will generate script/audio/video/thumbnail locally, and will NOT touch YouTube (no token refresh, no upload, no thumbnail set, no playlist writes). Temp files will be kept for inspection instead of cleaned up.", "warn");
  }

  // In dry run we deliberately never call YouTube, so don't require those
  // four keys to be present — only the generation keys matter.
  const requiredKeys = DRY_RUN
    ? { anthropic: KEYS.anthropic, elevenlabs: KEYS.elevenlabs, pexels: KEYS.pexels }
    : KEYS;
  const missing = Object.entries(requiredKeys).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    log(`Missing API keys: ${missing.join(", ")}`, "err");
    log("Set them as environment variables or GitHub Secrets.", "warn");
    process.exit(1);
  }

  try {
    if (!DRY_RUN) await refreshYouTubeToken();
    const { recentTopicIndices, recentTitles } = await fetchRecentUploadHistory();
    const { paper, topic } = await fetchPaperWithRetry(recentTopicIndices);
    log("Topic selected: " + topic.label);
    const script    = await generateScript(paper, topic);
    const metadata  = await generateMetadata(paper, script, topic, recentTitles);
    const clips     = await fetchFootage(topic, paper);
    const audio     = await generateVoiceover(script);
    const video     = await assembleVideo(clips, audio, metadata.title);
    const thumb     = await generateThumbnail(video, metadata, topic);
    const publishAt = schedulePublishTime();

    let videoId = null;
    if (DRY_RUN) {
      log(`DRY RUN — skipping YouTube upload. Inspect output at:`, "warn");
      console.log(`   Video:     ${video}`);
      console.log(`   Thumbnail: ${thumb}`);
    } else {
      videoId = await uploadToYouTube(video, metadata, publishAt);
      await uploadThumbnail(videoId, thumb);

      try {
        const playlistId = await getOrCreatePlaylist(topic.label);
        await addVideoToPlaylist(videoId, playlistId);
      } catch (e) {
        log(`Playlist error: ${e.message} — continuing`, "warn");
      }
    }

    log("\n── Generating matching Short ──");
    try {
      const { shortPath } = await assembleShort(clips, metadata, topic, paper);
      if (DRY_RUN) {
        log("DRY RUN — skipping Short upload. Inspect output at:", "warn");
        console.log(`   Short: ${shortPath}`);
      } else {
        const shortPublishAt = schedulePublishTime(); // same publish window
        const shortId = await uploadShort(shortPath, metadata, videoId, shortPublishAt);
        console.log(`   Short:      https://youtube.com/shorts/${shortId}`);
      }
    } catch (e) {
      log(`Short generation failed: ${e.message} — continuing without Short`, "warn");
    }

    const runLog = {
      timestamp: new Date().toISOString(),
      dryRun: DRY_RUN,
      topic: topic.label,
      paper: { pmid: paper.pmid, title: paper.title, authors: paper.authors, journal: paper.journal, date: paper.date, doi: paper.doi, url: paper.url },
      videoId,
      title: metadata.title,
      publishAt,
      wordCount: script.split(" ").length,
    };

    fs.writeFileSync(path.join(__dirname, `run_log_${Date.now()}.json`), JSON.stringify(runLog, null, 2));

    if (DRY_RUN) {
      console.log("\n✅ Dry run complete — nothing was uploaded to YouTube. Temp files kept in tmp/ for inspection.\n");
    } else {
      console.log("\n✅ Pipeline complete!");
      console.log(`   Video:      https://youtube.com/watch?v=${videoId}`);
      console.log(`   Thumbnail:  uploaded automatically`);
      console.log(`   Publishes:  ${publishAt}\n`);
      cleanup();
    }
  } catch (err) {
    log(`Pipeline failed: ${err.message}`, "err");
    console.error(err);
    process.exit(1);
  }
}

main();
