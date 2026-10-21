import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const core=createRequire(import.meta.url)('../src/core.js');
let state=core.empty();
const ctx=()=>({now:new Date().toISOString(),actor:'ローカルデモ',id:p=>p+'-'+randomUUID()});
const samples=[
  {name:'青葉 さくら',company:'株式会社ハルノ',department:'事業企画部',email:'sakura@example.com',source:'Sansan'},
  {name:'森田 透',company:'グリーン都市研究所',department:'研究開発部',email:'morita@example.com',source:'手入力',consent:'同意済み',consentAt:'2026-10-20T02:00:00Z',consentMethod:'架空の本人返信',consentEvidence:'架空の記録 DEMO-001'},
  {name:'小川 直子',company:'株式会社ミナト',department:'経営企画室',email:'ogawa@example.com',source:'名刺画像',stopped:true,stopReason:'架空の停止申出'},
  {name:'高橋 悠',company:'アトリエ青空',department:'',email:'takahashi@example.com',source:'手入力'}
];
for(const c of samples)state=core.save(state,c,ctx()).state;
const response=()=>({...state,events:state.events.slice(-100).reverse(),mode:'demo',actor:'ローカルデモ',spreadsheetUrl:''});
const completed=new Map();
const server=http.createServer(async(req,res)=>{
  const send=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));};
  try{
    if(req.method==='GET' && req.url==='/'){
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(await fs.readFile(path.join(root,'preview/index.html')));return;
    }
    if(req.method!=='POST'||!req.url.startsWith('/api/'))return send(404,{error:'見つかりません。'});
    if(req.headers.origin && req.headers.origin!==`http://${req.headers.host}`)return send(403,{error:'別のページからの操作は許可していません。'});
    const parts=[];let size=0;
    for await(const chunk of req){size+=chunk.length;if(size>8*1024*1024)throw new Error('ファイルが大きすぎます。');parts.push(chunk);}
    const input=JSON.parse(Buffer.concat(parts).toString('utf8')||'{}'), method=req.url.slice(5),context=ctx();
    if(method==='getAppData')return send(200,response());
    if(!input.operationId)throw new Error('操作番号が必要です。');
    if(completed.has(input.operationId))return send(200,completed.get(input.operationId));
    let result;
    if(method==='saveCustomer')result=core.save(state,input,context);
    else if(method==='resolveDuplicate')result=core.resolve(state,input,context);
    else if(method==='importSansan'){
      const bytes=Buffer.from(input.base64,'base64');if(bytes.length>2*1024*1024)throw new Error('CSVは2MBまでです。');
      const text=new TextDecoder(input.encoding==='Shift_JIS'?'shift-jis':'utf-8',{fatal:true}).decode(bytes);
      result=core.importCsv(state,text,{name:input.name,hash:createHash('sha256').update(bytes).digest('hex'),encoding:input.encoding},context);
    } else if(method==='readBusinessCard'){
      const bytes=Buffer.from(input.base64,'base64');if(bytes.length>5*1024*1024||!['image/jpeg','image/png'].includes(input.mime))throw new Error('5MB以下のJPEG・PNGを選んでください。');
      const image={id:context.id('IMG'),name:input.name,at:context.now,text:'',suggestions:{},ocrStatus:'デモでは文字読取なし'};
      const next=core.copy(state);next.images.push(image);
      result={state:next,image,message:'画像を確認して手入力できます。文字の自動読取はGAS版で利用します。'};
    } else return send(404,{error:'不明な操作です。'});
    state=result.state;
    const answer={...response(),message:result.message};if(result.image)answer.image=result.image;
    completed.set(input.operationId,answer);send(200,answer);
  }catch(e){send(400,{error:e.message});}
});
server.listen(Number(process.env.PORT||4173),'127.0.0.1',()=>console.log('Local: http://127.0.0.1:'+server.address().port));
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>server.close(()=>process.exit(0)));
