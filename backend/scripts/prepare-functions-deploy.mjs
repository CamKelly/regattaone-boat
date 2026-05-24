import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sharedDir = join(root, 'shared');
const vendorDir = join(root, 'functions', 'vendor', '@regattaone', 'shared');

execSync('npm run build -w @regattaone/shared', { cwd: root, stdio: 'inherit' });

rmSync(vendorDir, { recursive: true, force: true });
mkdirSync(vendorDir, { recursive: true });

cpSync(join(sharedDir, 'dist'), join(vendorDir, 'dist'), { recursive: true });

writeFileSync(
  join(vendorDir, 'package.json'),
  JSON.stringify(
    {
      name: '@regattaone/shared',
      version: '0.0.1',
      private: true,
      main: 'dist/index.js',
      types: 'dist/index.d.ts',
    },
    null,
    2,
  ),
);

console.log('Vendored @regattaone/shared into functions/vendor for deployment.');
