import { createServer } from 'vite';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('./call-audio-lab.html', import.meta.url), 'utf8');
const server = await createServer({
  server: { host: '127.0.0.1', port: 5197 },
  plugins: [
    {
      name: 'local-call-audio-lab',
      configureServer(vite) {
        vite.middlewares.use('/__call-audio-lab', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end(html);
        });
      },
    },
  ],
});
await server.listen();
console.log('Audio comparison: http://127.0.0.1:5197/__call-audio-lab');
