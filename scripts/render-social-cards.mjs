// Regenerate committed preview images with the repository's fonts and logo.
// PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chromium npm run assets:social
import { chromium } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
const data = async (path, type) =>
  `data:${type};base64,${(await readFile(path)).toString('base64')}`;
const logo = await data('static/anagram.png', 'image/png');
const font = await data('static/fonts/Manrope-latin-variable.ttf', 'font/ttf');
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  });
  await mkdir('static/social', { recursive: true });
  await page.setContent(`<!doctype html><html><head><style>
    @font-face{font-family:Manrope;src:url('${font}');font-weight:400 800}
    *{box-sizing:border-box}body{margin:0;font-family:Manrope,sans-serif}
    main{position:relative;width:1200px;height:630px;overflow:hidden;color:white;background:radial-gradient(ellipse at 98% 102%,#2869a7 0,transparent 64%),linear-gradient(125deg,#101d31,#172c48)}
    .glow{position:absolute;width:570px;height:570px;right:-50px;top:40px;border-radius:50%;background:radial-gradient(circle,#348de330,transparent 69%)}
    .ring{position:absolute;right:-140px;top:-70px;border:1px solid #7bc5ff1c;width:650px;height:650px;border-radius:50%}
    .mark{position:absolute;right:72px;top:163px;width:310px;height:310px;object-fit:contain}
    .content{position:absolute;left:72px;top:165px;right:450px}h1{margin:0 0 24px;font-size:129px;line-height:1.08;letter-spacing:-3px;font-weight:800}.tagline{font-size:40px;line-height:1.35;font-weight:500;color:#c5e5ff;margin:0}
    footer{position:absolute;bottom:50px;left:74px;font-size:24px;font-weight:600;color:#a7c5df;letter-spacing:.2px}
  </style></head><body><main><div class="glow"></div><div class="ring"></div><img class="mark" src="${logo}" alt=""><div class="content"><h1>Anagram</h1><p class="tagline">Private Groups, Chats &amp; Calls</p></div><footer>Powered by Nostr + Iroh</footer></main></body></html>`);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((img) => img.decode()));
  });
  await page.screenshot({ path: 'static/social/anagram-v2.jpg', quality: 90 });
} finally {
  await browser.close();
}
