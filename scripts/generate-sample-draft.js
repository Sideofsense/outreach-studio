#!/usr/bin/env node
'use strict';

/**
 * Standalone M5 verification: generate ONE draft via the personalization engine
 * and print it to stdout. Requires a real ANTHROPIC_API_KEY in .env.
 *
 *   npm run sample-draft
 */

const fs = require('node:fs');
const path = require('node:path');

const config = require('../src/config');
const { generateDraft } = require('../src/services/personalization-engine');

async function main() {
  if (!config.anthropic.apiKey || config.anthropic.apiKey.startsWith('sk-ant-...')) {
    console.error('\nThis test needs a real ANTHROPIC_API_KEY in .env.\n');
    process.exit(1);
  }

  // Use the configured user profile if present, otherwise the example template.
  let user_profile;
  const profilePath = path.resolve(config.paths.userProfile);
  if (fs.existsSync(profilePath)) {
    user_profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  } else {
    const examplePath = path.resolve('data/user-profile.example.json');
    user_profile = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
    console.error(`(no ${profilePath} found — using example profile)`);
  }

  const contact = {
    full_name: 'Aparna Krishnan',
    first_name: 'Aparna',
    last_name: 'Krishnan',
    title: 'Senior Product Manager, AI Platform',
    seniority: 'sr_pm',
    linkedin_url: 'linkedin.com/in/aparna-example',
    email: 'aparna@example.com',
  };

  const company = {
    name: 'Eightfold AI',
    custom_context:
      'AI talent intelligence platform. Recently launched agentic workflows on top of their skills graph. Customers include Bayer, Vodafone, Walmart.',
  };

  console.error('Calling Claude…');
  const draft = await generateDraft({ user_profile, contact, company });

  console.log('=========================================================');
  console.log(`Model:    ${draft.model}`);
  console.log(`Tokens:   in=${draft.tokens.input}, out=${draft.tokens.output}`);
  console.log(`Bucket:   ${draft.template.seniority_bucket} (step ${draft.template.sequence_step})`);
  console.log(`Warnings: ${draft.quality_warnings.length === 0 ? '(none)' : draft.quality_warnings.join(', ')}`);
  console.log('---------------------------------------------------------');
  console.log(`Subject:  ${draft.subject}`);
  console.log('---------------------------------------------------------');
  console.log(draft.body);
  console.log('=========================================================');
}

main().catch((err) => {
  console.error('\nDraft generation failed:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
