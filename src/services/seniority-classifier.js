'use strict';

/**
 * Map a free-text job title to a seniority bucket used to pick the email template.
 * Case-insensitive substring matching with order-based precedence — more specific
 * patterns are checked first. Returns 'other' when nothing matches.
 *
 * Buckets: 'cxo' | 'vp' | 'head' | 'staff_pm' | 'sr_pm' | 'pm' | 'apm' | 'other'
 */
function classifySeniority(title) {
  if (!title) return 'other';
  const t = String(title).toLowerCase();

  // CXOs first (most specific)
  if (/\b(ceo|chief executive|founder|co-?founder)\b/.test(t)) return 'cxo';
  if (/\b(cto|coo|chro|cmo|cfo|cpo|chief)\b/.test(t)) return 'cxo';

  // VPs
  if (/\bvp\b|vice president/.test(t)) return 'vp';

  // Heads / Directors
  if (/head of|director of|director,|director\b/.test(t)) return 'head';

  // Staff / Principal / Lead / Group
  if (/staff (product|pm)|principal (product|pm)|lead pm|lead product|group product|gpm/.test(t)) return 'staff_pm';

  // Senior PM
  if (/(senior|sr\.?)\s*(product|pm)/.test(t)) return 'sr_pm';

  // Technical PM — treated as senior peer
  if (/technical product|tpm/.test(t)) return 'sr_pm';

  // APM
  if (/associate product|apm|assistant product/.test(t)) return 'apm';

  // PM (catch-all for product manager)
  if (/product manager|\bpm\b/.test(t)) return 'pm';

  return 'other';
}

module.exports = { classifySeniority };
