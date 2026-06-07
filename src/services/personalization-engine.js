'use strict';

const fs = require('node:fs');
const path = require('node:path');

const config = require('../config');
const logger = require('../utils/logger');
const { getProvider } = require('./llm');

// Exactly the words the system prompt forbids. Code-level check so a draft that
// slips one through is caught and regenerated.
const BANNED_WORDS = [
  'synergy',
  'leverage',
  'innovative',
  'cutting-edge',
  'passionate',
  'rockstar',
  'ninja',
  'game-changer',
  'revolutionary',
  'transformative',
];

const COMPLIANCE_FOOTER = '\n\n---\nReply STOP and I won’t reach out again.';

const EMOJI_RE = /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]/u;
const UNSUB_VAR_RE = /\{[a-z_]+\}/i;

// Body length is a flat 80–130 words for every bucket (per spec). Anything
// outside the window is a regeneration trigger.
const MIN_BODY_WORDS = 80;
const MAX_BODY_WORDS = 130;
const SUBJECT_MAX_CHARS = 60;
const BAD_SUBJECT_PREFIX_RE = /^(quick|the|reaching out|hi|question)\b/i;

// User rule: the email must never say "your work" / "your team's work" /
// "your company's work" — the laziest possible opener, banned outright.
const YOUR_WORK_RE = /\byour\s+(?:team'?s?\s+|company'?s?\s+|recent\s+|latest\s+){0,2}work\b/i;

// Empty-praise admiration a weak local model falls back to instead of naming a
// concrete detail. Checked against the first sentence only.
const ADMIRATION_OPENING_RE =
  /\b(?:impressed|impressive|admire|fascinat(?:ed|ing)|inspir(?:ed|ing)|blown away|huge fan|big fan|love (?:what|how) (?:you|your)|following your|came across your)\b/i;

// Local models (e.g. llama3.1:8b) hallucinate and break rules, so we regenerate
// more aggressively and run cooler to keep the model closer to the given facts.
const MAX_DRAFT_ATTEMPTS = 3; // 1 initial draft + up to 2 grounded regenerations
const DRAFT_TEMPERATURE = 0.4;

const templateCache = new Map();
function loadTemplate(name) {
  if (templateCache.has(name)) return templateCache.get(name);
  const p = path.join(__dirname, '..', 'templates', `${name}.md`);
  const text = fs.readFileSync(p, 'utf8');
  templateCache.set(name, text);
  return text;
}

function bucketFromSeniority(seniority) {
  if (!seniority) return 'peer';
  if (seniority === 'cxo') return 'executive';
  if (seniority === 'vp' || seniority === 'head') return 'senior';
  return 'peer';
}

function templateNameForBucket(bucket, sequenceStep) {
  if (sequenceStep && sequenceStep >= 1) return 'follow-up';
  if (bucket === 'executive') return 'executive-email';
  if (bucket === 'senior') return 'senior-email';
  return 'peer-email';
}

// Default goal: ask for a 15-minute conversation. Peers also get a soft,
// optional referral ask.
function goalForBucket(bucket) {
  if (bucket === 'peer') {
    return 'Ask for a 15-minute conversation. A soft, optional referral ask is welcome (for example "or point me to the right person"). Keep it low-pressure. Make exactly one ask.';
  }
  return 'Ask for a 15-minute conversation. Keep it low-pressure. Make exactly one ask.';
}

function domainFromLink(link) {
  if (!link) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(link) ? link : `https://${link}`);
    return u.hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

// Drop a leading greeting line ("Hi Sam," or "Hi there,") so the "opening" we
// compare/inspect is the first real sentence of the email.
function stripGreeting(body) {
  let t = (body || '').trim();
  t = t.replace(/^\s*(hi|hello|hey|dear)\b[^\n]*\n+/i, '');
  t = t.replace(/^\s*(hi|hello|hey|dear)\b[^,\n]*,\s*/i, '');
  return t;
}

function extractOpening(body) {
  const t = stripGreeting(body);
  return (t.split(/(?<=[.?!])\s|\n/)[0] || '').trim();
}

// First ~6 normalized words of the opening sentence — used to detect when two
// emails in the same campaign open with the same construction.
function openingSignature(body) {
  return extractOpening(body)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join(' ');
}

