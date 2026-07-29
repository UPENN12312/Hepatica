#!/usr/bin/env node
/**
 * Hepatica — Liver Cancer Research Assistant
 * ============================================================
 * AI:       Google Gemini (AI Studio free tier)
 * Research: PubMed · Europe PMC · ClinicalTrials.gov
 * Hosting:  Render free tier
 *
 * v2.0 — Production-hardened with circuit breakers, caching,
 *        research deduplication, structured logging, and
 *        graceful degradation.
 */

import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import compression from "compression";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

/* ============================================================
   1. CONFIG & ENV VALIDATION
   ============================================================ */
const CONFIG = {
  GEMINI_KEY: process.env.GEMINI_API_KEY || "",
  GEMINI_MODEL: process.env.GEMINI_MODEL || "gemini-flash-latest",
  PORT: parseInt(process.env.PORT || "3000", 10),
  SHOW_ERRORS: process.env.SHOW_ERRORS === "true",
  NODE_ENV: process.env.NODE_ENV || "development",

  // Rate limits
  RATE_WINDOW_MS: 15 * 60 * 1000,
  RATE_MAX_PER_IP: 15,
  DAILY_CAP: 1200,

  // Timeouts & retries
  FETCH_TIMEOUT_MS: 8000,
  MAX_RETRIES: 2,
  RETRY_DELAY_MS: 800,

  // Cache
  CACHE_MAX_SIZE: 200,
  CACHE_TTL_MS: 10 * 60 * 1000, // 10 min

  // Circuit breaker
  CB_FAILURE_THRESHOLD: 5,
  CB_RESET_TIMEOUT_MS: 30000,

  // Research
  RESEARCH_CONCURRENCY: 3,
  MAX_ABSTRACT_CHARS: 1400,
  MAX_PAPERS: 6,
  MAX_TRIALS: 3,
};

if (!CONFIG.GEMINI_KEY) {
  console.warn("[INIT] WARNING: GEMINI_API_KEY not set — chat will fail.");
}

/* ============================================================
   2. STRUCTURED LOGGER
   ============================================================ */
class Logger {
  static log(level, msg, meta = {}) {
    const entry = {
      time: new Date().toISOString(),
      level,
      msg,
      ...meta,
    };
    // Render free tier: stdout goes to Logs tab
    console.log(JSON.stringify(entry));
  }
  static info(m, meta) { this.log("info", m, meta); }
  static warn(m, meta) { this.log("warn", m, meta); }
  static error(m, meta) { this.log("error", m, meta); }
}

/* ============================================================
   3. TTL LRU CACHE
   ============================================================ */
class TTLCache {
  constructor(maxSize = 100, ttlMs = 5 * 60 * 1000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.cache = new Map(); // key → {value, expiry}
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value) {
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
    this.cache.set(key, { value, expiry: Date.now() + this.ttlMs });
  }

  stats() {
    let valid = 0;
    for (const [, e] of this.cache) {
      if (Date.now() <= e.expiry) valid++;
    }
    return { size: this.cache.size, valid };
  }
}

const researchCache = new TTLCache(CONFIG.CACHE_MAX_SIZE, CONFIG.CACHE_TTL_MS);

/* ============================================================
   4. CIRCUIT BREAKER
   ============================================================ */
class CircuitBreaker {
  constructor(name, fn, {
    failureThreshold = 5,
    resetTimeoutMs = 30000,
  } = {}) {
    this.name = name;
    this.fn = fn;
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.state = "CLOSED"; // CLOSED, OPEN, HALF_OPEN
    this.failures = 0;
    this.lastFailureTime = null;
    this.successes = 0;
  }

  async call(...args) {
    if (this.state === "OPEN") {
      if (Date.now() - this.lastFailureTime > this.resetTimeoutMs) {
        this.state = "HALF_OPEN";
        Logger.info(`[CB] ${this.name} entering HALF_OPEN`);
      } else {
        throw new Error(`Circuit breaker OPEN for ${this.name}`);
      }
    }

    try {
      const result = await this.fn(...args);
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  onSuccess() {
    this.failures = 0;
    if (this.state === "HALF_OPEN") {
      this.state = "CLOSED";
      Logger.info(`[CB] ${this.name} CLOSED`);
    }
  }

  onFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.failures >= this.failureThreshold) {
      this.state = "OPEN";
      Logger.warn(`[CB] ${this.name} OPENED after ${this.failures} failures`);
    }
  }

