from pathlib import Path
import json,urllib.request
base='http://127.0.0.1:3001/api/'
def call(path,payload=None):
 request=urllib.request.Request(base+path,headers={'Content-Type':'application/json','Origin':'http://127.0.0.1:3001'},data=None if payload is None else json.dumps(payload).encode())
 with urllib.request.urlopen(request,timeout=15) as r:return json.load(r)
accounts=json.loads(Path('.data/discovery.json').read_text(encoding='utf-8'))
existing=call('workspace');byurl={p['url'].rstrip('/'):p for p in existing['projects']}
created=0
for account in accounts:
 ids=[]
 for site in account['sites']:
  p=byurl.get(site['url'].rstrip('/'))
  if not p:
   p=call('projects',{'name':site['name'],'url':site['url'],'provider':'o2switch','description':'Répertoire : '+site['path']+'\nCompte : '+account['label'],'tags':[account['label']]})
   byurl[site['url'].rstrip('/')]=p;created+=1
  ids.append(p['id'])
  if not any(a['projectId']==p['id'] and a['kind']=='hosting' for a in existing['accesses']):
   call('projects/'+p['id']+'/accesses',{'label':'cPanel · '+account['label'],'kind':'hosting','url':account['base'],'account':account['user'],'vaultRef':'site.txt · '+account['label']})
  if not any(r['reference']==site['database'] for r in existing['resources']):
   call('resources',{'name':site['name']+' · BDD','kind':'database','provider':'o2switch','reference':site['database'],'projectIds':[p['id']]})
 if not any(r['name']==account['label'] for r in existing['resources']):call('resources',{'name':account['label'],'kind':'other','provider':'o2switch','url':account['base'],'reference':account['user'],'projectIds':ids})
if not any(r['name']=='Railway' for r in existing['resources']):call('resources',{'name':'Railway','kind':'other','provider':'Railway','url':'https://railway.com/dashboard','notes':'Connexion via Git. Projets à référencer.','projectIds':[]})
print(json.dumps({'projectsAdded':created,'totalProjects':len(call('workspace')['projects']),'passwordsStored':False}))
