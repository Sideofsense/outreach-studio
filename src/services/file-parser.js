'use strict';

const path = require('node:path');
const Papa = require('papaparse');
const XLSX = require('xlsx');

const { classifySeniority } = require('./seniority-classifier');

const CANONICAL = {
  full_name: ['name', 'full name', 'fullname', 'contact name', 'person', 'candidate name'],
  first_name: ['first name', 'firstname', 'given name', 'first'],
  last_name: ['last name', 'lastname', 'surname', 'family name', 'last'],
  title: ['title', 'designation', 'role', 'job title', 'position', 'current title'],
  email: ['email', 'e-mail', 'email address', 'email id', 'emailid', 'work email'],
  linkedin_url: ['linkedin', 'linkedin url', 'linkedin profile', 'linkedin link', 'li url', 'profile url'],
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeHeader(raw) {
  if (raw === null || raw === undefined) return '';
  return String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Build a map from incoming column index → canonical field name based on synonyms.
 * Headers that match no canonical field are ignored.
 */
function detectColumns(headers) {
  const lookup = new Map(); // normalizedSynonym -> canonical
  for (const [canonical, synonyms] of Object.entries(CANONICAL)) {
    for (const syn of synonyms) {
      lookup.set(syn, canonical);
    }
  }
  const map = {};
  headers.forEach((raw, idx) => {
    const canonical = lookup.get(normalizeHeader(raw));
    if (canonical && !(canonical in map)) {
      map[canonical] = idx;
    }
  });
  return map;
}

function cellAt(row, idx) {
  if (idx === undefined || idx < 0) return null;
  const v = row[idx];
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function splitName(fullName) {
  if (!fullName) return { first_name: null, last_name: null };
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { first_name: parts[0], last_name: null };
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') };
}

function joinName(first, last) {
  return [first, last].filter(Boolean).join(' ').trim() || null;
}

function buildRow(rawRow, colMap, sourceRowNumber) {
  const full = cellAt(rawRow, colMap.full_name);
  const first = cellAt(rawRow, colMap.first_name);
  const last = cellAt(rawRow, colMap.last_name);
  const title = cellAt(rawRow, colMap.title);
  const linkedin = cellAt(rawRow, colMap.linkedin_url);
  let email = cellAt(rawRow, colMap.email);
  if (email) email = email.toLowerCase();

  let first_name = first;
  let last_name = last;
  let full_name = full;

  if (full_name && !first_name && !last_name) {
    const split = splitName(full_name);
    first_name = split.first_name;
    last_name = split.last_name;
  } else if (!full_name && (first_name || last_name)) {
    full_name = joinName(first_name, last_name);
  }

  const warnings = [];
  if (!email) warnings.push('missing_email');
  else if (!EMAIL_RE.test(email)) warnings.push('invalid_email');
  if (!full_name && !first_name) warnings.push('missing_name');

  return {
    source_row: sourceRowNumber,
    full_name,
    first_name,
    last_name,
    title,
    seniority: classifySeniority(title),
    email,
    linkedin_url: linkedin,
    valid: warnings.length === 0,
    warnings,
  };
}

function dedupByEmail(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (!row.email || !EMAIL_RE.test(row.email)) {
      out.push(row);
      continue;
    }
    if (seen.has(row.email)) {
      out.push({ ...row, valid: false, warnings: [...row.warnings, 'duplicate_email'] });
    } else {
      seen.add(row.email);
      out.push(row);
    }
  }
  return out;
}

function parseCsvBuffer(buffer) {
  // Strip UTF-8 BOM if present (common in Excel-exported CSVs)
  let text = buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF
    ? buffer.toString('utf8', 3)
    : buffer.toString('utf8');
  // Normalise Windows CRLF → LF so PapaParse line detection is consistent
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const result = Papa.parse(text, {
    header: false,
    skipEmptyLines: 'greedy',
    transform: (v) => (typeof v === 'string' ? v.trim() : v),
  });
  if (!result.data || result.data.length === 0) {
    return { headers: [], rows: [] };
  }
  const [headers, ...rows] = result.data;
  return { headers: headers || [], rows };
}

function parseXlsxBuffer(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const firstSheetName = wb.SheetNames[0];
  if (!firstSheetName) return { headers: [], rows: [] };
  const sheet = wb.Sheets[firstSheetName];
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: null });
  if (!data || data.length === 0) return { headers: [], rows: [] };
  const [headers, ...rows] = data;
  return { headers: headers || [], rows };
}

/**
 * Parse a contacts file buffer. Returns { headers, columnMap, rows, stats }.
 * Caller decides which rows to commit based on per-row .valid / .warnings.
 *
 * @param {Buffer} buffer
 * @param {string} filename - used to detect extension (.csv / .xlsx / .xls)
 */
function parseContactsFile(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  let parsed;
  if (ext === '.csv') {
    parsed = parseCsvBuffer(buffer);
  } else if (ext === '.xlsx' || ext === '.xls') {
    parsed = parseXlsxBuffer(buffer);
  } else {
    throw new Error(`unsupported file extension "${ext}"; accept .csv, .xlsx, .xls`);
  }

  const { headers, rows: dataRows } = parsed;
  const columnMap = detectColumns(headers);

  const requiredMissing = ['email'].filter((f) => !(f in columnMap));
  if (requiredMissing.length) {
    return {
      headers,
      columnMap,
      rows: [],
      stats: { total: 0, valid: 0, invalid: 0 },
      fatal: `required column missing: ${requiredMissing.join(', ')}. Expected one of: ${requiredMissing
        .flatMap((f) => CANONICAL[f])
        .join(', ')}.`,
    };
  }

  const builtRows = dataRows.map((r, i) => buildRow(r, columnMap, i + 2)); // +2: header is row 1, data starts at row 2
  const deduped = dedupByEmail(builtRows);

  const valid = deduped.filter((r) => r.valid).length;
  return {
    headers,
    columnMap,
    rows: deduped,
    stats: {
      total: deduped.length,
      valid,
      invalid: deduped.length - valid,
    },
  };
}

module.exports = {
  parseContactsFile,
  detectColumns,
  normalizeHeader,
  splitName,
  CANONICAL,
};
