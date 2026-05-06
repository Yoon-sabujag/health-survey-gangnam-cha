// dist/_worker.js + dist/<assets> 빌드
import fs from 'node:fs';
import path from 'node:path';

const main = fs.readFileSync('src/index.js', 'utf8');
fs.mkdirSync('dist', { recursive: true });

// (구버전) icons.js import 라인이 남아있으면 제거
const stripped = main.replace(/^import\s+\{[^}]+\}\s+from\s+['"]\.\/icons\.js['"];?\s*\n?/gm, '');
fs.writeFileSync('dist/_worker.js', stripped);
console.log('✓ dist/_worker.js (' + Math.round(fs.statSync('dist/_worker.js').size / 1024) + ' KB)');

// assets/* → dist/
const assetsDir = 'assets';
if (fs.existsSync(assetsDir)) {
  for (const f of fs.readdirSync(assetsDir)) {
    const src = path.join(assetsDir, f);
    const dst = path.join('dist', f);
    fs.copyFileSync(src, dst);
    console.log(`✓ dist/${f} (${Math.round(fs.statSync(dst).size / 1024)} KB)`);
  }
}
