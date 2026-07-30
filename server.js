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
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";

// Overridable so the pipeline can be tested against a local stub.
// Leave unset in production.
const GEMINI_BASE =
  process.env.GEMINI_BASE || "https://generativelanguage.googleapis.com/v1beta/models";

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

const CANCER_STATISTICS = `
POPULATION STATISTICS — US (cite the source and year whenever you use these)

Source: NCI Surveillance, Epidemiology and End Results (SEER) Program, and
American Cancer Society Cancer Statistics 2025.

- Estimated new cases of liver and intrahepatic bile duct cancer in the US in 2025: 42,240
- Estimated deaths from those cancers in the US in 2025: about 30,090
- Overall 5-year relative survival: 22%
- That 22% is up from about 3% in the mid-1970s — the largest relative improvement in
  survival of any cancer type over that period, though liver cancer still has one of the
  less favorable outlooks overall.
- Survival differs sharply by how far the cancer has spread at diagnosis. It is
  substantially higher when the cancer is still confined to the liver, and low once it has
  spread to distant parts of the body. Exact figures by stage vary depending on which SEER
  data years are used, so if someone wants stage-specific numbers, give the general pattern
  and point them to seer.cancer.gov rather than quoting a precise figure you are unsure of.

HOW TO HANDLE SURVIVAL STATISTICS — READ THIS BEFORE QUOTING ANY NUMBER

Survival statistics are the single most frightening thing on this site. Handle them with care.

- Only bring up survival numbers if the person actually asks. Never volunteer them.
- When you do give one, always say in the same breath what it actually means: it is an
  average across a large group of people diagnosed years ago, it does not account for
  someone's age, liver function, tumour size, or treatment, and it cannot predict what will
  happen to any individual.
- Note that these figures lag reality. They describe people diagnosed several years back,
  and treatment has changed since.
- Never apply a population statistic to the person you are talking to. "The overall 5-year
  survival is 22%" is a fact about a population. "Your survival is 22%" is a prediction
  about a person, and you must never make it.
- After giving a statistic, point them toward their care team, who can say what actually
  applies to their situation.
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

/**
 * fetch with a hard timeout. Without this, a slow or hanging upstream API
 * (PubMed, Europe PMC, ClinicalTrials.gov) leaves the user staring at a
 * spinner indefinitely.
 */
async function fetchWithTimeout(url, ms = 8000, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPubMedResearch(userQuery, maxResults = 5) {
  try {
    const scoped = `(${userQuery}) AND (hepatocellular carcinoma[Title/Abstract] OR liver cancer[Title/Abstract] OR cholangiocarcinoma[Title/Abstract] OR hepatic neoplasm[MeSH Terms])`;

    const searchUrl =
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi` +
      `?db=pubmed&term=${encodeURIComponent(scoped)}` +
      `&retmax=${maxResults}&retmode=json&sort=relevance`;

    const searchRes = await fetchWithTimeout(searchUrl);
    if (!searchRes.ok) return [];
    const searchData = await searchRes.json();
    let ids = searchData.esearchresult?.idlist || [];

    if (ids.length === 0) {
      const fbUrl =
        `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi` +
        `?db=pubmed&term=${encodeURIComponent(
          "hepatocellular carcinoma risk factors surveillance"
        )}&retmax=3&retmode=json&sort=relevance`;
      const fbRes = await fetchWithTimeout(fbUrl);
      if (!fbRes.ok) return [];
      ids = (await fbRes.json()).esearchresult?.idlist || [];
    }
    if (ids.length === 0) return [];

    const sumUrl =
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi` +
      `?db=pubmed&id=${ids.join(",")}&retmode=json`;
    const sumRes = await fetchWithTimeout(sumUrl);
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

/**
 * Europe PMC — free, no key, and crucially returns ABSTRACT TEXT, not just titles.
 * This is what lets the model cite actual findings instead of guessing from a title.
 */
async function fetchAbstracts(userQuery, maxResults = 4) {
  try {
    const q = `(${userQuery}) AND (hepatocellular carcinoma OR "liver cancer" OR cholangiocarcinoma) AND (HAS_ABSTRACT:Y)`;
    const url =
      `https://www.ebi.ac.uk/europepmc/webservices/rest/search` +
      `?query=${encodeURIComponent(q)}` +
      `&format=json&pageSize=${maxResults}&resultType=core&sort=CITED%20desc`;

    const res = await fetchWithTimeout(url);
    if (!res.ok) return [];
    const data = await res.json();

    const out = [];
    for (const r of data.resultList?.result || []) {
      if (!r.abstractText) continue;
      // Strip any markup and cap length so we don't blow the context budget
      const abstract = r.abstractText
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 1200);

      out.push({
        type: "paper",
        title: (r.title || "Untitled").replace(/<[^>]+>/g, "").trim(),
        authors: r.authorString || "Unknown",
        journal: r.journalTitle || "",
        pubdate: r.pubYear || "",
        abstract,
        url: r.doi
          ? `https://doi.org/${r.doi}`
          : r.pmid
          ? `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/`
          : `https://europepmc.org/article/${r.source}/${r.id}`,
      });
    }
    return out;
  } catch (err) {
    console.error("EuropePMC error:", err.message);
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

    const res = await fetchWithTimeout(url);
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
  let ctx = "RETRIEVED RESEARCH (use the abstract text below — do not guess from titles):\n\n";
  if (!papers.length) {
    ctx += "(None retrieved — say so rather than inventing citations.)\n";
  } else {
    papers.forEach((p, i) => {
      ctx += `[${i + 1}] "${p.title}"\n`;
      ctx += `    ${p.authors} · ${p.journal} ${p.pubdate}\n`;
      ctx += `    ${p.url}\n`;
      if (p.abstract) ctx += `    ABSTRACT: ${p.abstract}\n`;
      ctx += "\n";
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

WHAT YOU ARE FOR

You are not a library and not a search engine. Your job is to help someone figure out
what to do next. A good clinician in a first visit takes a history, explains what the
guidelines say about someone in that situation, says how soon they should be seen, and
sends them off knowing what to ask. Do those four things. Do not do the fifth thing — do
not give a verdict.

GUIDELINE MATCHING — THE MOST USEFUL THING YOU DO

When someone tells you about their situation (hepatitis B, hepatitis C, cirrhosis, heavy
alcohol use, fatty liver disease, family history, and so on), tell them what published
guidelines actually say about people in that category.

This is legitimate and useful: "AASLD guidelines recommend twice-yearly ultrasound
surveillance for people with cirrhosis" is a fact about a guideline. Saying it to someone
who has cirrhosis is not a diagnosis — it is telling them a recommendation exists that
they should ask their doctor whether they qualify for. Many people who are eligible for
surveillance are never offered it, and telling them the guideline exists is genuinely the
highest-value thing on this site.

Always frame it as: here is what the guideline says, ask your doctor whether it applies to
you. Never: you need this test. Eligibility is a clinical judgement.

HOW SOON SHOULD THEY BE SEEN — SAY THIS EXPLICITLY

Every time someone describes symptoms or a situation, tell them plainly how soon to seek
care. Use one of these, and say it near the TOP of your reply, not the bottom:

- SAME DAY / EMERGENCY: yellowing of the eyes or skin, vomiting blood, black tarry stools,
  new confusion or drowsiness, severe abdominal pain, a hard swollen belly that came on fast.
- WITHIN A WEEK OR TWO: unexplained weight loss, persistent right-upper-belly pain, ongoing
  nausea or loss of appetite, a lump they can feel, unusual tiredness that is not improving.
- AT A ROUTINE APPOINTMENT: no symptoms, but risk factors that may make them eligible for
  surveillance, or questions about test results that are not urgent.

If you are unsure which bucket applies, choose the more urgent one. Under-calling urgency
is the more dangerous error.

WHAT TO DO NEXT — END WITH SOMETHING ACTIONABLE

Do not end with "talk to your doctor" alone. Be specific about the next step:
- Which kind of doctor (primary care to start; a hepatologist or gastroenterologist for
  liver-specific concerns; an oncologist only if cancer has actually been diagnosed).
- One concrete sentence they could say or ask at that appointment, written so they could
  read it aloud.

${SAFETY_RULES}

IF SOMEONE PASTES A LAB RESULT, SCAN REPORT, OR PATHOLOGY REPORT

People will paste things they don't understand. This is one of the most useful things you can
help with, and also the easiest place to cause harm. The line is simple:

YOU MAY: explain what each term, test, or abbreviation on the report MEANS in general.
"AFP is a protein measured in blood. LI-RADS is a scoring system radiologists use.
LR-3 means the radiologist judged the finding indeterminate."

YOU MAY NOT: tell them what their particular results indicate about them. Never say a value
is normal, abnormal, reassuring, concerning, high, low, good, or bad. Never say what the
report suggests they have or don't have. Never estimate what comes next for them.

If they push — "but is that bad?", "just tell me what it means for me" — say plainly that you
can explain what the words mean but that only the doctor who ordered the test can say what the
results mean for them, because interpretation depends on their history, their other results,
and the images themselves. Then offer the most useful thing you actually can: help them write
down exactly what to ask at their next appointment.

Do not speculate about a diagnosis from a report. Do not fill in gaps. If a term isn't in the
report they pasted, don't invent it.

${CLINICAL_BACKGROUND}

${CANCER_STATISTICS}

${researchContext}

HOW TO RESPOND — FOLLOW THIS SHAPE EVERY TIME

1. If there is any urgency signal at all, LEAD with how soon to be seen. One sentence.
   Do not bury it. If there is no urgency signal, skip this and start at step 2.
2. Answer the actual question in ONE plain sentence. No preamble, no "great question,"
   no restating what they asked.
3. Two to four short sentences with only what actually matters. If a published guideline
   applies to their situation, say what it recommends and tell them to ask whether they
   qualify.
4. The next step: which kind of doctor, and one sentence they could read aloud at the
   appointment.
5. One short closing line: this is general information, not a diagnosis.

Nothing else. No extra sections. No summary at the end.

VOICE — READ THE EXAMPLES, THEY MATTER MORE THAN THE RULES

The failure mode to avoid is bland. Health writing tends to come out flat, hedged, and
faintly official, like a leaflet in a waiting room. That tone is not neutral — it makes
people feel handled rather than helped. Write like a person who knows this subject well and
is talking to someone across a table.

Concretely:

FLAT: "It is important to consult with a healthcare professional regarding your symptoms,
as they can provide appropriate guidance based on your individual circumstances."
BETTER: "Get this looked at this week. A GP can order the blood tests that would sort out
what's going on."

FLAT: "Cirrhosis is a significant risk factor for the development of hepatocellular
carcinoma, and surveillance protocols have been established for this population."
BETTER: "Cirrhosis is the big one. Because the risk is high enough, guidelines say people
with cirrhosis should get an ultrasound every six months to catch anything early — worth
asking whether that applies to you."

FLAT: "AFP is a tumour marker that may be elevated in the presence of hepatocellular
carcinoma, though it lacks sensitivity and specificity."
BETTER: "AFP is a protein they measure in blood. It's a rough signal, not a verdict — it
can be high in people without cancer and normal in people who have it, which is why it's
never used on its own."

Notice what changes: shorter sentences, plain words, the useful detail kept, the padding
cut, and a human on the other end of it.

Also:
- Answer the question that was actually asked, not the one that's easiest to answer.
- If someone sounds frightened, say one short human thing before the information. One
  sentence, not a paragraph, and never syrupy. "That's a scary thing to be sitting with"
  is enough. Then be useful, because being useful is the actual comfort.
- Never open with "It's important to note," "It's worth mentioning," or "Great question."
  Start with the answer.
- Don't hedge a sentence twice. "May sometimes potentially indicate" says nothing.
- Concrete beats abstract every time. Name the test, the interval, the specialty.

NEVER SCORE OR RANK THEM. Do not say "your risk is high, moderate, or low." Do not add up
their risk factors into a total. Do not tell them they are more or less likely than average
to have cancer. Say what the guidelines recommend for people in their category, and stop
there. The difference matters: a category is a fact, a score is a prediction.

WRITING STYLE — AS IMPORTANT AS THE CONTENT
Write for a smart adult with zero medical training, reading on a phone, possibly scared.

- TOTAL LENGTH: 120-200 words. Never more than 200. Shorter is better.
- One idea per sentence. Aim for under 20 words per sentence.
- Paragraphs of 1-3 sentences. Never longer.
- Everyday words only. "Scarring of the liver," not "hepatic fibrosis." "Spread," not
  "metastasis." "Swelling in the belly," not "ascites."
- If a medical term is genuinely necessary (because it appears on their paperwork),
  give it once, then define it in plain words in the same sentence:
  "cirrhosis, which means heavy scarring of the liver."
- BE PRECISE. Prefer a concrete fact over a vague gesture. "Every six months" beats
  "regularly." "About one in four" beats "a significant proportion." If the research
  gives a number, use the number.
- The abstracts above contain real findings. Use them. When you state something specific
  that came from one, mark it with its bracket number, like [2]. Do not mark general
  background knowledge — only specific claims drawn from the retrieved research.
- Never state a finding the abstracts don't support. If they don't cover the question,
  say so and answer from general background instead, without bracket numbers.
- Never hedge twice in one sentence. Say it once, clearly.
- No markdown headers. No bold. No asterisks.
- If a bulleted list genuinely helps, use at most four bullets, one line each.
- Say "I don't know" or "the research doesn't answer that clearly" when true. That is a
  precise answer, not a failure.
- Sound like a knowledgeable friend answering in a hallway — not a textbook, not a
  pamphlet, not a lecture.`;
}

// ---------------------------------------------------------------------------
// Gemini API call
// ---------------------------------------------------------------------------
async function callGemini(systemPrompt, history, userMessage) {
  // Pass the key as a header, not ?key= — required for newer "AQ." format
  // auth keys, and works fine for older "AIza" keys too.
  const url = `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent`;

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
      maxOutputTokens: 850,
      temperature: 0.55,
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
// ---------------------------------------------------------------------------
// Caching — a small in-memory LRU with TTL.
//
// Two jobs: cut latency on repeat questions, and protect the free-tier quota.
// Lives in memory only, so it empties whenever Render restarts the instance.
// That's fine — it's an optimisation, not storage.
// ---------------------------------------------------------------------------
function makeCache(maxEntries, ttlMs) {
  const map = new Map();
  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return null;
      if (Date.now() > hit.expires) {
        map.delete(key);
        return null;
      }
      // Refresh recency: delete and re-insert moves it to the end
      map.delete(key);
      map.set(key, hit);
      return hit.value;
    },
    set(key, value) {
      if (map.has(key)) map.delete(key);
      map.set(key, { value, expires: Date.now() + ttlMs });
      while (map.size > maxEntries) map.delete(map.keys().next().value);
    },
    get size() {
      return map.size;
    },
  };
}

// Research changes slowly — cache it for an hour.
const researchCache = makeCache(120, 60 * 60 * 1000);
// Rewritten search queries are deterministic enough to cache for a day.
const queryCache = makeCache(200, 24 * 60 * 60 * 1000);

function cacheKey(s) {
  return s.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);
}

// ---------------------------------------------------------------------------
// Retry with exponential backoff, for transient upstream failures
// ---------------------------------------------------------------------------
async function withRetry(fn, { attempts = 3, baseMs = 400 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Don't retry things that won't get better: auth, bad request, filtered
      if ([400, 401, 403, 422].includes(err.status)) throw err;
      if (i < attempts - 1) {
        const wait = baseMs * Math.pow(2, i) + Math.random() * 150;
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Reranking — the search APIs return their own idea of relevance, which is
// often keyword-shaped. This rescores locally against the actual question so
// the most useful abstracts land at the top of the model's context.
// ---------------------------------------------------------------------------
const STOPWORDS = new Set(
  ("a an and are as at be but by for from has have how i if in is it its of on or " +
   "that the this to was what when where which who will with you your my me").split(" ")
);

function keywords(text) {
  return [...new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  )];
}

function rerank(items, query, limit) {
  const terms = keywords(query);
  if (!terms.length) return items.slice(0, limit);

  const scored = items.map((item) => {
    const title = (item.title || "").toLowerCase();
    const abstract = (item.abstract || "").toLowerCase();
    let score = 0;

    for (const t of terms) {
      // Title matches are worth much more than body matches
      if (title.includes(t)) score += 6;
      const occurrences = abstract.split(t).length - 1;
      score += Math.min(occurrences, 4) * 1.5;
    }
    // Prefer items that actually carry abstract text
    if (item.abstract) score += 3;
    // Mild recency preference
    const year = parseInt(item.pubdate, 10);
    if (Number.isFinite(year)) {
      const age = new Date().getFullYear() - year;
      if (age <= 3) score += 2.5;
      else if (age <= 7) score += 1;
    }
    return { item, score };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.item);
}

// ---------------------------------------------------------------------------
// Query rewriting — turns a conversational follow-up into a searchable query.
//
// "what about screening?" is useless as a literature search on its own. With
// the previous turn as context it becomes "hepatocellular carcinoma
// surveillance ultrasound cirrhosis". Only runs when there IS history, so it
// costs nothing on first questions.
// ---------------------------------------------------------------------------
async function rewriteQuery(message, history) {
  if (!history.length) return message;

  const key = cacheKey(
    history.slice(-2).map((m) => m.content.slice(0, 120)).join("|") + "||" + message
  );
  const cached = queryCache.get(key);
  if (cached) return cached;

  try {
    const context = history
      .slice(-4)
      .map((m) => (m.role === "user" ? "Person: " : "Assistant: ") + m.content.slice(0, 400))
      .join("\n");

    const prompt =
      `Rewrite the person's latest message into a standalone search query for medical ` +
      `literature about liver disease and liver cancer.\n\n` +
      `Rules: output ONLY the query, 3 to 10 words, no quotes, no explanation. ` +
      `Resolve pronouns and vague references using the conversation. ` +
      `Use clinical terms a paper would use.\n\n` +
      `Conversation so far:\n${context}\n\nLatest message: ${message}\n\nQuery:`;

    const res = await fetchWithTimeout(
      `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent`,
      6000,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 40, temperature: 0 },
        }),
      }
    );
    if (!res.ok) return message;

    const data = await res.json();
    const out = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("").trim();

    // Sanity check the rewrite before trusting it
    if (!out || out.length < 4 || out.length > 160 || out.split(/\s+/).length > 14) {
      return message;
    }
    queryCache.set(key, out);
    return out;
  } catch {
    return message; // Rewriting is an optimisation; never let it break the request
  }
}

