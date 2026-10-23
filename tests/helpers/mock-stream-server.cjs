/**
 * 本機串流 mock 供應商（P0-T1 助手載具）。
 *
 * 只用 Node http 模組，綁 127.0.0.1 的隨機埠；不連外網、不需要金鑰。
 * 目的：Playwright 的 route.fulfill 無法「先送幾個 token 再斷線」，
 * 因此助手的中斷／停止／錯誤情境改用可控的本機 SSE 服務。
 *
 * 行為由 state.mode 控制：
 *   ok         逐段送出 state.chunks，最後送 [DONE]
 *   slow       每 state.chunkDelayMs 送一段（給「停止」與「向上捲動」情境）
 *   errorEvent 先送一段，再送 Gemini 風格的 error 事件
 *   interrupt  先送一段，然後直接 destroy socket（模擬網路中斷）
 *   http500    直接回 500
 */
const http = require('http');

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '600'
};

function createMockStreamServer() {
    const state = {
        mode: 'ok',
        chunks: ['第一段回答。'],
        chunkDelayMs: 120,
        requests: [],
        streamRequests: 0
    };

    const server = http.createServer((req, res) => {
        const url = String(req.url || '');
        if (req.method === 'OPTIONS') {
            res.writeHead(204, CORS);
            return res.end();
        }
        if (req.method === 'GET' && url.includes('/models')) {
            res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                models: [{ name: 'models/mock-model', displayName: 'Mock Model', supportedGenerationMethods: ['generateContent', 'streamGenerateContent'] }]
            }));
        }

        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
            let body = {};
            try { body = JSON.parse(raw || '{}'); } catch (_) { body = { raw }; }
            state.requests.push({ url, body });
            const isStream = url.includes('streamGenerateContent');
            if (isStream) state.streamRequests += 1;

            if (state.mode === 'http500') {
                res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: { message: 'mock provider failure' } }));
            }

            const chunkText = (text) => JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });

            if (!isStream) {
                res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                    candidates: [{ content: { parts: [{ text: state.chunks.join('') }] }, finishReason: 'STOP' }]
                }));
            }

            res.writeHead(200, {
                ...CORS,
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            });
            const send = (payload) => res.write(`data: ${payload}\n\n`);

            if (state.mode === 'errorEvent') {
                send(chunkText(state.chunks[0] || ''));
                send(JSON.stringify({ error: { message: 'mock stream broke' } }));
                return res.end();
            }
            if (state.mode === 'interrupt') {
                send(chunkText(state.chunks[0] || ''));
                return setTimeout(() => {
                    try { res.socket.destroy(); } catch (_) { /* already gone */ }
                }, 40);
            }
            if (state.mode === 'slow') {
                let index = 0;
                const timer = setInterval(() => {
                    if (index < state.chunks.length) {
                        send(chunkText(state.chunks[index]));
                        index += 1;
                        return;
                    }
                    clearInterval(timer);
                    send('[DONE]');
                    res.end();
                }, state.chunkDelayMs);
                // req 的 'close' 在 POST body 讀完就會觸發，不能用來判斷連線結束；
                // 改成監聽 response 的 close（客戶端中止時才停送）。
                res.on('close', () => clearInterval(timer));
                return undefined;
            }
            state.chunks.forEach((text) => send(chunkText(text)));
            send('[DONE]');
            return res.end();
        });
        return undefined;
    });

    return {
        state,
        listen: () => new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
        }),
        close: () => new Promise((resolve) => {
            server.close(() => resolve());
            // 串流完成後瀏覽器可能仍保留 keep-alive 連線；不主動關閉會讓 close 永遠等下去。
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        })
    };
}

module.exports = { createMockStreamServer };
