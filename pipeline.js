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

// DRY_RUN: skips every YouTube-touching call (token refresh, upload, thumbnail
// set, playlist writes, Short upload) and skips cleanup() so generated output
// stays in tmp/ for inspection. Triggered by `--dry-run` / `--dryrun` on the
// command line, or DRY_RUN=true in the environment.
const DRY_RUN = process.argv.includes("--dry-run") || process.argv.includes("--dryrun") || process.env.DRY_RUN === "true";

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const CONFIG = {
  CHANNEL_ID: "UCugairkMHQVneS7C5SbIP0g",
  CHANNEL_HANDLE: "@TurnsOutSci",
  ELEVENLABS_VOICE_ID: "ptBd2v6mebIps3ZQEXD7",
  VIDEO_DURATION_TARGET: 600,
  BUMPER_DURATION: 3,
  MUSIC_BED_VOLUME: 0.12, // linear gain (~-18dB) for the background music bed under narration
  ASSETS_DIR: path.join(__dirname, "assets"),
  MUSIC_CREDIT: `Music: "Upbeat Inspiring Corporate" by Pro Tunes - Copyright Safe Music | https://freemusicarchive.org/music/pro-tunes/single/upbeat-inspiring-corporate-1/`,
  // Shortlisted to the 7 highest-performing categories per view-data review (Sept 2026).
  // Weight loss query has GLP-1/semaglutide/tirzepatide baked in as the current "hot topic" —
  // see getRollingDateWindow()/note below for how to keep this list current over time.
  TOPICS: [
    { label: "Children's health",      query: "child+health+pediatric+disease+treatment",             pexels: "children health",       source: "pubmed" },
    { label: "Alternative therapies",  query: "psychedelic+cannabis+traditional+medicine+therapy",     pexels: "wellness alternative",  source: "pubmed" },
    { label: "Male vs. female health", query: "sex+differences+men+women+health+outcomes",             pexels: "diverse people health", source: "pubmed",
      // Requires one of these phrases in the paper's TITLE (see fetchPaper()) — the
      // bare query above matched papers where sex was just one variable analyzed
      // among many (e.g. a general dementia risk-factor cohort study), not papers
      // actually about sex/gender comparison. Narrower on purpose; may occasionally
      // return fewer results on a given day, which just falls through to the next topic.
      pubmedTitleTerms: ["sex differences", "gender differences", "men and women", "sex-specific", "sex disparities"] },
    { label: "Sleep science",          query: "sleep+circadian+rest+cognitive+performance",            pexels: "sleeping person",       source: "pubmed" },
    { label: "Bacteria & viruses",     query: "microbiome+bacteria+virus+infection+immune",            pexels: "microbiology science",  source: "pubmed" },
    { label: "Brain health",           query: "brain+neuroscience+cognitive+mental+performance",       pexels: "brain neuroscience",    source: "pubmed" },
    { label: "Weight loss",            query: "weight+loss+obesity+GLP-1+semaglutide+tirzepatide",     pexels: "fitness weight loss",   source: "pubmed" },
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

// FAL_KEY is intentionally not in the required-keys list below — it's optional.
// Missing it degrades the thumbnail to the old video-frame-grab approach
// instead of failing the whole run. ~$0.15/video via Nano Banana Pro when set.
const FAL_KEY = process.env.FAL_KEY;

// ─── UTILITIES ───────────────────────────────────────────────────────────────

function log(msg, type = "info") {
  const icons = { info: "→", ok: "✓", err: "✗", warn: "⚠" };
  console.log(`${icons[type] || "·"} ${msg}`);
}

function assert(condition, msg) {
  if (!condition) { log(msg, "err"); process.exit(1); }
}

// Wraps text into at most maxLines lines of at most maxCharsPerLine chars
// each. Unlike the old ad-hoc wrap logic, every line — including the last —
// is capped: any leftover words are dropped and the final line is ellipsized
// rather than ever overflowing the render canvas.
function wrapTextLines(text, maxCharsPerLine, maxLines) {
  const words = (text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  let i = 0;
  while (i < words.length && lines.length < maxLines) {
    const word = words[i];
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxCharsPerLine) {
      current = candidate;
      i++;
    } else if (!current) {
      // single word longer than the line budget — hard-truncate it
      current = word.slice(0, maxCharsPerLine);
      i++;
    } else {
      lines.push(current);
      current = "";
    }
  }
  if (current) lines.push(current);
  const overflow = i < words.length;
  if (overflow && lines.length) {
    const budget = maxCharsPerLine - 1;
    const last = lines[lines.length - 1].replace(/[.,;:!?]*$/, "");
    lines[lines.length - 1] = (last.length > budget ? last.slice(0, budget) : last) + "…";
  }
  return lines;
}

// Writes sanitized text to its own file in TMP and returns the path, for use
// with ffmpeg drawtext's textfile= option instead of an inline text='...'
// argument. This sidesteps filtergraph string escaping entirely — apostrophes,
// colons and quotes in the source text pass through untouched. Backslashes
// and percent signs are stripped since drawtext still expands %{...} and \
// escapes when reading from a textfile.
function writeDrawTextFile(text, name) {
  const safe = (text || "").replace(/\\/g, "").replace(/%/g, "").trim();
  const filePath = path.join(TMP, name);
  fs.writeFileSync(filePath, safe, "utf8");
  return filePath;
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

// Fisher-Yates shuffle — used to re-order the b-roll clip list on each loop
// pass so a 10-minute video doesn't replay the same clips in the same
// sequence every ~90 seconds.
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
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
      let succeeded = false;
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
      if (!succeeded) log('All sources failed for "' + topic.label + '" — trying next topic...', "warn");
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

// ─── DATE WINDOW: rolling 12 months, computed at runtime ───────────────────
// Every paper source is filtered to "published in the last 12 months as of
// today," instead of a fixed year range that goes stale. This is also the
// place to plug in real trend-tracking later (e.g. pull a live "hot topics"
// list and bias topic.query per run) — for now, hot terms (GLP-1s, etc.) are
// hand-baked into CONFIG.TOPICS queries above and refreshed manually as
// performance data comes in.
function getRollingDateWindow() {
  const now = new Date();
  const past = new Date(now);
  past.setMonth(past.getMonth() - 12);
  const pad = (n) => String(n).padStart(2, "0");
  const slash = (d) => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  const dash = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const compact = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}0000`;
  return {
    pubmedMin: slash(past),
    pubmedMax: slash(now),
    s2Range: `${dash(past)}:${dash(now)}`,
    arxivMin: compact(past),
    arxivMax: compact(now),
  };
}

// ─── STEP 1: FETCH PAPER ─────────────────────────────────────────────────────

async function fetchPaper(topic) {
  log(`Fetching paper for topic: ${topic.label}`);
  const win = getRollingDateWindow();
  // Most topic queries are broad on purpose (PubMed's own guidance: cast wide,
  // narrow ranges/filters miss too many valid results). But a few bare-word
  // queries are broad enough to match papers where the topic is incidental,
  // not central — pubmedTitleTerms (when present) fixes that by requiring the
  // topic to actually appear in the paper's TITLE, which is a much stronger
  // "this paper is really about X" signal than presence anywhere in the abstract.
  let term = topic.query.replace(/\+/g, " ");
  if (topic.pubmedTitleTerms?.length) {
    const titleGroup = topic.pubmedTitleTerms.map((t) => `"${t}"[Title]`).join(" OR ");
    term = `${term} AND (${titleGroup})`;
  }
  const searchUrl =
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi` +
    `?db=pubmed&term=${encodeURIComponent(term)}&sort=date&retmax=10&retmode=json` +
    `&datetype=pdat&mindate=${win.pubmedMin}&maxdate=${win.pubmedMax}`;
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
  const win = getRollingDateWindow();
  const query = encodeURIComponent(topic.query.replace(/\+/g, " "));
  const url =
    "https://api.semanticscholar.org/graph/v1/paper/search" +
    "?query=" + query +
    "&fields=title,abstract,authors,year,citationCount,influentialCitationCount,externalIds,publicationDate,journal" +
    "&limit=10&publicationDateOrYear=" + win.s2Range;
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

  const win = getRollingDateWindow();
  const query = encodeURIComponent(topic.query.replace(/\+/g, ' '));
  const dateFilter = encodeURIComponent(`AND submittedDate:[${win.arxivMin} TO ${win.arxivMax}]`);
  const url =
    'http://export.arxiv.org/api/query' +
    '?search_query=all:' + query + '+' + dateFilter +
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
  const prompt = `You are writing a YouTube script for "Turns Out" — a science channel hosted by someone who just cannot get over how cool real research is. This is not a professor. This is not a documentary narrator. This is a friend who read a study an hour ago and is still buzzing about it, and has to tell you RIGHT NOW before they explode. Every finding gets treated like the single coolest thing that happened this week — because to this host, it is.

The tone is delighted, breathless, "wait, WHAT?!" energy — not "researchers report" energy. Never sound like a textbook. Never sound like a press release. If a sentence could appear in a journal abstract, rewrite it until it sounds like something you'd blurt out to a friend at a bar.

Study title: ${paper.title}
Authors: ${paper.authors}${paper.affiliation ? `\nInstitution: ${paper.affiliation}` : ""}
Journal: ${paper.journal || "not specified"}
Published: ${paper.date}
Abstract: ${paper.abstract}
Topic category: ${topic.label}
Editorial note: this video is filed under "${topic.label}" for the channel's topic tracking. Keep the cold open, the central throughline, and the "what this means" section anchored to that specific angle — if the paper's abstract contains multiple findings, foreground the one connected to "${topic.label}" rather than pivoting the whole video toward a more dramatic but unrelated finding buried in the same abstract. If the paper genuinely does not support that angle at all, write the best script the paper actually supports rather than forcing a false connection.

Write a punchy 10-minute video script (approximately 1,400 words). Follow this structure exactly:

1. COLD OPEN (100 words): Drop the audience into the most surprising or unsettling implication of this research — no setup, no "today we're covering," no "did you know." Start mid-thought, like a story already in progress, mid-excitement. The first sentence must be a statement that makes someone stop scrolling — something you'd only say out loud if you genuinely could not believe it. End the cold open with a single sharp question that makes them need to keep watching. No "hey guys." No preamble. Just the most interesting thing first, delivered like you're still catching your breath over it.

2. CONTEXT (150 words): Now zoom out — but keep the energy up, don't downshift into lecture mode. What problem was science trying to solve here? What did we assume before this study existed, and how were we all kind of wrong about it? Keep it brisk — one short paragraph establishing stakes, one short paragraph on prior thinking. End with a one-sentence bridge that pulls them into the next section like a "but here's the thing" moment.

3. RE-HOOK #1 — THE RESEARCHERS (100 words): Introduce who ran this study like you're hyping up people who deserve it. Name the lead researchers, their institutions, when and where it was published. Make it feel human and genuinely impressive — these are real people who spent years chasing this down. End this section with a forward-pull line: tease what they were about to find like you can't wait to tell them.

4. THE STUDY (200 words): Break down the methodology in plain language, with genuine enthusiasm for how clever or ambitious it was. Who were the subjects? What did researchers actually do? Use one concrete real-world analogy to make the method click. Keep sentences short. Keep it moving.

5. RE-HOOK #2 — THE FINDINGS (250 words): The results. Go through them one by one like you're revealing plot twists. Use scale and analogy to make numbers feel real — don't just say "thirty percent higher," say what that actually means in a person's life, and let yourself react to it ("that's — okay, that's a lot"). Be honest about effect sizes and what the study can and can't claim, but don't let honesty kill the momentum. End this section with a short punchy line that pivots toward implications.

6. WHAT THIS MEANS (200 words): Connect findings to real everyday life — make it feel personally relevant, like "this changes how YOU should think about X." Be specific and practical. Then honestly address one or two limitations or reasons to be skeptical — this builds trust, and a good host is excited AND honest, not just hype. End with a line that opens the door to the bigger picture.

7. RE-HOOK #3 — THE BIGGER PICTURE (200 words): Where does this sit in the wider field? What assumptions does it challenge? What important question does it raise that nobody has answered yet? This is the section where curiosity peaks — lean all the way into "okay but THIS is the part that keeps me up at night" territory.

8. SIGN-OFF (100 words): Land on the single most mind-blowing takeaway from the whole video. One short punchy sentence. Then raise one final provocative question the viewer will be thinking about after they close the tab. End with exactly this line: "Turns out, scientists have been busy. And they're not done yet."

CRITICAL FORMATTING RULES:
- Write ONLY the spoken words — no section labels, no stage directions, no markdown, no headers
- Sentences must be short to medium length — maximum 20 words per sentence, aim for 12-15
- Vary sentence length deliberately — short punchy sentences after longer ones create rhythm
- Talk directly to the viewer using "you" often — this is a conversation, not a lecture
- Ban clinical/press-release phrasing outright: never write "researchers found," "the study demonstrates," "data suggest," or similar. Replace with human, excited phrasing: "turns out," "get this," "here's the wild part," "so here's what actually happened," "no, seriously."
- Use exclamation points and short reaction beats ("Wait." / "No, really." / "Let that sink in.") at the biggest moments — sparingly enough that they still hit, not on every sentence
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
  "title": "YouTube video title — should feel genuinely exciting to read, like the host can't believe this is real. Under 60 chars, hint at the finding. Excited framing is fine; don't misrepresent what the study found to get there",
  "short_title": "YouTube Shorts title — under 40 chars, hook-first, ends with a question or surprising claim, should read like a 'wait WHAT' moment",
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
  const metadata = { title: meta.title, shortTitle: meta.short_title || meta.title, summary: meta.summary || "", description, tags: meta.tags };
  log(`Title: "${metadata.title}"`, "ok");
  return metadata;
}

// ─── STEP 3B: GENERATE FOOTAGE SEARCH TERMS ──────────────────────────────────

async function generateFootageSearchTerms(paper, topic) {
  assert(KEYS.anthropic, "Missing ANTHROPIC_API_KEY");
  log("Generating footage search terms...");

  const prompt = `Given this science paper, generate 6 specific visual search terms for stock footage.

Paper title: ${paper.title}
Topic: ${topic.label}

Rules:
- Each term 2-3 words max
- Visually concrete and filmable
- Mix of: close-up scientific visuals, human lifestyle scenes, nature/environment, abstract/conceptual
- Every term must be distinctly different — no two terms should produce similar footage
- Avoid generic terms like "science laboratory" or "medical research" unless highly specific
- Think about the full arc of the video — terms should cover the topic from multiple visual angles

Respond ONLY with a JSON array of exactly 6 strings, no markdown:
["term one", "term two", "term three", "term four", "term five", "term six"]`;

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

// ─── STEP 4: FETCH B-ROLL ─────────────────────────────────────────────────────

// AI b-roll target: fewer unique clips than the old stock-footage count on
// purpose. assembleVideo() already shuffles/loops a fixed pool to fill the
// full runtime, so unique-clip count controls perceived variety, not cost of
// filling the video. 8 clips x 5s x $0.07/s (Kling 2.6 Pro, audio off) =
// ~$2.80/video in generation cost — confirmed against fal.ai's own pricing.
const AI_BROLL_CLIP_COUNT = 8;

// Asks Haiku for concrete, filmable AI-video prompts tied to the actual
// finding — full scene descriptions (camera framing, subject, motion), not
// the 2-3 word stock-search terms the old Pexels/Pixabay path used.
async function generateBrollPrompts(paper, topic, count) {
  assert(KEYS.anthropic, "Missing ANTHROPIC_API_KEY");
  log("Generating AI b-roll scene prompts...");

  const prompt = `Given this science paper, generate ${count} distinct video-generation prompts for short (5-second) b-roll clips to use in a YouTube science video.

Paper title: ${paper.title}
Topic: ${topic.label}
Key finding (abstract): ${paper.abstract.slice(0, 500)}

Rules:
- Each prompt describes ONE concrete, filmable scene: subject, setting, and a simple camera move or subject motion (e.g. "slow push-in", "gentle pan", "subject turns to look at camera")
- Mix of: close-up scientific/biological visuals, human lifestyle scenes relevant to the topic, abstract/conceptual visualizations, nature/environment
- Every prompt must be visually distinct from the others — no two should produce similar-looking footage
- No text, no words, no logos, no watermarks, no on-screen graphics in any prompt
- Realistic, cinematic, documentary-style visuals — not cartoonish or surreal
- Each prompt should be one or two sentences, specific enough to generate a coherent clip

Respond ONLY with a JSON array of exactly ${count} strings, no markdown:
["prompt one", "prompt two", ...]`;

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

  try {
    const raw = response.content?.[0]?.text || "";
    const clean = raw.replace(/```json|```/g, "").trim();
    const prompts = JSON.parse(clean);
    if (Array.isArray(prompts) && prompts.length > 0) {
      log(`Generated ${prompts.length} b-roll prompts`, "ok");
      return prompts;
    }
  } catch (e) {
    log("Failed to parse b-roll prompts — falling back to topic default", "warn");
  }
  return Array(count).fill(`A cinematic, documentary-style shot related to ${topic.label}, slow camera movement, no text or graphics.`);
}

// Generates one 5s b-roll clip via fal.ai's Kling 2.6 Pro text-to-video
// (~$0.35/clip with audio explicitly disabled — generate_audio defaults to
// true and would double the price). Returns null (never throws) on any
// failure so fetchFootage() can fall back to Pexels/Pixabay instead of
// failing the whole pipeline run.
async function generateAIBrollClip(prompt, index) {
  try {
    const response = await fetchJSON("https://fal.run/fal-ai/kling-video/v2.6/pro/text-to-video", {
      method: "POST",
      headers: {
        Authorization: `Key ${FAL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt,
        duration: "5",
        aspect_ratio: "16:9",
        generate_audio: false,
      }),
    });
    const videoUrl = response.video?.url;
    if (!videoUrl) {
      log(`  AI b-roll clip ${index + 1} returned no video: ${JSON.stringify(response).slice(0, 300)}`, "warn");
      return null;
    }
    const dest = path.join(TMP, `ai_broll_${index}.mp4`);
    await fetchBinary(videoUrl, dest);
    log(`  AI b-roll clip ${index + 1}/${AI_BROLL_CLIP_COUNT} generated`, "ok");
    return dest;
  } catch (e) {
    log(`  AI b-roll clip ${index + 1} failed: ${e.message}`, "warn");
    return null;
  }
}

