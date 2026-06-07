import { describe, it, expect } from 'vitest';
import XLSX from 'xlsx';

import {
  parseContactsFile,
  detectColumns,
  normalizeHeader,
  splitName,
  CANONICAL,
} from '../src/services/file-parser.js';

function bufferOfCsv(text) {
  return Buffer.from(text, 'utf8');
}

function bufferOfXlsx(aoa) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

describe('normalizeHeader', () => {
  it('lowercases, trims, collapses whitespace', () => {
    expect(normalizeHeader('  Email   Address  ')).toBe('email address');
    expect(normalizeHeader('NAME')).toBe('name');
    expect(normalizeHeader(null)).toBe('');
    expect(normalizeHeader(undefined)).toBe('');
  });
});

describe('detectColumns', () => {
  it('maps canonical fields from common variants', () => {
    const map = detectColumns(['Full Name', 'Designation', 'Email Id', 'LinkedIn URL']);
    expect(map).toEqual({
      full_name: 0,
      title: 1,
      email: 2,
      linkedin_url: 3,
    });
  });

  it('uses first-seen winner if duplicate synonyms appear', () => {
    const map = detectColumns(['Email', 'Email Address', 'Name']);
    expect(map.email).toBe(0);
    expect(map.full_name).toBe(2);
  });

  it('ignores unknown headers', () => {
    const map = detectColumns(['Foo', 'Bar', 'Email', 'Quarter']);
    expect(map).toEqual({ email: 2 });
  });

  it('covers every canonical field in the spec', () => {
    for (const canonical of Object.keys(CANONICAL)) {
      expect(CANONICAL[canonical].length).toBeGreaterThan(0);
    }
  });
});

describe('splitName', () => {
  it('splits two-word names on first space', () => {
    expect(splitName('Ada Lovelace')).toEqual({ first_name: 'Ada', last_name: 'Lovelace' });
  });
  it('handles multi-word last name', () => {
    expect(splitName('Maria del Mar Garcia')).toEqual({ first_name: 'Maria', last_name: 'del Mar Garcia' });
  });
  it('handles single-word name', () => {
    expect(splitName('Madonna')).toEqual({ first_name: 'Madonna', last_name: null });
  });
  it('handles empty', () => {
    expect(splitName('')).toEqual({ first_name: null, last_name: null });
  });
});

describe('parseContactsFile — CSV', () => {
  it('parses a canonical CSV', () => {
    const csv = [
      'Name,Job Title,Email Address,LinkedIn',
      'Ada Lovelace,Senior Product Manager,ada@example.com,linkedin.com/in/ada',
      'Grace Hopper,VP Engineering,grace@example.com,',
    ].join('\n');
    const result = parseContactsFile(bufferOfCsv(csv), 'contacts.csv');
    expect(result.stats).toEqual({ total: 2, valid: 2, invalid: 0 });
    expect(result.rows[0]).toMatchObject({
      full_name: 'Ada Lovelace',
      first_name: 'Ada',
      last_name: 'Lovelace',
      title: 'Senior Product Manager',
      seniority: 'sr_pm',
      email: 'ada@example.com',
      linkedin_url: 'linkedin.com/in/ada',
      valid: true,
    });
    expect(result.rows[1].seniority).toBe('vp');
  });

  it('flags rows with missing email', () => {
    const csv = 'Name,Email\nAda,\nGrace,grace@example.com\n';
    const result = parseContactsFile(bufferOfCsv(csv), 'x.csv');
    expect(result.stats).toEqual({ total: 2, valid: 1, invalid: 1 });
    expect(result.rows[0].warnings).toContain('missing_email');
  });

  it('flags rows with malformed email', () => {
    const csv = 'Name,Email\nAda,not-an-email\n';
    const result = parseContactsFile(bufferOfCsv(csv), 'x.csv');
    expect(result.rows[0].warnings).toContain('invalid_email');
    expect(result.rows[0].valid).toBe(false);
  });

  it('dedupes by lowercase email', () => {
    const csv = 'Name,Email\nAda,Ada@Example.com\nAlt Ada,ada@example.com\n';
    const result = parseContactsFile(bufferOfCsv(csv), 'x.csv');
    expect(result.stats.total).toBe(2);
    expect(result.rows[1].warnings).toContain('duplicate_email');
  });

  it('synthesises full_name from first + last when missing', () => {
    const csv = 'First Name,Last Name,Email\nAda,Lovelace,ada@example.com\n';
    const result = parseContactsFile(bufferOfCsv(csv), 'x.csv');
    expect(result.rows[0].full_name).toBe('Ada Lovelace');
    expect(result.rows[0].first_name).toBe('Ada');
  });

  it('reports a fatal error when email column is missing', () => {
    const csv = 'Name,Title\nAda,PM\n';
    const result = parseContactsFile(bufferOfCsv(csv), 'x.csv');
    expect(result.fatal).toMatch(/email/);
  });

  it('skips empty rows', () => {
    const csv = 'Name,Email\nAda,ada@example.com\n\n\nGrace,grace@example.com\n';
    const result = parseContactsFile(bufferOfCsv(csv), 'x.csv');
    expect(result.stats.total).toBe(2);
  });

  it('trims whitespace and lowercases email', () => {
    const csv = 'Name,Email\n  Ada  ,  Ada@Example.com  \n';
    const result = parseContactsFile(bufferOfCsv(csv), 'x.csv');
    expect(result.rows[0].full_name).toBe('Ada');
    expect(result.rows[0].email).toBe('ada@example.com');
  });
});

describe('parseContactsFile — XLSX', () => {
  it('parses an xlsx file with weird header names', () => {
    const buf = bufferOfXlsx([
      ['Contact Name', 'Designation', 'Email Id', 'LinkedIn Link'],
      ['Ada Lovelace', 'Head of Product', 'ada@example.com', 'linkedin.com/in/ada'],
      ['Grace Hopper', 'CTO', 'grace@example.com', null],
    ]);
    const result = parseContactsFile(buf, 'contacts.xlsx');
    expect(result.stats).toEqual({ total: 2, valid: 2, invalid: 0 });
    expect(result.rows[0].seniority).toBe('head');
    expect(result.rows[1].seniority).toBe('cxo');
  });
});

describe('parseContactsFile — unsupported types', () => {
  it('throws on unsupported extension', () => {
    expect(() => parseContactsFile(Buffer.from('x'), 'whatever.txt')).toThrow(/unsupported/);
  });
});
