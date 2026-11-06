from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import hashlib, json, urllib.request

root = Path(__file__).resolve().parent
expected = json.loads((root / 'expected-runtime.json').read_text())
release = expected['release']
files = expected.get('assets', expected['files'])
bases = ['http://10.10.10.149:8001', 'https://bdc.a4a4.qzz.io']

def verify(item):
    base, file = item
    url = base + '/' + ('' if file == 'index.html' else file + '?v=' + release)
    request = urllib.request.Request(url, headers={'Accept-Encoding': 'identity'})
    with urllib.request.urlopen(request, timeout=30) as response:
        content = response.read()
        digest = hashlib.sha256(content).hexdigest()
        return {'url': url, 'file': file, 'status': response.status, 'sha256': digest,
                'expected': files[file], 'ok': digest == files[file],
                'cache': response.headers.get('CF-Cache-Status', '')}

with ThreadPoolExecutor(max_workers=8) as pool:
    results = list(pool.map(verify, [(base, file) for base in bases for file in files]))
(root / 'online-runtime.json').write_text(json.dumps({'release': release, 'checks': results}, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'release': release, 'passed': sum(r['ok'] for r in results), 'total': len(results)}, ensure_ascii=False))
assert all(r['ok'] for r in results), [r for r in results if not r['ok']]
