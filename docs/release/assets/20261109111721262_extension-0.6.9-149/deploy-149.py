from pathlib import Path
import hashlib
import json
import re
import subprocess
import sys
import time
import urllib.request
import zipfile

ROOT = Path('/Users/linus/Documents/code/qinglong/ql/data/scripts/bdc')
DOCKER = '/usr/local/bin/docker'
EXPECTED = json.loads(Path(__file__).with_name('expected-runtime.json').read_text())
TARGET = sys.argv[1]
assert re.fullmatch('[0-9a-f]{40}', TARGET)


def run(arguments):
    result = subprocess.run(arguments, cwd=ROOT, text=True, capture_output=True, timeout=90)
    if result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    return result.stdout + result.stderr


def digest(name):
    return hashlib.sha256((ROOT / name).read_bytes()).hexdigest()


assert run(['git', 'branch', '--show-current']).strip() == 'master'
assert not run(['git', 'status', '--porcelain']).strip()
before = run(['git', 'rev-parse', 'HEAD']).strip()
assert digest('ai-config.js') == EXPECTED['privateConfigSha256']
run(['git', 'fetch', 'origin', 'master'])
assert run(['git', 'rev-parse', 'FETCH_HEAD']).strip() == TARGET
run(['git', 'merge-base', '--is-ancestor', before, TARGET])
run(['git', 'merge', '--ff-only', '--quiet', TARGET])
assert run(['git', 'rev-parse', 'HEAD']).strip() == TARGET
for name, sha in EXPECTED['files'].items():
    assert digest(name) == sha, name

# The host has no Node runtime. Only ignored generated dependencies come from
# the public-config archive; all tracked entries must already match Git.
archive = ROOT / EXPECTED['archive']
assert hashlib.sha256(archive.read_bytes()).hexdigest() == EXPECTED['archiveSha256']
tracked = set(run(['git', 'ls-files', '-z', '--', 'extension']).split('\0'))
generated = 0
with zipfile.ZipFile(archive) as zipped:
    assert zipped.testzip() is None
    assert set(zipped.namelist()) == set(EXPECTED['extensionFiles'])
    for name in zipped.namelist():
        assert name.startswith('extension/') and '..' not in Path(name).parts
        data = zipped.read(name)
        assert hashlib.sha256(data).hexdigest() == EXPECTED['extensionFiles'][name], name
        destination = ROOT / name
        assert not destination.is_symlink(), name
        if name in tracked:
            assert destination.read_bytes() == data, name
        else:
            assert name == 'extension/ai-config.js' or name.startswith((
                'extension/modules/', 'extension/locales/', 'extension/shared/', 'extension/_locales/'
            ))
            assert run(['git', 'check-ignore', '--', name]).strip() == name, name
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = destination.with_name(destination.name + '.tmp-' + TARGET[:12])
            temporary.write_bytes(data)
            temporary.replace(destination)
            generated += 1
    for name, sha in EXPECTED['extensionFiles'].items():
        assert digest(name) == sha, name
assert (ROOT / 'extension/ai-config.js').read_bytes() == (ROOT / 'ai-config.example.js').read_bytes()
assert json.loads((ROOT / 'extension/manifest.json').read_text())['version'] == EXPECTED['extensionVersion']
assert digest('ai-config.js') == EXPECTED['privateConfigSha256']

restart = run([DOCKER, 'compose', 'restart', 'bdc'])
nginx = run([DOCKER, 'exec', 'bdc', 'nginx', '-t'])
for attempt in range(45):
    state = json.loads(run([DOCKER, 'inspect', '--format', '{{json .State}}', 'bdc']))
    if state.get('Health', {}).get('Status') == 'healthy':
        break
    time.sleep(1)
assert state['Running'] and state.get('Health', {}).get('Status') == 'healthy'

paths = ['/srv/bdc/' + name for name in EXPECTED['files']]
runtime = {}
for line in run([DOCKER, 'exec', 'bdc', 'sha256sum', *paths]).splitlines():
    sha, name = line.split(maxsplit=1)
    runtime[name.removeprefix('/srv/bdc/')] = sha
verified = {}
for name, sha in EXPECTED['files'].items():
    assert digest(name) == runtime[name] == sha, name
    verified[name] = {'sha256': sha, 'ok': True}
private_runtime = run([DOCKER, 'exec', 'bdc', 'sha256sum', '/srv/bdc/ai-config.js']).split()[0]
assert private_runtime == digest('ai-config.js') == EXPECTED['privateConfigSha256']
assert not run(['git', 'status', '--porcelain']).strip()
with urllib.request.urlopen('http://127.0.0.1:8001/', timeout=15) as response:
    body, status = response.read(), response.status
assert status == 200 and hashlib.sha256(body).hexdigest() == EXPECTED['files']['index.html']
print(json.dumps({
    'before': before, 'head': TARGET, 'release': EXPECTED['release'],
    'extensionVersion': EXPECTED['extensionVersion'],
    'extensionFilesVerified': len(EXPECTED['extensionFiles']),
    'generatedDependenciesInstalled': generated, 'containerRunning': state['Running'],
    'containerHealth': state['Health']['Status'], 'startedAt': state['StartedAt'],
    'nginx': nginx, 'restart': restart, 'httpStatus': status,
    'privateConfigPreserved': True, 'runtimeFiles': verified, 'worktreeClean': True
}, ensure_ascii=False))