  status() {
    return { name: this.name, state: this.state, failures: this.failures };
  }
}

/* ============================================================
   5. RETRY + TIMEOUT FETCH
   ============================================================ */
async function fetchWithTimeout(url, ms = CONFIG.FETCH_TIMEOUT_MS, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(name, urlFn, options = {}, retries = CONFIG.MAX_RETRIES) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const url = typeof urlFn === "function" ? urlFn() : urlFn;
      const res = await fetchWithTimeout(url, CONFIG.FETCH_TIMEOUT_MS, options);
      if (res.ok) return res;
      // 429 or 5xx → retry; 4xx (except 429) → don't retry
      if (res.status !== 429 && res.status < 500) {
        throw new Error(`${name} HTTP ${res.status}`);
      }
      lastErr = new Error(`${name} HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
      if (err.name === "AbortError") lastErr = new Error(`${name} timeout`);
    }

    if (i < retries) {
      const delay = CONFIG.RETRY_DELAY_MS * Math.pow(2, i);
      Logger.warn(`[Retry] ${name} attempt ${i + 1} failed, waiting ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/* ============================================================
   6. CONCURRENCY SEMAPHORE
   ============================================================ */
function createSemaphore(max) {
  let running = 0;
  const queue = [];
  return async function acquire(fn) {
    if (running >= max) {
      await new Promise(r => queue.push(r));
    }
    running++;
    try {
      return await fn();
    } finally {
      running--;
      if (queue.length) queue.shift()();
    }
  };
}
const researchSemaphore = createSemaphore(CONFIG.RESEARCH_CONCURRENCY);

/* ============================================================
   7. EXPRESS SETUP
   ============================================================ */
app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(compression());
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

// Request ID for tracing
app.use((req, res, next) => {
  req.id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  res.setHeader("X-Request-ID", req.id);
  next();
});

/* ============================================================
   8. RATE LIMITING & BUDGET
   ============================================================ */
const ipDailyCounts = new Map(); // ip → {count, resetAt}

const chatLimiter = rateLimit({
  windowMs: CONFIG.RATE_WINDOW_MS,
  max: CONFIG.RATE_MAX_PER_IP,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "You've hit the message limit for this window. Please wait about 15 minutes.",
  },
});

let globalDailyCount = 0;
let globalDailyResetAt = Date.now() + 24 * 60 * 60 * 1000;

function checkDailyBudget() {
  const now = Date.now();
  if (now > globalDailyResetAt) {
    globalDailyCount = 0;
    globalDailyResetAt = now + 24 * 60 * 60 * 1000;
    ipDailyCounts.clear();
    Logger.info("[Budget] Daily budget reset");
  }
  return globalDailyCount < CONFIG.DAILY_CAP;
}

function checkIpDailyBudget(ip) {
  const now = Date.now();
  let entry = ipDailyCounts.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 24 * 60 * 60 * 1000 };
    ipDailyCounts.set(ip, entry);
  }
  // Per-IP soft cap: 30/day (generous but prevents one user burning quota)
  return entry.count < 30;
}

function incrementBudget(ip) {
  globalDailyCount++;
  const entry = ipDailyCounts.get(ip);
  if (entry) entry.count++;
}

/* ============================================================
   9. QUERY INTELLIGENCE
   ============================================================ */