// Old Pexels + Pixabay stock-footage sourcing — kept as the fallback path for
// when FAL_KEY isn't set, or the AI b-roll pass comes back too thin.
async function fetchStockFootage(topic, paper) {
  assert(KEYS.pexels, "Missing PEXELS_API_KEY");

  const searchTerms = await generateFootageSearchTerms(paper, topic);
  const TARGET_CLIPS = 32; // was 24 — more unique clips means fewer repeats over a 10-minute video
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

async function fetchFootage(topic, paper) {
  if (FAL_KEY) {
    log(`Generating AI b-roll via Kling 2.6 Pro (${AI_BROLL_CLIP_COUNT} clips, ~$${(AI_BROLL_CLIP_COUNT * 5 * 0.07).toFixed(2)})...`);
    const prompts = await generateBrollPrompts(paper, topic, AI_BROLL_CLIP_COUNT);
    const aiClips = [];
    for (let i = 0; i < prompts.length; i++) {
      const clip = await generateAIBrollClip(prompts[i], i);
      if (clip) aiClips.push(clip);
    }
    // Require at least half the target count before trusting the AI batch —
    // otherwise fall through to stock footage rather than shipping a video
    // that loops 2-3 clips the whole way through.
    if (aiClips.length >= Math.ceil(AI_BROLL_CLIP_COUNT / 2)) {
      log(`AI b-roll: ${aiClips.length}/${AI_BROLL_CLIP_COUNT} clips generated`, "ok");
      return aiClips;
    }
    log(`AI b-roll only produced ${aiClips.length}/${AI_BROLL_CLIP_COUNT} usable clips — falling back to stock footage`, "warn");
  } else {
    log("FAL_KEY not set — using stock footage (Pexels/Pixabay)", "warn");
  }
  return fetchStockFootage(topic, paper);
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

  // Shuffle the clip order on every loop pass (instead of repeating the exact
  // same sequence each time) so a 10-minute video doesn't visibly cycle the
  // same 24-32 clips in the same order every ~90 seconds. First pass keeps the
  // original order (it's usually the most deliberately-varied one from the
  // search terms); every later pass is re-shuffled.
  const repeats = Math.ceil(audioDuration / (normalizedPaths.length * 4)) + 2;
  let fullContent = "";
  for (let i = 0; i < repeats; i++) {
    const order = i === 0 ? normalizedPaths : shuffle(normalizedPaths);
    for (const p of order) fullContent += `file '${p}'\n`;
  }
  fs.writeFileSync(concatList, fullContent);

  execSync(
    `ffmpeg -y -f concat -safe 0 -i "${concatList}" -t ${audioDuration} -c copy "${scaledFootage}" 2>/dev/null`,
    { stdio: "pipe" }
  );

  // Background music bed: loop the bumper track under the narration at low
  // volume, faded in/out, mixed with the voiceover (not replacing it).
  // Falls back to voice-only if the asset is missing rather than failing the
  // whole video.
  const musicSrc = path.join(CONFIG.ASSETS_DIR, "bumper_music.mp3");
  let musicBedPath = null;
  if (fs.existsSync(musicSrc)) {
    musicBedPath = path.join(TMP, "music_bed.m4a");
    const fadeOutStart = Math.max(audioDuration - 2, 0);
    try {
      execSync(
        `ffmpeg -y -stream_loop -1 -i "${musicSrc}" -t ${audioDuration} ` +
        `-af "afade=t=in:st=0:d=2,afade=t=out:st=${fadeOutStart}:d=2,volume=${CONFIG.MUSIC_BED_VOLUME}" ` +
        `-c:a aac -b:a 128k "${musicBedPath}" 2>/dev/null`,
        { stdio: "pipe" }
      );
    } catch (e) {
      log(`Music bed build failed — continuing voice-only: ${e.message}`, "warn");
      musicBedPath = null;
    }
  } else {
    log("assets/bumper_music.mp3 not found — video will be voice-only, no music bed", "warn");
  }

  const audioMixCmd = musicBedPath
    ? `-i "${scaledFootage}" -i "${audioPath}" -i "${musicBedPath}" ` +
      `-filter_complex "[1:a][2:a]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[aout]" ` +
      `-map 0:v:0 -map "[aout]"`
    : `-i "${scaledFootage}" -i "${audioPath}" -map 0:v:0 -map 1:a:0`;

  const ffmpegOutput = execSync(
    `ffmpeg -y \
      ${audioMixCmd} \
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

// Asks Haiku for one concrete, filmable visual concept tied to the actual
// finding (not a generic "scientist in a lab" cliche), for use as the AI
// thumbnail image prompt.
async function generateThumbnailConcept(paper, topic) {
  const prompt = `Come up with ONE vivid, concrete visual scene for a YouTube science video thumbnail illustrating this finding, in one or two sentences. It must be a specific, paintable image — not an abstract concept, and not a generic person-in-a-lab-coat-holding-a-test-tube unless the study is literally about lab work. Make it visually striking, slightly surreal or dramatic — the kind of image that stops a thumb mid-scroll.

Study title: ${paper.title}
Topic: ${topic.label}
Key finding (abstract): ${paper.abstract.slice(0, 500)}

Respond with ONLY the visual scene description — no preamble, no quotes, no markdown.`;
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
  const concept = response.content?.[0]?.text?.trim();
  return concept || `A striking, symbolic scene representing: ${topic.label}`;
}

// Generates the thumbnail's background art via fal.ai's Nano Banana Pro
// (~$0.15/video). Returns null (never throws) on any failure — including
// FAL_KEY not being set — so generateThumbnail() can fall back to the old
// video-frame-grab approach instead of failing the whole pipeline run.
async function generateAIThumbnailBackground(paper, topic) {
  if (!FAL_KEY) {
    log("FAL_KEY not set — skipping AI thumbnail, using video-frame fallback", "warn");
    return null;
  }
  try {
    const concept = await generateThumbnailConcept(paper, topic);
    log(`AI thumbnail concept: "${concept.slice(0, 100)}${concept.length > 100 ? "..." : ""}"`);
    const imagePrompt =
      `Bold, vivid digital illustration for a YouTube science video thumbnail. ${concept} ` +
      `Style: bold flat colors, dramatic high-contrast lighting, slightly surreal and eye-catching, ` +
      `cinematic composition, dark navy and warm amber color palette, no text, no words, no letters, ` +
      `no logos, no watermarks. Leave the lower third of the frame relatively simple and uncluttered ` +
      `so text can be overlaid there.`;
    const response = await fetchJSON("https://fal.run/fal-ai/nano-banana-pro", {
      method: "POST",
      headers: {
        Authorization: `Key ${FAL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: imagePrompt,
        aspect_ratio: "16:9",
        resolution: "1K",
        num_images: 1,
      }),
    });
    const imageUrl = response.images?.[0]?.url;
    if (!imageUrl) {
      log(`AI thumbnail generation returned no image: ${JSON.stringify(response).slice(0, 300)}`, "warn");
      return null;
    }
    const bgPath = path.join(TMP, "ai_thumb_bg.png");
    await fetchBinary(imageUrl, bgPath);
    log("AI thumbnail background generated (Nano Banana Pro, ~$0.15)", "ok");
    return bgPath;
  } catch (e) {
    log(`AI thumbnail generation failed — falling back to video frame: ${e.message}`, "warn");
    return null;
  }
}

