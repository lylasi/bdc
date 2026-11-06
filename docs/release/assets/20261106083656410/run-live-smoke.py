"""Create one disposable non-admin D1 fixture, test it, and remove only that fixture."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
from datetime import datetime, timezone

state = json.loads(Path('/tmp/bdc-worker-extension-live-state.json').read_text())
assets = Path(state['assets'])
temporary = Path(state['temp'])
cli = ['node', '/Users/linus/.npm/_npx/32026684e21afda6/node_modules/wrangler/bin/wrangler.js']
token = secrets.token_urlsafe(32)
token_hash = hashlib.sha256(token.encode()).hexdigest()
user_id = 'ext_probe_' + state['stamp'] + '_' + secrets.token_hex(4)
fixture_path = temporary / 'fixture.json'

def quote(value):
    return "'" + str(value).replace("'", "''") + "'"

def execute(sql, label):
    sql_path = temporary / (label + '.sql')
    sql_path.write_text(sql)
    sql_path.chmod(0o600)
    result = subprocess.run(cli + ['d1', 'execute', 'bdc-sync', '--remote', '--command', sql, '--json'],
                            cwd=state['workerRoot'], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(label + ': Wrangler failed; credential-bearing output withheld')
    data = json.loads(result.stdout)
    if not all(row.get('success') for row in data):
        raise RuntimeError(label + ': D1 query failed')
    return data

owner = 'user_id=' + quote(user_id) + ' AND token_hash=' + quote(token_hash) + " AND role='user'"
children = ['user_ai_credentials', 'user_sessions', 'pairing_codes', 'articles', 'article_changes',
            'article_state', 'reading_entities', 'reading_changes', 'reading_mutations', 'reading_state', 'snapshots']
columns = json.loads((assets / 'fixture-table-columns.json').read_text())
owner_columns = {table: ('owner_user_id' if 'owner_user_id' in columns[table] else 'user_id') for table in children}
if not all(column in columns[table] for table, column in owner_columns.items()):
    raise RuntimeError('Unexpected production fixture schema')
temporary.mkdir(mode=0o700, parents=True, exist_ok=True)
fixture_path.write_text(json.dumps({
    'endpoint': 'https://bdc-sync-api.penzibdc.workers.dev',
    'extensionRoot': state['extensionRoot'],
    'token': token,
    'userId': user_id,
}))
fixture_path.chmod(0o600)
cleanup = '\n'.join('DELETE FROM ' + table + ' WHERE ' + owner_columns[table]
                    + ' IN (SELECT user_id FROM users WHERE ' + owner + ');' for table in children)
cleanup += '\nDELETE FROM users WHERE ' + owner + ';'
exit_code = 1
cleanup_ok = False
try:
    inserted = execute('INSERT INTO users (token_hash,user_id,label,role,created_at) VALUES ('
                       + ','.join(quote(value) for value in [token_hash, user_id, 'Extension live integration probe',
                                                           'user', datetime.now(timezone.utc).isoformat()]) + ');', 'create-fixture')
    present = execute('SELECT COUNT(*) AS present FROM users WHERE ' + owner + ';', 'verify-fixture')
    if sum(row['present'] for result in present for row in result.get('results', [])) != 1:
        raise RuntimeError('Fixture insert did not affect exactly one row')
    print('Created disposable non-admin test account (no existing account changed)', flush=True)
    env = os.environ.copy()
    env['PLAYWRIGHT_MODULE'] = '/Users/linus/.local/share/fnm/node-versions/v24.20.0/installation/lib/node_modules/@playwright/cli/node_modules/playwright'
    browser = subprocess.run(['node', str(assets / 'verify-live-extension.cjs'), str(fixture_path), str(assets)],
                             cwd=str(Path(state['extensionRoot']).parent), env=env, capture_output=True, text=True)
    browser_output = (browser.stdout + browser.stderr).replace(token, '[redacted]')
    (assets / 'live-extension.txt').write_text(browser_output)
    print(browser_output, flush=True)
    exit_code = browser.returncode
finally:
    evidence = {'userId': user_id, 'role': 'user', 'temporaryTokenLength': len(token),
                'cleanupOk': False, 'existingAccountModificationAttempted': False}
    try:
        execute(cleanup, 'cleanup-fixture')
        counters = [('users', 'user_id')] + list(owner_columns.items())
        verification_sql = 'SELECT ' + ','.join(
            '(SELECT COUNT(*) FROM ' + table + ' WHERE ' + column + '=' + quote(user_id) + ') AS ' + table
            for table, column in counters) + ';'
        verification = execute(verification_sql, 'verify-cleanup')
        remaining = {key: value for result in verification for row in result.get('results', []) for key, value in row.items()}
        cleanup_ok = len(remaining) == len(counters) and all(value == 0 for value in remaining.values())
        evidence.update({'remainingUsers': remaining.get('users'), 'remainingRows': remaining, 'cleanupOk': cleanup_ok})
    finally:
        fixture_path.unlink(missing_ok=True)
        evidence['tokenFileRemoved'] = not fixture_path.exists()
        (assets / 'fixture-cleanup.json').write_text(json.dumps(evidence, indent=2) + '\n')
        if cleanup_ok:
            for p in temporary.iterdir():
                if p.is_file():
                    p.unlink()
            temporary.rmdir()
        print('Disposable test account cleanup:', 'PASS' if cleanup_ok else 'FAIL', flush=True)
if not cleanup_ok:
    exit_code = 1
sys.exit(exit_code)
