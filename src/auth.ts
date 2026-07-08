import fs from 'node:fs';
import path from 'node:path';
import type { Browser, BrowserContext, ElementHandle, Page } from 'playwright';
import { config } from './config.js';
import { logger, screenshot } from './logger.js';
import type { Restaurant } from './supabase.js';

const RECEIPTS_URL = 'https://www.restaurantdepot.com/member/receipts';

/**
 * Try each selector in order, return the first visible element found.
 * NOTE: `input[id="signInName"]` from the reference actor is intentionally
 * dropped here — it never matched on the live Azure B2C page and only added
 * a guaranteed-to-fail probe before the selectors that actually work.
 */
export async function findElement(
  page: Page,
  selectors: string[],
  timeout = 5000
): Promise<ElementHandle<SVGElement | HTMLElement> | null> {
  for (const selector of selectors) {
    try {
      const el = await page.waitForSelector(selector, { timeout, state: 'visible' });
      if (el) {
        logger.debug(`Found element: ${selector}`);
        return el;
      }
    } catch {
      logger.debug(`Not found: ${selector}`);
    }
  }
  return null;
}

function getStorageStatePath(restaurantId: string): string {
  return path.join(config.paths.authStateDir, `${restaurantId}.json`);
}

function hasStoredSession(restaurantId: string): boolean {
  return fs.existsSync(getStorageStatePath(restaurantId));
}

async function isLoggedIn(page: Page): Promise<boolean> {
  const url = page.url();
  return !url.includes('login.restaurantdepot.com') && !url.includes('b2c') && url.includes('receipts');
}

/** Fills and submits the Azure B2C login form. Throws on any failure. */
async function login(page: Page, client: Restaurant): Promise<void> {
  const { name: restaurantName, rd_email: email, rd_password: passwordRaw } = client;
  const password = passwordRaw != null ? String(passwordRaw) : null;

  logger.step(`Login: ${restaurantName}`);
  await page.waitForTimeout(2_000);
  await screenshot(page, `${restaurantName}_login_page`);

  const allInputs = await page.$$eval('input', (els) =>
    els.map((el) => ({ type: el.type, name: el.name, id: el.id, placeholder: el.placeholder }))
  );
  logger.debug('Inputs found on login page', { inputs: allInputs });

  const emailField = await findElement(page, [
    'input[id="email"]',
    'input[name="signInName"]',
    'input[name="email"]',
    'input[type="email"]',
    'input[placeholder*="email" i]',
    'input[autocomplete="email"]',
    'input[autocomplete="username"]',
  ]);
  if (!emailField) throw new Error('Could not find email input field on Azure B2C login page');
  await emailField.click();
  await emailField.fill(email);

  const passwordField = await findElement(page, [
    'input[id="password"]',
    'input[name="password"]',
    'input[type="password"]',
  ]);
  if (!passwordField) throw new Error('Could not find password input field');
  if (!password) {
    throw new Error(`rd_password is null for ${restaurantName} — update it in Supabase restaurants table`);
  }
  await passwordField.click();
  await passwordField.fill(password);

  const submitBtn = await findElement(page, [
    'button[id="next"]',
    'button[id="continue"]',
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Sign in")',
    'button:has-text("Sign In")',
    'button:has-text("Login")',
    'button:has-text("Continue")',
    'button:has-text("Next")',
  ]);
  if (!submitBtn) throw new Error('Could not find submit button on Azure B2C login page');

  await Promise.all([
    page.waitForURL('**/member/**', { timeout: 45_000 }).catch(() => {}),
    submitBtn.click(),
  ]);
  await page.waitForTimeout(2_000);
  await screenshot(page, `${restaurantName}_after_login`);

  const urlAfterLogin = page.url();
  logger.debug('URL after login', { url: urlAfterLogin });

  const errorEl = await page.$('#claimVerificationServerError, .alert-error').catch(() => null);
  if (errorEl) {
    const errText = (await errorEl.textContent())?.trim();
    if (errText) throw new Error(`Login error: ${errText}`);
  }

  if (urlAfterLogin.includes('login.restaurantdepot.com') || urlAfterLogin.includes('b2clogin')) {
    const pageText = await page.evaluate(() => document.body.innerText.slice(0, 500));
    throw new Error(`Login failed — still on login page. Page text: ${pageText}`);
  }
}

export interface AuthenticatedSession {
  context: BrowserContext;
  page: Page;
  /** true if an existing auth-state/{id}.json was reused without running the login flow */
  reusedSession: boolean;
}

/**
 * Opens a fresh browser context for one restaurant, reusing a saved
 * storageState if present and still valid, otherwise running the full
 * Azure B2C login flow and persisting storageState for next time.
 */
export async function openAuthenticatedContext(browser: Browser, client: Restaurant): Promise<AuthenticatedSession> {
  const storageStatePath = getStorageStatePath(client.id);
  const reusableSession = hasStoredSession(client.id);

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    acceptDownloads: true,
    ...(reusableSession ? { storageState: storageStatePath } : {}),
  });

  try {
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') logger.warn('[browser console error]', { text: msg.text() });
    });

    await page.goto(RECEIPTS_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(2_000);
    await screenshot(page, `${client.name}_after_nav`);

    if (await isLoggedIn(page)) {
      if (reusableSession) {
        logger.info('Reused stored session — skipped login', { restaurant: client.name });
      }
      return { context, page, reusedSession: reusableSession };
    }

    logger.info('Azure B2C login required', { restaurant: client.name, url: page.url() });
    await login(page, client);
    await context.storageState({ path: storageStatePath });
    logger.debug('Saved storageState', { restaurant: client.name, path: storageStatePath });

    return { context, page, reusedSession: false };
  } catch (err) {
    // If setup/login fails, the caller never receives this context to close —
    // close it here so a failed login doesn't leak an open browser context.
    await context.close().catch(() => {});
    throw err;
  }
}

export { RECEIPTS_URL };