function analyzeQuery(message) {
  const lower = message.toLowerCase();
  const urgent = [
    "vomit blood", "black stool", "yellow eye", "yellow skin", "jaundice",
    "confusion", "severe pain", "swollen belly", "ascites", "faint",
  ];
  const isUrgent = urgent.some(k => lower.includes(k));

  const labTerms = ["afp", "alt", "ast", "platelet", "bilirubin", "albumin", "inr", "fib-4", "apri"];
  const isLab = labTerms.some(k => lower.includes(k));

  const imaging = ["li-rads", "ct scan", "mri", "ultrasound", "lesion", "mass", "tumor", "nodule"];
  const isImaging = imaging.some(k => lower.includes(k));

  const trialTerms = ["clinical trial", "study", "recruiting", "enroll", "experiment"];
  const wantsTrials = trialTerms.some(k => lower.includes(k));

  return { isUrgent, isLab, isImaging, wantsTrials };
}

/* ============================================================
   10. RESEARCH SERVICES
   ============================================================ */
async function _fetchPubMed(userQuery, maxResults = 5) {
  const scoped = `(${userQuery}) AND (hepatocellular carcinoma[Title/Abstract] OR liver cancer[Title/Abstract] OR cholangiocarcinoma[Title/Abstract] OR hepatic neoplasm[MeSH Terms])`;

  const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(scoped)}&retmax=${maxResults}&retmode=json&sort=relevance`;

  const searchRes = await fetchWithRetry("PubMed-search", searchUrl);
  const searchData = await searchRes.json();
  let ids = searchData.esearchresult?.idlist || [];

  if (ids.length === 0) {
    const fbUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent("hepatocellular carcinoma risk factors surveillance")}&retmax=3&retmode=json&sort=relevance`;
    const fbRes = await fetchWithRetry("PubMed-fallback", fbUrl);
    ids = (await fbRes.json()).esearchresult?.idlist || [];
  }
  if (ids.length === 0) return [];

  const sumUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.join(",")}&retmode=json`;
  const sumRes = await fetchWithRetry("PubMed-summary", sumUrl);
  const sumData = await sumRes.json();

  const papers = [];
  for (const [key, doc] of Object.entries(sumData.result || {})) {
    if (key === "uids" || !doc?.uid) continue;
    const authorList = doc.authors?.slice(0, 3).map(a => a.name).join(", ");
    papers.push({
      type: "paper",
      title: (doc.title || "Untitled").replace(/<\/?[^>]+>/g, ""),
      authors: authorList ? authorList + (doc.authors.length > 3 ? ", et al." : "") : "Unknown",
      journal: doc.fulljournalname || doc.source || "",
      pubdate: doc.pubdate || "",
      year: parseInt((doc.pubdate || "").match(/\d{4}/)?.[0], 10) || 0,
      url: `https://pubmed.ncbi.nlm.nih.gov/${doc.uid}/`,
      source: "pubmed",
      pmid: doc.uid,
    });
  }
  return papers;
}

async function _fetchEuropePMC(userQuery, maxResults = 4) {
  const q = `(${userQuery}) AND (hepatocellular carcinoma OR "liver cancer" OR cholangiocarcinoma) AND (HAS_ABSTRACT:Y)`;
  const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(q)}&format=json&pageSize=${maxResults}&resultType=core&sort=CITED%20desc`;

  const res = await fetchWithRetry("EuropePMC", url);
  const data = await res.json();

  const out = [];
  for (const r of data.resultList?.result || []) {
    if (!r.abstractText) continue;
    const abstract = r.abstractText
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, CONFIG.MAX_ABSTRACT_CHARS);

    out.push({
      type: "paper",
      title: (r.title || "Untitled").replace(/<[^>]+>/g, "").trim(),
      authors: r.authorString || "Unknown",
      journal: r.journalTitle || "",
      pubdate: r.pubYear || "",
      year: parseInt(r.pubYear, 10) || 0,
      abstract,
      url: r.doi ? `https://doi.org/${r.doi}` : r.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/` : `https://europepmc.org/article/${r.source}/${r.id}`,
      source: "europepmc",
      pmid: r.pmid || null,
      doi: r.doi || null,
    });
  }
  return out;
}

