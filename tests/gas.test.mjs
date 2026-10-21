import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import crypto from 'node:crypto';
const core=fs.readFileSync(new URL('../src/core.js',import.meta.url),'utf8');
const code=fs.readFileSync(new URL('../gas/Code.gs',import.meta.url),'utf8');
function harness(){
  const sheets=new Map();let actor='owner@example.com',fail='',flushes=0;
  function sheet(name){
    const cells=[];
    const sh={
      getLastRow:()=>{for(let i=cells.length-1;i>=0;i--)if(cells[i]?.some(x=>x!==''&&x!=null))return i+1;return 0;},
      getMaxRows:()=>5000,insertRowsAfter:()=>sh,setFrozenRows:()=>sh,
      appendRow:r=>{cells.push(r);return sh;},
      getRange:(row,col,height=1,width=1)=>{
        const range={
          getValues:()=>Array.from({length:height},(_,r)=>Array.from({length:width},(_,c)=>cells[row+r-1]?.[col+c-1]??'')),
          setValues:values=>{if(fail===name){fail='';throw new Error('simulated write failure');}values.forEach((r,i)=>r.forEach((v,j)=>{(cells[row+i-1]||=([]))[col+j-1]=v;}));return range;},
          setValue:v=>range.setValues([[v]]),setBackground:()=>range,setFontColor:()=>range,setNumberFormat:()=>range,
          clearContent:()=>range.setValues(Array.from({length:height},()=>Array(width).fill('')))
        };return range;
      }
    };sheets.set(name,sh);return sh;
  }
  const db={getSheetByName:n=>sheets.get(n),insertSheet:sheet,getUrl:()=> 'https://docs.google.com/spreadsheets/d/fiction/edit'};
  const props={SPREADSHEET_ID:'fiction',ARCHIVE_FOLDER_ID:'archive',ALLOWED_USERS:'owner@example.com'};
  const files=[];
  const blob=(bytes,mime,name)=>({getBytes:()=>Array.from(bytes),getDataAsString:enc=>new TextDecoder(enc==='Shift_JIS'?'shift-jis':'utf-8').decode(Uint8Array.from(bytes)),getName:()=>name});
  const context=vm.createContext({console,Date,JSON,
    Session:{getActiveUser:()=>({getEmail:()=>actor})},
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]})},
    LockService:{getScriptLock:()=>({waitLock:()=>{},releaseLock:()=>{}})},
    SpreadsheetApp:{openById:()=>db,flush:()=>{flushes++;}},
    DriveApp:{getFolderById:()=>({getName:()=> 'archive',createFile:b=>{const f={getId:()=> 'file-'+files.length,setName:()=>{},getName:()=>b.getName()};files.push(f);return f;}})},
    Drive:{Files:{create:()=>({id:'ocr-document'})}},DocumentApp:{openById:()=>({getBody:()=>({getText:()=> '架空名刺\nphoto@example.com\n03-1234-5678'})})},
    Utilities:{getUuid:()=>crypto.randomUUID(),base64Decode:s=>Array.from(Buffer.from(s,'base64')),newBlob:blob,DigestAlgorithm:{SHA_256:'sha256'},computeDigest:(_,b)=>Array.from(crypto.createHash('sha256').update(Buffer.from(b)).digest())},
    HtmlService:{createHtmlOutputFromFile:()=>({setTitle(){return this;},addMetaTag(){return this;}})}
  });vm.runInContext(core+'\n'+code,context);context.setupApp();
  return {context,sheets,files,props,setActor:a=>actor=a,failNext:n=>fail=n,getFlushes:()=>flushes};
}
const op=()=>crypto.randomUUID();
test('GAS stores/reloads customers, audit and readable sheet columns',()=>{
  const h=harness();const r=h.context.saveCustomer({operationId:op(),name:'架空 太郎',company:'架空社',email:'a@example.com'});
  assert.equal(r.customers.length,1);assert.equal(h.context.getAppData().customers[0].name,'架空 太郎');
  assert.equal(h.sheets.get('顧客一覧').getRange(2,2).getValues()[0][0],'架空 太郎');
  assert.equal(h.context.getAppData().events.length,2);
});
test('GAS authorization fails closed on every externally callable data operation',()=>{
  const h=harness();h.setActor('');
  for(const fn of ['getAppData','saveCustomer','resolveDuplicate','importSansan','readBusinessCard','doGet'])assert.throws(()=>h.context[fn]({operationId:op()}),/利用できません/);
  h.setActor('outsider@example.com');assert.throws(()=>h.context.getAppData(),/利用できません/);
});
test('GAS rejects repeated operation without duplicate records',()=>{
  const h=harness(),input={operationId:op(),name:'架空'};
  h.context.saveCustomer(input);const r=h.context.saveCustomer(input);
  assert.equal(r.customers.length,1);assert.match(r.message,/保存済み/);
});
test('GAS recovers a partial sheet write before next read and prevents replay',()=>{
  const h=harness(),input={operationId:op(),name:'復旧テスト'};
  h.failNext('変更履歴');assert.throws(()=>h.context.saveCustomer(input),/simulated/);
  const repaired=h.context.getAppData();assert.equal(repaired.customers.length,1);assert.equal(repaired.events.length,2);
  h.context.saveCustomer(input);assert.equal(h.context.getAppData().customers.length,1);
});
test('GAS file upload preserves original and validates a full Sansan CSV',()=>{
  const h=harness(),C=h.context.CustomerCore;
  const values=C.HEADERS.map(x=>x==='氏名'?'架空CSV':x==='Email(1)'?'csv@example.com':'');
  const text=C.HEADERS.join(',')+'\r\n'+values.join(',');
  const input={operationId:op(),name:'fiction.csv',mime:'text/csv',base64:Buffer.from(text).toString('base64'),encoding:'UTF-8'};
  const r=h.context.importSansan(input);assert.equal(r.customers.length,1);assert.equal(h.files.length,1);assert.equal(r.imports[0].headers.length,60);
  assert.throws(()=>h.context.importSansan({...input,operationId:op()}),/取込済み/);
});
test('GAS image OCR returns suggestions and retains original and document IDs',()=>{
  const h=harness(),input={operationId:op(),name:'fiction.png',mime:'image/png',base64:Buffer.from([137,80,78,71,13,10,26,10,0,0]).toString('base64')};
  const r=h.context.readBusinessCard(input);assert.equal(r.image.ocrFileId,'ocr-document');assert.equal(r.image.suggestions.email,'photo@example.com');assert.equal(r.customers.length,0);
  h.context.saveCustomer({operationId:op(),name:'架空写真',source:'名刺画像',email:r.image.suggestions.email,imageId:r.image.id});assert.equal(h.context.getAppData().customers[0].source,'名刺画像');
});
test('GAS keeps image if OCR fails and permits human review',()=>{
  const h=harness();h.context.Drive.Files.create=()=>{throw new Error('not enabled');};
  const r=h.context.readBusinessCard({operationId:op(),name:'fiction.png',mime:'image/png',base64:Buffer.from([137,80,78,71,13,10,26,10]).toString('base64')});
  assert.equal(r.image.ocrStatus,'読取未完了');assert.equal(h.files.length,1);assert.equal(r.images.length,1);
});
test('GAS escapes spreadsheet formulas in display cells',()=>{
  const h=harness();h.context.saveCustomer({operationId:op(),name:'=IMPORTXML("x")'});
  assert.equal(h.sheets.get('顧客一覧').getRange(2,2).getValues()[0][0],"'=IMPORTXML(\"x\")");
  assert.equal(h.context.getAppData().customers[0].name,'=IMPORTXML("x")');
});
