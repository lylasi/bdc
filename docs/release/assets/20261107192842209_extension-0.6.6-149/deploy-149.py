from pathlib import Path
import json
EXPECTED=json.loads(Path(__file__).with_name('expected-runtime.json').read_text())
from pathlib import Path
import hashlib,json,re,subprocess,sys,time,urllib.request,zipfile
p=Path('/Users/linus/Documents/code/qinglong/ql/data/scripts/bdc')
docker='/usr/local/bin/docker'
target=sys.argv[1]
assert re.fullmatch('[0-9a-f]{40}',target)
def run(args):
 r=subprocess.run(args,cwd=p,text=True,capture_output=True,timeout=90)
 if r.returncode:raise RuntimeError(r.stdout+r.stderr)
 return r.stdout+r.stderr
def digest(name):return hashlib.sha256((p/name).read_bytes()).hexdigest()
assert run(['git','branch','--show-current']).strip()=='master'
assert not run(['git','status','--porcelain']).strip()
before=run(['git','rev-parse','HEAD']).strip()
assert digest('ai-config.js')==EXPECTED['privateConfigSha256']
run(['git','fetch','origin','master'])
assert run(['git','rev-parse','FETCH_HEAD']).strip()==target
run(['git','merge-base','--is-ancestor',before,target])
run(['git','merge','--ff-only','--quiet',target])
assert run(['git','rev-parse','HEAD']).strip()==target
for name,sha in EXPECTED['files'].items():assert digest(name)==sha,name
# 149 has no Node. Install only ignored generated dependencies from the
# reproducible public-config package; tracked source files must already match Git.
archive=p/EXPECTED['archive']
assert hashlib.sha256(archive.read_bytes()).hexdigest()==EXPECTED['archiveSha256']
tracked=set(run(['git','ls-files','-z','--','extension']).split('\0'))
generated=0
with zipfile.ZipFile(archive) as z:
 assert z.testzip() is None
 assert set(z.namelist())==set(EXPECTED['extensionFiles'])
 for name in z.namelist():
  assert name.startswith('extension/') and '..' not in Path(name).parts
  data=z.read(name)
  assert hashlib.sha256(data).hexdigest()==EXPECTED['extensionFiles'][name],name
  dest=p/name
  if name in tracked:
   assert dest.read_bytes()==data,name
  else:
   assert name=='extension/ai-config.js' or name.startswith(('extension/modules/','extension/locales/','extension/shared/','extension/_locales/'))
   assert run(['git','check-ignore','--',name]).strip()==name,name
   dest.parent.mkdir(parents=True,exist_ok=True)
   temp=dest.with_name(dest.name+'.tmp')
   temp.write_bytes(data)
   temp.replace(dest)
   generated+=1
 for name,sha in EXPECTED['extensionFiles'].items():assert digest(name)==sha,name
assert (p/'extension/ai-config.js').read_bytes()==(p/'ai-config.example.js').read_bytes()
assert json.loads((p/'extension/manifest.json').read_text())['version']=='0.6.6'
assert digest('ai-config.js')==EXPECTED['privateConfigSha256']
restart=run([docker,'compose','restart','bdc'])
nginx=run([docker,'exec','bdc','nginx','-t'])
for attempt in range(45):
 state=json.loads(run([docker,'inspect','bdc']))[0]['State']
 if state.get('Health',{}).get('Status')=='healthy':break
 time.sleep(1)
assert state['Running'] and state.get('Health',{}).get('Status')=='healthy'
verified={}
for name,sha in EXPECTED['files'].items():
 runtime=run([docker,'exec','bdc','sha256sum','/srv/bdc/'+name]).split()[0]
 assert digest(name)==runtime==sha,name
 verified[name]={'sha256':sha,'ok':True}
privateRuntime=run([docker,'exec','bdc','sha256sum','/srv/bdc/ai-config.js']).split()[0]
assert privateRuntime==digest('ai-config.js')==EXPECTED['privateConfigSha256']
assert not run(['git','status','--porcelain']).strip()
with urllib.request.urlopen('http://127.0.0.1:8001/',timeout=15) as response:
 body=response.read();status=response.status
assert status==200 and hashlib.sha256(body).hexdigest()==EXPECTED['files']['index.html']
print(json.dumps({'before':before,'head':target,'release':EXPECTED['release'],'extensionVersion':'0.6.6','extensionFilesVerified':len(EXPECTED['extensionFiles']),'generatedDependenciesInstalled':generated,'containerRunning':state['Running'],'containerHealth':state['Health']['Status'],'startedAt':state['StartedAt'],'nginx':nginx,'restart':restart,'httpStatus':status,'privateConfigPreserved':True,'runtimeFiles':verified,'worktreeClean':True},ensure_ascii=False))
