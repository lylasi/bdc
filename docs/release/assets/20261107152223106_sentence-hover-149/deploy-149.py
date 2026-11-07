EXPECTED = {'release': '1f2c52a9f361', 'base': 'd3b361392b07a6a35d46b0d2d0488b418f8c1838', 'files': {'index.html': '2b09bfdece55bb5e7a8a68b0432474694f9086c0c7d7a7a65f05ee95ee7cd391', 'styles.css': 'a6730bf270322b300a5811a5ebfca1250360a5fb330441ed59d4dc00b72a3d50', 'features/article/article.js': '6fcb58f710054c71440739f1f22ecdacac741b933732c92b61346a110bce8893', 'features/article/sentence-actions.js': '7e4f9042b835119b787c6a27618bdd0e4f873cbd296b597833f1e69903631130'}, 'config': '6961935c69385e837692203fb0eba506a04b7d7b99680ef0e2dd5d09870aec93'}
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