async function _fetchClinicalTrials(userQuery, maxResults = 3) {
  const url = `https://clinicaltrials.gov/api/v2/studies?query.cond=${encodeURIComponent("liver cancer OR hepatocellular carcinoma")}&query.term=${encodeURIComponent(userQuery)}&filter.overallStatus=RECRUITING&pageSize=${maxResults}&fields=NCTId,BriefTitle,OverallStatus,Phase`;

  const res = await fetchWithRetry("ClinicalTrials", url);
  const data = await res.json();

  const trials = [];
  for (const study of data.studies || []) {
    const p = study.protocolSection;
    const nctId = p?.identificationModule?.nctId;
    if (!nctId) continue;
    trials.push({
      type: "trial",
      title: p?.identificationModule?.briefTitle || "Untitled trial",
      status: p?.statusModule?.overallStatus || "Unknown",
      phase: p?.designModule?.phases?.join(", ") || "N/A",
      url: `https://clinicaltrials.gov/study/${nctId}`,
      source: "clinicaltrials",
    });
  }
  return trials;
}

// Wrap in circuit breakers
const cbPubMed = new CircuitBreaker("PubMed", _fetchPubMed, {
  failureThreshold: CONFIG.CB_FAILURE_THRESHOLD,
  resetTimeoutMs: CONFIG.CB_RESET_TIMEOUT_MS,
});
const cbEuropePMC = new CircuitBreaker("EuropePMC", _fetchEuropePMC, {
  failureThreshold: CONFIG.CB_FAILURE_THRESHOLD,
  resetTimeoutMs: CONFIG.CB_RESET_TIMEOUT_MS,
});
const cbTrials = new CircuitBreaker("ClinicalTrials", _fetchClinicalTrials, {
  failureThreshold: CONFIG.CB_FAILURE_THRESHOLD,
  resetTimeoutMs: CONFIG.CB_RESET_TIMEOUT_MS,
});

/* ============================================================
   11. RESEARCH AGGREGATION & DEDUPLICATION
   ============================================================ */
function normalizeTitle(t) {
  return t.toLowerCase().replace(/[^\w]/g, "").slice(0, 60);
}

function scorePaper(paper, query) {
  let score = 0;
  const qWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const title = paper.title.toLowerCase();

  // Recency boost (last 5 years)
  if (paper.year >= 2020) score += 15;
  else if (paper.year >= 2015) score += 8;

  // Guideline / review boost
  const guidelineTerms = ["guideline", "consensus", "recommendation", "aasld", "easl", "acr", "apasl"];
  if (guidelineTerms.some(t => title.includes(t))) score += 20;

  // Meta-analysis / review
  if (title.includes("meta-analysis") || title.includes("systematic review")) score += 12;

  // Keyword match in title
  for (const w of qWords) {
    if (title.includes(w)) score += 5;
  }

  // Prefer papers with abstracts
  if (paper.abstract) score += 10;

  return score;
}

async function gatherResearch(message, wantsTrials) {
  const cacheKey = `research:${message.toLowerCase().trim().slice(0, 80)}:${wantsTrials ? 1 : 0}`;
  const cached = researchCache.get(cacheKey);
  if (cached) {
    Logger.info("[Cache] Research cache hit", { cacheKey });
    return cached;
  }

  const results = await researchSemaphore(async () => {
    const promises = [
      cbEuropePMC.call(message, 5).catch(err => {
        Logger.error("[Research] EuropePMC failed", { error: err.message });
        return [];
      }),
      cbPubMed.call(message, 4).catch(err => {
        Logger.error("[Research] PubMed failed", { error: err.message });
        return [];
      }),
    ];

    if (wantsTrials) {
      promises.push(
        cbTrials.call(message, CONFIG.MAX_TRIALS).catch(err => {
          Logger.error("[Research] ClinicalTrials failed", { error: err.message });
          return [];
        })
      );
    }

    const [europePapers, pubmedPapers, trials = []] = await Promise.all(promises);
    return { europePapers, pubmedPapers, trials };
  });

  // Deduplicate: Europe PMC has abstracts (preferred), PubMed fills gaps
  const seen = new Set();
  const papers = [];

  // Add Europe PMC first (has abstracts)
  for (const p of results.europePapers) {
    const key = normalizeTitle(p.title);
    if (!seen.has(key)) {
      seen.add(key);
      papers.push({ ...p, score: scorePaper(p, message) });
    }
  }

  // Top up with PubMed, skipping duplicates
  for (const p of results.pubmedPapers) {
    const key = normalizeTitle(p.title);
    if (!seen.has(key)) {
      seen.add(key);
      papers.push({ ...p, score: scorePaper(p, message) });
    }
  }

  // Sort by score descending, cap
  papers.sort((a, b) => b.score - a.score);

  const output = {
    papers: papers.slice(0, CONFIG.MAX_PAPERS),
    trials: wantsTrials ? results.trials.slice(0, CONFIG.MAX_TRIALS) : [],
  };

  researchCache.set(cacheKey, output);
  return output;
}

