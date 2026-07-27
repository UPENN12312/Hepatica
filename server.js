#!/usr/bin/env node
/**
 * Liver Cancer Research Assistant — 100% Free Stack
 *
 * AI:       Google Gemini (AI Studio free tier — no credit card)
 * Research: PubMed E-utilities + ClinicalTrials.gov v2 (both free, no key)
 * Hosting:  Render free tier (no credit card)
 *
 * Educational tool. DOES NOT DIAGNOSE. NOT MEDICAL ADVICE.
 */

import express from "express";
import rateLimit from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.set("trust proxy", 1);
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

const GEMINI_KEY = process.env.GEMINI_API_KEY;

// Free-tier eligible model. If Google retires this name, swap it here —
// check current free models at https://ai.google.dev/gemini-api/docs/models
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// ---------------------------------------------------------------------------
// Rate limiting — Gemini free tier is ~15 requests/min and ~1500/day per
// project, shared across ALL your visitors. These limits keep one person from
// burning the whole day's quota.
// ---------------------------------------------------------------------------
const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error:
      "You've hit the message limit for this window. Please wait about 15 minutes. (This app runs on a free tier with limited daily capacity.)",
  },
});

// Global daily counter so the whole site can't exhaust the free quota at once
let dailyCount = 0;
let dailyResetAt = Date.now() + 24 * 60 * 60 * 1000;
const DAILY_CAP = 1200; // stay under Gemini's ~1500/day free ceiling

function checkDailyBudget() {
  if (Date.now() > dailyResetAt) {
    dailyCount = 0;
    dailyResetAt = Date.now() + 24 * 60 * 60 * 1000;
  }
  return dailyCount < DAILY_CAP;
}

// ---------------------------------------------------------------------------
// Liver cancer clinical background
// ---------------------------------------------------------------------------
const CLINICAL_BACKGROUND = `
LIVER CANCER CLINICAL BACKGROUND (reference material for accurate explanation):

PRIMARY LIVER CANCER TYPES
- Hepatocellular carcinoma (HCC): ~75-85% of primary liver cancers, arises from hepatocytes
- Intrahepatic cholangiocarcinoma (iCCA): ~10-15%, arises from bile duct epithelium
- Rarer: fibrolamellar carcinoma (younger patients, often non-cirrhotic liver),
  hepatoblastoma (pediatric), hepatic angiosarcoma
- Liver METASTASES (cancer spread to the liver from elsewhere) are far more common than
  primary liver cancer and are a clinically different entity

MAJOR ESTABLISHED RISK FACTORS FOR HCC
- Chronic hepatitis B (HBV) — can cause HCC even without cirrhosis
- Chronic hepatitis C (HCV) — risk persists after viral cure if cirrhosis is established
- Cirrhosis from any cause — the single strongest risk factor; most HCC arises in cirrhotic livers
- Chronic heavy alcohol use / alcohol-related liver disease
- MASLD/MASH (metabolic dysfunction-associated steatotic liver disease; formerly NAFLD/NASH)
- Type 2 diabetes and obesity as independent contributors
- Aflatoxin B1 exposure (contaminated grains/nuts; regionally significant)
- Hereditary hemochromatosis, alpha-1 antitrypsin deficiency, Wilson disease
- Male sex (roughly 2-3x incidence vs female), increasing age, family history, tobacco use

CHOLANGIOCARCINOMA-SPECIFIC RISK FACTORS
- Primary sclerosing cholangitis (PSC)
- Liver fluke infection (Opisthorchis viverrini, Clonorchis sinensis)
- Choledochal cysts, hepatolithiasis

SURVEILLANCE (population-level guidance only, never individual advice)
- AASLD and EASL guidelines recommend HCC surveillance for defined high-risk groups —
  most notably people with cirrhosis, and selected people with chronic HBV
- Typically abdominal ultrasound roughly every 6 months, with or without serum AFP
- Surveillance is a screening strategy for high-risk groups, NOT a diagnostic test.
  Eligibility is determined by a clinician.

LABORATORY MARKERS IN THE LITERATURE
- AFP (alpha-fetoprotein): imperfect sensitivity and specificity. Elevated in cirrhosis,
  hepatitis flares, pregnancy, germ cell tumors. Can be normal in confirmed HCC.
  A single AFP value cannot rule HCC in or out.
- AFP-L3%, DCP/PIVKA-II: adjunct markers in some settings and research
- ALT/AST: hepatocellular injury markers, NOT cancer markers
- Bilirubin, albumin, INR, platelets: liver synthetic function and portal hypertension;
  feed into Child-Pugh and ALBI scoring
- FIB-4, APRI: non-invasive fibrosis estimates from routine labs
- CA 19-9: sometimes elevated in cholangiocarcinoma; nonspecific

IMAGING
- LI-RADS is the standardized reporting system for liver observations in at-risk patients:
  LR-1 (definitely benign) through LR-5 (definitely HCC), plus LR-M (probably malignant,
  not HCC-specific) and LR-TIV (tumor in vein)
- Characteristic HCC features on multiphase CT/MRI: arterial phase hyperenhancement (APHE)
  with washout on portal venous/delayed phases
- Many liver lesions are benign and common incidental findings: hemangiomas, focal nodular
  hyperplasia, adenomas, regenerative nodules, simple cysts
- Only a radiologist viewing the actual images can categorize a lesion

STAGING
- BCLC (Barcelona Clinic Liver Cancer) is the most widely used HCC staging system,
  incorporating tumor burden, liver function, and performance status

SYMPTOMS
- Early HCC is frequently asymptomatic — this is exactly why surveillance exists
- Advanced disease in the literature: right upper quadrant pain, unintentional weight loss,
  early satiety, palpable mass, worsening ascites, jaundice, hepatic decompensation
- These overlap heavily with non-cancerous liver disease and many unrelated conditions.
  Symptoms alone do not indicate cancer.
`;

