// 단일 _worker.js로 번들링: src/icons.js + src/index.js
import fs from 'node:fs';

const main = fs.readFileSync('src/index.js', 'utf8');
const icons = fs.existsSync('src/icons.js') ? fs.readFileSync('src/icons.js', 'utf8') : '';

// icons.js의 export 제거 (단순 const로)
const iconsStripped = icons.replace(/^export\s+/gm, '');
// index.js에서 ./icons.js import 제거
const mainStripped = main.replace(/^import\s+\{[^}]+\}\s+from\s+['"]\.\/icons\.js['"];?\s*$\n?/gm, '');

fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/_worker.js', iconsStripped + '\n' + mainStripped);
console.log('✓ dist/_worker.js (' + Math.round(fs.statSync('dist/_worker.js').size / 1024) + ' KB)');