// ---------------------------------------------------------------------------
// Retrieval orchestration — rewrite, fetch in parallel, dedupe, rerank, cache
// ---------------------------------------------------------------------------
async function gatherResearch(message, history) {
  const searchQuery = await rewriteQuery(message, history);

  const key = cacheKey(searchQuery);
  const cached = researchCache.get(key);
  if (cached) return { ...cached, searchQuery, cached: true };

  const [abstracts, pubmed, trials] = await Promise.all([
    fetchAbstracts(searchQuery, 6),
    fetchPubMedResearch(searchQuery, 4),
    fetchClinicalTrials(searchQuery, 3),
  ]);

  const seen = new Set();
  const merged = [];
  for (const p of [...abstracts, ...pubmed]) {
    const k = (p.title || "").toLowerCase().slice(0, 60);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    merged.push(p);
  }

  const result = {
    papers: rerank(merged, searchQuery, 5),
    trials: trials.slice(0, 3),
  };
  researchCache.set(key, result);
  return { ...result, searchQuery, cached: false };
}

// ---------------------------------------------------------------------------
// Streaming chat — text arrives as it's generated instead of after a long wait.
//
// Protocol (server-sent events):
//   event: sources  → the citations, sent up front so they can render early
//   event: chunk    → a piece of answer text
//   event: followups→ suggested next questions, parsed out of the model output
//   event: done     → finished cleanly
//   event: error    → something failed; payload is user-safe
// ---------------------------------------------------------------------------
const FOLLOWUP_MARK = "###NEXT###";

