// Draws the OpenMail mark (a plain envelope on the accent blue, DESIGN.md) into every icon the web app and the
// native shells need. Uses the desktop app's Electron as the renderer, so no image tools are needed:
//   cd apps/desktop && npx electron ../make-icons.js
// Writes web/public/icon.svg + web/public/icons/*, Android mipmaps, the iOS app icon and apps/desktop/icon.icns.
const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path');

const root = path.join(__dirname, '..');
const BLUE = '#115bcd'; // --accent, oklch(50% 0.19 260)
const envelope = '<path d="M136 176h240a16 16 0 0 1 16 16v128a16 16 0 0 1-16 16H136a16 16 0 0 1-16-16V192a16 16 0 0 1 16-16z" fill="none" stroke="#fff" stroke-width="28" stroke-linejoin="round"/>'
  + '<path d="M128 188l128 96 128-96" fill="none" stroke="#fff" stroke-width="28" stroke-linejoin="round" stroke-linecap="round"/>';
const plus = '<path d="M256 168v176M168 256h176" stroke="#fff" stroke-width="36" stroke-linecap="round"/>';
const bg = { rounded: `<rect width="512" height="512" rx="112" fill="${BLUE}"/>`, square: `<rect width="512" height="512" fill="${BLUE}"/>`,
  circle: `<circle cx="256" cy="256" r="256" fill="${BLUE}"/>`, none: '' };
// box: viewBox; macOS icons leave a margin around the tile (Apple's grid: 824 of 1024).
const svg = (shape, { scale = 1, glyph = envelope, box = '0 0 512 512' } = {}) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}">${bg[shape]}<g transform="translate(256 256) scale(${scale}) translate(-256 -256)">${glyph}</g></svg>`;

const web = (f) => path.join(root, 'web/public', f);
const res = (d, f) => path.join(root, 'apps/mobile/android/app/src/main/res', d, f);
const iconset = path.join(root, 'apps/desktop/icon.iconset');
const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const out = [ // [file, size, svg]
  [web('icons/icon-192.png'), 192, svg('rounded')], [web('icons/icon-512.png'), 512, svg('rounded')],
  [web('icons/maskable-192.png'), 192, svg('square', { scale: 0.85 })], [web('icons/maskable-512.png'), 512, svg('square', { scale: 0.85 })],
  [web('icons/apple-touch-icon.png'), 180, svg('square')], // iOS rounds the corners itself
  [web('icons/badge-96.png'), 96, svg('none', { scale: 1.4 })], // Android status bar: white on transparent
  [web('icons/compose-96.png'), 96, svg('rounded', { glyph: plus })],
  [path.join(root, 'apps/mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'), 1024, svg('square'), 'opaque'],
  ...Object.entries(dens).flatMap(([d, x]) => [
    [res(`mipmap-${d}`, 'ic_launcher.png'), 48 * x, svg('rounded')],
    [res(`mipmap-${d}`, 'ic_launcher_round.png'), 48 * x, svg('circle', { scale: 0.85 })],
    // Adaptive icon foreground: 108dp, launchers crop to a 66dp circle or squircle in the middle.
    [res(`mipmap-${d}`, 'ic_launcher_foreground.png'), 108 * x, svg('none', { scale: 0.7 })],
  ]),
  ...[16, 32, 128, 256, 512].flatMap((s) => [
    [path.join(iconset, `icon_${s}x${s}.png`), s, svg('rounded', { box: '-62 -62 636 636' })],
    [path.join(iconset, `icon_${s}x${s}@2x.png`), s * 2, svg('rounded', { box: '-62 -62 636 636' })],
  ]),
];

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  fs.writeFileSync(web('icon.svg'), svg('rounded') + '\n');
  const win = new BrowserWindow({ show: false, width: 1024, height: 1024, transparent: true, frame: false, webPreferences: { offscreen: true } });
  for (const [file, size, image, opaque] of out) {
    await win.loadURL('data:text/html,' + encodeURIComponent(`<body style="margin:0;background:transparent">${image.replace('<svg ', '<svg width="1024" height="1024" ')}</body>`));
    await new Promise((r) => setTimeout(r, 150));
    const png = (await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })).resize({ width: size, height: size, quality: 'best' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!opaque) { fs.writeFileSync(file, png.toPNG()); continue; }
    // App Store icons must have no alpha channel: round-trip through JPEG.
    const jpg = file.replace(/\.png$/, '.jpg');
    fs.writeFileSync(jpg, png.toJPEG(100));
    execFileSync('sips', ['-s', 'format', 'png', jpg, '--out', file], { stdio: 'ignore' });
    fs.unlinkSync(jpg);
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(root, 'apps/desktop/icon.icns')]);
  fs.rmSync(iconset, { recursive: true });
  fs.writeFileSync(res('values', 'ic_launcher_background.xml'), `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${BLUE.toUpperCase()}</color>\n</resources>\n`);
  console.log(`wrote ${out.length} icons`);
  app.quit();
});
