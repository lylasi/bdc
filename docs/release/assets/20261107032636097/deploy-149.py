"""Fast-forward the existing 149 checkout and verify its private configuration."""
import json
from pathlib import Path
import subprocess

assets = Path(__file__).resolve().parent
root = assets.parents[3]
target = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
before = json.loads((assets / 'site-before.json').read_text())
script = '''from pathlib import Path
import hashlib,json,subprocess,time,urllib.request
p=Path('/Users/linus/Documents/code/qinglong/ql/data/scripts/bdc')
docker='/usr/local/bin/docker'
def run(args):
 r=subprocess.run(args,cwd=p,text=True,capture_output=True)
 if r.returncode: raise RuntimeError(r.stdout+r.stderr)
 return r.stdout+r.stderr
def digest(): return hashlib.sha256((p/'ai-config.js').read_bytes()).hexdigest()
before=run(['git','rev-parse','HEAD']).strip()
assert run(['git','branch','--show-current']).strip()=='master'
assert not run(['git','status','--porcelain']).strip()
assert before==EXPECTED_BEFORE
assert digest()==EXPECTED_CONFIG
pull=run(['git','pull','--ff-only','origin','master'])
assert run(['git','rev-parse','HEAD']).strip()==EXPECTED_TARGET
restart=run([docker,'compose','restart','bdc'])
nginx=run([docker,'exec','bdc','nginx','-t'])
for i in range(20):
 state=json.loads(run([docker,'inspect','bdc']))[0]
 if state['State'].get('Health',{}).get('Status')=='healthy': break
 time.sleep(1)
assert state['State']['Running'] and state['State'].get('Health',{}).get('Status')=='healthy'
assert digest()==EXPECTED_CONFIG
assert not run(['git','status','--porcelain']).strip()
response=urllib.request.urlopen('http://127.0.0.1:8001/',timeout=15)
body=response.read()
print(json.dumps({'before':before,'head':EXPECTED_TARGET,'private_config_before':EXPECTED_CONFIG,
 'private_config_after':digest(),'pull':pull,'restart':restart,'nginx':nginx,
 'status':'','container_running':state['State']['Running'],
 'container_health':state['State'].get('Health',{}).get('Status'),
 'started_at':state['State']['StartedAt'],'mounts':state['Mounts'],
 'http_status':response.status,'index_sha256':hashlib.sha256(body).hexdigest()}))
'''
script = 'EXPECTED_BEFORE=' + repr(before['head']) + '\nEXPECTED_CONFIG=' + repr(before['config_sha256']) + '\nEXPECTED_TARGET=' + repr(target) + '\n' + script
result = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', '10.10.10.149', 'python3 -'],
                        input=script, text=True, capture_output=True, timeout=90)
if result.returncode:
    (assets / 'deploy-149-failed.txt').write_text(result.stdout + result.stderr)
    raise RuntimeError(result.stderr)
data = json.loads(result.stdout)
(assets / 'deploy-149.json').write_text(json.dumps(data, indent=2) + '\n')
print(json.dumps({key: data[key] for key in ['head', 'private_config_after', 'container_running', 'container_health', 'http_status']}, indent=2))
