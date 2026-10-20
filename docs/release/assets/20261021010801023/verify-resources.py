"""Compare URLs selected by the deployed HTML to checked-out frontend sources."""
import concurrent.futures
import hashlib
import json
import re
import urllib.request
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse

ROOT = Path(__file__).resolve().parents[4]
ASSETS = Path(__file__).resolve().parent
prior = json.loads((ASSETS / 'production-resource-check.json').read_text())

class AssetsParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_map = False
        self.map_text = ''
        self.assets = []
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'script' and attrs.get('type') == 'importmap':
            self.in_map = True
        if tag == 'script' and attrs.get('type') == 'module' and attrs.get('src'):
            self.assets.append(attrs['src'])
        if tag == 'link' and attrs.get('rel') == 'stylesheet':
            self.assets.append(attrs['href'])
    def handle_endtag(self, tag):
        if tag == 'script':
            self.in_map = False
    def handle_data(self, data):
        if self.in_map:
            self.map_text += data

mappings = {}
for base in sorted(set(item['base'] for item in prior)):
    request = urllib.request.Request(base + '/', headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(request, timeout=30) as response:
        parser = AssetsParser()
        parser.feed(response.read().decode())
    urls = list(json.loads(parser.map_text or '{}').get('imports', {}).values()) + parser.assets
    mappings[base] = {urlparse(urljoin(base + '/', value)).path.lstrip('/'): urljoin(base + '/', value) for value in urls}

def verify(item):
    base, file = item['base'], item['path']
    url = mappings[base].get(file, base + '/' + file)
    request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(request, timeout=30) as response:
        digest = hashlib.sha256(response.read()).hexdigest()
        expected = hashlib.sha256((ROOT / file).read_bytes()).hexdigest()
        return {'base': base, 'path': file, 'url': url, 'status': response.status, 'sha256': digest, 'expected': expected, 'matches': digest == expected, 'cache': response.headers.get('CF-Cache-Status', '')}

with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
    results = list(pool.map(verify, prior))
(ASSETS / 'final-resource-check.json').write_text(json.dumps(results, indent=2) + '\n')
print(json.dumps({'checks': len(results), 'passed': sum(r['matches'] for r in results)}))
raise SystemExit(0 if all(r['matches'] for r in results) else 1)
