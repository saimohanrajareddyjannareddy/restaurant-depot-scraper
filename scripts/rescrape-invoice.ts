/**
 * Delete a specific invoice from Supabase + Google Drive, then re-scrape.
 *
 * Usage:
 *   npx tsx scripts/rescrape-invoice.ts <invoice_number>              # dry-run
 *   npx tsx scripts/rescrape-invoice.ts <invoice_number> --apply      # actually delete
 *
 * Note: does NOT auto-run the scraper. Deletes the target invoice, then you run
 * `npm start` and the scraper will re-download it (since it's no longer in Drive
 * and no longer in invoice_files).
 */
import { createClient } from '@supabase/supabase-js';
import { createDriveClient } from '../src/drive.js';
import { config } from '../src/config.js';

const APPLY = process.argv.includes('--apply');
const invoiceNumberArg = process.argv.filter((a) => !a.startsWith('--'))[2];

if (!invoiceNumberArg) {
  console.error('Usage: tsx scripts/rescrape-invoice.ts <invoice_number> [--apply]');
  process.exit(1);
}

const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey);
const drive = createDriveClient();

async function main() {
  console.log('\n' + '='.repeat(78));
  console.log(`Delete + prepare for re-scrape — ${APPLY ? '🔥 APPLY MODE' : '👀 DRY-RUN'}`);
  console.log(`Target invoice: #${invoiceNumberArg}`);
  console.log('='.repeat(78) + '\n');

  // Fetch the header
  const { data: header, error: hdrErr } = await supabase
    .from('invoice_headers')
    .select('id, invoice_number, invoice_date, total, file_id, restaurant_id')
    .eq('invoice_number', invoiceNumberArg)
    .single();

  if (hdrErr || !header) {
    console.error(`❌ Invoice #${invoiceNumberArg} not found in invoice_headers`);
    process.exit(1);
  }

  console.log(`Header found:`);
  console.log(`  header_id: ${header.id}`);
  console.log(`  invoice_date: ${header.invoice_date}`);
  console.log(`  total: $${header.total}`);
  console.log(`  file_id: ${header.file_id}`);
  console.log(`  restaurant_id: ${header.restaurant_id}\n`);

  // Fetch the file
  const { data: file, error: fileErr } = await supabase
    .from('invoice_files')
    .select('id, drive_file_id, filename')
    .eq('id', header.file_id)
    .single();

  if (fileErr || !file) {
    console.error(`❌ File ${header.file_id} not found in invoice_files`);
    process.exit(1);
  }

  console.log(`File found:`);
  console.log(`  filename: ${file.filename}`);
  console.log(`  drive_file_id: ${file.drive_file_id}\n`);

  // Count invoice_lines that would be deleted
  const { count: linesCount } = await supabase
    .from('invoice_lines')
    .select('*', { count: 'exact', head: true })
    .eq('header_id', header.id);

  console.log(`Actions that would be taken:`);
  console.log(`  1. Delete ${linesCount ?? 0} rows from invoice_lines (header_id=${header.id})`);
  console.log(`  2. Delete 1 row from invoice_headers (id=${header.id})`);
  console.log(`  3. Delete 1 row from invoice_files (id=${file.id})`);
  console.log(`  4. Delete Drive file ${file.drive_file_id}`);
  console.log('');

  if (!APPLY) {
    console.log('👀 DRY-RUN — no changes made.\n');
    console.log('To actually delete, re-run with --apply flag.');
    console.log(`Then manually run \`npm start\` to have the scraper re-fetch this invoice.\n`);
    return;
  }

  console.log('🔥 APPLYING...\n');

  // Delete invoice_lines
  const { error: linesErr } = await supabase
    .from('invoice_lines')
    .delete()
    .eq('header_id', header.id);
  if (linesErr) throw new Error(`invoice_lines delete failed: ${linesErr.message}`);
  console.log(`  ✓ Deleted invoice_lines`);

  // Delete invoice_headers
  const { error: hdrDelErr } = await supabase
    .from('invoice_headers')
    .delete()
    .eq('id', header.id);
  if (hdrDelErr) throw new Error(`invoice_headers delete failed: ${hdrDelErr.message}`);
  console.log(`  ✓ Deleted invoice_headers row`);

  // Delete Drive file
  try {
    await drive.files.delete({ fileId: file.drive_file_id });
    console.log(`  ✓ Deleted Drive file ${file.drive_file_id}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ⚠️ Drive delete failed (continuing): ${msg}`);
    // Don't fail — file might already be gone
  }

  // Delete invoice_files (last, in case of FK)
  const { error: fileDelErr } = await supabase
    .from('invoice_files')
    .delete()
    .eq('id', file.id);
  if (fileDelErr) throw new Error(`invoice_files delete failed: ${fileDelErr.message}`);
  console.log(`  ✓ Deleted invoice_files row`);

  console.log('\n✅ Done. Invoice #' + invoiceNumberArg + ' is gone from Supabase + Drive.\n');
  console.log(`Next step: run \`npm start\` and the scraper will pick this up as a "new" invoice`);
  console.log(`and re-download it fresh from Restaurant Depot.\n`);
}

main().catch((err) => {
  console.error('\n💥 Fatal error:', err);
  process.exit(1);
});
