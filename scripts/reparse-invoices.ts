/**
 * Re-parse invoices captured by the new Node.js scraper (uploaded >= 2026-07-08).
 *
 * DRY-RUN by default. Prints a report showing OLD line count/sum vs NEW.
 * Pass --apply to actually update Supabase.
 *
 * Usage:
 *   npx tsx scripts/reparse-invoices.ts           # dry-run
 *   npx tsx scripts/reparse-invoices.ts --apply   # execute
 */
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { parseInvoiceExcel } from '../src/excel.js';
import { createDriveClient } from '../src/drive.js';
import { config } from '../src/config.js';

const APPLY = process.argv.includes('--apply');
const CUTOFF_DATE = '2026-07-08';

// Corrupted files in Drive (only partial data survived download upload race).
// Fresh copies were downloaded manually — handle these in a separate pass.
const SKIP_INVOICES = new Set(['28954', '20191']);

const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey);

// Reuse the one central OAuth Drive client from src/drive.ts.
const drive = createDriveClient();

interface FileRow {
  id: string;
  filename: string;
  drive_file_id: string;
  restaurant_id: string;
  header_id: string | null;
  invoice_number: string | null;
}

async function fetchFiles(): Promise<FileRow[]> {
  const { data, error } = await supabase
    .from('invoice_files')
    .select(`
      id,
      filename,
      drive_file_id,
      restaurant_id,
      invoice_headers ( id, invoice_number )
    `)
    .gte('uploaded_at', CUTOFF_DATE)
    .like('filename', 'RestaurantDepot_%')
    .order('uploaded_at', { ascending: false });

  if (error) throw error;

  return (data ?? []).map((f: any) => ({
    id: f.id,
    filename: f.filename,
    drive_file_id: f.drive_file_id,
    restaurant_id: f.restaurant_id,
    header_id: f.invoice_headers?.[0]?.id ?? f.invoice_headers?.id ?? null,
    invoice_number: f.invoice_headers?.[0]?.invoice_number ?? f.invoice_headers?.invoice_number ?? null,
  }));
}

async function downloadFromDrive(fileId: string, localPath: string): Promise<void> {
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  );
  await new Promise<void>((resolve, reject) => {
    const dest = fs.createWriteStream(localPath);
    dest.on('finish', () => resolve());
    dest.on('error', reject);
    res.data.on('error', reject);
    res.data.pipe(dest);
  });
}

async function getOldLineStats(headerId: string): Promise<{ count: number; sum: number }> {
  const { data, error } = await supabase
    .from('invoice_lines')
    .select('total')
    .eq('header_id', headerId);
  if (error) throw error;
  const rows = data ?? [];
  const sum = rows.reduce((acc, r) => acc + Number(r.total ?? 0), 0);
  return { count: rows.length, sum };
}

async function replaceLines(
  headerId: string,
  restaurantId: string,
  items: ReturnType<typeof parseInvoiceExcel> extends infer T ? (T extends { items: infer I } ? I : never) : never
): Promise<void> {
  // Delete existing wrong lines for this header
  const { error: delErr } = await supabase
    .from('invoice_lines')
    .delete()
    .eq('header_id', headerId);
  if (delErr) throw new Error(`Delete failed: ${delErr.message}`);

  // Look up invoice_date from header (invoice_lines requires it)
  const { data: hdr, error: hdrErr } = await supabase
    .from('invoice_headers')
    .select('invoice_date')
    .eq('id', headerId)
    .single();
  if (hdrErr) throw new Error(`Header fetch failed: ${hdrErr.message}`);

  // Bulk insert fresh lines
  const rows = items.map((it) => ({
    header_id: headerId,
    restaurant_id: restaurantId,
    invoice_date: hdr!.invoice_date,
    item_name: it.item_name,
    category: it.category,
    unit_qty: it.unit_qty,
    case_qty: it.case_qty,
    unit_price: it.unit_price,
    total: it.total,
  }));

  const { error: insErr } = await supabase.from('invoice_lines').insert(rows);
  if (insErr) throw new Error(`Insert failed: ${insErr.message}`);
}

