EXPECTED = {'release': '51bb93579a8c', 'base': 'd259c2d4963cd1487bee641127bdcbfc7f52cba6', 'files': {'index.html': '5909deed5471fccfb14518a1f796eb0d6583547fc20421279e97aa4cce3da76d', 'styles.css': '21a22fec3c82960b84dc9e7b9b7327ca4b3040af4e193553a58246203f4f596a', 'features/article/article.js': '2715093ba72dd375c735c5d93c30bd6c02b53d7f928008f3a24760a2141b54d1', 'features/article/sentence-actions.js': '9a81a52bc61b771da2f6faf286f8fbdae1077b049f9541fb29c2ff0c33dc695a', 'modules/dom.js': '095bc451161704ac6cb75e6e0b410a932d35edba15387f8d1fc78a50cf75b025', 'locales/zh-CN.js': '7d1be0530950d8f8977267fc2fa305d374668c7836562dc3de483e6ed4959d14', 'locales/zh-HK.js': '6a0f3a8ecbb302fa880f53a9f9819a95d4f9589df63e9165b19c99cf00c5dd65'}, 'config': '6961935c69385e837692203fb0eba506a04b7d7b99680ef0e2dd5d09870aec93'}
from pathlib import Path
import hashlib, json, re, subprocess, sys, time, urllib.request

p = Path('/Users/linus/Documents/code/qinglong/ql/data/scripts/bdc')
docker = '/usr/local/bin/docker'
target = sys.argv[1]
assert re.fullmatch('[0-9a-f]{40}', target)

def run(args):
    result = subprocess.run(args, cwd=p, text=True, capture_output=True, timeout=90)
    if result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    return result.stdout + result.stderr

def digest(file):
    return hashlib.sha256((p / file).read_bytes()).hexdigest()

before = run(['git', 'rev-parse', 'HEAD']).strip()
assert run(['git', 'branch', '--show-current']).strip() == 'master'
assert not run(['git', 'status', '--porcelain']).strip()
assert before == EXPECTED['base'], before
assert digest('ai-config.js') == EXPECTED['config']
run(['git', 'fetch', 'origin', 'master'])
assert run(['git', 'rev-parse', 'FETCH_HEAD']).strip() == target
update = run(['git', 'merge', '--ff-only', target])
assert run(['git', 'rev-parse', 'HEAD']).strip() == target
for file, expected in EXPECTED['files'].items():
    assert digest(file) == expected, file
assert digest('ai-config.js') == EXPECTED['config']
restart = run([docker, 'compose', 'restart', 'bdc'])
nginx = run([docker, 'exec', 'bdc', 'nginx', '-t'])
for attempt in range(45):
    state = json.loads(run([docker, 'inspect', 'bdc']))[0]['State']
    if state.get('Health', {}).get('Status') == 'healthy':
        break
    time.sleep(1)
assert state['Running'] and state.get('Health', {}).get('Status') == 'healthy'
verified = {}
for file, expected in EXPECTED['files'].items():
    source = digest(file)
    runtime = run([docker, 'exec', 'bdc', 'sha256sum', '/srv/bdc/' + file]).split()[0]
    assert source == runtime == expected, file
    verified[file] = {'source': source, 'runtime': runtime, 'ok': True}
private_runtime = run([docker, 'exec', 'bdc', 'sha256sum', '/srv/bdc/ai-config.js']).split()[0]
assert private_runtime == digest('ai-config.js') == EXPECTED['config']
assert not run(['git', 'status', '--porcelain']).strip()
with urllib.request.urlopen('http://127.0.0.1:8001/', timeout=15) as response:
    body = response.read()
    http_status = response.status
assert http_status == 200
assert hashlib.sha256(body).hexdigest() == EXPECTED['files']['index.html']
print(json.dumps({'before': before, 'head': target, 'release': EXPECTED['release'],
    'update': update, 'restart': restart, 'nginx': nginx,
    'container_running': state['Running'], 'container_health': state.get('Health', {}).get('Status'),
    'started_at': state['StartedAt'], 'private_config_before': EXPECTED['config'],
    'private_config_after': digest('ai-config.js'), 'private_config_runtime': private_runtime,
    'http_status': http_status, 'files': verified}, ensure_ascii=False))