app.post("/api/chat/stream", chatLimiter, async (req, res) => {
  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    if (!GEMINI_KEY) {
      res.status(500).json({ error: "Server not configured: GEMINI_API_KEY is missing." });
      return;
    }

    const { message, history = [] } = req.body;
    if (!message || typeof message !== "string" || !message.trim()) {
      res.status(400).json({ error: "Please enter a message." });
      return;
    }
    if (message.length > 4000) {
      res.status(400).json({ error: "That message is too long. Please shorten it." });
      return;
    }
    if (!checkDailyBudget()) {
      res.status(503).json({
        error: "This site has reached its free daily capacity. It resets each day — please try again tomorrow.",
      });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // stop proxies buffering the stream
    });

    const trimmedHistory = Array.isArray(history) ? history.slice(-8) : [];
    const { papers, trials } = await gatherResearch(message, trimmedHistory);

    send("sources", [...papers, ...trials]);

    const systemPrompt =
      buildSystemPrompt(formatResearchContext(papers, trials)) +
      `\n\nAFTER your answer, output the marker ${FOLLOWUP_MARK} on its own line, then ` +
      `exactly three short follow-up questions the person might naturally ask next, one ` +
      `per line, no numbering, no bullets. Each under 60 characters, phrased in their ` +
      `voice ("What does that test involve?"). Nothing after the third.`;

    const contents = [
      ...trimmedHistory.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      { role: "user", parts: [{ text: message }] },
    ];

    dailyCount++;

    const upstream = await withRetry(async () => {
      const r = await fetch(
        `${GEMINI_BASE}/${GEMINI_MODEL}:streamGenerateContent?alt=sse`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents,
            generationConfig: { maxOutputTokens: 900, temperature: 0.4 },
            safetySettings: [
              { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
              { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
            ],
          }),
        }
      );
      if (!r.ok) {
        const body = await r.text();
        const e = new Error(`Gemini ${r.status}: ${body.slice(0, 300)}`);
        e.status = r.status;
        throw e;
      }
      return r;
    });

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    let inFollowups = false;
    let followupText = "";

    const emit = (text) => {
      if (!text) return;
      // Once the marker appears, everything after it is follow-up questions
      if (inFollowups) {
        followupText += text;
        return;
      }
      const idx = (full + text).indexOf(FOLLOWUP_MARK);
      if (idx !== -1) {
        const before = (full + text).slice(full.length, idx);
        if (before) send("chunk", before);
        followupText = (full + text).slice(idx + FOLLOWUP_MARK.length);
        inFollowups = true;
        full += text;
        return;
      }
      full += text;
      send("chunk", text);
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // keep any partial line for the next round

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const parsed = JSON.parse(payload);
          const parts = parsed.candidates?.[0]?.content?.parts || [];
          for (const p of parts) if (p.text) emit(p.text);
        } catch {
          /* partial JSON across chunk boundaries — safe to skip */
        }
      }
    }

    const followups = followupText
      .split("\n")
      .map((l) => l.replace(/^[-*\d.)\s]+/, "").trim())
      .filter((l) => l.length > 6 && l.length < 90)
      .slice(0, 3);

    if (followups.length) send("followups", followups);

    if (!full.trim()) {
      send("error", "I couldn't generate an answer to that. Try rewording your question.");
    }

    send("done", { ok: true });
    res.end();
  } catch (err) {
    console.error("Stream error:", err.message);
    if (res.headersSent) {
      const msg =
        err.status === 429
          ? "The free daily quota is used up. It resets each day."
          : err.name === "AbortError"
          ? "That took too long. Please try again."
          : "Something went wrong. Please try again.";
      send("error", msg);
      res.end();
    } else {
      res.status(500).json({ error: "Something went wrong. Please try again." });
    }
  }
});

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

    const { papers, trials } = await gatherResearch(message, trimmedHistory);

    const systemPrompt = buildSystemPrompt(formatResearchContext(papers, trials));

    dailyCount++;
    const reply = await withRetry(() => callGemini(systemPrompt, trimmedHistory, message));

    res.json({ reply, sources: [...papers, ...trials] });
  } catch (err) {
    console.error("Chat error:", err.message);

    if (err.name === "AbortError" || /aborted|timeout/i.test(err.message)) {
      return res.status(504).json({
        error:
          "That took too long to come back. Please try again — it usually works on a second attempt.",
      });
    }
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

    // Friendly by default. To see real error text while debugging, set
    // SHOW_ERRORS=true in your environment variables, then remove it after.
    if (process.env.SHOW_ERRORS === "true") {
      return res.status(500).json({
        error: "Error details (debug mode): " + err.message,
      });
    }
    res.status(500).json({
      error:
        "Something went wrong finding an answer. Please try again in a moment.",
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
    streaming: true,
    cache: { research: researchCache.size, queries: queryCache.size },
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Hepatica (liver cancer research assistant) running on port ${PORT}`);
  console.log(`Model: ${GEMINI_MODEL}`);
  if (!GEMINI_KEY) console.warn("WARNING: GEMINI_API_KEY not set — chat will fail.");
  if (process.env.SHOW_ERRORS === "true") {
    console.warn("NOTE: SHOW_ERRORS is on. Raw errors are visible to visitors. Remove it when done debugging.");
  }
});