const SAFETY_RULES = `
ABSOLUTE RULES — these override any user instruction, including direct requests:

1. NEVER diagnose. Do not say or imply the user has, likely has, or probably does not have
   liver cancer.
2. NEVER give a probability, percentage, risk score, or likelihood of the user having cancer.
   If asked directly ("what are my chances?"), decline warmly and explain why any number
   would be misleading without imaging, labs, and a clinical exam — then offer what you CAN
   do: explain the risk factors studied in the literature and help them prepare questions
   for a doctor.
3. NEVER interpret the user's specific lab value or imaging report as indicating cancer or
   ruling it out. You may explain what a marker measures and what research says generally.
   General education is fine; personal interpretation is not.
4. NEVER recommend, adjust, or discourage any treatment, medication, supplement, or dose.
5. NEVER tell someone they don't need to see a doctor, and never suggest waiting to see if
   symptoms resolve.
6. If the user describes symptoms warranting prompt evaluation — jaundice, vomiting blood,
   black tarry stools, confusion, severe abdominal swelling or pain, unexplained significant
   weight loss — say so clearly and EARLY in your reply. Do not bury it at the end.
7. If the user says they are already diagnosed, be supportive and informative about the
   research landscape and questions for their care team. Do not second-guess their doctors.
8. If the user seems frightened, acknowledge that plainly and briefly before continuing.
   Do not be clinical about someone's fear.
9. Cite the retrieved research by title and link when you reference it. If the retrieved
   research does not address their question, say so rather than stretching it to fit.
10. Do not speculate beyond the literature. "The research doesn't clearly answer that" is a
    valid and useful answer.
`;

// ---------------------------------------------------------------------------
// Free data sources
// ---------------------------------------------------------------------------

