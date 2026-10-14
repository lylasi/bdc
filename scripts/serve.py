#!/usr/bin/env python3
"""本機開發伺服器（靜態檔 + 同源代理）。

    python3 scripts/serve.py                      # 只綁 127.0.0.1
    python3 scripts/serve.py --lan                # 綁 0.0.0.0，手機／平板可用
    python3 scripts/serve.py --ai-proxy http://127.0.0.1:3425

為什麼需要它（而不是 `npx serve .`）：

1. **AI 同源代理**：`--ai-proxy` 會把 `/v1/*` 轉給指定的 AI 網關。瀏覽器只跟自己的來源
   打交道，因此不會遇到網關「不發 CORS 標頭／只允許白名單網頁來源」的問題；
   `ai-config.js` 把 provider 寫成相對路徑 `/v1/chat/completions` 就能桌機與手機共用。
2. **文章抓取**：`/fetch?url=` 回原始 HTML、`/extract?url=` 回 `{title, markdown, ...}`。
   瀏覽器直接抓新聞網站會被 CORS 擋，第三方代理又不一定開放目標主機，
   這兩條路由由伺服器端代抓，並已做 SSRF 防護（只允許 http/https、拒私網／loopback／
   link-local／保留位址、逐次轉址重檢、限大小與逾時）。
3. **停用快取**：改完檔案重新整理一定拿到新版。

不想開第 2 項就用 `--no-article-fetch`。
"""
import argparse
from functools import partial
from html.parser import HTMLParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from ipaddress import ip_address, ip_network
from pathlib import Path
import json
import re
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent.parent

# 本機代理常見的 fake-IP 網段（見 _addr_is_blocked 的說明）
_FAKEIP_NET = ip_network('198.18.0.0/15')

ARTICLE_MAX_BYTES = 2_000_000      # 抓取上限（原始 HTML）
ARTICLE_MAX_RETURN = 400_000       # 回給前端的 HTML 上限
ARTICLE_TIMEOUT = 20
ARTICLE_MAX_REDIRECTS = 5
ARTICLE_UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/124.0 Safari/537.36')

# HTML 白名單：只留正文可能用到的標籤與屬性，其餘連內容一起丟掉
KEEP_TAGS = {
    'article', 'main', 'section', 'div', 'p', 'br', 'hr',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'blockquote', 'pre', 'code', 'cite', 'q', 'time', 'sup', 'sub',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
    'figure', 'figcaption', 'img', 'a', 'strong', 'em', 'b', 'i', 'span',
}
DROP_TAGS = {
    'script', 'style', 'noscript', 'svg', 'iframe', 'template', 'form',
    'button', 'select', 'option', 'textarea', 'input', 'video', 'audio',
    'canvas', 'nav', 'footer', 'header', 'aside', 'menu', 'dialog', 'map',
}
KEEP_ATTRS = {'href', 'src', 'alt', 'title', 'datetime', 'colspan', 'rowspan', 'srcset'}


class _ArticleExtractor(HTMLParser):
    """把 HTML 依白名單重建成乾淨的正文片段（丟掉 script/style/導覽等）。"""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.drop_depth = 0
        self.drop_tag = None
        self.void = {'br', 'hr', 'img', 'input', 'meta', 'link', 'source'}

    def handle_starttag(self, tag, attrs):
        if self.drop_depth:
            if tag == self.drop_tag:
                self.drop_depth += 1
            return
        if tag in DROP_TAGS:
            self.drop_depth = 1
            self.drop_tag = tag
            return
        if tag not in KEEP_TAGS:
            return
        kept = ' '.join(
            f'{name}="{value}"' for name, value in attrs
            if name in KEEP_ATTRS and value is not None
        )
        self.parts.append(f'<{tag}{(" " + kept) if kept else ""}>')

    def handle_endtag(self, tag):
        if self.drop_depth:
            if tag == self.drop_tag:
                self.drop_depth -= 1
                if self.drop_depth == 0:
                    self.drop_tag = None
            return
        if tag in KEEP_TAGS and tag not in self.void:
            self.parts.append(f'</{tag}>')

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)

    def handle_data(self, data):
        if self.drop_depth:
            return
        self.parts.append(data)

    def result(self):
        return ''.join(self.parts)


