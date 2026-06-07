import { describe, it, expect } from 'vitest';
import { detectStopRequest, STOP_WORD_RE, normalize } from '../src/services/suppressions.js';

describe('detectStopRequest', () => {
  it('matches STOP as a standalone word in the subject', () => {
    expect(detectStopRequest({ subject: 'STOP', body: 'hi' })).toBe(true);
    expect(detectStopRequest({ subject: 'Please STOP emailing me', body: '' })).toBe(true);
  });

  it('matches UNSUBSCRIBE in the body', () => {
    expect(detectStopRequest({ subject: 'Re: outreach', body: 'unsubscribe please' })).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(detectStopRequest({ subject: '', body: 'StOp' })).toBe(true);
    expect(detectStopRequest({ subject: '', body: 'unSubScribe' })).toBe(true);
  });

  it('does NOT match substrings of other words', () => {
    expect(detectStopRequest({ subject: '', body: 'stopgap proposal' })).toBe(false);
    expect(detectStopRequest({ subject: '', body: 'unsubscribed long ago' })).toBe(false);
    expect(detectStopRequest({ subject: 'unstoppable', body: '' })).toBe(false);
  });

  it('handles missing fields gracefully', () => {
    expect(detectStopRequest({})).toBe(false);
    expect(detectStopRequest()).toBe(false);
  });
});

describe('STOP_WORD_RE', () => {
  it('uses word boundaries', () => {
    expect(STOP_WORD_RE.test('STOP')).toBe(true);
    expect(STOP_WORD_RE.test('stopwatch')).toBe(false);
  });
});

describe('normalize', () => {
  it('trims and lowercases', () => {
    expect(normalize('  Foo@BAR.com ')).toBe('foo@bar.com');
  });
  it('handles null/undefined', () => {
    expect(normalize(null)).toBe('');
    expect(normalize(undefined)).toBe('');
  });
});
