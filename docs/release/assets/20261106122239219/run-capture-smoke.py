"""Production smoke test with one disposable, non-admin account and guarded cleanup."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
from datetime import datetime, timezone

os.umask(0o077)
assets = Path(__file__).resolve().parent
root = assets.parents[3]
temporary = Path('/Users/linus/.local/share/bdc-private-backups/20261106122239219/smoke')
temporary.mkdir(mode=0o700, exist_ok=True)
cli = ['node', '/Users/linus/.npm/_npx/32026684e21afda6/node_modules/wrangler/bin/wrangler.js']
worker_root = Path('/Users/linus/CODE/bdc/cloudflare-worker')
token = secrets.token_urlsafe(32)
token_hash = hashlib.sha256(token.encode()).hexdigest()
user_id = 'ext_capture_probe_20261106122239219_' + secrets.token_hex(4)
fixture_path = temporary / 'fixture.json'


def quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def execute(sql, label):
    (temporary / (label + '.sql')).write_text(sql)
    result = subprocess.run(cli + ['d1', 'execute', 'bdc-sync', '--remote', '--command', sql, '--json'],
                            cwd=worker_root, capture_output=True, text=True)
    if result.returncode:
        (temporary / (label + '-private.txt')).write_text(result.stdout + result.stderr)
        raise RuntimeError(label + ': D1 execution failed; private output withheld')
    data = json.loads(result.stdout)
    if not all(row.get('success') for row in data):
        raise RuntimeError(label + ': D1 query unsuccessful')
    return data


owner = 'user_id=' + quote(user_id) + ' AND token_hash=' + quote(token_hash) + " AND role='user'"
children = {
    'vocabulary_captures': 'owner_user_id',
    'user_ai_credentials': 'user_id', 'user_sessions': 'user_id', 'pairing_codes': 'user_id',
    'snapshots': 'user_id', 'articles': 'owner_user_id', 'article_changes': 'owner_user_id',
    'article_state': 'owner_user_id', 'reading_entities': 'owner_user_id',
    'reading_changes': 'owner_user_id', 'reading_mutations': 'owner_user_id',
    'reading_state': 'owner_user_id',
}
fixture_path.write_text(json.dumps({
    'endpoint': 'https://bdc-sync-api.penzibdc.workers.dev',
    'website': 'http://10.10.10.149:8001',
    'publicWebsite': 'https://bdc.a4a4.qzz.io',
    'extensionRoot': str(root / 'extension'),
    'token': token, 'userId': user_id,
}))
cleanup = '\n'.join('DELETE FROM ' + table + ' WHERE ' + column
                    + ' IN (SELECT user_id FROM users WHERE ' + owner + ');'
                    for table, column in children.items())
cleanup += '\nDELETE FROM users WHERE ' + owner + ';'
(temporary / 'guarded-cleanup.sql').write_text(cleanup)
exit_code = 1
cleanup_ok = False
try:
    execute('INSERT INTO users (token_hash,user_id,label,role,created_at) VALUES ('
            + ','.join(quote(value) for value in [token_hash, user_id, 'BDC capture release probe',
                                                'user', datetime.now(timezone.utc).isoformat()]) + ');', 'create-fixture')
    rows = execute('SELECT COUNT(*) AS present FROM users WHERE ' + owner + ';', 'verify-fixture')
    assert sum(row['present'] for result in rows for row in result.get('results', [])) == 1
    print('Created isolated non-admin release fixture', flush=True)
    env = os.environ.copy()
    env['PLAYWRIGHT_MODULE'] = '/Users/linus/.local/share/fnm/node-versions/v24.20.0/installation/lib/node_modules/@playwright/cli/node_modules/playwright'
    browser = subprocess.run(['node', str(assets / 'verify-capture-live.cjs'), str(fixture_path)],
                             cwd=root, env=env, capture_output=True, text=True, timeout=360)
    output = (browser.stdout + browser.stderr).replace(token, '[redacted-token]')
    (assets / 'capture-smoke.txt').write_text(output)
    print(output, flush=True)
    exit_code = browser.returncode
finally:
    evidence = {'userId': user_id, 'role': 'user', 'cleanupOk': False,
                'existingUserDataModified': False}
    try:
        ledger = execute('SELECT COUNT(*) AS receipts FROM vocabulary_captures WHERE owner_user_id='
                         + quote(user_id) + ';', 'fixture-ledger-count')
        evidence['receiptsBeforeCleanup'] = ledger[0]['results'][0]['receipts']
        execute(cleanup, 'cleanup-fixture')
        counters = {'users': 'user_id', **children}
        query = 'SELECT ' + ','.join('(SELECT COUNT(*) FROM ' + table + ' WHERE ' + column
                                    + '=' + quote(user_id) + ') AS ' + table
                                    for table, column in counters.items()) + ';'
        verification = execute(query, 'verify-cleanup')
        remaining = verification[0]['results'][0]
        cleanup_ok = len(remaining) == len(counters) and all(value == 0 for value in remaining.values())
        evidence.update({'remainingRows': remaining, 'cleanupOk': cleanup_ok})
    finally:
        fixture_path.unlink(missing_ok=True)
        evidence['tokenFileRemoved'] = not fixture_path.exists()
        (assets / 'fixture-cleanup.json').write_text(json.dumps(evidence, indent=2) + '\n')
        print('Disposable fixture cleanup:', 'PASS' if cleanup_ok else 'FAIL', flush=True)
if not cleanup_ok:
    exit_code = 1
sys.exit(exit_code)