// Content words of the opening sentence (drop short/function words). Two openings
// that lean on the SAME concrete detail — e.g. both leading with the Mars-rover
// story — share most content words even when the wording differs, which the
// first-6-word signature misses. Used for a topic-overlap variety check.
const OPENING_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'these', 'those', 'are', 'was', 'were', 'been',
  'has', 'have', 'had', 'its', 'their', 'they', 'them', 'about', 'how', 'what', 'which', 'who',
  'can', 'could', 'would', 'will', 'your', 'you', 'our', 'from', 'into', 'over', 'not', 'but',
]);
function openingContentWords(body) {
  return new Set(
    extractOpening(body)
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !OPENING_STOPWORDS.has(w))
  );
}
function openingsOverlap(aSet, bSet) {
  if (!aSet.size || !bSet.size) return 0;
  let inter = 0;
  for (const w of aSet) if (bSet.has(w)) inter += 1;
  const union = aSet.size + bSet.size - inter;
  return union ? inter / union : 0;
}

function firstSentenceAboutSender(body) {
  const first = extractOpening(body);
  return /^(i|we|my|our)\b/i.test(first);
}

function companyReferenced(draft, company) {
  if (!company || !company.name) return true;
  const hay = `${draft.body || ''} ${draft.subject || ''}`.toLowerCase();
  if (hay.includes(company.name.toLowerCase())) return true;
  const keywords = (company.key_products || '')
    .split(/[,;\n/|]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 3);
  return keywords.some((k) => hay.includes(k));
}

// ── Deterministic structure pass ─────────────────────────────────────────────
// Weak local models (e.g. llama3.1:8b) routinely emit the whole email as ONE
// run-on paragraph with no greeting break and no sign-off. smtp.js renders a
// blank line as a <p> block and a single newline as <br>, so shaping the body
// into "greeting / short paragraphs / — First" makes both the editor preview and
// the sent email read like a real email. This is purely mechanical — no model
// call — so it is a guaranteed floor on structure regardless of model quality.

const GREETING_RE = /^\s*((?:hi|hello|hey|dear)\b[^,\n]*,)/i;
const CLOSER_WORD_RE = /^(best|regards|thanks|thank|cheers|sincerely|warmly|kind|warm|many)$/i;

// Split into sentences only at a terminal mark followed by whitespace and the
// start of the next sentence (capital letter or opening quote/paren). This avoids
// splitting "3.5", "U.S", or "e.g. the" mid-sentence.
function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z"'(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// A short trailing line that is a sign-off ("Best,", "Thanks, Alex", "Alex") and
// not a real sentence — dropped so we can re-add a single canonical "— First".
function isSignoffLine(line, senderFirst) {
  const l = (line || '').trim();
  if (!l) return false;
  if (senderFirst && l.toLowerCase() === senderFirst.trim().toLowerCase()) return true;
  const words = l.split(/\s+/);
  if (words.length > 4) return false;
  const firstWord = (words[0] || '').replace(/[^a-zA-Z]/g, '');
  return CLOSER_WORD_RE.test(firstWord);
}

function stripSignature(text, senderFirst) {
  // 1. Canonical dash sign-off (em/en dash or "--" + 1–3 capitalized words) at the
  //    very end. ASCII single hyphen is excluded so "15-minute"/"RAG-based" survive.
  let t = text
    .replace(/(?:\n+\s*|\s+)(?:[—–]|--)\s*[A-Z][\w'’.-]*(?:\s+[A-Z][\w'’.-]*){0,2}\s*$/u, '')
    .trim();

  // 2. Closing-word sign-off lines ("Best,\nAlex" / "Thanks, Alex") at the end.
  const lines = t.split('\n');
  while (lines.length && (!lines[lines.length - 1].trim() || isSignoffLine(lines[lines.length - 1], senderFirst))) {
    lines.pop();
  }
  return lines.join('\n').trim();
}

// Turn the body core (greeting + sign-off already removed) into short paragraphs.
// If the model already used blank lines or line breaks, respect them. Otherwise
// break a run-on blob into opening / bridge / ask by sentence boundaries.
function paragraphsFromCore(core) {
  const byBlank = core.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  if (byBlank.length > 1) return byBlank;
  const byLine = core.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (byLine.length > 1) return byLine;

  const sentences = splitSentences(core);
  if (sentences.length <= 2) return sentences.length ? sentences : [core.trim()].filter(Boolean);
  const opening = sentences[0];
  const ask = sentences[sentences.length - 1];
  const bridge = sentences.slice(1, -1).join(' ');
  return [opening, bridge, ask];
}

