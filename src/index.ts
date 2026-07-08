import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { openAuthenticatedContext } from './auth.js';
import { processClient, type ClientSummary } from './client.js';
import { config } from './config.js';
import { createDriveClient, verifyDriveAccess } from './drive.js';
import { logger } from './logger.js';
import { fetchActiveRestaurants, type Restaurant } from './supabase.js';

function filterRestaurants(restaurants: Restaurant[]): Restaurant[] {
  if (!config.singleClient) return restaurants;
  const match = restaurants.find((r) => r.name === config.singleClient);
  if (!match) {
    const available = restaurants.map((r) => r.name).join(', ') || '(none)';
    throw new Error(
      `SINGLE_CLIENT "${config.singleClient}" did not match any active restaurant. Available: ${available}`
    );
  }
  return [match];
}

/** TEST_LOGIN=true: exercise only the login/storageState flow, no scraping. */
async function runTestLogin(restaurants: Restaurant[]): Promise<number> {
  const client = restaurants[0];
  if (!client) {
    logger.error('TEST_LOGIN: no active restaurant to test against');
    return 1;
  }

  logger.section(`TEST LOGIN: ${client.name}`);
  const browser = await chromium.launch({
    headless: config.headless,
    ...(config.browserChannel ? { channel: config.browserChannel } : {}),
  });
  try {
    const { context, reusedSession } = await openAuthenticatedContext(browser, client);
    logger.success(`Login OK for ${client.name}`, { reusedSession });
    await context.close();
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Login FAILED for ${client.name}`, { error: message });
    return 1;
  } finally {
    await browser.close();
  }
}

async function main(): Promise<number> {
  if (config.dryRun) {
    logger.info('DRY_RUN enabled — scraping only, no Drive uploads or Supabase writes');
  }

  logger.info('Loading active clients from Supabase...');
  const allRestaurants = await fetchActiveRestaurants();

  if (allRestaurants.length === 0) {
    logger.info('No active restaurants found in Supabase. Nothing to do.');
    return 0;
  }

  const restaurants = filterRestaurants(allRestaurants);
  logger.info(`Found ${restaurants.length} client(s) to process`, { names: restaurants.map((r) => r.name) });

  if (config.testLogin) {
    return runTestLogin(restaurants);
  }

  const drive = createDriveClient();
  await verifyDriveAccess(drive);
  logger.success('Central Google Drive credentials verified');

  logger.info('Launching browser...', { headless: config.headless, browserChannel: config.browserChannel ?? 'bundled chromium' });
  const browser = await chromium.launch({
    headless: config.headless,
    ...(config.browserChannel ? { channel: config.browserChannel } : {}),
  });

  const clientSummaries: ClientSummary[] = [];
  try {
    for (const client of restaurants) {
      const summary = await processClient(browser, client, drive);
      clientSummaries.push(summary);
    }
  } finally {
    await browser.close();
  }

  const totals = clientSummaries.reduce(
    (acc, s) => ({
      clients: acc.clients + 1,
      uploaded: acc.uploaded + s.uploaded,
      duplicates: acc.duplicates + s.duplicates,
      skipped: acc.skipped + s.skipped,
      errors: acc.errors + s.errors,
    }),
    { clients: 0, uploaded: 0, duplicates: 0, skipped: 0, errors: 0 }
  );

  logger.info('Run complete', totals);
  console.log('\nPer-client breakdown:');
  for (const s of clientSummaries) {
    console.log(
      `  ${s.restaurantName}: ${s.uploaded} uploaded, ${s.duplicates} duplicates, ${s.skipped} skipped, ${s.errors} errors`
    );
  }

  const summaryPath = path.join(config.paths.logsDir, 'last-run-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify({ ...totals, dryRun: config.dryRun, clients_detail: clientSummaries }, null, 2));
  logger.debug('Wrote run summary', { summaryPath });

  if (totals.errors > 0) {
    logger.warn(`${totals.errors} total error(s) across all clients — see ${summaryPath} for details`);
  }

  return totals.errors > 0 ? 1 : 0;
}

main()
  .then(async (exitCode) => {
    await logger.close();
    process.exit(exitCode);
  })
  .catch(async (err) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Fatal error', { error: message });
    await logger.close();
    process.exit(1);
  });
