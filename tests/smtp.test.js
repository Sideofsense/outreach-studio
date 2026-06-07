import { describe, it, expect } from 'vitest';

import { classifyError } from '../src/services/email/smtp.js';

// Build a nodemailer-shaped SMTP error.
function smtpErr(responseCode, response) {
  const e = new Error(`Data command failed: ${response}`);
  e.responseCode = responseCode;
  e.response = response;
  return e;
}

describe('classifyError', () => {
  it('treats Gmail daily sending limit (550-5.4.5) as rate_limit, NOT a bounce', () => {
    // The real error the user hit. Must NOT be a bounce — otherwise the send
    // route would suppress a perfectly valid recipient.
    const err = smtpErr(
      550,
      '550-5.4.5 Daily user sending limit exceeded. For more information on ' +
        'Gmail sending limits go to https://support.google.com/a/answer/166852 - gsmtp'
    );
    expect(classifyError(err)).toBe('rate_limit');
  });

  it('treats a temporary 4.7.0 rate-limit deferral as rate_limit', () => {
    const err = smtpErr(421, '421-4.7.0 Try again later, closing connection (rate limited). - gsmtp');
    expect(classifyError(err)).toBe('rate_limit');
  });

  it('still treats a genuine unknown-mailbox 550 5.1.1 as a bounce', () => {
    const err = smtpErr(550, '550-5.1.1 The email account that you tried to reach does not exist. - gsmtp');
    expect(classifyError(err)).toBe('bounce');
  });

  it('treats auth failures (535 / EAUTH) as auth_error, never a bounce', () => {
    expect(classifyError(smtpErr(535, '535-5.7.8 Username and Password not accepted'))).toBe('auth_error');
    const e = new Error('Invalid login'); e.code = 'EAUTH';
    expect(classifyError(e)).toBe('auth_error');
  });

  it('treats a plain transient 4xx (no rate-limit wording) as transient', () => {
    const err = smtpErr(451, '451 4.3.0 Temporary system problem. Try again later.');
    expect(classifyError(err)).toBe('transient');
  });
});