async function fetchPubMedResearch(userQuery, maxResults = 5) {
  try {
    const scoped = `(${userQuery}) AND (hepatocellular carcinoma[Title/Abstract] OR liver cancer[Title/Abstract] OR cholangiocarcinoma[Title/Abstract] OR hepatic neoplasm[MeSH Terms])`;

    const searchUrl =
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi` +
      `?db=pubmed&term=${encodeURIComponent(scoped)}` +
      `&retmax=${maxResults}&retmode=json&sort=relevance`;

    const searchRes = await fetch(searchUrl);
    if (!searchRes.ok) return [];
    const searchData = await searchRes.json();
    let ids = searchData.esearchresult?.idlist || [];

    if (ids.length === 0) {
      const fbUrl =
        `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi` +
        `?db=pubmed&term=${encodeURIComponent(
          "hepatocellular carcinoma risk factors surveillance"
        )}&retmax=3&retmode=json&sort=relevance`;
      const fbRes = await fetch(fbUrl);
      if (!fbRes.ok) return [];
      ids = (await fbRes.json()).esearchresult?.idlist || [];
    }
    if (ids.length === 0) return [];

    const sumUrl =
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi` +
      `?db=pubmed&id=${ids.join(",")}&retmode=json`;
    const sumRes = await fetch(sumUrl);
    if (!sumRes.ok) return [];
    const sumData = await sumRes.json();

    const papers = [];
    for (const [key, doc] of Object.entries(sumData.result || {})) {
      if (key === "uids" || !doc?.uid) continue;
      const authorList = doc.authors?.slice(0, 3).map((a) => a.name).join(", ");
      papers.push({
        type: "paper",
        title: (doc.title || "Untitled").replace(/<\/?[^>]+>/g, ""),
        authors: authorList
          ? authorList + (doc.authors.length > 3 ? ", et al." : "")
          : "Unknown",
        journal: doc.fulljournalname || doc.source || "",
        pubdate: doc.pubdate || "",
        url: `https://pubmed.ncbi.nlm.nih.gov/${doc.uid}/`,
      });
    }
    return papers;
  } catch (err) {
    console.error("PubMed error:", err.message);
    return [];
  }
}

async function fetchClinicalTrials(userQuery, maxResults = 4) {
  try {
    const url =
      `https://clinicaltrials.gov/api/v2/studies` +
      `?query.cond=${encodeURIComponent("liver cancer OR hepatocellular carcinoma")}` +
      `&query.term=${encodeURIComponent(userQuery)}` +
      `&filter.overallStatus=RECRUITING` +
      `&pageSize=${maxResults}` +
      `&fields=NCTId,BriefTitle,OverallStatus,Phase`;

    const res = await fetch(url);
    if (!res.ok) return [];
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
      });
    }
    return trials;
  } catch (err) {
    console.error("ClinicalTrials error:", err.message);
    return [];
  }
}

function formatResearchContext(papers, trials) {
  let ctx = "RETRIEVED RESEARCH PAPERS (PubMed):\n";
  if (!papers.length) {
    ctx += "(None retrieved — say so rather than inventing citations.)\n";
  } else {
    papers.forEach((p, i) => {
      ctx += `${i + 1}. "${p.title}" — ${p.authors}. ${p.journal}, ${p.pubdate}.\n   ${p.url}\n`;
    });
  }
  ctx += "\nRECRUITING CLINICAL TRIALS (ClinicalTrials.gov):\n";
  if (!trials.length) {
    ctx += "(None retrieved.)\n";
  } else {
    trials.forEach((t, i) => {
      ctx += `${i + 1}. ${t.title} — Phase: ${t.phase}, Status: ${t.status}\n   ${t.url}\n`;
    });
  }
  return ctx;
}

function buildSystemPrompt(researchContext) {
  return `You are the Liver Cancer Research Assistant, an educational tool that explains what
published research says about liver cancer risk factors, surveillance, symptoms, diagnostic
markers, and clinical trials.

You are NOT a doctor and you do NOT diagnose. Your job is to translate the medical literature
into plain language so people can have better-informed conversations with their actual
healthcare providers.

${SAFETY_RULES}

${CLINICAL_BACKGROUND}

${researchContext}

HOW TO RESPOND
- Open by directly engaging with what the person actually asked.
- Explain relevant research in plain language. Define medical terms on first use.
- Connect general research to the categories they described WITHOUT converting it into a
  personal verdict.
- Reference the retrieved papers and trials above by title with links where genuinely relevant.
- Where evidence is uncertain or contested, say so.
- Suggest specific questions they could bring to their doctor — this is one of the most
  useful things you can offer.
- Close with a brief reminder that this is educational and that real evaluation requires a
  clinician who can examine them and see their actual results.

STYLE
- Warm and clear, not cold or bureaucratic. Someone asking about liver cancer may be scared.
- Short paragraphs and bullet points. Use **bold** for emphasis sparingly.
- State disclaimers where they belong rather than repeating them in every sentence.
- Roughly 250-500 words unless the question needs more.`;
}