/* ============================================================
   12. PROMPT ENGINE
   ============================================================ */
const CLINICAL_BACKGROUND = `
LIVER CANCER CLINICAL BACKGROUND (reference material for accurate explanation):

PRIMARY LIVER CANCER TYPES
- Hepatocellular carcinoma (HCC): ~75-85% of primary liver cancers
- Intrahepatic cholangiocarcinoma (iCCA): ~10-15%
- Rarer: fibrolamellar carcinoma, hepatoblastoma, hepatic angiosarcoma
- Liver METASTASES are far more common than primary liver cancer

MAJOR RISK FACTORS FOR HCC
- Chronic hepatitis B (HBV) — can cause HCC even without cirrhosis
- Chronic hepatitis C (HCV) — risk persists after cure if cirrhosis established
- Cirrhosis from any cause — single strongest risk factor
- Alcohol-related liver disease, MASLD/MASH, type 2 diabetes, obesity
- Aflatoxin B1 exposure, hereditary hemochromatosis, alpha-1 antitrypsin deficiency
- Male sex (~2-3x), increasing age, family history, tobacco

CHOLANGIOCARCINOMA RISK FACTORS
- Primary sclerosing cholangitis (PSC), liver fluke infection, choledochal cysts

SURVEILLANCE
- AASLD/EASL recommend HCC surveillance for defined high-risk groups (cirrhosis, selected HBV)
- Typically abdominal ultrasound every ~6 months, with/without serum AFP
- Surveillance is screening for high-risk groups, NOT diagnosis

LAB MARKERS
- AFP: imperfect sensitivity/specificity. Elevated in cirrhosis, hepatitis, pregnancy, germ cell tumors. Can be normal in confirmed HCC.
- AFP-L3%, DCP/PIVKA-II: adjunct markers
- ALT/AST: injury markers, NOT cancer markers
- FIB-4, APRI: non-invasive fibrosis estimates

IMAGING
- LI-RADS: LR-1 (definitely benign) → LR-5 (definitely HCC), LR-M, LR-TIV
- HCC features: arterial phase hyperenhancement with washout
- Common benign lesions: hemangiomas, FNH, adenomas, cysts

STAGING
- BCLC most widely used for HCC
`;

const CANCER_STATISTICS = `
POPULATION STATISTICS — US (SEER / ACS 2025)
- Estimated new liver/intrahepatic bile duct cancers 2025: ~42,240
- Estimated deaths: ~30,090
- Overall 5-year relative survival: ~22% (up from ~3% in mid-1970s)
- Survival differs sharply by stage at diagnosis
- Only give if asked. Always frame as population averages from years ago, not individual prediction.
`;

const SAFETY_RULES = `
ABSOLUTE RULES:
1. NEVER diagnose or imply cancer presence/absence.
2. NEVER give a probability, risk score, or likelihood.
3. NEVER interpret specific lab/imaging results as indicating cancer or ruling it out.
4. NEVER recommend, adjust, or discourage treatment/medication/supplements.
5. NEVER tell someone they don't need to see a doctor.
6. Flag urgent symptoms EARLY in the reply (jaundice, vomiting blood, black stools, confusion, severe pain/swelling, significant weight loss).
7. If already diagnosed: be supportive, informative, don't second-guess doctors.
8. Acknowledge fear plainly before continuing.
9. Cite retrieved research by title and link. If research doesn't address the question, say so.
10. Do not speculate beyond literature.
`;

