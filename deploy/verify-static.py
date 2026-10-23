#!/usr/bin/env python3
"""以 curl 驗證靜態部署；只輸出狀態與雜湊，不輸出設定檔內容。"""

import argparse
import hashlib
import json
import re
import subprocess
import tempfile
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit


class ReleaseAssets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = set()
        self.importmap = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'script' and attrs.get('type') == 'importmap':
            self.importmap = ''
        candidate = attrs.get('src') if tag == 'script' else None
        if tag == 'link' and attrs.get('rel') == 'stylesheet':
            candidate = attrs.get('href')
        if candidate:
            self.paths.add(candidate)

    def handle_data(self, data):
        if self.importmap is not None:
            self.importmap += data

    def handle_endtag(self, tag):
        if tag == 'script' and self.importmap is not None:
            self.paths.update(json.loads(self.importmap).get('imports', {}).values())
            self.importmap = None


def verify(base_url, expected_sha):
    checks = 0
    with tempfile.TemporaryDirectory(prefix='bdc-http-check-') as scratch:
        body_path = Path(scratch) / 'body'
        header_path = Path(scratch) / 'headers'

        def request(path, expected_status):
            nonlocal checks
            result = subprocess.run([
                'curl', '--silent', '--show-error', '--path-as-is',
                '--connect-timeout', '5', '--max-time', '20',
                '--output', str(body_path), '--dump-header', str(header_path),
                '--write-out', '%{http_code}', urljoin(base_url, path),
            ], capture_output=True, text=True, check=True)
            status = int(result.stdout)
            if status != expected_status:
                raise RuntimeError(f'{path}: HTTP {status}，預期 {expected_status}')
            headers = {}
            for line in header_path.read_text().splitlines():
                if ':' in line:
                    key, value = line.split(':', 1)
                    headers[key.lower()] = value.strip()
            checks += 1
            return body_path.read_bytes(), headers

        index, _ = request('/', 200)
        for path in ['/index.html', '/main.js', '/styles.css']:
            _, headers = request(path, 200)
            mime = headers.get('content-type', '').split(';', 1)[0]
            if path.endswith('.js') and mime not in ['application/javascript', 'text/javascript']:
                raise RuntimeError(f'{path}: JavaScript MIME 不正確：{mime}')
            if path.endswith('.css') and mime != 'text/css':
                raise RuntimeError(f'{path}: CSS MIME 不正確：{mime}')

        config, headers = request('/ai-config.js', 200)
        config_sha = hashlib.sha256(config).hexdigest()
        if config_sha != expected_sha:
            raise RuntimeError(f'ai-config.js SHA256 不符：{config_sha}')
        if headers.get('cache-control') != 'no-store':
            raise RuntimeError('ai-config.js 缺少 Cache-Control: no-store')
        print(f'ai-config.js SHA256={config_sha}；Cache-Control=no-store')

        assets = ReleaseAssets()
        assets.feed(index.decode('utf-8'))
        paths = assets.paths | {
            '/shared/article-protocol.mjs', '/shared/reading-protocol.mjs',
            '/wordlists/manifest.json', '/articles/manifest.json', '/qa-sets/manifest.json',
            '/phonetics.html', '/phonetic-chart/index.html',
            '/voices.json', '/voices.min.json', '/voices.fallback.json',
            '/5AU1_1.jpg', '/5AU1_2.jpg',
        }
        local_paths = sorted(path for path in paths if not urlsplit(path).scheme and not urlsplit(path).netloc)
        for path in local_paths:
            _, headers = request(path, 200)
            if urlsplit(path).path.endswith('.mjs'):
                mime = headers.get('content-type', '').split(';', 1)[0]
                if mime != 'application/javascript':
                    raise RuntimeError(f'{path}: .mjs MIME 不正確：{mime}')
        print(f'發佈資源與執行期入口：{len(local_paths)} 個 URL 全部 200；.mjs MIME 正確')

        denied = [
            '/.git/config', '/.env', '/docs/', '/scripts/', '/tests/',
            '/selfhost/', '/cloudflare-worker/', '/article-import-service/',
            '/node_modules/', '/deploy/', '/Dockerfile', '/docker-compose.yml',
            '/ai-config.example.js', '/README.md', '/main.js.map',
            '/test-floating-statusbar.html', '/modules/.git/config',
            '/features/docs/index.html', '/shared/missing.mjs', '/missing-route',
        ]
        for path in denied:
            request(path, 404)
        print(f'敏感路徑與不存在資源：{len(denied)} 個 URL 全部 404')
    print(f'PASS {base_url}：{checks} 項 HTTP 檢查')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--config-sha256', required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'[0-9a-f]{64}', args.config_sha256):
        parser.error('--config-sha256 必須為小寫 SHA256')
    if urlsplit(args.base_url).scheme not in ['http', 'https']:
        parser.error('--base-url 必須為 HTTP 或 HTTPS 網址')
    try:
        verify(args.base_url.rstrip('/') + '/', args.config_sha256)
    except (RuntimeError, subprocess.CalledProcessError, ValueError) as error:
        parser.exit(1, f'FAIL：{error}\n')


if __name__ == '__main__':
    main()
