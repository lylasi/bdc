"""Create one disposable non-admin fixture, run real integration, always clean up."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
from datetime import datetime, timezone

os.umask(0o077)
assets = Path(__file__).resolve().parent
root = assets.parents[3]
private = Path('/Users/linus/.local/share/bdc-private-backups') / assets.name / 'popup-smoke'
private.mkdir(mode=0o700, parents=True, exist_ok=True)
cli = ['node', '/Users/linus/.npm/_npx/32026684e21afda6/node_modules/wrangler/bin/wrangler.js']
worker_root = Path('/Users/linus/CODE/bdc/cloudflare-worker')
token = secrets.token_urlsafe(32)
token_hash = hashlib.sha256(token.encode()).hexdigest()
user_id = 'ext_popup_probe_' + assets.name + '_' + secrets.token_hex(4)
fixture = private / 'fixture.json'


def quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def execute(sql, label):
    (private / (label + '.sql')).write_text(sql)
    for attempt in range(3):
        result = subprocess.run(cli + ['d1', 'execute', 'bdc-sync', '--remote', '--command', sql, '--json'],
                                cwd=worker_root, capture_output=True, text=True, timeout=90)
        if not result.returncode:
            break
        (private / (label + '-attempt-' + str(attempt + 1) + '-private.txt')).write_text(result.stdout + result.stderr)
        if attempt < 2:
            time.sleep(1 + attempt)
    if result.returncode:
        (private / (label + '-private.txt')).write_text(result.stdout + result.stderr)
        raise RuntimeError(label + ': private D1 output withheld')
    data = json.loads(result.stdout)
    if not all(row.get('success') for row in data):
        raise RuntimeError(label + ': query unsuccessful')
    return data


guard = 'user_id=' + quote(user_id) + ' AND token_hash=' + quote(token_hash) + " AND role='user'"
children = {
    'vocabulary_capture_settings': 'owner_user_id', 'vocabulary_captures': 'owner_user_id',
    'user_ai_credentials': 'user_id', 'user_sessions': 'user_id', 'pairing_codes': 'user_id',
    'snapshots': 'user_id', 'articles': 'owner_user_id', 'article_changes': 'owner_user_id',
    'article_state': 'owner_user_id', 'reading_entities': 'owner_user_id',
    'reading_changes': 'owner_user_id', 'reading_mutations': 'owner_user_id', 'reading_state': 'owner_user_id',
}
fixture.write_text(json.dumps({
    'endpoint': 'https://bdc-sync-api.penzibdc.workers.dev',
    'website': 'http://10.10.10.149:8001', 'publicWebsite': 'https://bdc.a4a4.qzz.io',
    'extensionRoot': str(root / 'extension'), 'token': token, 'userId': user_id,
}))
cleanup = '\n'.join('DELETE FROM ' + table + ' WHERE ' + column
                    + ' IN (SELECT user_id FROM users WHERE ' + guard + ');'
                    for table, column in children.items())
cleanup += '\nDELETE FROM users WHERE ' + guard + ';'
(private / 'guarded-cleanup.sql').write_text(cleanup)
exit_code = 1
cleanup_ok = False
try:
    execute('INSERT INTO users (token_hash,user_id,label,role,created_at) VALUES ('
            + ','.join(quote(v) for v in [token_hash, user_id, 'BDC page release probe',
                                        'user', datetime.now(timezone.utc).isoformat()]) + ') ON CONFLICT (token_hash) DO NOTHING;', 'create-fixture')
    rows = execute('SELECT COUNT(*) AS present FROM users WHERE ' + guard + ';', 'verify-fixture')
    assert rows[0]['results'][0]['present'] == 1
    print('Created isolated non-admin page release fixture', flush=True)
    env = os.environ.copy()
    env['PLAYWRIGHT_MODULE'] = '/Users/linus/.local/share/fnm/node-versions/v24.20.0/installation/lib/node_modules/@playwright/cli/node_modules/playwright'
    result = subprocess.run(['node', str(assets / 'verify-popup-live.cjs'), str(fixture)],
                            cwd=root, env=env, capture_output=True, text=True, timeout=720)
    output = (result.stdout + result.stderr).replace(token, '[redacted-token]')
    (assets / 'popup-smoke.txt').write_text(output)
    print(output, flush=True)
    exit_code = result.returncode
finally:
    evidence = {'userId': user_id, 'role': 'user', 'cleanupOk': False, 'existingUserDataModified': False}
    try:
        execute(cleanup, 'cleanup-fixture')
        tables = {'users': 'user_id', **children}
        query = 'SELECT ' + ','.join('(SELECT COUNT(*) FROM ' + table + ' WHERE ' + column
                                    + '=' + quote(user_id) + ') AS ' + table
                                    for table, column in tables.items()) + ';'
        remaining = execute(query, 'verify-cleanup')[0]['results'][0]
        cleanup_ok = len(remaining) == len(tables) and all(value == 0 for value in remaining.values())
        evidence.update({'remainingRows': remaining, 'cleanupOk': cleanup_ok})
    finally:
        fixture.unlink(missing_ok=True)
        evidence['tokenFileRemoved'] = not fixture.exists()
        (assets / 'fixture-cleanup.json').write_text(json.dumps(evidence, indent=2) + '\n')
        print('Disposable fixture cleanup:', 'PASS' if cleanup_ok else 'FAIL', flush=True)
if not cleanup_ok:
    exit_code = 1
sys.exit(exit_code)