function buildSystemPrompt(researchContext, queryMeta) {
  const urgencyNote = queryMeta.isUrgent
    ? `\nURGENCY DETECTED: The user mentioned symptoms that may warrant prompt evaluation. Lead with how soon to be seen.`
    : "";

  const labNote = queryMeta.isLab
    ? `\nLAB REPORT NOTE: The user may be asking about lab values. Explain what markers measure in general. NEVER tell them their particular value is normal, abnormal, concerning, or reassuring.`
    : "";

  const imagingNote = queryMeta.isImaging
    ? `\nIMAGING NOTE: The user may be asking about imaging results. Explain what terms mean in general (LI-RADS categories, etc.). NEVER interpret their specific findings as cancer or benign.`
    : "";

  return `You are Hepatica, an educational liver-health assistant. You translate published medical literature into plain language so people can have better-informed conversations with their healthcare providers.

You are NOT a doctor and you do NOT diagnose.

WHAT YOU DO
1. When someone describes their situation, tell them what published guidelines say for people in that category. Frame as "guidelines recommend X for people with Y — ask your doctor if you qualify."
2. Say explicitly how soon to be seen (same day / within 1-2 weeks / routine appointment). Put this near the TOP.
3. End with a concrete next step: which kind of doctor, and one sentence they could read aloud.
4. Cite retrieved research with bracket numbers [1] when stating specific claims from it.

HOW SOON TO BE SEEN
- SAME DAY / EMERGENCY: yellowing eyes/skin, vomiting blood, black tarry stools, confusion, severe abdominal pain, rapidly swollen hard belly.
- WITHIN 1-2 WEEKS: unexplained weight loss, persistent RUQ pain, ongoing nausea/loss of appetite, palpable lump, unusual fatigue not improving.
- ROUTINE: no symptoms, risk-factor questions, non-urgent test result questions.

If unsure which bucket, choose the more urgent one.

${urgencyNote}${labNote}${imagingNote}

${SAFETY_RULES}

${CLINICAL_BACKGROUND}

${CANCER_STATISTICS}

${researchContext}

WRITING STYLE
- 120-200 words total. Shorter is better.
- One idea per sentence. Under 20 words per sentence.
- Paragraphs of 1-3 sentences.
- Everyday words: "scarring of the liver," not "hepatic fibrosis." "Spread," not "metastasis."
- Define necessary medical terms in the same sentence: "cirrhosis, which means heavy scarring of the liver."
- Be precise: "Every six months" beats "regularly." "About one in four" beats "a significant proportion."
- Use retrieved abstract findings. Mark specific claims with [n]. Don't mark general background.
- No markdown headers, no bold, no asterisks in final output.
- Max 4 bullets if needed, one line each.
- Sound like a knowledgeable friend in a hallway — not a textbook, not a pamphlet.`;
}

function formatResearchContext(papers, trials) {
  let ctx = "RETRIEVED RESEARCH (use abstract text — do not guess from titles):\n\n";
  if (!papers.length) {
    ctx += "(None retrieved — say so rather than inventing citations.)\n";
  } else {
    papers.forEach((p, i) => {
      ctx += `[${i + 1}] "${p.title}"\n`;
      ctx += `    ${p.authors} · ${p.journal} ${p.pubdate} · Score:${p.score}\n`;
      ctx += `    ${p.url}\n`;
      if (p.abstract) ctx += `    ABSTRACT: ${p.abstract}\n`;
      ctx += "\n";
    });
  }

  if (trials.length) {
    ctx += "\nRECRUITING CLINICAL TRIALS:\n";
    trials.forEach((t, i) => {
      ctx += `${i + 1}. ${t.title} — Phase: ${t.phase}, Status: ${t.status}\n   ${t.url}\n`;
    });
  }
  return ctx;
}

/* ============================================================
   13. GEMINI SERVICE
   ============================================================ */