// The sender's display name for the email sign-off. The profile schema means
// `name` to hold the full name; some profiles only put the first name there and
// the surname in `first_name`. Prefer a `name` that already reads as a full name
// (has a space); otherwise join the two distinct tokens so the sign-off shows the
// complete name (e.g. name "Alex" + first_name "Morgan" → "Alex Morgan").
function senderSignName(user_profile = {}) {
  const name = String(user_profile.name || '').trim();
  const first = String(user_profile.first_name || '').trim();
  if (name && /\s/.test(name)) return name;
  if (name && first && first.toLowerCase() !== name.toLowerCase()) return `${name} ${first}`;
  return name || first;
}

/**
 * Guarantee a real email shape: a greeting line, blank-line-separated short
 * paragraphs, and a "— Name" sign-off (the sender's full name when known).
 * Idempotent and safe to run on output that is already well structured.
 */
function enforceStructure(rawBody, { recipientFirst, senderFirst, senderFull } = {}) {
  let text = String(rawBody || '').replace(/\r\n?/g, '\n').trim();
  if (!text) return text;

  // 1. Pull off the greeting (or synthesize one from the recipient's first name).
  let greeting = '';
  const gm = text.match(GREETING_RE);
  if (gm) {
    greeting = gm[1].trim();
    text = text.slice(gm[0].length).replace(/^[\s,]+/, '');
  } else if (recipientFirst && recipientFirst !== '(unknown)') {
    greeting = `Hi ${recipientFirst},`;
  }

  // 2. Drop any sign-off the model added, then shape the rest into paragraphs.
  const core = stripSignature(text.trim(), senderFirst);
  const paragraphs = paragraphsFromCore(core);

  // 3. Re-attach exactly one canonical sign-off — the sender's full name when
  //    known, otherwise their first name.
  const signName =
    senderFull && senderFull !== '(unknown)'
      ? senderFull
      : senderFirst && senderFirst !== '(unknown)'
        ? senderFirst
        : '';
  const signature = signName ? `— ${signName}` : '';

  return [greeting, ...paragraphs, signature].filter(Boolean).join('\n\n');
}

