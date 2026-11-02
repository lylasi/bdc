"""靜態資源唯讀驗證；並行讀取，連線短暫逾時可重試，僅記錄狀態與雜湊。"""
import concurrent.futures
import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urljoin, urlsplit

root = Path(__file__).resolve().parents[4]
spec = importlib.util.spec_from_file_location('verify_static', root / 'deploy/verify-static.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assets = module.ReleaseAssets()
assets.feed((root / 'index.html').read_text())
paths = {path for path in assets.paths if not urlsplit(path).scheme and not urlsplit(path).netloc}
paths.update(['/', '/index.html', '/main.js', '/styles.css', '/ai-config.js',
              '/shared/article-protocol.mjs', '/shared/reading-protocol.mjs',
              '/wordlists/manifest.json', '/articles/manifest.json', '/qa-sets/manifest.json',
              '/phonetics.html', '/phonetic-chart/index.html', '/voices.json', '/voices.min.json',
              '/voices.fallback.json', '/5AU1_1.jpg', '/5AU1_2.jpg'])
denied = ['/.git/config', '/.env', '/docs/', '/scripts/', '/tests/', '/selfhost/',
          '/cloudflare-worker/', '/article-import-service/', '/node_modules/', '/deploy/',
          '/Dockerfile', '/docker-compose.yml', '/ai-config.example.js', '/README.md',
          '/main.js.map', '/test-floating-statusbar.html', '/modules/.git/config',
          '/features/docs/index.html', '/shared/missing.mjs', '/missing-route']
base = sys.argv[1].rstrip('/') + '/'
expected_config = '6961935c69385e837692203fb0eba506a04b7d7b99680ef0e2dd5d09870aec93'


def check(item):
    path, expected_status = item
    with tempfile.TemporaryDirectory(prefix='bdc-static-read-') as directory:
        body = Path(directory) / 'body'
        headers = Path(directory) / 'headers'
        response = subprocess.run(['curl', '--silent', '--show-error', '--path-as-is',
                                   '--connect-timeout', '5', '--max-time', '20', '--retry', '2',
                                   '--retry-delay', '1', '--retry-max-time', '50',
                                   '--output', str(body), '--dump-header', str(headers),
                                   '--write-out', '%{http_code}', urljoin(base, path)], capture_output=True, text=True)
        status = int(response.stdout or 0)
        result = {'path': path, 'status': status, 'expectedStatus': expected_status, 'exitCode': response.returncode}
        if body.exists():
            result['sha256'] = hashlib.sha256(body.read_bytes()).hexdigest()
        result['ok'] = response.returncode == 0 and status == expected_status
        if path == '/ai-config.js':
            result['ok'] = result['ok'] and result.get('sha256') == expected_config and 'cache-control: no-store' in headers.read_text().lower()
        if urlsplit(path).path.endswith('.mjs') and status == 200:
            result['ok'] = result['ok'] and 'content-type: application/javascript' in headers.read_text().lower()
        return result


with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
    results = list(executor.map(check, [(path, 200) for path in sorted(paths)] + [(path, 404) for path in denied]))
report = {'base': base, 'passed': sum(row['ok'] for row in results), 'total': len(results), 'checks': results}
output = Path(__file__).with_name('public-http.json' if base.startswith('https:') else 'lan-http.json')
output.write_text(json.dumps(report, indent=2) + '\n')
print(f"{report['passed']}/{report['total']} {base}")
for row in results:
    if not row['ok']:
        print(json.dumps(row))
sys.exit(0 if all(row['ok'] for row in results) else 1)
