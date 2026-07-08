/**
 * One-off verification: does the total-extraction regex + totalToFilenameSegment
 * produce the exact filename shape the reference actor / existing Drive files
 * use, including the leading-minus case for returns/credits that caused the
 * duplicate-upload bug (src/client.ts's totalMatch regex previously couldn't
 * capture a leading '-', so returns got uploaded under a wrongly-signed
 * filename that didn't match what was already in Drive).
 *
 * NOTE: the /-?\$[\d,]+\.\d{2}/ regex below is a literal copy of the one in
 * src/client.ts's row-parsing loop — keep the two in sync if either changes.
 *
 * Non-production, one-off. Usage: npx tsx scripts/verify-filename.ts
 */
import { totalToFilenameSegment } from '../src/excel.js';

const TOTAL_REGEX = /-?\$[\d,]+\.\d{2}/;

interface Case {
  label: string;
  cellText: string;
  date: string;
  expectedFilename: string;
}

const CASES: Case[] = [
  {
    label: 'positive, no comma',
    cellText: 'Total Due: $64.89',
    date: '2026-06-15',
    expectedFilename: 'RestaurantDepot_2026-06-15_$64-89.xlsx',
  },
  {
    label: 'negative (return/credit), no comma',
    cellText: 'Total Due: -$64.89',
    date: '2026-06-15',
    expectedFilename: 'RestaurantDepot_2026-06-15_$-64-89.xlsx',
  },
  {
    label: 'positive, with comma (thousands)',
    cellText: 'Amount $1,507.64 due',
    date: '2026-07-06',
    expectedFilename: 'RestaurantDepot_2026-07-06_$1507-64.xlsx',
  },
  {
    label: 'negative, with comma (thousands)',
    cellText: 'Return credit -$1,507.64 applied',
    date: '2026-07-06',
    expectedFilename: 'RestaurantDepot_2026-07-06_$-1507-64.xlsx',
  },
  {
    label: 'no dollar amount present (fallback default)',
    cellText: 'No dollar amount in this cell',
    date: '2026-01-01',
    expectedFilename: 'RestaurantDepot_2026-01-01_$0-00.xlsx',
  },
];

function buildFilename(cellText: string, date: string): string {
  const match = cellText.match(TOTAL_REGEX);
  const segment = match ? totalToFilenameSegment(match[0]) : '0-00';
  return `RestaurantDepot_${date}_$${segment}.xlsx`;
}

function main() {
  console.log('Filename generation verification (non-production)\n');

  let failures = 0;
  for (const c of CASES) {
    const actual = buildFilename(c.cellText, c.date);
    const pass = actual === c.expectedFilename;
    if (!pass) failures++;
    console.log(`[${pass ? 'PASS' : 'FAIL'}] ${c.label}`);
    console.log(`  input:    ${JSON.stringify(c.cellText)}`);
    console.log(`  expected: ${c.expectedFilename}`);
    console.log(`  actual:   ${actual}`);
    console.log();
  }

  console.log(`${CASES.length - failures}/${CASES.length} cases passed.`);
  if (failures > 0) {
    console.error(`${failures} case(s) FAILED.`);
    process.exit(1);
  }
}

main();
