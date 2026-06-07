import { describe, it, expect } from 'vitest';

import {
  runQualityChecks,
  enforceStructure,
  senderSignName,
  appendComplianceFooter,
  extractFirstJsonObject,
  substituteVariables,
  bucketFromSeniority,
  templateNameForBucket,
  COMPLIANCE_FOOTER,
} from '../src/services/personalization-engine.js';

const baseContact = { first_name: 'Aparna', full_name: 'Aparna Krishnan' };
const baseCompany = { name: 'Eightfold AI' };

// A clean draft: 80–130 words, concrete subject under 60 chars, opens about the
// recipient/company, no banned words, no placeholders, first name present.
const cleanDraft = {
  subject: 'Agentic workflows at Eightfold AI',
  body:
    "Hi Aparna, Eightfold AI's confirm-before-execute step in the agentic ATS is the sharpest take on recruiter trust I have read this year. Letting a recruiter approve an action before the agent runs it solves the problem most tools ignore. I spent the last year building a hiring co-pilot with the same design, and shipped the demotion logic that pulls an agent back when override rates climb. I would value fifteen minutes to hear how the platform team thinks about that boundary, or a pointer to the right person. Either way, the recent direction is genuinely good. — Riley",
};

describe('runQualityChecks', () => {
  it('returns empty warnings for a clean draft', () => {
    expect(runQualityChecks(cleanDraft, baseContact, baseCompany, 'peer')).toEqual([]);
  });

  it('flags every banned word', () => {
    const draft = {
      subject: 'note',
      body: 'Aparna at Eightfold AI — passionate rockstar synergy ninja. Game-changer cutting-edge transformative.',
    };
    const warns = runQualityChecks(draft, baseContact, baseCompany, 'peer');
    expect(warns).toEqual(
      expect.arrayContaining([
        'banned_word:synergy',
        'banned_word:rockstar',
        'banned_word:ninja',
        'banned_word:passionate',
        'banned_word:game-changer',
        'banned_word:cutting-edge',
        'banned_word:transformative',
      ])
    );
  });

  it('flags exclamation marks', () => {
    const draft = { subject: 'note', body: 'Hey Aparna at Eightfold AI!' };
    expect(runQualityChecks(draft, baseContact, baseCompany, 'peer')).toContain('exclamation_mark');
  });

  it('flags emojis', () => {
    const draft = { subject: 'note', body: 'Hey Aparna at Eightfold AI 🚀 quick note.' };
    expect(runQualityChecks(draft, baseContact, baseCompany, 'peer')).toContain('emoji_detected');
  });

  it('flags overly long subject', () => {
    const draft = {
      subject: 'this subject line is intentionally written to exceed sixty characters total length',
      body: 'Aparna at Eightfold AI — short body.',
    };
    expect(runQualityChecks(draft, baseContact, baseCompany, 'peer')).toContain('subject_too_long');
  });

  it('flags a body over 130 words', () => {
    const body = ['Aparna at Eightfold AI.', ...Array(200).fill('word')].join(' ');
    const warns = runQualityChecks({ subject: 'note', body }, baseContact, baseCompany, 'peer');
    expect(warns.find((w) => w.startsWith('too_long:'))).toBeTruthy();
  });

  it('flags a body under 80 words', () => {
    const draft = { subject: 'note', body: 'Hi Aparna, a short note about Eightfold AI and your team.' };
    expect(runQualityChecks(draft, baseContact, baseCompany, 'peer')).toContain('too_short');
  });

  it('flags unsubstituted template variables', () => {
    const draft = { subject: 'note', body: 'Aparna at Eightfold AI — {one_specific_topic}.' };
    expect(runQualityChecks(draft, baseContact, baseCompany, 'peer')).toContain('unsubstituted_variable');
  });

  it('flags missing company reference', () => {
    const draft = { subject: 'note', body: 'Hey Aparna, just following up.' };
    expect(runQualityChecks(draft, baseContact, baseCompany, 'peer')).toContain('company_name_missing');
  });

  it('does not flag company when a keyword/product is referenced instead of the name', () => {
    const company = { name: 'Eightfold AI', key_products: 'talent intelligence, agentic ATS' };
    const draft = { subject: 'note', body: 'Hey Aparna, your talent intelligence work is sharp and worth a chat.' };
    expect(runQualityChecks(draft, baseContact, company, 'peer')).not.toContain('company_name_missing');
  });

  it('flags missing recipient first name', () => {
    const draft = { subject: 'note', body: 'Hey there at Eightfold AI, just following up.' };
    expect(runQualityChecks(draft, baseContact, baseCompany, 'peer')).toContain('first_name_missing');
  });

  it('flags a subject that starts with a dead phrase', () => {
    const draft = { subject: 'The agentic ATS question', body: 'Hi Aparna, your Eightfold AI work is great.' };
    const warns = runQualityChecks(draft, baseContact, baseCompany, 'peer');
    expect(warns).toContain('subject_bad_prefix');
    expect(warns).not.toContain('subject_too_long');
  });

  it('flags a first sentence that is about the sender', () => {
    const draft = {
      subject: 'note',
      body: 'Hi Aparna, I lead product at a startup and want to connect about Eightfold AI work.',
    };
    expect(runQualityChecks(draft, baseContact, baseCompany, 'peer')).toContain('first_sentence_about_sender');
  });

  it('flags an opening reused from another draft in the same campaign', () => {
    const recent = ["Hi Sam, your team's work on agentic workflows at Eightfold AI is impressive and worth a chat."];
    const draft = {
      subject: 'note',
      body: "Hi Aparna, your team's work on agentic workflows at Eightfold AI is the best thing I have seen.",
    };
    expect(runQualityChecks(draft, baseContact, baseCompany, 'peer', recent)).toContain('opening_repeated');
  });

  it('flags two openings that lean on the same concrete detail, even when reworded', () => {
    const recent = [
      "Hi Sam, the 400-meter Perseverance rover drive on Mars with Claude's assistance shows real promise for autonomous exploration.",
    ];
    const draft = {
      subject: 'note',
      body: "Hi Aparna, Claude's 400-meter drive of NASA's Perseverance rover on Mars demonstrates real promise for autonomous exploration.",
    };
    expect(runQualityChecks(draft, baseContact, baseCompany, 'peer', recent)).toContain('opening_repeated');
  });

  it('does not flag two openings about the same company that use different concrete details', () => {
    const recent = [
      "Hi Sam, the 400-meter Perseverance rover drive on Mars with Claude's assistance shows real promise.",
    ];
    const draft = {
      subject: 'note',
      body: "Hi Aparna, Claude's Constitution sets a clear bar for interpretability and honest model behaviour.",
    };
    expect(runQualityChecks(draft, baseContact, baseCompany, 'peer', recent)).not.toContain('opening_repeated');
  });

  it('flags AI word overuse (>3 times)', () => {
    const draft = {
      subject: 'note',
      body: 'Aparna at Eightfold AI. AI AI AI AI overload but valid otherwise.',
    };
    const warns = runQualityChecks(draft, baseContact, baseCompany, 'peer');
    expect(warns.find((w) => w.startsWith('ai_overuse:'))).toBeTruthy();
  });

  it('flags the banned phrase "your work"', () => {
    const draft = { subject: 'note', body: 'Hi Aparna, your work at Eightfold AI is great and worth a chat.' };
    expect(runQualityChecks(draft, baseContact, baseCompany, 'peer')).toContain('your_work_phrase');
  });

  it("flags the banned phrase \"your team's work\"", () => {
    const draft = { subject: 'note', body: "Hi Aparna, your team's work at Eightfold AI is great and worth a chat." };
    expect(runQualityChecks(draft, baseContact, baseCompany, 'peer')).toContain('your_work_phrase');
  });

  it('flags a generic admiration opening (impressed)', () => {
    const draft = {
      subject: 'note',
      body: "Hi Aparna, I have been impressed by Eightfold AI's agentic ATS and the recruiter trust angle.",
    };
    expect(runQualityChecks(draft, baseContact, baseCompany, 'peer')).toContain('generic_opening');
  });

  it('flags a generic admiration opening (came across your)', () => {
    const draft = {
      subject: 'note',
      body: 'Hi Aparna, I came across your agentic ATS launch at Eightfold AI and wanted to connect.',
    };
    expect(runQualityChecks(draft, baseContact, baseCompany, 'peer')).toContain('generic_opening');
  });

  it('does not flag a concrete opening that names a specific detail', () => {
    const warns = runQualityChecks(cleanDraft, baseContact, baseCompany, 'peer');
    expect(warns).not.toContain('your_work_phrase');
    expect(warns).not.toContain('generic_opening');
  });
});

