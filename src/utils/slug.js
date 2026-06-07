'use strict';

function slugify(input) {
  if (!input) return '';
  return String(input)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function uniqueSlug(base, existsFn) {
  const root = slugify(base) || 'company';
  if (!existsFn(root)) return root;
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${root}-${i}`;
    if (!existsFn(candidate)) return candidate;
  }
  throw new Error(`could not generate unique slug for "${base}"`);
}

module.exports = { slugify, uniqueSlug };
