// Plain script test for shouldKeepInvoice — no test framework wired into this
// repo, so this is just `npx tsx src/cardFilter.test.ts`. Exits non-zero if any
// case fails.
//
// All card numbers below are FAKE.
import { shouldKeepInvoice } from './cardFilter.js';

type Case = {
  name: string;
  invoiceCard: string | null;
  knownCards: string[] | null;
  expected: boolean;
};

const KNOWN = ['2063', '1111'];

const cases: Case[] = [
  { name: "known card in list",        invoiceCard: '2063', knownCards: KNOWN, expected: true },
  { name: "foreign card not in list",  invoiceCard: '9999', knownCards: KNOWN, expected: false },
  { name: "null card (cash)",          invoiceCard: null,   knownCards: KNOWN, expected: true },
  { name: "empty card (unreadable)",   invoiceCard: '',     knownCards: KNOWN, expected: true },
  { name: "null known cards",          invoiceCard: '2063', knownCards: null,  expected: true },
  { name: "empty known cards",         invoiceCard: '2063', knownCards: [],    expected: true },
];

let failed = 0;

for (const c of cases) {
  const actual = shouldKeepInvoice(c.invoiceCard, c.knownCards);
  const ok = actual === c.expected;
  if (!ok) failed++;
  const args = `(${JSON.stringify(c.invoiceCard)}, ${JSON.stringify(c.knownCards)})`;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(26)} ${args} -> ${actual}` +
      (ok ? '' : ` (expected ${c.expected})`),
  );
}

console.log(`\n${cases.length - failed}/${cases.length} passed`);

if (failed > 0) {
  console.log('FAIL');
  process.exit(1);
}
console.log('PASS');
