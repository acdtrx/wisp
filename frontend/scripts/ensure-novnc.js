/**
 * Ensures noVNC core is present in public/vendor/novnc/ before build.
 * Runs as prebuild so every "npm run build" has vendor files for Vite to copy into dist.
 */
import { existsSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const rfbPath = join(root, 'public', 'vendor', 'novnc', 'core', 'rfb.js');
const vendorPakoPath = join(root, 'public', 'vendor', 'novnc', 'vendor', 'pako');

if (existsSync(rfbPath) && existsSync(vendorPakoPath)) {
  process.exit(0);
}

const vendorNovnc = join(root, 'public', 'vendor', 'novnc');
mkdirSync(vendorNovnc, { recursive: true });

const tmpDir = join(root, 'node_modules', '.cache', 'novnc-ensure');
mkdirSync(join(tmpDir, '..'), { recursive: true });

try {
  execSync(
    `git clone --depth 1 --config core.hooksPath=/dev/null https://github.com/novnc/noVNC.git "${join(tmpDir, 'noVNC')}"`,
    { stdio: 'pipe', cwd: root }
  );
} catch (err) {
  // Git may fail on .git/hooks in restricted envs but still create files
}

const coreSrc = join(tmpDir, 'noVNC', 'core');
const coreDest = join(vendorNovnc, 'core');
const vendorSrc = join(tmpDir, 'noVNC', 'vendor');
const vendorDest = join(vendorNovnc, 'vendor');
if (existsSync(coreSrc)) {
  cpSync(coreSrc, coreDest, { recursive: true });
  console.log('ensure-novnc: copied noVNC core to public/vendor/novnc/');
} else {
  console.error('ensure-novnc: could not fetch noVNC (network/git?). VNC console will not work.');
  process.exit(1);
}
if (existsSync(vendorSrc)) {
  cpSync(vendorSrc, vendorDest, { recursive: true });
  console.log('ensure-novnc: copied noVNC vendor (pako) to public/vendor/novnc/');
}

try {
  rmSync(tmpDir, { recursive: true, force: true });
} catch {
  // ignore cleanup failure
}