async function main() {
  console.log('\n' + '='.repeat(78));
  console.log(`Reparse tool — ${APPLY ? '🔥 APPLY MODE (will modify DB)' : '👀 DRY-RUN (no writes)'}`);
  console.log('='.repeat(78) + '\n');

  const files = await fetchFiles();
  console.log(`Found ${files.length} invoices to reparse (uploaded_at >= ${CUTOFF_DATE})\n`);

  const tmpDir = path.join(config.paths.tmpDir, 'reparse');
  fs.mkdirSync(tmpDir, { recursive: true });

  const stats = { ok: 0, skipped: 0, errors: 0, oldSum: 0, newSum: 0 };

  // Header row
  console.log(
    'Invoice#'.padEnd(10) +
    'File'.padEnd(46) +
    'OldLines'.padStart(9) +
    'NewLines'.padStart(9) +
    'OldSum'.padStart(12) +
    'NewSum'.padStart(12)
  );
  console.log('-'.repeat(98));

  for (const f of files) {
    if (f.invoice_number && SKIP_INVOICES.has(f.invoice_number)) {
      console.log(`${(f.invoice_number ?? '?').padEnd(10)}${f.filename.slice(0, 44).padEnd(46)} [SKIP: corrupted Drive file — handle separately]`);
      stats.skipped++;
      continue;
    }
    if (!f.header_id) {
      console.log(`${(f.invoice_number ?? '?').padEnd(10)}${f.filename.slice(0, 44).padEnd(46)} [SKIP: no header]`);
      stats.skipped++;
      continue;
    }

    const localPath = path.join(tmpDir, f.filename);
    try {
      await downloadFromDrive(f.drive_file_id, localPath);
      const parsed = parseInvoiceExcel(localPath);
      if (!parsed || parsed.items.length === 0) {
        console.log(`${(f.invoice_number ?? '?').padEnd(10)}${f.filename.slice(0, 44).padEnd(46)} [SKIP: no items parsed]`);
        stats.skipped++;
        continue;
      }

      const oldStats = await getOldLineStats(f.header_id);
      const newSum = parsed.items.reduce((a, it) => a + it.total, 0);

      console.log(
        (f.invoice_number ?? '?').padEnd(10) +
        f.filename.slice(0, 44).padEnd(46) +
        String(oldStats.count).padStart(9) +
        String(parsed.items.length).padStart(9) +
        ('$' + oldStats.sum.toFixed(2)).padStart(12) +
        ('$' + newSum.toFixed(2)).padStart(12)
      );

      stats.oldSum += oldStats.sum;
      stats.newSum += newSum;

      if (APPLY) {
        await replaceLines(f.header_id, f.restaurant_id, parsed.items);
      }
      stats.ok++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`${(f.invoice_number ?? '?').padEnd(10)}${f.filename.slice(0, 44).padEnd(46)} [ERROR: ${msg.slice(0, 40)}]`);
      stats.errors++;
    } finally {
      try { fs.unlinkSync(localPath); } catch { /* ignore */ }
    }
  }

  console.log('-'.repeat(98));
  console.log(
    'TOTAL'.padEnd(56) +
    ''.padStart(9) +
    ''.padStart(9) +
    ('$' + stats.oldSum.toFixed(2)).padStart(12) +
    ('$' + stats.newSum.toFixed(2)).padStart(12)
  );
  console.log(`\n✓ Processed: ${stats.ok}   ⊘ Skipped: ${stats.skipped}   ✗ Errors: ${stats.errors}`);
  console.log(APPLY ? '\n🔥 DB was modified.' : '\n👀 Dry-run only. Re-run with --apply to actually update.\n');
}

main().catch((err) => {
  console.error('\n💥 Fatal error:', err);
  process.exit(1);
});

