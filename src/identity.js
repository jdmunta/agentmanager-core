// Who this Agent Manager runs as, for the menu in the top bar: the computer's user, the Claude
// account its agents use (as Claude Code recorded it in ~/.claude.json), and the git identity
// their commits get. Read on request; nothing here leaves the machine.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const gitConfig = (key) =>
  new Promise((resolve) => execFile('git', ['config', '--global', key], { timeout: 3000 }, (e, out) => resolve(e ? null : out.trim() || null)));

/** The signed-in Claude account from Claude Code's settings file, or null. */
export function claudeAccount(file = path.join(os.homedir(), '.claude.json')) {
  try {
    const a = JSON.parse(fs.readFileSync(file, 'utf8')).oauthAccount;
    if (!a?.emailAddress) return null;
    return { email: a.emailAddress, name: a.displayName || a.fullName || null, organization: a.organizationName || null };
  } catch {
    return null;
  }
}

export async function identity() {
  const [gitName, gitEmail] = await Promise.all([gitConfig('user.name'), gitConfig('user.email')]);
  let user = null;
  try {
    user = os.userInfo().username;
  } catch {
    // No passwd entry (some containers).
  }
  const claude = claudeAccount();
  return {
    user,
    host: os.hostname().replace(/\.local$/, ''),
    claude,
    git: gitName || gitEmail ? { name: gitName, email: gitEmail } : null,
    // What the menu shows first: a name, then an email.
    display: claude?.name || gitName || user || 'You',
    email: claude?.email || gitEmail || null,
  };
}