# 轉 Markdown 時需要換行的區塊標籤，以及要吃掉但不留痕跡的行內標籤
MD_BLOCK_TAGS = {
    'article', 'main', 'section', 'div', 'p', 'figure', 'figcaption',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'hr',
}
MD_INLINE_TAGS = {'span', 'time', 'cite', 'q', 'sup', 'sub', 'dl', 'dt', 'dd'}


class _HtmlToMarkdown(HTMLParser):
    """把正文 HTML 轉成 Markdown。

    放在伺服器端做的理由：把 10KB 原始 HTML 丟給模型再要它輸出整篇 Markdown，
    既慢又容易撞到輸出上限（實測會回傳空字串）。標籤白名單在這裡已經先過一遍，
    再機械式轉換反而又快又穩；AI 清洗留給使用者自己勾選的那一步。
    """

    def __init__(self, base_url=''):
        super().__init__(convert_charrefs=True)
        self.base = base_url or ''
        self.parts = []
        self.drop_depth = 0
        self.drop_tag = None
        self.list_stack = []
        self.ol_counters = []
        self.href_stack = []
        self.pre_depth = 0
        self.quote_depth = 0
        self.table_rows = []
        self.table_row = []
        self.in_cell = False
        self.cell_parts = []

    # --- 工具 ---
    def _emit(self, text):
        self.parts.append(text)

    def _block_break(self):
        if not self.parts:
            return
        if self.href_stack:
            # <a> 裡面可能包著整塊標題；此時換行會把 [標題] 與 (網址) 拆到兩段
            return
        tail = ''.join(self.parts[-2:])
        if self.quote_depth:
            # 引用區內換行只接一個 "> "，且不重複標記
            if tail.endswith('\n') or tail.endswith('> '):
                return
            self.parts.append('\n> ')
            return
        if tail.endswith('\n\n'):
            return
        self.parts.append('\n\n')

    def _absolute(self, url):
        if not url:
            return ''
        try:
            return urllib.parse.urljoin(self.base, url)
        except ValueError:
            return url

    # --- HTMLParser ---
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if self.drop_depth:
            if tag == self.drop_tag:
                self.drop_depth += 1
            return
        if tag in DROP_TAGS:
            self.drop_depth = 1
            self.drop_tag = tag
            return
        if self.pre_depth and tag != 'code':
            return
        if tag in ('script', 'style'):
            return
        if tag == 'br':
            self._emit('\n')
            return
        if tag == 'hr':
            self._block_break()
            self._emit('---')
            self._block_break()
            return
        if tag in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
            self._block_break()
            self._emit('#' * int(tag[1]) + ' ')
            return
        if tag in ('ul', 'ol'):
            self._block_break()
            self.list_stack.append(tag)
            self.ol_counters.append(0)
            return
        if tag == 'li':
            self._block_break()
            depth = max(0, len(self.list_stack) - 1)
            if self.list_stack and self.list_stack[-1] == 'ol':
                self.ol_counters[-1] += 1
                marker = f'{self.ol_counters[-1]}. '
            else:
                marker = '- '
            self._emit('  ' * depth + marker)
            return
        if tag == 'blockquote':
            self._block_break()
            self.quote_depth += 1
            self._emit('> ')
            return
        if tag == 'pre':
            self._block_break()
            self._emit('```\n')
            self.pre_depth += 1
            return
        if tag == 'table':
            self._block_break()
            self.table_rows = []
            return
        if tag == 'tr':
            self.table_row = []
            return
        if tag in ('td', 'th'):
            self.in_cell = True
            self.cell_parts = []
            return
        if tag == 'img':
            src = self._absolute(attrs.get('src') or attrs.get('data-src') or '')
            alt = (attrs.get('alt') or '').strip()
            if src:
                self._emit(f'![{alt}]({src})')
            return
        if tag in ('p', 'div', 'section', 'article', 'figure', 'figcaption'):
            self._block_break()
            return
        if tag == 'a':
            self.href_stack.append(self._absolute(attrs.get('href') or ''))
            self._emit('[')
            return
        if tag in ('strong', 'b'):
            self._emit('**')
            return
        if tag in ('em', 'i'):
            self._emit('*')
            return
        if tag == 'code':
            self._emit('`' if not self.pre_depth else '')
            return

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if self.drop_depth:
            if tag == self.drop_tag:
                self.drop_depth -= 1
                if self.drop_depth == 0:
                    self.drop_tag = None
            return
        if self.pre_depth:
            if tag == 'pre':
                self.pre_depth -= 1
                self._emit('\n```')
                self._block_break()
            return
        if tag in ('ul', 'ol'):
            self.list_stack.pop() if self.list_stack else None
            self.ol_counters.pop() if self.ol_counters else None
            self._block_break()
            return
        if tag == 'blockquote':
            if self.parts and self.parts[-1] == '\n> ':
                self.parts.pop()   # 收掉結尾多出來的續行標記
            self.quote_depth = max(0, self.quote_depth - 1)
            self._block_break()
            return
        if tag in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li',
                   'p', 'div', 'section', 'article', 'figure', 'figcaption'):
            self._block_break()
            return
        if tag == 'a':
            href = self.href_stack.pop() if self.href_stack else ''
            self._emit(f']({href})' if href else ']')
            return
        if tag in ('strong', 'b'):
            self._emit('**')
            return
        if tag in ('em', 'i'):
            self._emit('*')
            return
        if tag == 'code':
            self._emit('`' if not self.pre_depth else '')
            return
        if tag in ('td', 'th'):
            if self.in_cell:
                self.table_row.append(re.sub(r'\s+', ' ', ''.join(self.cell_parts)).strip())
            self.in_cell = False
            return
        if tag == 'tr':
            if self.table_row:
                self.table_rows.append(self.table_row)
            self.table_row = []
            return
        if tag == 'table':
            self._flush_table()
            return

    def handle_data(self, data):
        if self.drop_depth:
            return
        if self.in_cell:
            self.cell_parts.append(data)
            return
        if self.pre_depth:
            self._emit(data)
            return
        self._emit(re.sub(r'\s+', ' ', data))

    def _flush_table(self):
        rows = [r for r in self.table_rows if any(c for c in r)]
        self.table_rows = []
        if not rows:
            return
        width = max(len(r) for r in rows)
        rows = [r + [''] * (width - len(r)) for r in rows]
        header = rows[0]
        self._emit('| ' + ' | '.join(header) + ' |\n')
        self._emit('| ' + ' | '.join(['---'] * width) + ' |\n')
        for row in rows[1:]:
            self._emit('| ' + ' | '.join(row) + ' |\n')
        self._block_break()

    def result(self):
        md = ''.join(self.parts)
        md = re.sub(r'(?<=\S)[ \t\u00a0]+', ' ', md)   # 壓縮行內空白，但保留行首縮排
        md = re.sub(r'[ \t]+\n', '\n', md)   # 只收行尾空白，清單縮排要留著
        md = re.sub(r'\n{3,}', '\n\n', md)
        return md.strip()



