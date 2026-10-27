"""Check deployed public assets against a committed tree; log config hash only."""
import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--base', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--ref', default='afa9696aad5a0a31d54aae26e16e135d38eadf98')
args = parser.parse_args()
root = Path(__file__).resolve().parents[4]
base = args.base.rstrip('/')


def source(name):
    return subprocess.check_output(['git', 'show', f'{args.ref}:{name}'], cwd=root)


html = source('index.html')
imports = json.loads(re.search(rb'<script type="importmap">([\s\S]*?)</script>', html)[1])['imports']
release = urllib.parse.parse_qs(urllib.parse.urlparse(next(iter(imports.values()))).query)['v'][0]
expected = {'/': html, f'/styles.css?v={release}': source('styles.css')}
for name, url in imports.items():
    expected[url] = source(name.lstrip('/'))


def request(url):
    try:
        response = urllib.request.urlopen(base + url, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, response.headers, response.read()


def check_asset(pair):
    url, wanted = pair
    try:
        status, headers, content = request(url)
        sha = hashlib.sha256(content).hexdigest()
        wanted_sha = hashlib.sha256(wanted).hexdigest()
        mime = headers.get('Content-Type', '')
        suffix = urllib.parse.urlparse(url).path
        good_mime = ('javascript' in mime) if suffix.endswith(('.js', '.mjs')) else (
            ('text/css' in mime) if suffix.endswith('.css') else 'text/html' in mime)
        return {'path': url, 'status': status, 'sha256': sha, 'expected': wanted_sha,
                'mime': mime, 'pass': status == 200 and sha == wanted_sha and good_mime}
    except Exception as error:
        return {'path': url, 'pass': False, 'error': str(error)}


with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
    assets = list(pool.map(check_asset, expected.items()))

blocked = []
for url in ['/.git/config', '/docs/', '/scripts/serve.py', '/tests/article-navigation.cjs',
            '/selfhost/package.json', '/cloudflare-worker/wrangler.toml',
            '/deploy/nginx.conf', '/ai-config.example.js', '/test-floating-statusbar.html',
            '/features/article/reading-view.js']:
    status, _, _ = request(url)
    blocked.append({'path': url, 'status': status, 'pass': status == 404})

status, headers, config = request('/ai-config.js')
config_sha = hashlib.sha256(config).hexdigest()
config_check = {'path': '/ai-config.js', 'status': status, 'sha256': config_sha,
                'cacheControl': headers.get('Cache-Control'),
                'pass': status == 200 and config_sha == '6961935c69385e837692203fb0eba506a04b7d7b99680ef0e2dd5d09870aec93'
                and 'no-store' in headers.get('Cache-Control', '')}
result = {'base': base, 'ref': args.ref, 'release': release, 'assets': assets,
          'blocked': blocked, 'privateConfig': config_check}
Path(args.output).write_text(json.dumps(result, indent=2) + '\n')
bad = [item for item in assets + blocked + [config_check] if not item['pass']]
if bad:
    print(json.dumps(bad, indent=2))
    raise SystemExit(1)
print(f'PASS {base}: {len(assets)} asset hashes/MIME, {len(blocked)} excluded paths, unchanged private config/no-store; release {release}')
