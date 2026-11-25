#!/usr/bin/env node
// Validates plans/*.json. Run by CI on every pull request.
// Usage: node tools/check.mjs [--strict]   (--strict fails on warnings too)
import { loadAll } from '../src/plans.mjs';
const { plans, errors, warnings } = loadAll();
warnings.forEach(w => console.warn('warn  ' + w));
errors.forEach(e => console.error('error ' + e));
if (errors.length || (process.argv.includes('--strict') && warnings.length)) {
  console.error(`\n${errors.length} error(s), ${warnings.length} warning(s).`);
  process.exit(1);
}
console.log(`ok    ${plans.length} plans valid${warnings.length ? `, ${warnings.length} warning(s)` : ''}`);
