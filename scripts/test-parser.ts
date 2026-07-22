import { parseInvoiceExcel } from '../src/excel.js';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: tsx scripts/test-parser.ts <path-to-xlsx>');
  process.exit(1);
}

for (const filePath of args) {
  console.log('\n' + '='.repeat(70));
  console.log('FILE:', filePath);
  console.log('='.repeat(70));

  const result = parseInvoiceExcel(filePath);
  if (!result) {
    console.error('❌ Parse returned null');
    continue;
  }

  console.log(`Invoice number: ${result.invoice_number}`);
  console.log(`Line items: ${result.items.length}`);
  console.log('');

  // Table header
  console.log(
    'Item'.padEnd(32) +
    'UnitQ'.padStart(6) +
    'CaseQ'.padStart(6) +
    'UnitPr'.padStart(10) +
    'Total'.padStart(10)
  );
  console.log('-'.repeat(64));

  let sumTotal = 0;
  for (const item of result.items) {
    console.log(
      item.item_name.slice(0, 30).padEnd(32) +
      String(item.unit_qty).padStart(6) +
      String(item.case_qty).padStart(6) +
      ('$' + item.unit_price.toFixed(2)).padStart(10) +
      ('$' + item.total.toFixed(2)).padStart(10)
    );
    sumTotal += item.total;
  }
  console.log('-'.repeat(64));
  console.log('Sum of line totals:'.padEnd(54) + ('$' + sumTotal.toFixed(2)).padStart(10));
  console.log('(should match Sub-Total on receipt, before tax)');
}