def _addr_is_blocked(addr):
    """判斷解析出來的位址是否為不該連的內網位址。

    例外：198.18.0.0/15 是 Surge／Clash 這類本機代理常見的 fake-IP 網段——
    本機 DNS 會把「所有」網域都解析到這裡，實際連線走的是代理而不是私網主機。
    若在這裡擋掉，等於整個抓取功能都用不了，所以只放行這一段。
    """
    try:
        ip = ip_address(addr)
    except ValueError:
        return True
    if ip.version == 4 and ip in _FAKEIP_NET:
        return False
    return (ip.is_private or ip.is_loopback or ip.is_link_local
            or ip.is_reserved or ip.is_multicast or ip.is_unspecified)


def _host_is_public(host):
    """解析主機名並確認所有位址都是公網（擋 SSRF）。"""
    if not host or host.lower() in ('localhost', 'localhost.localdomain'):
        return False
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False
    if not infos:
        return False
    return not any(_addr_is_blocked(info[4][0]) for info in infos)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def _open_with_retry(request, attempts=3):
    """本機代理偶爾會 SSL handshake timeout；這類暫時性錯誤重試通常就好了。"""
    last_err = None
    for attempt in range(attempts):
        try:
            return _opener.open(request, timeout=ARTICLE_TIMEOUT)
        except urllib.error.HTTPError:
            raise
        except Exception as err:  # noqa: BLE001 - 網路層錯誤重試
            last_err = err
            if attempt + 1 >= attempts:
                raise
            time.sleep(0.4 * (attempt + 1))
    raise last_err