async function generateThumbnail(videoPath, metadata, topic, paper) {
  log("Generating thumbnail...");
  const thumbPath = path.join(TMP, "thumbnail.jpg");

  const aiBg = await generateAIThumbnailBackground(paper, topic);
  let basePath;
  if (aiBg) {
    // Normalize whatever aspect/resolution fal.ai returned to an exact
    // 1280x720 canvas so the drawtext coordinates below stay correct.
    basePath = path.join(TMP, "thumb_base.jpg");
    execSync(
      `ffmpeg -y -i "${aiBg}" -vf "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720" -q:v 2 "${basePath}" 2>/dev/null`,
      { stdio: "pipe" }
    );
  } else {
    // Fallback: original video-frame-grab + color-grade approach.
    const duration = parseFloat(
      execSync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`
      ).toString().trim()
    );
    const seekTo = (duration * 0.20).toFixed(2);
    const rawFrame = path.join(TMP, "raw_frame.jpg");
    execSync(`ffmpeg -y -ss ${seekTo} -i "${videoPath}" -vframes 1 -q:v 2 "${rawFrame}" 2>/dev/null`, { stdio: "pipe" });
    basePath = path.join(TMP, "darkened_frame.jpg");
    execSync(
      `ffmpeg -y -i "${rawFrame}" -vf "eq=brightness=-0.28:contrast=0.88,colorchannelmixer=rr=0.92:gg=0.86:bb=0.78" "${basePath}" 2>/dev/null`,
      { stdio: "pipe" }
    );
  }

  const [line1 = "", line2 = ""] = wrapTextLines(metadata.title, 28, 2);
  const topicLabel = topic.label.toUpperCase();
  const font = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
  const topicLabelFile = writeDrawTextFile(topicLabel, "thumb_topic.txt");
  const wordmarkFile = writeDrawTextFile("TURNS OUT", "thumb_wordmark.txt");
  const line1File = writeDrawTextFile(line1, "thumb_line1.txt");
  let vf = [
    `drawbox=x=0:y=480:w=iw:h=240:color=#1A1610@0.72:t=fill`,
    `drawbox=x=30:y=30:w=230:h=40:color=#C17B2F@1.0:t=fill`,
    `drawtext=fontfile='${font}':textfile='${topicLabelFile}':fontsize=18:fontcolor=#1A1610:x=42:y=41`,
    `drawtext=fontfile='${font}':textfile='${wordmarkFile}':fontsize=15:fontcolor=#8A7F6B:x=w-tw-30:y=42`,
    `drawtext=fontfile='${font}':textfile='${line1File}':fontsize=54:fontcolor=#F5EDD8:x=30:y=492:shadowcolor=black@0.8:shadowx=2:shadowy=2`,
  ];
  if (line2) {
    const line2File = writeDrawTextFile(line2, "thumb_line2.txt");
    vf.push(`drawtext=fontfile='${font}':textfile='${line2File}':fontsize=54:fontcolor=#F5EDD8:x=30:y=556:shadowcolor=black@0.8:shadowx=2:shadowy=2`);
  }
  execSync(`ffmpeg -y -i "${basePath}" -vf "${vf.join(",")}" -q:v 2 "${thumbPath}" 2>/dev/null`, { stdio: "pipe" });
  log(`Thumbnail generated (1280×720, ${aiBg ? "AI background" : "video-frame fallback"})`, "ok");
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

  const prompt = `You are writing a YouTube Shorts script for "Turns Out" — a science channel hosted by someone who just cannot get over how cool this finding is and has to tell you before you scroll away. Delighted, breathless, "wait, WHAT?!" energy — not a news anchor reading a summary.

Study title: ${paper.title}
Topic: ${topic.label}
Abstract: ${paper.abstract}

Write a self-contained, punchy script of approximately 130 words that:
- Opens with the single most surprising finding — no setup, no "today we're talking about" — say it like you genuinely can't believe it
- Delivers 2-3 concrete details from the study in plain, excited English, talking directly to the viewer with "you"
- Bans clinical phrasing like "researchers found" or "the study shows" — use "turns out," "get this," "here's the wild part" instead
- Must work as a STANDALONE piece — the viewer has not seen the long-form video
- Ends with exactly this line as the final sentence: "Full breakdown is one tap away."

CRITICAL FORMATTING RULES:
- Write ONLY the spoken words — no labels, no markdown
- Short, punchy sentences — max 15 words each
- One or two exclamation points at the biggest moment is fine — don't overdo it every line
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
      execSync(
        `ffmpeg -y -i "${clipPaths[i]}" -vf "scale=1920:1080:force_original_aspect_ratio=increase,crop=608:1080:656:0,scale=1080:1920,fps=30" -c:v libx264 -preset ultrafast -crf 23 -an "${vPath}" 2>/dev/null`,
        { stdio: "pipe" }
      );
      verticalClips.push(vPath);
    } catch (e) {
      log(`  Skipping clip ${i} for Short (conversion failed)`, "warn");
    }
  }
  assert(verticalClips.length, "No usable clips for Short");

  const repeats = Math.ceil(audioDuration / (verticalClips.length * 4)) + 2;
  let fullContent = "";
  for (let i = 0; i < repeats; i++) {
    const order = i === 0 ? verticalClips : shuffle(verticalClips);
    for (const p of order) fullContent += `file '${p}'\n`;
  }
  fs.writeFileSync(shortConcat, fullContent);

  execSync(
    `ffmpeg -y -f concat -safe 0 -i "${shortConcat}" -t ${audioDuration} -c copy "${shortFootage}" 2>/dev/null`,
    { stdio: "pipe" }
  );

  // Step 3: Title overlay + end-screen callout
  const MAX_CHARS_PER_LINE = 13; // tuned for fontsize=64 on a 1080px-wide canvas with margin
  const [line1 = "", line2 = "", line3 = ""] = wrapTextLines(metadata.shortTitle, MAX_CHARS_PER_LINE, 3);
  const topicLabel = topic.label.toUpperCase();

  const topicLabelFile = writeDrawTextFile(topicLabel, "short_topic.txt");
  const line1File = writeDrawTextFile(line1, "short_line1.txt");
  const wordmarkFile = writeDrawTextFile("TURNS OUT", "short_wordmark.txt");
  const calloutFile = writeDrawTextFile("Full video on channel", "short_callout.txt");

  let vf = [
    `drawbox=x=0:y=0:w=iw:h=700:color=#1A1610@0.75:t=fill`,
    `drawbox=x=(iw-240)/2:y=40:w=240:h=44:color=#C17B2F@1.0:t=fill`,
    `drawtext=fontfile='${font}':textfile='${topicLabelFile}':fontsize=20:fontcolor=#1A1610:x=(w-tw)/2:y=50`,
    `drawtext=fontfile='${font}':textfile='${line1File}':fontsize=64:fontcolor=#F5EDD8:x=(w-tw)/2:y=150:shadowcolor=black@0.8:shadowx=2:shadowy=2`,
  ];
  if (line2) {
    const line2File = writeDrawTextFile(line2, "short_line2.txt");
    vf.push(`drawtext=fontfile='${font}':textfile='${line2File}':fontsize=64:fontcolor=#F5EDD8:x=(w-tw)/2:y=230:shadowcolor=black@0.8:shadowx=2:shadowy=2`);
  }
  if (line3) {
    const line3File = writeDrawTextFile(line3, "short_line3.txt");
    vf.push(`drawtext=fontfile='${font}':textfile='${line3File}':fontsize=64:fontcolor=#F5EDD8:x=(w-tw)/2:y=310:shadowcolor=black@0.8:shadowx=2:shadowy=2`);
  }
  vf.push(`drawtext=fontfile='${font}':textfile='${wordmarkFile}':fontsize=22:fontcolor=#8A7F6B:x=(w-tw)/2:y=h-60`);
  vf.push(`drawtext=fontfile='${font}':textfile='${calloutFile}':fontsize=24:fontcolor=#C17B2F:x=(w-tw)/2:y=h-110:enable='gte(t,${(audioDuration - 4).toFixed(1)})'`);

  try {
    execSync(
      `ffmpeg -y \
        -i "${shortFootage}" \
        -i "${shortAudio}" \
        -map 0:v:0 -map 1:a:0 \
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
    log("DRY RUN — YouTube upload, thumbnail set, playlist writes, and Short upload will be skipped.", "warn");
  }

  // In DRY_RUN, the four YouTube OAuth keys aren't needed since nothing YouTube-related runs.
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
    const { paper, topic } = await fetchPaperWithRetry();
    log("Topic selected: " + topic.label);
    const script    = await generateScript(paper, topic);
    const metadata  = await generateMetadata(paper, script, topic);
    const clips     = await fetchFootage(topic, paper);
    const audio     = await generateVoiceover(script);
    const video     = await assembleVideo(clips, audio, metadata.title);
    const thumb     = await generateThumbnail(video, metadata, topic, paper);
    const publishAt = schedulePublishTime();

    let videoId = null;
    if (!DRY_RUN) {
      videoId = await uploadToYouTube(video, metadata, publishAt);
      await uploadThumbnail(videoId, thumb);

      try {
        const playlistId = await getOrCreatePlaylist(topic.label);
        await addVideoToPlaylist(videoId, playlistId);
      } catch (e) {
        log(`Playlist error: ${e.message} — continuing`, "warn");
      }
    } else {
      log("DRY RUN — skipping YouTube upload, thumbnail set, and playlist writes.", "warn");
    }

    log("\n── Generating matching Short ──");
    let shortPath = null;
    try {
      const assembled = await assembleShort(clips, metadata, topic, paper);
      shortPath = assembled.shortPath;
      if (!DRY_RUN) {
        const shortPublishAt = schedulePublishTime(); // same publish window
        const shortId = await uploadShort(shortPath, metadata, videoId, shortPublishAt);
        console.log(`   Short:      https://youtube.com/shorts/${shortId}`);
      } else {
        log("DRY RUN — skipping Short upload.", "warn");
      }
    } catch (e) {
      log(`Short generation failed: ${e.message} — continuing without Short`, "warn");
    }

    const runLog = {
      timestamp: new Date().toISOString(),
      topic: topic.label,
      paper: { pmid: paper.pmid, title: paper.title, authors: paper.authors, journal: paper.journal, date: paper.date, doi: paper.doi, url: paper.url },
      videoId,
      title: metadata.title,
      publishAt,
      wordCount: script.split(" ").length,
      dryRun: DRY_RUN,
    };

    fs.writeFileSync(path.join(__dirname, `run_log_${Date.now()}.json`), JSON.stringify(runLog, null, 2));

    if (DRY_RUN) {
      console.log("\n⚠ DRY RUN — skipping YouTube upload. Inspect output at:");
      console.log(`   Video:      ${video}`);
      console.log(`   Thumbnail:  ${thumb}`);
      if (shortPath) console.log(`   Short:      ${shortPath}`);
      console.log("   (tmp/ was left in place — not cleaned up)\n");
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
