import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(extensionRoot, 'dist', 'manifest.json'), 'utf8'));
const forbiddenPermissions = ['<all_urls>', 'cookies', 'webRequest', 'history', 'clipboardRead', 'clipboardWrite', 'downloads', 'nativeMessaging', 'debugger', 'scripting'];
if (manifest.manifest_version !== 3) throw new Error('Manifest V3 is required.');
if (!Array.isArray(manifest.permissions) || !manifest.permissions.every((permission) => !forbiddenPermissions.includes(permission))) {
  throw new Error('Manifest contains a forbidden permission.');
}
if (!Array.isArray(manifest.host_permissions) || manifest.host_permissions.some((host) => host === '<all_urls>')) {
  throw new Error('Manifest host permissions are not restricted.');
}
if (manifest.content_security_policy?.extension_pages !== "script-src 'self'; object-src 'self'; base-uri 'self';") {
  throw new Error('Manifest CSP is not the expected strict policy.');
}
process.stdout.write('Manifest validation passed.\n');