describe('enforceStructure', () => {
  const names = { recipientFirst: 'Alex', senderFirst: 'Riley' };

  it('breaks a run-on blob into greeting / paragraphs / sign-off', () => {
    const blob =
      "Hi Alex, your team's work on agentic workflows is the sharpest take I have read. " +
      'I spent the last year building a confirm-before-execute hiring co-pilot that lines up with that. ' +
      'Would fifteen minutes next week be useful?';
    const out = enforceStructure(blob, names);
    const blocks = out.split('\n\n');
    expect(blocks[0]).toBe('Hi Alex,');
    expect(blocks[blocks.length - 1]).toBe('— Riley');
    // opening / bridge / ask + greeting + sign-off = 5 blocks
    expect(blocks.length).toBe(5);
    expect(out).toContain("your team's work on agentic workflows");
    expect(out).toContain('Would fifteen minutes next week be useful?');
  });

  it('adds a sign-off when the model omitted one', () => {
    const out = enforceStructure('Hi Alex, quick note about your work.', names);
    expect(out.endsWith('— Riley')).toBe(true);
    // exactly one sign-off
    expect(out.match(/— Riley/g)).toHaveLength(1);
  });

  it('does not duplicate an existing dash sign-off', () => {
    const out = enforceStructure('Hi Alex, quick note about your work.\n\n— Riley', names);
    expect(out.match(/— Riley/g)).toHaveLength(1);
  });

  it('normalizes a "Best, Riley" closer to the canonical sign-off', () => {
    const out = enforceStructure('Hi Alex, quick note.\n\nBest,\nRiley', names);
    expect(out.endsWith('— Riley')).toBe(true);
    expect(out).not.toMatch(/Best,/);
  });

  it('preserves paragraphs the model already separated with blank lines', () => {
    const structured = 'Hi Alex,\n\nYour work is great.\n\nI build similar tools.\n\nFifteen minutes?\n\n— Riley';
    expect(enforceStructure(structured, names)).toBe(structured);
  });

  it('never splits a hyphenated word like 15-minute or RAG-based', () => {
    const out = enforceStructure(
      'Hi Alex, I built RAG-based eval gates last year. A 15-minute chat would be great?',
      names
    );
    expect(out).toContain('RAG-based');
    expect(out).toContain('15-minute');
  });

  it('synthesizes a greeting when the model forgot one', () => {
    const out = enforceStructure('Your work on agentic ATS is sharp. Open to a chat?', names);
    expect(out.startsWith('Hi Alex,')).toBe(true);
  });

  it('signs off with the sender full name when senderFull is provided', () => {
    const out = enforceStructure('Hi Priya, quick note about the launch.\n\n— Morgan', {
      recipientFirst: 'Priya',
      senderFirst: 'Morgan',
      senderFull: 'Alex Morgan',
    });
    expect(out.endsWith('— Alex Morgan')).toBe(true);
    // the model's own "— Morgan" is stripped, not left behind or duplicated
    expect(out).not.toMatch(/—\s*Morgan$/);
    expect(out.match(/—/g)).toHaveLength(1);
  });

  it('falls back to senderFirst when no senderFull is given (backward compatible)', () => {
    const out = enforceStructure('Hi Alex, quick note.', names);
    expect(out.endsWith('— Riley')).toBe(true);
  });
});

