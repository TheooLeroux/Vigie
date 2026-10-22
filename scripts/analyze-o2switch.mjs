import {DatabaseSync} from 'node:sqlite';
import {createDecipheriv,createHash} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,posix} from 'node:path';

// Read-only hosting diagnostic: never fetch config/secrets or execute hosted code.
const db=new DatabaseSync(resolve('.data/vigie.sqlite'),{readOnly:true});
const projects=db.prepare("SELECT data FROM projects WHERE workspace='live'").all().map(r=>JSON.parse(r.data));
const connections=db.prepare("SELECT data,secret_cipher FROM hosting_connections WHERE workspace='live'").all().map(r=>({metadata:JSON.parse(r.data),cipher:r.secret_cipher}));
const key=Buffer.from(process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY || '', 'hex');
if (key.length !== 32) throw new Error('Clé privée manquante.');
const allowed=new Set(['DomainInfo/domains_data','LangPHP/php_get_vhost_versions','Mysql/list_databases','Fileman/list_files','Fileman/get_file_content']);
const safeString=v=>typeof v==='string'?v:'';
const report={collectedAt:new Date().toISOString(),accounts:[]};
const detailed=process.argv.includes('--inspect');
const enrich=process.argv.includes('--enrich');
const followup=process.argv.includes('--followup');
const reuse=enrich||followup;
const previous=reuse?JSON.parse(readFileSync('.data/analysis/o2switch-latest.json','utf8')):null;
for (const {metadata:c,cipher:encrypted} of connections.sort((a,b)=>a.metadata.name.localeCompare(b.metadata.name))) {
 if (!encrypted || !/^https:\/\/[a-z0-9-]+\.o2switch\.net:2083$/.test(c.endpoint)) continue;
 const encoded=JSON.parse(encrypted),decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(encoded.iv,'base64'));
 decipher.setAAD(Buffer.from(`vigie:hosting:v1:live:${c.id}:${c.endpoint}:${c.username}:${c.authMode}`));decipher.setAuthTag(Buffer.from(encoded.tag,'base64'));
 const secret=Buffer.concat([decipher.update(Buffer.from(encoded.value,'base64')),decipher.final()]).toString('utf8');
 let calls=0;
 async function api(operation,params={}) {
  if (!allowed.has(operation)) throw new Error('Fonction non autorisée.');
  calls++;if(calls>600) throw new Error('Limite de lecture atteinte.');
  const url=new URL(c.endpoint+'/execute/'+operation);for(const [k,v] of Object.entries(params))url.searchParams.set(k,String(v));
  const response=await fetch(url,{headers:{Authorization:c.authMode==='token'?`cpanel ${c.username}:${secret}`:`Basic ${Buffer.from(c.username+':'+secret).toString('base64')}`,Accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error(`HTTP ${response.status}`);
  const reader=response.body.getReader();let length=0;const chunks=[];while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>4_000_000){await reader.cancel();throw new Error('Réponse trop volumineuse.');}chunks.push(value);}
  const raw=JSON.parse(Buffer.concat(chunks).toString('utf8')),result=raw.result || raw;
  if(result.status!==1)throw new Error('Lecture API refusée ('+operation+').');
  return result.data;
 }
 const account=reuse?previous.accounts.find(a=>a.id===c.id):{id:c.id,name:c.name,host:new URL(c.endpoint).hostname,username:c.username,domains:[],php:[],databases:[],roots:[],warnings:[]};
 const operations=[['domains','DomainInfo/domains_data',{format:'list'}],['php','LangPHP/php_get_vhost_versions',{}],['databases','Mysql/list_databases',{}]];
 const responses=reuse?[]:await Promise.allSettled(operations.map(([,operation,params])=>api(operation,params)));
 for(let i=0;i<responses.length;i++){
  const result=responses[i],type=operations[i][0];
  if(result.status==='rejected'){account.warnings.push(type+': '+result.reason.message);continue;}
  const data=result.value;
  if(type==='domains'){
   let rows=Array.isArray(data)?data:[];
   if(!rows.length && data && typeof data==='object')for(const [kind,values]of Object.entries(data))if(Array.isArray(values))rows.push(...values.map(v=>typeof v==='object'?{...v,domain_type:kind}:{}));
   account.domains=rows.map(d=>({domain:safeString(d.domain),root:safeString(d.documentroot),type:safeString(d.domain_type),aliases:typeof d.serveralias==='string'?d.serveralias.split(/\s+/):[],php:safeString(d.phpversion)})).filter(d=>d.domain);
   if(!account.domains.length)account.warnings.push('Structure domaines non reconnue : '+Object.keys(data||{}).join(','));
  }
  if(type==='php'){
   const rows=Array.isArray(data)?data:Array.isArray(data?.versions)?data.versions:[];
   account.php=rows.map(v=>({domain:safeString(v.vhost),version:safeString(v.version),phpFpm:v.php_fpm===1}));
   if(!rows.length)account.warnings.push('Structure PHP non reconnue : '+Object.keys(data||{}).join(','));
  }
  if(type==='databases'){
   const rows=Array.isArray(data)?data:[];
   account.databases=rows.map(d=>({name:safeString(d.database),bytes:Number(d.disk_usage)||0,userCount:Array.isArray(d.users)?d.users.length:null}));
  }
 }
 const grouped=new Map();if(!reuse)for(const d of account.domains){if(!d.root)continue;if(!grouped.has(d.root))grouped.set(d.root,[]);grouped.get(d.root).push(d.domain);}
 for(const [root,domains]of grouped){
  const matching=projects.filter(p=>{try{return domains.some(d=>d.replace(/^www\./,'')===new URL(p.url).hostname.replace(/^www\./,''));}catch{return false;}}).map(p=>({id:p.id,name:p.name}));
  account.roots.push({path:root,domains,projects:matching,kind:'not_inspected'});
 }
 if(detailed)for(const root of account.roots){
  if(!posix.normalize(root.path).startsWith('/home/'+c.username+'/')){root.kind='outside_home';continue;}
  try{
   const listing=await api('Fileman/list_files',{dir:root.path,include_mime:0,include_hash:0,include_permissions:0});
   const rows=Array.isArray(listing)?listing:Array.isArray(listing?.files)?listing.files:[];
   const names=rows.map(v=>safeString(v.file||v.name)).filter(Boolean);
   root.fileCount=rows.length;
   root.markers=names.filter(n=>['wp-admin','wp-content','wp-includes','wp-config.php','index.php','index.html','package.json','package-lock.json','composer.json','composer.lock','artisan','app','public','dist','build','.git'].includes(n));
   root.kind=names.includes('wp-includes') && names.includes('wp-content')?'wordpress':names.includes('package.json')?'javascript':names.includes('composer.json')?'php-composer':names.includes('index.html')?'static-or-built':names.includes('index.php')?'php':names.length?'other':'empty';
   if(root.kind==='wordpress'){
    const data=await api('Fileman/get_file_content',{dir:posix.join(root.path,'wp-includes'),file:'version.php',charset:'utf-8'});
    const contents=typeof data==='string'?data:safeString(data?.content);
    root.wordpressVersion=contents.match(/\$wp_version\s*=\s*['"]([^'"\s]+)['"]/)?.[1]||null;
    if(!root.wordpressVersion)root.warnings=['Version WordPress non reconnue ; champs reçus : '+Object.keys(data||{}).join(',')];
   }
  }catch(error){root.kind=root.kind==='wordpress'?'wordpress':'unreadable';root.warnings=[error.message];}
 }
 if(enrich){
  const entries=async path=>{const data=await api('Fileman/list_files',{dir:path,include_mime:0,include_hash:0,include_permissions:0});return (Array.isArray(data)?data:Array.isArray(data?.files)?data.files:[]).map(v=>({name:safeString(v.file||v.name),type:safeString(v.type),bytes:Number(v.size)||0})).filter(v=>v.name);};
  const content=async (dir,file)=>{const data=await api('Fileman/get_file_content',{dir,file,charset:'utf-8'});return typeof data==='string'?data:safeString(data?.content);};
  const header=(text,label)=>text.slice(0,8192).match(new RegExp('^[\\s/*#]*'+label+':\\s*(.+)$','im'))?.[1]?.trim().slice(0,200)||null;
  for(const root of account.roots){
   if(root.kind==='empty'||root.kind==='outside_home')continue;
   try{
    root.entries=await entries(root.path);const names=root.entries.map(e=>e.name);
    if(names.includes('wp-content') && (names.includes('wp-admin')||names.includes('wp-config.php')) && !names.includes('wp-includes'))root.kind='wordpress-incomplete';
    if(names.includes('composer.json')){
     const composer=JSON.parse(await content(root.path,'composer.json'));
     root.composer={name:safeString(composer.name),requires:Object.keys(composer.require||{}).filter(v=>v!=='php')};
     if(root.composer.requires.includes('laravel/framework'))root.kind='laravel';
     else if(root.composer.name.includes('dolibarr')||names.includes('main.inc.php'))root.kind='dolibarr';
     else if(root.kind==='javascript')root.kind='php-composer-with-assets';
    }
    if(names.includes('main.inc.php')&&names.includes('core'))root.kind='dolibarr';
    if(root.kind==='dolibarr'){
     const file=names.includes('filefunc.inc.php')?'filefunc.inc.php':null;
     if(file)root.applicationVersion=(await content(root.path,file)).match(/define\s*\(\s*['"]DOL_VERSION['"]\s*,\s*['"]([^'"]+)['"]/)?.[1]||null;
    }
    if(names.includes('package.json')){
     const pkg=JSON.parse(await content(root.path,'package.json'));
     root.package={name:safeString(pkg.name),version:safeString(pkg.version),dependencies:Object.keys(pkg.dependencies||{}),developmentDependencies:Object.keys(pkg.devDependencies||{})};
    }
    if(root.kind==='wordpress'||root.kind==='wordpress-incomplete'){
     root.plugins=[];root.themes=[];
     const pluginDir=posix.join(root.path,'wp-content/plugins');
     const plugins=await entries(pluginDir);
     for(const item of plugins){
      if(item.name.startsWith('.')||item.name==='index.php')continue;
      try{
       if(item.type==='dir'){
        const files=await entries(posix.join(pluginDir,item.name));
        const candidates=files.filter(f=>f.name.endsWith('.php')).sort((a,b)=>Number(b.name===item.name+'.php')-Number(a.name===item.name+'.php'));
        let found=null;
        for(const file of candidates.slice(0,12)){
         if(file.bytes>1_000_000)continue;
         const source=await content(posix.join(pluginDir,item.name),file.name),name=header(source,'Plugin Name');
         if(name){found={slug:item.name,name,version:header(source,'Version'),requiresPhp:header(source,'Requires PHP'),requiresWordPress:header(source,'Requires at least')};break;}
        }
        root.plugins.push(found||{slug:item.name,name:null,version:null});
       }else if(item.name.endsWith('.php')){
        const source=await content(pluginDir,item.name),name=header(source,'Plugin Name');
        if(name)root.plugins.push({slug:item.name,name,version:header(source,'Version')});
       }
      }catch{root.plugins.push({slug:item.name,name:null,version:null,unreadable:true});}
     }
     const themeDir=posix.join(root.path,'wp-content/themes');
     for(const item of await entries(themeDir))if(item.type==='dir'&&!item.name.startsWith('.')){
      try{const style=await content(posix.join(themeDir,item.name),'style.css');root.themes.push({slug:item.name,name:header(style,'Theme Name'),version:header(style,'Version'),template:header(style,'Template')});}catch{root.themes.push({slug:item.name,name:null,version:null,unreadable:true});}
     }
    }
   }catch(error){root.enrichmentWarning=error.message;}
  }
 }
 if(followup){
  const listing=async path=>{const data=await api('Fileman/list_files',{dir:path,include_mime:0,include_hash:0,include_permissions:0});return (Array.isArray(data)?data:Array.isArray(data?.files)?data.files:[]).map(v=>({name:safeString(v.file||v.name),type:safeString(v.type),bytes:Number(v.size)||0})).filter(v=>v.name);};
  const read=async (dir,file)=>{const data=await api('Fileman/get_file_content',{dir,file,charset:'utf-8'});return typeof data==='string'?data:safeString(data?.content);};
  account.unmappedInstallations=[];
  const known=new Set(account.roots.map(r=>r.path));
  for(const item of (await listing('/home/'+c.username)).filter(e=>e.type==='dir'&&!e.name.startsWith('.')&&!['mail','logs','tmp','ssl','etc','access-logs','lscache','public_ftp'].includes(e.name)).slice(0,60)){
   const path=posix.join('/home/'+c.username,item.name);if(known.has(path))continue;
   try{
    const names=(await listing(path)).map(v=>v.name);
    if(names.includes('wp-content')&&names.includes('wp-includes')){
     const version=(await read(posix.join(path,'wp-includes'),'version.php')).match(/\$wp_version\s*=\s*['"]([^'"\s]+)['"]/)?.[1]||null;
     account.unmappedInstallations.push({path,kind:'wordpress',version});
    }
   }catch{account.warnings.push('Répertoire supplémentaire non lisible : '+item.name);}
  }
  for(const root of account.roots){
   if(root.kind==='dolibarr'&&!root.applicationVersion&&root.entries?.some(e=>e.name==='htdocs')){
    try{root.applicationVersion=(await read(posix.join(root.path,'htdocs'),'filefunc.inc.php')).match(/define\s*\(\s*['"]DOL_VERSION['"]\s*,\s*['"]([^'"]+)['"]/)?.[1]||null;}catch{root.versionWarning='Version Dolibarr non lue.';}
   }
   if(root.kind==='wordpress-incomplete'&&root.entries?.some(e=>e.name==='kek.php')){
    const source=await read(root.path,'kek.php');
    root.unexpectedPhp={file:'kek.php',bytes:Buffer.byteLength(source),sha256:createHash('sha256').update(source).digest('hex'),hasPhpInfo:/\bphpinfo\s*\(/.test(source),dynamicFunctions:['eval','assert','system','exec','shell_exec','passthru','popen','proc_open'].filter(f=>new RegExp('\\b'+f+'\\s*\\(').test(source)),usesRequestInput:/\$_(?:GET|POST|REQUEST|COOKIE)\b/.test(source)};
   }
  }
 }
 account.apiCalls=(reuse?account.apiCalls||0:0)+calls;report.accounts.push(account);
 console.log(JSON.stringify({name:account.name,domains:account.domains.length,roots:account.roots.length,php:account.php.length,databases:account.databases.length,wordpress:account.roots.filter(r=>r.kind==='wordpress').length,warnings:account.warnings,apiCalls:calls}));
}
mkdirSync('.data/analysis',{recursive:true});const destination=resolve('.data/analysis/o2switch-latest.json');writeFileSync(destination,JSON.stringify(report,null,2));console.log('Rapport privé : '+destination);