// Build the structured user message: SENDER / RECIPIENT / COMPANY / CAMPAIGN
// ANGLE / GOAL, then "Now write the email." No {variable} template is pasted in
// — the model fills facts from the labeled context instead.
function buildUserMessage({ user_profile = {}, contact = {}, company = {}, setup = {}, bucket, goal, recentOpenings = [] }) {
  const achievements = (user_profile.key_achievements || [])
    .map((a) => `  - ${a}`)
    .join('\n');
  const links = user_profile.links || {};
  const linkedin = links.linkedin || links.LinkedIn || links.linkedIn || '';
  const domain = domainFromLink(company.company_link);
  const seniorityLabel = bucket || bucketFromSeniority(contact.seniority);
  const priorOpenings = (recentOpenings || [])
    .map((b) => extractOpening(b))
    .filter(Boolean)
    .slice(0, 3);

  const lines = [
    'Write one personalized outreach email using ONLY the context below. Follow every hard rule in the system prompt.',
    '',
    'SENDER:',
    `- Name: ${user_profile.name || '(unknown)'}`,
    `- First name: ${user_profile.first_name || '(unknown)'}`,
    `- Current role: ${user_profile.current_role || '(unknown)'}${user_profile.current_company ? ` at ${user_profile.current_company}` : ''}`,
    user_profile.location ? `- Location: ${user_profile.location}` : null,
    user_profile.summary ? `- Background summary: ${user_profile.summary}` : null,
    achievements ? `- Key achievements:\n${achievements}` : null,
    linkedin ? `- LinkedIn: ${linkedin}` : null,
    setup.detailed_summary
      ? `- More about the sender (quote at most one short phrase if useful):\n${String(setup.detailed_summary).slice(0, 1500)}`
      : null,
    setup.cv_text
      ? `- CV / resume (pull ONE achievement that connects to this company; do not list everything):\n${String(setup.cv_text).slice(0, 2500)}`
      : null,
    '',
    'RECIPIENT:',
    `- First name: ${contact.first_name || '(missing — open with "Hi there")'}`,
    contact.last_name ? `- Last name: ${contact.last_name}` : null,
    `- Job title: ${contact.title || '(unknown)'}`,
    `- Seniority: ${seniorityLabel}`,
    contact.linkedin_url ? `- LinkedIn: ${contact.linkedin_url}` : null,
    '',
    'COMPANY:',
    `- Name: ${company.name}`,
    domain ? `- Domain: ${domain}` : null,
    company.industry ? `- Industry: ${company.industry}` : null,
    company.key_products ? `- Keywords / products: ${company.key_products}` : null,
    company.fetched_text
      ? `- Fetched page summary (mine ONE concrete, specific detail — a named product, customer, value, or initiative; skip nav and marketing fluff):\n${String(company.fetched_text).slice(0, 1500)}`
      : null,
    '',
    'CAMPAIGN ANGLE (the sender wrote this — it is why they are targeting this company; let it shape the email):',
    company.custom_context && company.custom_context.trim()
      ? company.custom_context.trim()
      : '(none provided — infer a specific angle from the company details above)',
    '',
    'GOAL FOR THIS EMAIL:',
    goal,
  ];

  if (priorOpenings.length) {
    lines.push(
      '',
      'OPENINGS ALREADY USED for other people at this company — open with a DIFFERENT construction, do not echo these:',
      ...priorOpenings.map((o) => `- ${o}`)
    );
  }

  lines.push(
    '',
    'EMAIL STRUCTURE (follow exactly — this shapes the "body" value):',
    `- Greeting on its own line: "Hi ${contact.first_name || 'there'},"`,
    '- Blank line, then a 1-sentence opening that NAMES a concrete, specific detail about the company (a product, customer, feature, number, or initiative from the context) and says something concrete about it. Do NOT write "your work" / "your team\'s work". Do NOT open with admiration ("I was impressed", "I admire", "I came across").',
    '- Blank line, then 1–2 sentences connecting the sender to them (one concrete, relevant fact).',
    '- Blank line, then the single ask in one sentence.',
    `- Blank line, then the sign-off on its own line: "— ${senderSignName(user_profile) || '(your name)'}"`,
    'Every paragraph break in the "body" string MUST be two newline characters (\\n\\n). Example body: "Hi Sam,\\n\\nYour work on X is the clearest take I have read.\\n\\nI spent the last year building Y, which lines up with that.\\n\\nWould 15 minutes next week be useful?\\n\\n— Alex"'
  );

  lines.push(
    '',
    'GROUNDING (critical): Use ONLY the facts above. Do NOT invent products, projects, partnerships, customers, tools, awards, or numbers that are not present in this context. If the sender has no specific achievement to cite, keep the relevance sentence general — never fabricate a metric or a project.'
  );
  lines.push('', 'Now write the email. Output ONLY a JSON object: {"subject": "...", "body": "..."}');

  return lines.filter((l) => l !== null && l !== undefined).join('\n');
}

// Map of placeholder names the model might emit -> real values. Recipient first
// name falls back to "there" so a missing name never leaks "{first_name}".
function buildSubstitutionContext({ user_profile = {}, contact = {}, company = {} }) {
  const recipientFirst = (contact.first_name || '').trim();
  const recipientFull = (contact.full_name || '').trim();
  const anyRecipient = recipientFull || recipientFirst || 'there';
  return {
    first_name: recipientFirst || 'there',
    firstname: recipientFirst || 'there',
    recipient_first_name: recipientFirst || 'there',
    name: anyRecipient,
    full_name: anyRecipient,
    fullname: anyRecipient,
    recipient: anyRecipient,
    company: company.name || '',
    company_name: company.name || '',
    user_first_name: user_profile.first_name || '',
    sender_first_name: user_profile.first_name || '',
    user_name: user_profile.name || '',
    sender_name: user_profile.name || '',
    user_company: user_profile.current_company || '',
    user_role: user_profile.current_role || '',
  };
}

// Replace {placeholder} tokens by code (the bug fix): known tokens get real
// values, unknown ones are left intact so the quality check flags them.
function substituteVariables(text, ctx) {
  if (!text) return text || '';
  return text.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (match, rawKey) => {
    const key = rawKey.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(ctx, key)) return ctx[key];
    return match;
  });
}

function applySubstitution(draft, ctx) {
  return {
    subject: substituteVariables(draft.subject, ctx),
    body: substituteVariables(draft.body, ctx),
  };
}

