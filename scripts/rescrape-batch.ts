/**
 * Delete a BATCH of corrupted invoices from Supabase + Google Drive.
 *
 * Usage:
 *   npx tsx scripts/rescrape-batch.ts               # dry-run
 *   npx tsx scripts/rescrape-batch.ts --apply       # actually delete all
 *
 * After --apply completes, run `npm start` to have the scraper re-fetch them.
 */
import { createClient } from '@supabase/supabase-js';
import { createDriveClient } from '../src/drive.js';
import { config } from '../src/config.js';

const APPLY = process.argv.includes('--apply');

// The 3 remaining corrupted invoices to rescrape (the other 12 are already fixed)
const INVOICE_NUMBERS = [
  '22099', '18477', '4969',
];

const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey);
const drive = createDriveClient();

async function deleteOne(invoiceNumber: string): Promise<boolean> {
  const { data: header } = await supabase
    .from('invoice_headers')
    .select('id, invoice_date, total, file_id, restaurant_id')
    .eq('invoice_number', invoiceNumber)
    .single();

  if (!header) {
    console.log(`  ⊘ #${invoiceNumber}: not found in Supabase (already deleted?)`);
    return false;
  }

  const { data: file } = await supabase
    .from('invoice_files')
    .select('id, drive_file_id, filename')
    .eq('id', header.file_id)
    .single();

  const { count: linesCount } = await supabase
    .from('invoice_lines')
    .select('*', { count: 'exact', head: true })
    .eq('header_id', header.id);

  console.log(`  #${invoiceNumber} (${header.invoice_date}, $${header.total}): ` +
    `${linesCount ?? 0} lines, file ${file?.filename ?? 'unknown'}`);

  if (!APPLY) return true;

  // Delete order matters: lines → headers → drive → files (FK safety)
  await supabase.from('invoice_lines').delete().eq('header_id', header.id);
  await supabase.from('invoice_headers').delete().eq('id', header.id);
  if (file?.drive_file_id) {
    try {
      await drive.files.delete({ fileId: file.drive_file_id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`     ⚠️ Drive delete failed: ${msg}`);
    }
  }
  if (file?.id) {
    await supabase.from('invoice_files').delete().eq('id', file.id);
  }
  console.log(`     ✓ Deleted`);
  return true;
}

async function main() {
  console.log('\n' + '='.repeat(78));
  console.log(`Batch delete for re-scrape — ${APPLY ? '🔥 APPLY MODE' : '👀 DRY-RUN'}`);
  console.log(`Target: ${INVOICE_NUMBERS.length} invoices`);
  console.log('='.repeat(78) + '\n');

  const stats = { deleted: 0, missing: 0 };

  for (const invNum of INVOICE_NUMBERS) {
    const found = await deleteOne(invNum);
    if (found) stats.deleted++;
    else stats.missing++;
  }

  console.log('\n' + '-'.repeat(78));
  console.log(`Found: ${stats.deleted}   Missing: ${stats.missing}`);
  if (APPLY) {
    console.log('\n✅ Deletions complete.');
    console.log('Next step: run `npm start` to have the scraper re-fetch all 12 invoices.\n');
  } else {
    console.log('\n👀 DRY-RUN — no changes made.');
    console.log('Re-run with --apply to actually delete.\n');
  }
}

main().catch((err) => {
  console.error('\n💥 Fatal error:', err);
  process.exit(1);
});
