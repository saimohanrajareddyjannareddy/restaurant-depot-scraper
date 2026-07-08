/**
 * One-off, READ-ONLY audit: how many invoice_files / invoice_headers / invoice_lines
 * rows already exist per restaurant. Run this before the first real (non-dry-run)
 * scrape to check whether a restaurant already has prior data (e.g. from the old
 * Apify actor) — re-scraping a restaurant that already has headers/lines would
 * double-count. Uses supabaseCount (PostgREST Prefer: count=exact, Range: 0-0) —
 * true row counts without pulling any rows, so large tables (e.g. invoice_lines)
 * aren't truncated by PostgREST's default ~1000-row page cap. GET/HEAD only —
 * no inserts, updates, or deletes are possible from this script.
 *
 * Usage: npx tsx scripts/check-supabase-state.ts
 */
import { pgFilter, supabaseCount } from '../src/supabase.js';

const RESTAURANTS: Record<string, string> = {
  '525b4f99-3693-43ff-8449-f8891ea5081b': 'Turmeric STL',
  '5ee302f5-d3b6-44ec-be64-b9ece24d9e1e': 'BASIL INDIA',
};

const RESTAURANT_IDS = Object.keys(RESTAURANTS);
const TABLES = ['invoice_files', 'invoice_headers', 'invoice_lines'] as const;

async function countsForRestaurant(restaurantId: string): Promise<Record<(typeof TABLES)[number], number>> {
  const filter = `?restaurant_id=${pgFilter('eq', restaurantId)}&select=id`;
  const [invoice_files, invoice_headers, invoice_lines] = await Promise.all([
    supabaseCount('invoice_files', filter),
    supabaseCount('invoice_headers', filter),
    supabaseCount('invoice_lines', filter),
  ]);
  return { invoice_files, invoice_headers, invoice_lines };
}

async function main() {
  console.log('Read-only Supabase state check (GET/HEAD only — no writes)\n');

  const results: Record<string, Record<(typeof TABLES)[number], number>> = {};
  for (const id of RESTAURANT_IDS) {
    results[id] = await countsForRestaurant(id);
  }

  console.log('True row counts per restaurant per table (Prefer: count=exact):\n');
  const colWidths = { name: 14, table: 16 };
  console.log('restaurant'.padEnd(colWidths.name) + TABLES.map((t) => t.padEnd(colWidths.table)).join(''));
  console.log('-'.repeat(colWidths.name + colWidths.table * TABLES.length));
  for (const id of RESTAURANT_IDS) {
    const name = RESTAURANTS[id]!;
    const row =
      name.padEnd(colWidths.name) + TABLES.map((t) => String(results[id]![t]).padEnd(colWidths.table)).join('');
    console.log(row);
  }
  console.log();
}

main().catch((err) => {
  console.error('Failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