// Escape raw control characters (newlines, tabs, etc.) that appear *inside*
// JSON string literals. Local models (e.g. llama3.1:8b) routinely emit a real
// newline inside the "body" value, which is invalid JSON and makes JSON.parse
// throw "Bad control character in string literal". We only touch chars inside
// strings, so JSON structure is preserved.
function escapeControlCharsInStrings(jsonText) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < jsonText.length; i++) {
    const ch = jsonText[i];
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (inString && code < 0x20) {
      if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else out += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
    out += ch;
  }
  return out;
}

// Last-resort recovery: pull "subject"/"body" values out directly when the
// object still will not parse. Keeps a quirky local model from hard-failing
// the whole campaign.
function salvageSubjectBody(candidate) {
  const grab = (key) => {
    const m = candidate.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    if (!m) return null;
    return m[1]
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  };
  const subject = grab('subject');
  const body = grab('body');
  if (subject === null && body === null) return null;
  return { subject: subject ?? '', body: body ?? '' };
}

function extractFirstJsonObject(text) {
  if (!text) throw new Error('empty LLM response');
  const start = text.indexOf('{');
  if (start === -1) throw new Error('no JSON object found in LLM response');
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error('unbalanced JSON in LLM response');

  const candidate = text.slice(start, end + 1);

  // 1. Strict parse (well-behaved models / cloud Claude land here).
  try {
    return JSON.parse(candidate);
  } catch (strictErr) {
    // 2. Escape stray control chars inside strings and retry.
    try {
      return JSON.parse(escapeControlCharsInStrings(candidate));
    } catch (err) {
      // 3. Tolerant field extraction so a usable draft still comes back.
      const salvaged = salvageSubjectBody(candidate);
      if (salvaged) return salvaged;
      throw strictErr;
    }
  }
}

/**
 * Run the post-generation quality checks. Returns an array of warning codes.
 * `recentOpenings` is an array of recent draft bodies in the same campaign;
 * when supplied, a reused opening is flagged so the caller can regenerate.
 */
function runQualityChecks(draft, contact, company, bucket, recentOpenings = []) {
  const warnings = [];
  const body = draft.body || '';
  const subject = draft.subject || '';
  const bodyLower = body.toLowerCase();

  // 1. Body word count 80–130.
  const words = body.split(/\s+/).filter(Boolean).length;
  if (words < MIN_BODY_WORDS) warnings.push('too_short');
  if (words > MAX_BODY_WORDS) warnings.push(`too_long:${words}`);

  // 2. Subject under 60 characters.
  if (subject.length > SUBJECT_MAX_CHARS) warnings.push('subject_too_long');

  // 3. No banned words.
  for (const word of BANNED_WORDS) {
    if (bodyLower.includes(word)) warnings.push(`banned_word:${word}`);
  }

  // 4. No exclamation marks.
  if (body.includes('!')) warnings.push('exclamation_mark');

  // 5. No literal {variables} (should have been substituted by code).
  if (UNSUB_VAR_RE.test(body) || UNSUB_VAR_RE.test(subject)) {
    warnings.push('unsubstituted_variable');
  }

  // 6. Body references the company name OR a specific keyword/product.
  if (!companyReferenced(draft, company)) warnings.push('company_name_missing');

  // 7. Recipient first name used in the body.
  if (contact && contact.first_name && !bodyLower.includes(contact.first_name.toLowerCase())) {
    warnings.push('first_name_missing');
  }

  // 8. Subject does not start with a dead phrase.
  if (BAD_SUBJECT_PREFIX_RE.test(subject.trim())) warnings.push('subject_bad_prefix');

  // 9. First sentence is about the recipient/company, not the sender.
  if (firstSentenceAboutSender(body)) warnings.push('first_sentence_about_sender');

  // 10. Never the phrase "your work" / "your team's work" (explicit user rule).
  if (YOUR_WORK_RE.test(body)) warnings.push('your_work_phrase');

  // 11. Opening is a concrete detail, not generic admiration.
  if (ADMIRATION_OPENING_RE.test(extractOpening(body))) warnings.push('generic_opening');

  // Vary openings across the same campaign. Flag a repeat when EITHER the opening
  // construction matches (first-6-word signature) OR it leans on the same concrete
  // detail as a prior opening (high content-word overlap, even if reworded).
  if (recentOpenings && recentOpenings.length) {
    const sig = openingSignature(body);
    const sigDup =
      sig && sig.split(' ').length >= 3 && recentOpenings.map(openingSignature).some((u) => u && u === sig);
    const wordsSet = openingContentWords(body);
    const topicDup =
      wordsSet.size >= 4 && recentOpenings.some((b) => openingsOverlap(wordsSet, openingContentWords(b)) >= 0.5);
    if (sigDup || topicDup) warnings.push('opening_repeated');
  }

  // Advisory only (surfaced, but not a regeneration trigger).
  if (EMOJI_RE.test(body)) warnings.push('emoji_detected');
  const aiCount = body.match(/\bAI\b/g)?.length || 0;
  if (aiCount > 3) warnings.push(`ai_overuse:${aiCount}`);

  return warnings;
}