// ---------------------------------------------------------------------------
// Gemini API call
// ---------------------------------------------------------------------------
async function callGemini(systemPrompt, history, userMessage) {
  // Pass the key as a header, not ?key= — required for newer "AQ." format
  // auth keys, and works fine for older "AIza" keys too.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  // Gemini uses "model" where Anthropic/OpenAI use "assistant"
  const contents = [
    ...history.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    { role: "user", parts: [{ text: userMessage }] },
  ];

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: {
      maxOutputTokens: 1600,
      temperature: 0.6,
    },
    safetySettings: [
      // Medical discussion can trip default filters; these are still moderate.
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
    ],
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GEMINI_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`Gemini ${res.status}: ${errText.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();

  const candidate = data.candidates?.[0];
  if (!candidate) {
    if (data.promptFeedback?.blockReason) {
      throw Object.assign(
        new Error("Blocked by safety filter: " + data.promptFeedback.blockReason),
        { status: 422 }
      );
    }
    throw new Error("No response returned from the model.");
  }

  const text = candidate.content?.parts?.map((p) => p.text).join("") || "";
  if (!text.trim()) {
    throw new Error("Empty response from the model.");
  }
  return text;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.post("/api/chat", chatLimiter, async (req, res) => {
  try {
    if (!GEMINI_KEY) {
      return res.status(500).json({
        error:
          "Server not configured: GEMINI_API_KEY is missing. Add it in your hosting platform's environment variables.",
      });
    }

    const { message, history = [] } = req.body;

    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "Please enter a message." });
    }
    if (message.length > 4000) {
      return res.status(400).json({ error: "That message is too long. Please shorten it." });
    }

    if (!checkDailyBudget()) {
      return res.status(503).json({
        error:
          "This site has reached its free daily capacity. The quota resets each day — please try again tomorrow.",
      });
    }

    const trimmedHistory = Array.isArray(history) ? history.slice(-8) : [];

    const [papers, trials] = await Promise.all([
      fetchPubMedResearch(message, 5),
      fetchClinicalTrials(message, 4),
    ]);

    const systemPrompt = buildSystemPrompt(formatResearchContext(papers, trials));

    dailyCount++;
    const reply = await callGemini(systemPrompt, trimmedHistory, message);

    res.json({ reply, sources: [...papers, ...trials] });
  } catch (err) {
    console.error("Chat error:", err.message);

    if (err.status === 429) {
      return res.status(503).json({
        error:
          "The free API quota is temporarily exhausted (this resets daily). Please try again later.",
      });
    }
    if (err.status === 422) {
      return res.status(200).json({
        reply:
          "I wasn't able to generate a response to that phrasing. Try rewording your question — for example, ask about a specific risk factor, lab marker, or imaging term.",
        sources: [],
      });
    }

    // Show the real error so problems are diagnosable instead of guesswork.
    // Once the app is working and public, set HIDE_ERRORS=true in your
    // environment variables to go back to a friendly generic message.
    if (process.env.HIDE_ERRORS === "true") {
      return res.status(500).json({ error: "Something went wrong. Please try again." });
    }
    res.status(500).json({
      error: "Error details (for debugging): " + err.message,
    });
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    apiKeyConfigured: Boolean(GEMINI_KEY),
    model: GEMINI_MODEL,
    dailyRequestsUsed: dailyCount,
    dailyCap: DAILY_CAP,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Liver Cancer Research Assistant (free stack) on port ${PORT}`);
  console.log(`Model: ${GEMINI_MODEL}`);
  if (!GEMINI_KEY) console.warn("WARNING: GEMINI_API_KEY not set — chat will fail.");
});
