EXPECTED={'before': '4e7de51d1d07c143fd6714b6a38352fd9ea4503c', 'target': 'c7439bc855f76ee238766eeb13d3d71bc19c5f54', 'config': '6961935c69385e837692203fb0eba506a04b7d7b99680ef0e2dd5d09870aec93', 'files': {'index.html': '01f75f9379b5805540532a3aceeae046bb9f4d696dffaf5883d00c2f81f82b0a', 'styles.css': '1628a52f2756ca49e2fc16e97f85e14259e870df8b02049a1c91916d54068b89', 'features/vocabulary/vocabulary.js': '66895bdec94ea651c56a772e05c3f915acdf4e2383354dbc6ea2e981a3c5523d', 'features/sync/sync.js': '10bbcfd779cc5728dd502b0b4d15b1ba97ee58e0fdeb74af02b53a26fc6e9916', 'modules/settings.js': 'f71e36e6c39a9f1f5863802b3d5f39227afe3685e37b5e046d87d68f3977ba7d', 'locales/zh-CN.js': '0ea9d0f66ed0eaa395606e4f871901e1b82d9c843947926b60fcf6061aa290e0', 'locales/zh-HK.js': '2dfd5e01d7969f9232e943e8661aa826c5b7aec36b831bb0a28297346fd5eff8'}}
from pathlib import Path
import hashlib,json,subprocess,time,urllib.request
p=Path('/Users/linus/Documents/code/qinglong/ql/data/scripts/bdc')
docker='/usr/local/bin/docker'
def run(args):
    result=subprocess.run(args,cwd=p,text=True,capture_output=True)
    if result.returncode: raise RuntimeError(result.stdout+result.stderr)
    return result.stdout+result.stderr
def digest(file): return hashlib.sha256((p/file).read_bytes()).hexdigest()
before=run(['git','rev-parse','HEAD']).strip()
assert run(['git','branch','--show-current']).strip()=='master'
assert not run(['git','status','--porcelain']).strip()
assert before==EXPECTED['before'], before
assert digest('ai-config.js')==EXPECTED['config']
pull=run(['git','pull','--ff-only','origin','master'])
assert run(['git','rev-parse','HEAD']).strip()==EXPECTED['target']
restart=run([docker,'compose','restart','bdc'])
nginx=run([docker,'exec','bdc','nginx','-t'])
for attempt in range(30):
    state=json.loads(run([docker,'inspect','bdc']))[0]['State']
    if state.get('Health',{}).get('Status')=='healthy': break
    time.sleep(1)
assert state['Running'] and state.get('Health',{}).get('Status')=='healthy'
assert digest('ai-config.js')==EXPECTED['config']
assert not run(['git','status','--porcelain']).strip()
verified={}
for file,expected in EXPECTED['files'].items():
    source=digest(file)
    runtime=run([docker,'exec','bdc','sha256sum','/srv/bdc/'+file]).split()[0]
    assert source==runtime==expected, file
    verified[file]={'source':source,'runtime':runtime,'ok':True}
private_runtime=run([docker,'exec','bdc','sha256sum','/srv/bdc/ai-config.js']).split()[0]
assert private_runtime==EXPECTED['config']
with urllib.request.urlopen('http://127.0.0.1:8001/',timeout=15) as response:
    body=response.read(); http_status=response.status
assert hashlib.sha256(body).hexdigest()==EXPECTED['files']['index.html']
print(json.dumps({'before':before,'head':EXPECTED['target'],'pull':pull,'restart':restart,'nginx':nginx,'container_running':state['Running'],'container_health':state.get('Health',{}).get('Status'),'started_at':state['StartedAt'],'private_config_before':EXPECTED['config'],'private_config_after':digest('ai-config.js'),'private_config_runtime':private_runtime,'http_status':http_status,'files':verified},ensure_ascii=False))
