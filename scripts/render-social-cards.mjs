// Regenerate committed preview images with the repository's fonts and logo.
// PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chromium npm run assets:social
import { chromium } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
const data = async (path, type) =>
  `data:${type};base64,${(await readFile(path)).toString('base64')}`;
const logo = await data('static/anagram.png', 'image/png');
const font = await data('static/fonts/Manrope-latin-variable.ttf', 'font/ttf');
const cards = [
  {
    name: 'anagram',
    title: 'A Nostr<br>Alternative Gram',
    detail: 'Nostr and Iroh powered private chats, groups chats and calls',
    action: 'join us!',
    icon: 'chat',
  },
  {
    name: 'chat',
    title: 'Join chat',
    detail: 'An open conversation on Nostr.',
    action: 'You’re invited',
    icon: 'chat',
  },
  {
    name: 'call',
    title: 'Join call',
    detail: 'Voice and video, powered by Iroh.',
    action: 'You’re invited',
    icon: 'call',
  },
];
const icons = {
  chat: '<path d="M30 34h116v78H74l-30 24v-24H30z"/><path d="M55 59h66M55 82h43"/>',
  call: '<rect x="24" y="46" width="90" height="76" rx="20"/><path d="m114 70 42-22v72l-42-22z"/>',
};
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  });
  await mkdir('static/social', { recursive: true });
  for (const card of cards) {
    await page.setContent(`<!doctype html><html><head><style>
      @font-face{font-family:Manrope;src:url('${font}');font-weight:400 800}
      *{box-sizing:border-box}body{margin:0;width:1200px;height:630px;overflow:hidden;font-family:Manrope,sans-serif;color:#f4f8ff;background:radial-gradient(ellipse at 93% 80%,#194775 0,transparent 52%),#101c2b}
      main{position:relative;padding:52px 66px;height:100%;isolation:isolate}
      header{display:flex;align-items:center;gap:16px;font-size:30px;font-weight:800;letter-spacing:-1px}header img{width:58px;height:58px;object-fit:contain}
      .copy{position:absolute;left:66px;top:179px;z-index:2}h1{font-size:72px;line-height:1.12;letter-spacing:-3px;font-weight:800;margin:0 0 24px}p{max-width:560px;font-size:25px;color:#b3c9dd;margin:0}
      footer{position:absolute;bottom:52px;left:66px;right:66px;display:flex;align-items:center;justify-content:space-between}.action{background:#77c9ff;color:#101c2b;border-radius:30px;padding:13px 26px;font-weight:800;font-size:23px}.domain{font-size:20px;color:#b3c9dd}
      .art{position:absolute;right:63px;top:178px;width:265px;height:265px;display:grid;place-items:center;background:linear-gradient(145deg,#23466c,#152f4d);border:1px solid #4b7b9d;border-radius:68px;transform:rotate(-7deg);box-shadow:0 25px 80px #060d1880}
      .art svg{width:180px;height:180px;fill:none;stroke:#85d7ff;stroke-width:9;stroke-linejoin:round;stroke-linecap:round}
      .orbit{position:absolute;right:-85px;top:33px;width:570px;height:570px;border:1px solid #31526d;border-radius:50%;z-index:-1}.orbit:after{content:'';position:absolute;inset:45px;border:1px solid #294960;border-radius:50%}
      .dot{position:absolute;width:16px;height:16px;background:#85d7ff;border-radius:50%;right:92px;top:120px}
    </style></head><body><main><header><img src="${logo}" alt="">Anagram</header><div class="copy"><h1>${card.title}</h1><p>${card.detail}</p></div><div class="orbit"></div><div class="dot"></div><div class="art"><svg viewBox="0 0 180 170">${icons[card.icon]}</svg></div><footer><span class="action">${card.action}</span><span class="domain">anagram.chat</span></footer></main></body></html>`);
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map((img) => img.decode()));
    });
    await page.screenshot({ path: `static/social/${card.name}-v1.jpg`, quality: 90 });
  }
} finally {
  await browser.close();
}