async function callGemini(systemPrompt, history, userMessage) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL}:generateContent`;

  const contents = [
    ...history.map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    { role: "user", parts: [{ text: userMessage }] },
  ];

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: {
      maxOutputTokens: 700,
      temperature: 0.35,
      topP: 0.9,
    },
    safetySettings: [
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
    ],
  };

  const res = await fetchWithRetry("Gemini", url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": CONFIG.GEMINI_KEY,
    },
    body: JSON.stringify(body),
  }, 1); // Only 1 retry for Gemini (don't burn quota)

  const data = await res.json();

  const candidate = data.candidates?.[0];
  if (!candidate) {
    if (data.promptFeedback?.blockReason) {
      const err = new Error("Blocked by safety filter: " + data.promptFeedback.blockReason);
      err.status = 422;
      throw err;
    }
    throw new Error("No response returned from the model.");
  }

  const text = candidate.content?.parts?.map(p => p.text).join("") || "";
  if (!text.trim()) {
    throw new Error("Empty response from the model.");
  }
  return text;
}

/* ============================================================
   14. METRICS & HEALTH
   ============================================================ */
const metrics = {
  requestsTotal: 0,
  requestsSuccess: 0,
  requestsError: 0,
  geminiLatencyMs: [],
  researchLatencyMs: [],
};

function recordLatency(bucket, ms) {
  bucket.push(ms);
  if (bucket.length > 100) bucket.shift();
}

function avg(arr) {
  return arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
}

/* ============================================================
   15. ROUTES
   ============================================================ */
app.post("/api/chat", chatLimiter, async (req, res) => {
  const startTime = Date.now();
  const reqId = req.id;
  const clientIp = req.ip;

  metrics.requestsTotal++;

  try {
    if (!CONFIG.GEMINI_KEY) {
      metrics.requestsError++;
      return res.status(503).json({
        error: "Service temporarily unavailable. API key not configured.",
        code: "NO_API_KEY",
      });
    }

    const { message, history = [] } = req.body;

    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "Please enter a message.", code: "EMPTY_MESSAGE" });
    }
    if (message.length > 4000) {
      return res.status(400).json({ error: "Message too long (max 4000 chars).", code: "MESSAGE_TOO_LONG" });
    }

    if (!checkDailyBudget()) {
      return res.status(503).json({
        error: "This site has reached its free daily capacity. Please try again tomorrow.",
        code: "DAILY_CAP_EXHAUSTED",
      });
    }

    if (!checkIpDailyBudget(clientIp)) {
      return res.status(429).json({
        error: "You've reached the daily personal limit. Please try again tomorrow.",
        code: "IP_DAILY_CAP",
      });
    }

    const queryMeta = analyzeQuery(message);
    const trimmedHistory = Array.isArray(history) ? history.slice(-8) : [];

    // Research phase
    const researchStart = Date.now();
    const { papers, trials } = await gatherResearch(message, queryMeta.wantsTrials);
    recordLatency(metrics.researchLatencyMs, Date.now() - researchStart);

    const systemPrompt = buildSystemPrompt(formatResearchContext(papers, trials), queryMeta);

    // AI phase
    const aiStart = Date.now();
    incrementBudget(clientIp);
    const reply = await callGemini(systemPrompt, trimmedHistory, message);
    recordLatency(metrics.geminiLatencyMs, Date.now() - aiStart);

    metrics.requestsSuccess++;

    Logger.info("[Chat] Success", {
      reqId,
      ip: clientIp,
      messageLen: message.length,
      replyLen: reply.length,
      papers: papers.length,
      trials: trials.length,
      urgency: queryMeta.isUrgent,
      totalMs: Date.now() - startTime,
    });

    res.json({
      reply,
      sources: [...papers, ...trials],
      meta: {
        papersFound: papers.length,
        trialsFound: trials.length,
        cached: false,
      },
    });
  } catch (err) {
    metrics.requestsError++;
    Logger.error("[Chat] Error", {
      reqId,
      ip: clientIp,
      error: err.message,
      stack: err.stack?.split("\n")?.[0],
      totalMs: Date.now() - startTime,
    });

    if (err.name === "AbortError" || /aborted|timeout/i.test(err.message)) {
      return res.status(504).json({
        error: "That took too long. Please try again — it usually works on a second attempt.",
        code: "TIMEOUT",
      });
    }
    if (err.message?.includes("Circuit breaker OPEN")) {
      return res.status(503).json({
        error: "Research services are temporarily unavailable. Please try again in a moment.",
        code: "CIRCUIT_OPEN",
      });
    }
    if (err.status === 429) {
      return res.status(503).json({
        error: "The free API quota is temporarily exhausted. Please try again later.",
        code: "RATE_LIMITED",
      });
    }
    if (err.status === 422) {
      return res.status(200).json({
        reply: "I wasn't able to generate a response to that phrasing. Try rewording your question — for example, ask about a specific risk factor, lab marker, or imaging term.",
        sources: [],
        code: "SAFETY_BLOCKED",
      });
    }

    if (CONFIG.SHOW_ERRORS) {
      return res.status(500).json({
        error: "Error details (debug): " + err.message,
        code: "INTERNAL_ERROR",
      });
    }

    res.status(500).json({
      error: "Something went wrong finding an answer. Please try again in a moment.",
      code: "INTERNAL_ERROR",
    });
  }
});

app.get("/api/health", (req, res) => {
  const cbStatus = [cbPubMed, cbEuropePMC, cbTrials].map(cb => cb.status());
  res.json({
    status: "ok",
    apiKeyConfigured: Boolean(CONFIG.GEMINI_KEY),
    model: CONFIG.GEMINI_MODEL,
    dailyRequestsUsed: globalDailyCount,
    dailyCap: CONFIG.DAILY_CAP,
    dailyResetsAt: new Date(globalDailyResetAt).toISOString(),
    cache: researchCache.stats(),
    circuitBreakers: cbStatus,
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  });
});

app.get("/api/metrics", (req, res) => {
  res.json({
    requests: {
      total: metrics.requestsTotal,
      success: metrics.requestsSuccess,
      error: metrics.requestsError,
      successRate: metrics.requestsTotal
        ? Math.round((metrics.requestsSuccess / metrics.requestsTotal) * 100) + "%"
        : "N/A",
    },
    latency: {
      researchAvgMs: avg(metrics.researchLatencyMs),
      geminiAvgMs: avg(metrics.geminiLatencyMs),
    },
    cache: researchCache.stats(),
    circuitBreakers: [cbPubMed, cbEuropePMC, cbTrials].map(cb => cb.status()),
  });
});

/* ============================================================
   16. ERROR HANDLING & GRACEFUL SHUTDOWN
   ============================================================ */
app.use((err, req, res, next) => {
  Logger.error("[Express] Unhandled error", {
    reqId: req.id,
    error: err.message,
    stack: err.stack?.split("\n")?.slice(0, 3),
  });
  res.status(500).json({ error: "Internal server error.", code: "UNHANDLED" });
});

const server = app.listen(CONFIG.PORT, () => {
  Logger.info("[INIT] Hepatica started", {
    port: CONFIG.PORT,
    model: CONFIG.GEMINI_MODEL,
    env: CONFIG.NODE_ENV,
    showErrors: CONFIG.SHOW_ERRORS,
  });
});

function shutdown(signal) {
  Logger.info(`[Shutdown] ${signal} received. Closing server...`);
  server.close(() => {
    Logger.info("[Shutdown] Server closed. Exiting.");
    process.exit(0);
  });
  setTimeout(() => {
    Logger.error("[Shutdown] Forced exit after timeout.");
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Catch unhandled rejections so Render doesn't crash-loop silently
process.on("unhandledRejection", (reason, promise) => {
  Logger.error("[Process] Unhandled rejection", { reason: reason?.message || reason });
});
process.on("uncaughtException", (err) => {
  Logger.error("[Process] Uncaught exception", { error: err.message, stack: err.stack?.split("\n")?.[0] });
  // Give logs time to flush, then die
  setTimeout(() => process.exit(1), 1000);
});