// Everything except these is a blocking warning that triggers one regeneration.
const ADVISORY_EXACT = new Set(['emoji_detected']);
const ADVISORY_PREFIXES = ['ai_overuse:'];
function isBlockingWarning(code) {
  if (ADVISORY_EXACT.has(code)) return false;
  if (ADVISORY_PREFIXES.some((p) => code.startsWith(p))) return false;
  return true;
}

function describeWarning(code, { company, contact } = {}) {
  if (code.startsWith('banned_word:')) return `Remove the banned word "${code.slice('banned_word:'.length)}".`;
  if (code.startsWith('too_long:')) return `Body is too long (${code.slice('too_long:'.length)} words). Cut it to 80–130 words.`;
  switch (code) {
    case 'too_short':
      return 'Body is too short. Write 80–130 words.';
    case 'subject_too_long':
      return 'Subject is too long. Keep it under 60 characters.';
    case 'subject_bad_prefix':
      return 'Subject starts with a dead phrase (Quick / The / Reaching out / Hi / Question). Make it concrete and specific.';
    case 'exclamation_mark':
      return 'Remove every exclamation mark.';
    case 'unsubstituted_variable':
      return 'There is an unfilled {placeholder}. Use a real value or remove it.';
    case 'company_name_missing':
      return `Reference ${company?.name || 'the company'} by name, or one of its specific products/keywords.`;
    case 'first_name_missing':
      return `Greet the recipient by first name${contact?.first_name ? ` (${contact.first_name})` : ''}.`;
    case 'first_sentence_about_sender':
      return 'The first sentence is about the sender. Make the first sentence about the recipient or their company.';
    case 'opening_repeated':
      return 'Use a different opening construction — this one was already used for someone else at this company.';
    case 'your_work_phrase':
      return 'Delete the phrase "your work" / "your team\'s work". Open instead by naming a concrete, specific thing about the company — a product, customer, feature, number, or initiative — and saying something concrete about it.';
    case 'generic_opening':
      return 'The first sentence is generic admiration ("I was impressed" / "I admire" / "I came across"). Replace it: name a specific detail about the company and make a concrete observation about it. No praise of "your work".';
    default:
      return `Fix: ${code}.`;
  }
}

function buildRetryNote(blocking, draft, company, contact) {
  return [
    '',
    'Your previous attempt did not pass review.',
    'Previous attempt:',
    JSON.stringify({ subject: draft.subject, body: draft.body }),
    '',
    'Fix ALL of these problems and keep every other hard rule:',
    ...blocking.map((c) => `- ${describeWarning(c, { company, contact })}`),
    '',
    'Rewrite the email now. Output ONLY JSON: {"subject": "...", "body": "..."}',
  ].join('\n');
}

function appendComplianceFooter(body) {
  if (!body) return COMPLIANCE_FOOTER.trimStart();
  return body.trimEnd() + COMPLIANCE_FOOTER;
}

async function callModel(provider, system, user) {
  const response = await provider.complete({
    system,
    user,
    maxTokens: 800,
    temperature: DRAFT_TEMPERATURE,
  });

  let parsed;
  try {
    parsed = extractFirstJsonObject(response.text);
  } catch (err) {
    logger.warn({ err, text: response.text }, 'failed to parse LLM JSON');
    throw new Error(`LLM returned unparseable response: ${err.message}`);
  }
  if (typeof parsed.subject !== 'string' || typeof parsed.body !== 'string') {
    throw new Error('LLM response missing string subject/body');
  }
  return {
    draft: { subject: parsed.subject.trim(), body: parsed.body.trim() },
    tokens: response.tokens || { input: 0, output: 0 },
    model: response.model,
  };
}