describe('senderSignName', () => {
  it('combines a first-name-only `name` with a distinct `first_name` surname', () => {
    // The real profile case: name "Alex", first_name "Morgan" → "Alex Morgan".
    expect(senderSignName({ name: 'Alex', first_name: 'Morgan' })).toBe('Alex Morgan');
  });

  it('uses `name` as-is when it already reads as a full name', () => {
    expect(senderSignName({ name: 'Alex Morgan', first_name: 'Alex' })).toBe('Alex Morgan');
  });

  it('does not duplicate when `name` and `first_name` are the same token', () => {
    expect(senderSignName({ name: 'Riley', first_name: 'Riley' })).toBe('Riley');
  });

  it('falls back to whichever single field is present', () => {
    expect(senderSignName({ first_name: 'Morgan' })).toBe('Morgan');
    expect(senderSignName({ name: 'Alex' })).toBe('Alex');
    expect(senderSignName({})).toBe('');
  });
});

describe('substituteVariables', () => {
  it('fills known placeholders and is case-insensitive on the name', () => {
    const ctx = { first_name: 'Sam', company: 'Eightfold AI', user_first_name: 'Riley', name: 'Sam Patel' };
    expect(substituteVariables('Hi {first_name} at {company}, — {user_first_name}', ctx)).toBe(
      'Hi Sam at Eightfold AI, — Riley'
    );
    expect(substituteVariables('Hi {Name}', ctx)).toBe('Hi Sam Patel');
  });

  it('leaves unknown placeholders intact so the quality check can flag them', () => {
    expect(substituteVariables('Topic: {one_specific_topic}', { first_name: 'Sam' })).toBe(
      'Topic: {one_specific_topic}'
    );
  });
});

