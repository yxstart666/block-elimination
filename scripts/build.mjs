import { build, context } from 'esbuild';
import { mkdir, copyFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const entries = [
  ['src/platform/browser.ts', 'dist/web/app.js', 'iife'],
  ['src/platform/wechat-miniprogram.ts', 'platforms/miniprogram/pages/game/game.js', 'cjs'],
  ['src/platform/wechat-game.ts', 'platforms/minigame/game.js', 'cjs'],
];
const runtimeAssets = ['tiles.png', 'icons.png', 'ui.png', 'background.png', 'atlas.json'];

export async function copyRuntimeAssets() {
  for (const output of ['dist/web/assets/ui', 'platforms/miniprogram/assets/ui', 'platforms/minigame/assets/ui']) {
    await mkdir(path.join(root, output), { recursive: true });
    await Promise.all(runtimeAssets.map(name => copyFile(path.join(root, 'assets/ui', name), path.join(root, output, name))));
  }
}

export async function buildAll(watch = false) {
  await mkdir(path.join(root, 'dist/web'), { recursive: true });
  await copyFile(path.join(root, 'web/index.html'), path.join(root, 'dist/web/index.html'));
  await copyRuntimeAssets();
  for (const [entry, outfile, format] of entries) {
    const options = { entryPoints: [path.join(root, entry)], outfile: path.join(root, outfile), bundle: true, minify: true, format, target: 'es2018', legalComments: 'none', logLevel: 'warning' };
    if (watch) {
      const ctx = await context(options);
      await ctx.watch();
    } else {
      await build(options);
      console.log(`${outfile}: ${((await stat(path.join(root, outfile))).size / 1024).toFixed(1)} KB`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildAll();
