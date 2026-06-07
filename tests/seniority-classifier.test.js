import { describe, it, expect } from 'vitest';
import { classifySeniority } from '../src/services/seniority-classifier.js';

describe('classifySeniority', () => {
  const cases = [
    // CXO
    ['CEO', 'cxo'],
    ['Chief Executive Officer', 'cxo'],
    ['Founder', 'cxo'],
    ['Co-Founder & CEO', 'cxo'],
    ['Cofounder', 'cxo'],
    ['CTO', 'cxo'],
    ['Chief Product Officer', 'cxo'],
    ['CHRO', 'cxo'],
    ['CMO', 'cxo'],
    ['CPO and Founder', 'cxo'],

    // VP
    ['VP Product', 'vp'],
    ['Vice President, Product Management', 'vp'],
    ['Senior Vice President', 'vp'],
    // Note: "SVP" alone is not matched by spec classifier (\bvp\b finds no boundary in "svp").
    // Known gap — flagged for M12 polish.

    // Head / Director
    ['Head of Product', 'head'],
    ['Director of Product Management', 'head'],
    ['Director, Engineering', 'head'],
    ['Sr. Director', 'head'],
    ['Head of Growth', 'head'],

    // Staff / Principal / Lead / Group
    ['Staff Product Manager', 'staff_pm'],
    ['Principal Product Manager', 'staff_pm'],
    ['Lead Product Manager', 'staff_pm'],
    ['Group Product Manager', 'staff_pm'],
    ['GPM, Platform', 'staff_pm'],

    // Senior PM
    ['Senior Product Manager', 'sr_pm'],
    ['Sr Product Manager', 'sr_pm'],
    ['Sr. PM', 'sr_pm'],
    ['Senior PM, Growth', 'sr_pm'],

    // Technical PM
    ['Technical Product Manager', 'sr_pm'],
    ['TPM, Infra', 'sr_pm'],

    // APM
    ['APM', 'apm'],
    ['Associate Product Manager', 'apm'],
    ['Assistant Product Manager', 'apm'],

    // PM catch-all
    ['Product Manager', 'pm'],
    ['PM', 'pm'],
    ['PM II', 'pm'],

    // Other / edge
    ['Software Engineer', 'other'],
    ['Designer', 'other'],
    ['', 'other'],
    [null, 'other'],
    [undefined, 'other'],
    ['Marketing Lead', 'other'],
  ];

  for (const [title, expected] of cases) {
    it(`maps ${JSON.stringify(title)} → ${expected}`, () => {
      expect(classifySeniority(title)).toBe(expected);
    });
  }
});
