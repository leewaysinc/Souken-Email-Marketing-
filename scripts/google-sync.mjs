/** Google Apps Script API transport using an existing local clasp login. No browser cookies. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const privateDir=path.join(root,'private-data');
const command=process.argv[2] || 'check';
if(!['check','push','deploy-private'].includes(command))throw new Error('Use check, push, or deploy-private.');
const config=JSON.parse(await fs.readFile(path.join(root,'.clasp.json'),'utf8'));
const settings=JSON.parse(await fs.readFile(path.join(privateDir,'google-local-settings.json'),'utf8'));
if(!config.scriptId || !settings.expectedEmail)throw new Error('Local project and expected account settings are required.');
const credentials=JSON.parse(await fs.readFile(path.join(os.homedir(),'.clasprc.json'),'utf8')).tokens?.[settings.accountName || 'default'];
if(!credentials?.refresh_token)throw new Error('Existing clasp login is unavailable. No automatic login was started.');
async function request(url,init={}){
  const response=await fetch(url,{...init,signal:AbortSignal.timeout(30000)});
  const body=await response.json();
  if(!response.ok){const e=new Error(body.error?.message || (typeof body.error==='string'?body.error:'Google request failed'));e.httpStatus=response.status;throw e;}
  return body;
}
const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
const canonical=x=>{if(Array.isArray(x))return x.map(canonical);if(x&&typeof x==='object')return Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])]));return x;};
const normalize=f=>f.type==='JSON'?JSON.stringify(canonical(JSON.parse(f.source))):f.source.replace(/\r\n/g,'\n').trimEnd();
const contentHash=files=>digest(JSON.stringify(files.map(f=>({name:f.name,type:f.type,source:normalize(f)})).sort((a,b)=>a.name.localeCompare(b.name))));
const mapping={appsscript:'gas/appsscript.json',コード:'gas/Code.gs',Code:'gas/Code.gs',Core:'gas/Core.gs',Index:'gas/Index.html'};
await fs.mkdir(privateDir,{recursive:true});
const token=await request('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:credentials.client_id,client_secret:credentials.client_secret,refresh_token:credentials.refresh_token,grant_type:'refresh_token'})});
const authHeaders={Authorization:'Bearer '+token.access_token};
const identity=await request('https://www.googleapis.com/oauth2/v2/userinfo',{headers:authHeaders});
if(identity.email?.toLowerCase()!==settings.expectedEmail.toLowerCase())throw new Error('The authenticated account differs from the configured account. No changes were made.');
const api='https://script.googleapis.com/v1/projects/'+encodeURIComponent(config.scriptId);
const get=suffix=>request(api+suffix,{headers:authHeaders});
const write=(suffix,method,body)=>request(api+suffix,{method,headers:{...authHeaders,'Content-Type':'application/json'},body:JSON.stringify(body)});
const project=await get('');
const remote=await get('/content');
if(!remote.files?.length)throw new Error('Remote code is empty. Stop and review the project.');
if(remote.files.some(f=>!mapping[f.name]))throw new Error('Unrecognized remote files exist. Review them before pushing.');
const local=[];
for(const f of remote.files)local.push({name:f.name,type:f.type,source:await fs.readFile(path.join(root,mapping[f.name]),'utf8')});
if(local.length!==4 || new Set(local.map(f=>mapping[f.name])).size!==4)throw new Error('Expected exactly the four deployment files.');
const snapshotPath=path.join(privateDir,'google-sync-snapshot.json');
const changes=remote.files.filter((f,i)=>normalize(f)!==normalize(local[i])).map(f=>f.name);
console.log(JSON.stringify({stage:'comparison',project:project.title,accountMatched:true,changedFiles:changes}));
if(command==='check'){
  await fs.writeFile(snapshotPath,JSON.stringify({checkedAt:new Date().toISOString(),scriptId:config.scriptId,hash:contentHash(remote.files),files:remote.files},null,2));
  console.log('Read-only snapshot saved. No Google changes.');
} else {
  if(command==='push'){
    if(!process.argv.includes('--apply'))throw new Error('Push requires --apply after reviewing changedFiles.');
    const snapshot=JSON.parse(await fs.readFile(snapshotPath,'utf8'));
    if(snapshot.scriptId!==config.scriptId || snapshot.hash!==contentHash(remote.files))throw new Error('Google code changed after the previous check. Run check and review again.');
    if(changes.length){
      await fs.writeFile(path.join(privateDir,'google-before-push-'+Date.now()+'.json'),JSON.stringify(remote,null,2));
      await write('/content','PUT',{files:local});
      const verified=await get('/content');
      if(contentHash(verified.files)!==contentHash(local))throw new Error('Readback differs after push. Review the saved backup.');
      await fs.writeFile(snapshotPath,JSON.stringify({checkedAt:new Date().toISOString(),scriptId:config.scriptId,hash:contentHash(verified.files),files:verified.files},null,2));
      console.log('Push and readback verified. Original remote filenames preserved.');
    }else console.log('No changes to push.');
  }else {
    if(changes.length)throw new Error('Push and verify local changes before deploying.');
    const manifest=JSON.parse(local.find(f=>f.name==='appsscript').source);
    if(manifest.webapp?.access!=='MYSELF'||manifest.webapp?.executeAs!=='USER_ACCESSING')throw new Error('Private deployment requires MYSELF and USER_ACCESSING.');
    const release='customer-private-'+contentHash(local).slice(0,20);
    const versionList=await get('/versions?pageSize=200');
    let version=versionList.versions?.find(v=>v.description===release);
    if(!version)version=await write('/versions','POST',{description:release});
    const deployments=await get('/deployments');
    let deployment=deployments.deployments?.find(d=>d.deploymentConfig?.description===release);
    if(!deployment){
      let previous;
      try{previous=JSON.parse(await fs.readFile(path.join(privateDir,'google-private-deployment.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
      if(previous){
        const current=deployments.deployments?.find(d=>d.deploymentId===previous.deploymentId);
        const currentEntry=current?.entryPoints?.find(e=>e.entryPointType==='WEB_APP');
        if(!currentEntry || currentEntry.webApp.entryPointConfig.access!=='MYSELF' || currentEntry.webApp.entryPointConfig.executeAs!=='USER_ACCESSING' || current.deploymentConfig.description!==previous.release)throw new Error('Existing deployment changed or is not private. Review before updating.');
        await fs.writeFile(path.join(privateDir,'google-deployment-before-update-'+Date.now()+'.json'),JSON.stringify(current,null,2));
        deployment=await write('/deployments/'+encodeURIComponent(previous.deploymentId),'PUT',{deploymentConfig:{scriptId:config.scriptId,versionNumber:version.versionNumber,manifestFileName:'appsscript',description:release}});
      }else deployment=await write('/deployments','POST',{versionNumber:version.versionNumber,manifestFileName:'appsscript',description:release});
    }
    const entry=deployment.entryPoints?.find(e=>e.entryPointType==='WEB_APP');
    if(!entry||entry.webApp.entryPointConfig.access!=='MYSELF'||entry.webApp.entryPointConfig.executeAs!=='USER_ACCESSING')throw new Error('Returned deployment does not match private access settings.');
    const saved={deployedAt:new Date().toISOString(),version:version.versionNumber,deploymentId:deployment.deploymentId,url:entry.webApp.url,access:'MYSELF',executeAs:'USER_ACCESSING',release};
    await fs.writeFile(path.join(privateDir,'google-private-deployment.json'),JSON.stringify(saved,null,2));
    console.log(JSON.stringify({stage:'private-deployment',version:saved.version,url:saved.url,access:saved.access,executeAs:saved.executeAs}));
  }
}