def fetch_article_html(target):
    """抓取目標網址的 HTML；逐次轉址都重新做公網檢查。回傳 (final_url, text)。"""
    url = target
    for _ in range(ARTICLE_MAX_REDIRECTS + 1):
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in ('http', 'https'):
            raise ValueError('只支援 http/https')
        if not _host_is_public(parsed.hostname):
            raise PermissionError(f'拒絕存取非公網主機：{parsed.hostname or url}')
        request = urllib.request.Request(url, headers={
            'User-Agent': ARTICLE_UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en,zh-TW;q=0.8,zh;q=0.7',
        })
        try:
            response = _open_with_retry(request)
            try:
                raw = response.read(ARTICLE_MAX_BYTES + 1)
                charset = response.headers.get_content_charset() or 'utf-8'
                final_url = response.geturl()
            finally:
                response.close()
        except urllib.error.HTTPError as err:
            if err.code in (301, 302, 303, 307, 308):
                location = err.headers.get('Location')
                if not location:
                    raise
                url = urllib.parse.urljoin(url, location)
                continue
            raise
        if len(raw) > ARTICLE_MAX_BYTES:
            raw = raw[:ARTICLE_MAX_BYTES]
        return final_url, raw.decode(charset, errors='replace')
    raise ValueError('轉址次數過多')


def _pick_container(html):
    """優先取 <article>，其次 <main>，再退到 <body>；都沒有就用整份文件。"""
    for tag in ('article', 'main'):
        match = re.search(rf'<{tag}\b[^>]*>(.*?)</{tag}>', html, re.IGNORECASE | re.DOTALL)
        if match and len(match.group(1)) > 500:
            return match.group(1)
    match = re.search(r'<body\b[^>]*>(.*?)</body>', html, re.IGNORECASE | re.DOTALL)
    return match.group(1) if match else html


def extract_article_payload(html, source_url):
    """回傳 { title, markdown, contentHtml, sourceUrl }。

    markdown 是伺服器端直接轉好的正文，前端會優先用它（不必再叫一次 AI）；
    contentHtml 保留給需要 AI 重新整理的流程。
    """
    title_match = re.search(r'<title\b[^>]*>(.*?)</title>', html, re.IGNORECASE | re.DOTALL)
    title = re.sub(r'\s+', ' ', title_match.group(1)).strip() if title_match else ''
    h1_match = re.search(r'<h1\b[^>]*>(.*?)</h1>', html, re.IGNORECASE | re.DOTALL)
    if h1_match:
        heading = re.sub(r'<[^>]+>', '', h1_match.group(1))
        heading = re.sub(r'\s+', ' ', heading).strip()
        if heading:
            title = heading

    container = _pick_container(html)
    converter = _HtmlToMarkdown(source_url)
    converter.feed(container)
    converter.close()
    markdown = converter.result()
    if len(markdown) > ARTICLE_MAX_RETURN:
        markdown = markdown[:ARTICLE_MAX_RETURN]

    parser = _ArticleExtractor()
    parser.feed(container)
    parser.close()
    content = re.sub(r'\n{3,}', '\n\n', parser.result()).strip()
    if len(content) > ARTICLE_MAX_RETURN:
        content = content[:ARTICLE_MAX_RETURN]

    return {'title': title, 'markdown': markdown, 'contentHtml': content, 'sourceUrl': source_url}