/**
 * Generate one personalized draft.
 *
 * @param {object} input
 * @param {object} input.user_profile
 * @param {object} input.contact          { full_name, first_name, last_name, title, seniority, linkedin_url, email }
 * @param {object} input.company          { name, custom_context, company_link, industry, key_products, fetched_text }
 * @param {object} [input.setup]          { cv_text, detailed_summary }
 * @param {string[]} [input.recent_openings] - recent draft bodies in the same campaign (for opening variety)
 * @param {object} [input.template]       - only sequence_step is read
 * @param {object} [deps]
 * @param {object} [deps.provider]        - LLM provider; defaults to factory
 * @returns {Promise<{ subject, body, quality_warnings: string[], needs_review: boolean, tokens, model, template }>}
 */
async function generateDraft(input, deps = {}) {
  const { user_profile, contact, company, setup } = input;
  if (!user_profile) throw new Error('user_profile is required');
  if (!contact || !contact.email) throw new Error('contact with email is required');
  if (!company || !company.name) throw new Error('company with name is required');

  const bucket = bucketFromSeniority(contact.seniority);
  const sequenceStep = input.template?.sequence_step ?? 0;
  const recentOpenings = Array.isArray(input.recent_openings) ? input.recent_openings : [];
  const goal = goalForBucket(bucket);

  const system = loadTemplate('system-prompt');
  const baseUser = buildUserMessage({ user_profile, contact, company, setup, bucket, goal, recentOpenings });
  const provider = deps.provider || getProvider();
  const subCtx = buildSubstitutionContext({ user_profile, contact, company });

  let tokensIn = 0;
  let tokensOut = 0;
  let model;
  const attempts = [];

  const runAttempt = async (userMessage) => {
    const r = await callModel(provider, system, userMessage);
    tokensIn += r.tokens.input || 0;
    tokensOut += r.tokens.output || 0;
    model = r.model;
    const draft = applySubstitution(r.draft, subCtx);
    const warnings = runQualityChecks(draft, contact, company, bucket, recentOpenings);
    const blocking = warnings.filter(isBlockingWarning);
    attempts.push({ draft, warnings, blocking });
    return blocking;
  };

  // First attempt, then regenerate up to MAX_DRAFT_ATTEMPTS total while any
  // blocking check still fails. Each retry feeds back the specific failures so a
  // weak local model gets concrete corrections. Stop early once an attempt is clean.
  let lastBlocking = await runAttempt(baseUser);
  while (lastBlocking.length > 0 && attempts.length < MAX_DRAFT_ATTEMPTS) {
    const prev = attempts[attempts.length - 1];
    const retryUser = baseUser + '\n' + buildRetryNote(prev.blocking, prev.draft, company, contact);
    try {
      lastBlocking = await runAttempt(retryUser);
    } catch (err) {
      // If a regeneration call fails, keep the attempts we already have.
      logger.warn({ err }, 'draft regeneration attempt failed; keeping previous attempts');
      break;
    }
  }

  // Keep the attempt with the fewest blocking warnings (a later attempt wins ties).
  let best = attempts[0];
  for (const a of attempts) {
    if (a.blocking.length <= best.blocking.length) best = a;
  }

  // Final deterministic pass: guarantee greeting / short paragraphs / sign-off so
  // a weak local model's run-on blob still renders as a real email.
  const structuredBody = enforceStructure(best.draft.body, {
    recipientFirst: (contact.first_name || '').trim(),
    senderFirst: (user_profile.first_name || '').trim(),
    senderFull: senderSignName(user_profile),
  });

  return {
    subject: best.draft.subject,
    body: structuredBody,
    quality_warnings: best.warnings,
    needs_review: best.blocking.length > 0,
    tokens: { input: tokensIn, output: tokensOut },
    model,
    template: { seniority_bucket: bucket, sequence_step: sequenceStep },
  };
}

module.exports = {
  generateDraft,
  runQualityChecks,
  enforceStructure,
  senderSignName,
  appendComplianceFooter,
  extractFirstJsonObject,
  buildUserMessage,
  substituteVariables,
  bucketFromSeniority,
  templateNameForBucket,
  loadTemplate,
  BANNED_WORDS,
  COMPLIANCE_FOOTER,
};