describe('appendComplianceFooter', () => {
  it('appends the canonical footer', () => {
    expect(appendComplianceFooter('Body line.')).toBe('Body line.' + COMPLIANCE_FOOTER);
  });
  it('trims trailing whitespace before appending', () => {
    const out = appendComplianceFooter('Body line.\n\n');
    expect(out.endsWith(COMPLIANCE_FOOTER)).toBe(true);
    expect(out.includes('Body line.\n\n\n')).toBe(false);
  });
});

describe('extractFirstJsonObject', () => {
  it('parses a clean JSON object', () => {
    expect(extractFirstJsonObject('{"a":1}')).toEqual({ a: 1 });
  });
  it('skips preamble before the JSON', () => {
    expect(extractFirstJsonObject('Here you go:\n{"subject":"hi","body":"x"}')).toEqual({
      subject: 'hi',
      body: 'x',
    });
  });
  it('handles braces inside strings without confusing depth', () => {
    expect(extractFirstJsonObject('{"body":"hello {name}"}')).toEqual({ body: 'hello {name}' });
  });
  it('handles escaped quotes inside strings', () => {
    expect(extractFirstJsonObject('{"body":"she said \\"hi\\""}')).toEqual({ body: 'she said "hi"' });
  });
  it('throws on unbalanced JSON', () => {
    expect(() => extractFirstJsonObject('{"a":1')).toThrow(/unbalanced/);
  });
  it('throws on no JSON', () => {
    expect(() => extractFirstJsonObject('plain text only')).toThrow(/no JSON object/);
  });
});

describe('bucket + template selection', () => {
  it('maps cxo → executive', () => {
    expect(bucketFromSeniority('cxo')).toBe('executive');
  });
  it('maps vp / head → senior', () => {
    expect(bucketFromSeniority('vp')).toBe('senior');
    expect(bucketFromSeniority('head')).toBe('senior');
  });
  it('maps pm / sr_pm / staff_pm / apm / other → peer', () => {
    for (const s of ['pm', 'sr_pm', 'staff_pm', 'apm', 'other', null, undefined]) {
      expect(bucketFromSeniority(s)).toBe('peer');
    }
  });
  it('picks follow-up template on sequence_step >= 1', () => {
    expect(templateNameForBucket('peer', 1)).toBe('follow-up');
    expect(templateNameForBucket('executive', 2)).toBe('follow-up');
  });
  it('picks bucket template at sequence_step 0', () => {
    expect(templateNameForBucket('peer', 0)).toBe('peer-email');
    expect(templateNameForBucket('senior', 0)).toBe('senior-email');
    expect(templateNameForBucket('executive', 0)).toBe('executive-email');
  });
});
