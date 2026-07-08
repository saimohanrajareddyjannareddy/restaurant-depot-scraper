import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === '') return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;
  return defaultValue;
}

const missingVars: string[] = [];
function required(name: string): string {
  const value = process.env[name];
  if (!value) missingVars.push(name);
  return value ?? '';
}

const supabaseUrl = required('SUPABASE_URL');
const supabaseServiceKey = required('SUPABASE_SERVICE_KEY');
const googleOAuthClientId = required('GOOGLE_OAUTH_CLIENT_ID');
const googleOAuthClientSecret = required('GOOGLE_OAUTH_CLIENT_SECRET');
const googleOAuthRefreshToken = required('GOOGLE_OAUTH_REFRESH_TOKEN');

if (missingVars.length > 0) {
  throw new Error(
    `Missing required environment variable(s): ${missingVars.join(', ')}. ` +
      'Copy .env.example to .env and fill them in.'
  );
}

// A CLI positional arg (e.g. `npm run one -- "Turmeric STL"`) takes priority
// over SINGLE_CLIENT in .env, so `one` can be reused for different clients
// without editing the env file each time.
const cliClientArg = process.argv.slice(2).find((arg) => !arg.startsWith('-'));
const singleClientRaw = cliClientArg || process.env.SINGLE_CLIENT || '';

const authStateDir = path.join(projectRoot, 'auth-state');
const tmpDir = path.join(projectRoot, 'tmp');
const logsDir = path.join(projectRoot, 'logs');
for (const dir of [authStateDir, tmpDir, logsDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

export const config = {
  supabaseUrl,
  supabaseServiceKey,
  googleOAuthClientId,
  googleOAuthClientSecret,
  googleOAuthRefreshToken,
  dateRange: process.env.DATE_RANGE?.trim() || 'Last 30 Days – On Demand',
  browserChannel: process.env.BROWSER_CHANNEL?.trim() || undefined,
  headless: parseBool(process.env.HEADLESS, true),
  dryRun: parseBool(process.env.DRY_RUN, false),
  singleClient: singleClientRaw.trim() || undefined,
  testLogin: parseBool(process.env.TEST_LOGIN, false),
  paths: {
    projectRoot,
    authStateDir,
    tmpDir,
    logsDir,
  },
} as const;
