import fs from 'node:fs';
import { google, type drive_v3 } from 'googleapis';
import { config } from './config.js';
import { logger } from './logger.js';

export type DriveClient = drive_v3.Drive;

/** One central Drive client (your OAuth account), reused across every restaurant. */
export function createDriveClient(): DriveClient {
  const oauth2Client = new google.auth.OAuth2(config.googleOAuthClientId, config.googleOAuthClientSecret);
  oauth2Client.setCredentials({ refresh_token: config.googleOAuthRefreshToken });
  return google.drive({ version: 'v3', auth: oauth2Client });
}

/** Fail-fast credential check — call once at startup before processing any client. */
export async function verifyDriveAccess(drive: DriveClient): Promise<void> {
  try {
    await drive.files.list({ pageSize: 1, fields: 'files(id)' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Drive credential check failed: ${message}. Verify GOOGLE_OAUTH_* in .env.`);
  }
}

/** Escapes backslash and single-quote for a string literal embedded in a Drive `q` filter. */
function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Permanently deletes a file from Drive. Destructive — never used by the
 * normal scrape flow, only by deliberate one-off cleanup scripts.
 */
export async function deleteDriveFile(drive: DriveClient, fileId: string): Promise<void> {
  await drive.files.delete({ fileId });
}

/**
 * Check if a file with the given name already exists in the Drive folder.
 * First line of dedup defense — avoids re-downloading and re-uploading.
 * Runs even in DRY_RUN so the dry-run summary still reports duplicates accurately.
 */
export async function fileExistsInDrive(drive: DriveClient, fileName: string, folderId: string): Promise<boolean> {
  const safeName = escapeDriveQueryValue(fileName);
  const safeFolderId = escapeDriveQueryValue(folderId);
  const res = await drive.files.list({
    q: `name='${safeName}' and '${safeFolderId}' in parents and trashed=false`,
    fields: 'files(id, name)',
    spaces: 'drive',
  });
  return (res.data.files?.length ?? 0) > 0;
}

/**
 * Lists every filename in a Drive folder, paginated. Read-only — for
 * diagnostic scripts that cross-reference Drive contents against Supabase,
 * not used in the normal scrape flow (which only ever checks one filename
 * at a time via fileExistsInDrive).
 */
export async function listDriveFolderFilenames(drive: DriveClient, folderId: string): Promise<string[]> {
  const safeFolderId = escapeDriveQueryValue(folderId);
  const names: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q: `'${safeFolderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(name)',
      spaces: 'drive',
      pageSize: 1000,
      pageToken,
    });
    for (const file of res.data.files ?? []) {
      if (file.name) names.push(file.name);
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return names;
}

export interface UploadedDriveFile {
  id: string;
  webViewLink: string | null;
  name: string;
}

export async function uploadToDrive(
  drive: DriveClient,
  localPath: string,
  fileName: string,
  folderId: string
): Promise<UploadedDriveFile> {
  if (config.dryRun) {
    logger.info('[dry-run] would upload to Drive', { fileName, folderId });
    return { id: `dry-run-${fileName}`, webViewLink: null, name: fileName };
  }

  const response = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId] },
    media: {
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: fs.createReadStream(localPath),
    },
    fields: 'id, webViewLink, name',
  });

  const { id, webViewLink, name } = response.data;
  if (!id || !name) {
    throw new Error(`Drive upload succeeded but response was missing id/name for ${fileName}`);
  }
  return { id, webViewLink: webViewLink ?? null, name };
}

/** Retries an async fn up to maxAttempts times with linear backoff (baseDelayMs * attempt). */
export async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3, baseDelayMs = 2000): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * attempt;
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`Attempt ${attempt}/${maxAttempts} failed — retrying in ${delay}ms`, { error: message });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastErr;
}
