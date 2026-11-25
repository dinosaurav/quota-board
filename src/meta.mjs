// Paths, version and repository shared by the CLI, collectors and renderers.
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';

export const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PKG = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8'));
export const VERSION = PKG.version;
/** GitHub "owner/name". Forks: change package.json "repository", or set QUOTA_BOARD_REPO. */
export const REPO = process.env.QUOTA_BOARD_REPO || String(PKG.repository && (PKG.repository.url || PKG.repository) || '').replace(/^.*github\.com[/:]/, '').replace(/\.git$/, '');
/** Where user data lives: config, manual readings, last usage, generated dashboard. */
export const DATA_DIR = process.env.QUOTA_BOARD_HOME || join(homedir(), '.quota-board');

/**
 * Write a file that only the current user can read (mode 0600; a folder it creates gets 0700).
 * The chmod also tightens files written by older versions. Existing folders are left alone, in case
 * QUOTA_BOARD_HOME points somewhere shared. Windows ignores POSIX modes; there the file inherits the
 * user-profile ACL, which is already private.
 */
export function writePrivate(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, data, { mode: 0o600 });
  if (process.platform !== 'win32') { try { chmodSync(path, 0o600); } catch { /* not ours to change */ } }
}
