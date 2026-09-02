import http from 'node:http';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const pub = join(root, 'public');
const file = join(root, 'data.json');
const seed = join(root, 'data.example.json');
const port = process.env.PORT || 3000;
const revealTimeoutMs = 60_000;
const adminClients = new Set();
const publicClients = new Set();
const revealTimers = new Map();
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml'
};

let chain = Promise.resolve();

function lock(task) {
  const next = chain.then(task, task);
  chain = next.catch(() => {});
  return next;
}

async function getData() {
  if (!existsSync(file)) await copyFile(seed, file);
  return JSON.parse(await readFile(file, 'utf8'));
}

function toPublicState(data) {
  const now = Date.now();
  const hiddenByItem = new Map();

  for (const draw of data.draws) {
    const revealAt = Date.parse(draw.revealAt || '');
    const isHidden = draw.revealed === false && Number.isFinite(revealAt) && revealAt > now;
    if (isHidden) {
      hiddenByItem.set(draw.itemId, (hiddenByItem.get(draw.itemId) || 0) + 1);
    }
  }

  return {
    items: data.items.map(item => ({
      ...item,
      remaining: item.remaining + (hiddenByItem.get(item.id) || 0)
    })),
    draws: data.draws.filter(draw => {
      const revealAt = Date.parse(draw.revealAt || '');
      return draw.revealed !== false || !Number.isFinite(revealAt) || revealAt <= now;
    })
  };
}

function sendEvent(clients, data) {
  const message = 'event: state\ndata: ' + JSON.stringify(data) + '\n\n';
  clients.forEach(response => response.write(message));
}

function broadcastAdmin(data) {
  sendEvent(adminClients, data);
}

function broadcastPublic(data) {
  sendEvent(publicClients, toPublicState(data));
}

async function saveData(data, { publicUpdate = false } = {}) {
  await writeFile(file, JSON.stringify(data, null, 2) + '\n');
  broadcastAdmin(data);
  if (publicUpdate) broadcastPublic(data);
}

function output(response, status, body, type = 'application/json; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  response.end(Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
}

async function readBody(request) {
  let body = '';
  for await (const part of request) body += part;
  return JSON.parse(body || '{}');
}

function pickPrize(items) {
  const available = items.filter(item => item.remaining > 0);
  const total = available.reduce((sum, item) => sum + item.remaining, 0);
  let point = Math.random() * total;
  return available.find(item => (point -= item.remaining) < 0);
}

async function revealDraw(drawId) {
  return lock(async () => {
    const data = await getData();
    const draw = data.draws.find(entry => entry.id === drawId);
    if (!draw) return null;

    if (draw.revealed === false) {
      draw.revealed = true;
      await saveData(data);
    }

    const timer = revealTimers.get(drawId);
    if (timer) clearTimeout(timer);
    revealTimers.delete(drawId);
    broadcastPublic(data);
    return toPublicState(data);
  });
}

function scheduleReveal(draw) {
  if (draw.revealed !== false) return;
  const revealAt = Date.parse(draw.revealAt || '');
  if (!Number.isFinite(revealAt)) return;

  const delay = Math.max(0, revealAt - Date.now());
  const timer = setTimeout(() => {
    revealDraw(draw.id).catch(error => console.error('Automatic reveal failed:', error));
  }, delay);
  timer.unref?.();
  revealTimers.set(draw.id, timer);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');

  try {
    if (url.pathname === '/api/state' && request.method === 'GET') {
      return output(response, 200, await getData());
    }

    if (url.pathname === '/api/public-state' && request.method === 'GET') {
      return output(response, 200, toPublicState(await getData()));
    }

    if (url.pathname === '/api/events' && request.method === 'GET') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      adminClients.add(response);
      response.write('event: state\ndata: ' + JSON.stringify(await getData()) + '\n\n');
      request.on('close', () => adminClients.delete(response));
      return;
    }

    if (url.pathname === '/api/public-events' && request.method === 'GET') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      publicClients.add(response);
      response.write('event: state\ndata: ' + JSON.stringify(toPublicState(await getData())) + '\n\n');
      request.on('close', () => publicClients.delete(response));
      return;
    }

    if (url.pathname === '/api/draw' && request.method === 'POST') {
      return lock(async () => {
        const data = await getData();
        const prize = pickPrize(data.items);
        if (!prize) {
          return output(response, 409, { error: '모든 상품의 수량이 소진되었습니다.' });
        }

        prize.remaining--;
        const result = {
          id: crypto.randomUUID(),
          itemId: prize.id,
          itemName: prize.name,
          drawnAt: new Date().toISOString(),
          revealed: false,
          revealAt: new Date(Date.now() + revealTimeoutMs).toISOString()
        };
        data.draws.unshift(result);
        data.draws = data.draws.slice(0, 1000);
        await saveData(data);
        scheduleReveal(result);
        return output(response, 200, { result, state: data });
      });
    }

    if (url.pathname === '/api/reveal' && request.method === 'POST') {
      const payload = await readBody(request);
      if (!payload.drawId) return output(response, 400, { error: '추첨 ID가 필요합니다.' });
      const state = await revealDraw(String(payload.drawId));
      if (!state) return output(response, 404, { error: '추첨 기록을 찾을 수 없습니다.' });
      return output(response, 200, { state });
    }

    if (url.pathname === '/api/items' && request.method === 'PUT') {
      return lock(async () => {
        const payload = await readBody(request);
        if (
          !Array.isArray(payload.items) ||
          payload.items.some(item =>
            !item.id ||
            !item.name ||
            !Number.isInteger(item.remaining) ||
            item.remaining < 0
          )
        ) {
          return output(response, 400, { error: '항목 이름과 수량을 확인해 주세요.' });
        }

        const data = await getData();
        data.items = payload.items.map(item => ({
          id: String(item.id),
          name: String(item.name).trim(),
          remaining: item.remaining
        }));
        await saveData(data, { publicUpdate: true });
        return output(response, 200, data);
      });
    }

    const relative = url.pathname === '/' ? '/index.html' : url.pathname;
    const path = join(pub, relative);
    if (!path.startsWith(pub) || !existsSync(path)) {
      return output(response, 404, 'Not found', 'text/plain');
    }

    return output(
      response,
      200,
      await readFile(path),
      mime[extname(path)] || 'application/octet-stream'
    );
  } catch (error) {
    console.error(error);
    return output(response, 500, { error: '서버 오류가 발생했습니다.' });
  }
});

server.listen(port, '0.0.0.0', async () => {
  console.log('Roulette running on http://localhost:' + port);
  const data = await getData();
  data.draws.filter(draw => draw.revealed === false).forEach(scheduleReveal);
});