class ServeHandler(SimpleHTTPRequestHandler):
    """靜態檔 + /v1 代理 + /fetch、/extract 文章抓取；一律停用快取。"""

    ai_proxy = None
    article_fetch = True

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def _send_payload(self, payload, status=200, ctype='application/json; charset=utf-8'):
        if isinstance(payload, str):
            payload = payload.encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _proxy(self, method):
        length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(length) if length else None
        request = urllib.request.Request(self.ai_proxy + self.path, data=body, method=method)
        # 只轉送需要的標頭；不轉送 Origin，讓網關把它當成一般用戶端
        for header in ('Content-Type', 'Authorization', 'Accept'):
            value = self.headers.get(header)
            if value:
                request.add_header(header, value)
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                payload, status = response.read(), response.status
                ctype = response.headers.get('Content-Type', 'application/json')
        except urllib.error.HTTPError as err:
            payload, status = err.read(), err.code
            ctype = err.headers.get('Content-Type', 'application/json')
        except Exception as err:  # noqa: BLE001 - 本機開發用，直接把原因吐回去
            payload = ('{"error":{"message":"proxy failed: %s"}}' % err).encode()
            status, ctype = 502, 'application/json'
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _article_route(self):
        """處理 /fetch 與 /extract；非這兩條路由回傳 False。"""
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path not in ('/fetch', '/extract'):
            return False
        if not self.article_fetch:
            self._send_payload(json.dumps({'error': '此伺服器已停用文章抓取（--no-article-fetch）'}), 403)
            return True
        params = urllib.parse.parse_qs(parsed.query)
        target = (params.get('url') or [''])[0].strip()
        if not target:
            self._send_payload(json.dumps({'error': 'missing url'}), 400)
            return True
        try:
            final_url, html = fetch_article_html(target)
        except PermissionError as err:
            self._send_payload(json.dumps({'error': str(err), 'status': 403}), 403)
            return True
        except urllib.error.HTTPError as err:
            self._send_payload(json.dumps({'error': '目標站點回應 %s' % err.code, 'status': err.code}), 502)
            return True
        except Exception as err:  # noqa: BLE001
            self._send_payload(json.dumps({'error': '抓取失敗：%s' % err, 'status': 502}), 502)
            return True
        if parsed.path == '/fetch':
            self._send_payload(html, 200, 'text/html; charset=utf-8')
        else:
            self._send_payload(json.dumps(extract_article_payload(html, final_url), ensure_ascii=False))
        return True

    def do_POST(self):  # noqa: N802
        if self.ai_proxy and self.path.startswith('/v1/'):
            return self._proxy('POST')
        self.send_error(404)

    def do_GET(self):  # noqa: N802
        if self._article_route():
            return
        if self.ai_proxy and self.path.startswith('/v1/'):
            return self._proxy('GET')
        return super().do_GET()


def lan_address():
    """取得本機在區域網的 IPv4（不會真的送出封包）。"""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(('10.255.255.255', 1))
            return probe.getsockname()[0]
    except OSError:
        return None


def main():
    parser = argparse.ArgumentParser(description='BDC 本機開發伺服器')
    parser.add_argument('--port', type=int, default=8313, help='連接埠（預設 8313）')
    parser.add_argument('--lan', action='store_true', help='綁定 0.0.0.0，區域網內其他裝置也能開啟')
    parser.add_argument('--ai-proxy', metavar='URL', default=None,
                        help='把 /v1/* 代理到 AI 網關，例如 http://127.0.0.1:3425')
    parser.add_argument('--no-article-fetch', action='store_true',
                        help='關閉同源文章抓取路由（/fetch、/extract）')
    args = parser.parse_args()

    ServeHandler.ai_proxy = args.ai_proxy.rstrip('/') if args.ai_proxy else None
    ServeHandler.article_fetch = not args.no_article_fetch
    host = '0.0.0.0' if args.lan else '127.0.0.1'
    shown = (lan_address() or '<本機區域網 IP>') if args.lan else '127.0.0.1'
    handler = partial(ServeHandler, directory=str(ROOT))
    server = ThreadingHTTPServer((host, args.port), handler)
    extra = []
    if ServeHandler.ai_proxy:
        extra.append('AI 走同源 /v1 代理')
    if ServeHandler.article_fetch:
        extra.append('文章抓取 /fetch、/extract')
    suffix = ('  （%s）' % '；'.join(extra)) if extra else ''
    print('http://%s:%d/%s' % (shown, args.port, suffix), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == '__main__':
    main()
