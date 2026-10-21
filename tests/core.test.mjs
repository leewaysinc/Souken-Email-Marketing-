import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const C=createRequire(import.meta.url)('../src/core.js');
let serial=0;
const ctx=()=>({now:'2026-10-21T05:00:00.000Z',actor:'test@example.com',id:p=>p+'-'+(++serial)});
const row=(overrides={})=>C.HEADERS.map(h=>overrides[h]||'');
const quote=v=>'"'+String(v).replaceAll('"','""')+'"';
const csv=rows=>[C.HEADERS,...rows].map(r=>r.map(quote).join(',')).join('\r\n');
const agreed={name:'架空 一郎',company:'架空社',email:'a@example.com',consent:'同意済み',consentAt:'2026-10-20T00:00:00Z',consentMethod:'返信',consentEvidence:'架空記録'};
test('CSV quoting, BOM, embedded newline, trailing empty fields',()=>{
  assert.deepEqual(C.parseCsv('\uFEFFa,b,c\r\n"a,b","a""b","a\nb"\r\nx,,\r\n'),[['a','b','c'],['a,b','a"b','a\nb'],['x','','']]);
  assert.throws(()=>C.parseCsv('"unclosed'),/引用符/);
  assert.throws(()=>C.parseCsv('"closed"wrong'),/引用符/);
});
test('strict 60-column schema and blank records',()=>{
  const p=C.csvPlan(csv([row({'氏名':'架空','Email(1)':'a@example.com'}),row()]),C.empty());
  assert.equal(p.items.length,1);assert.equal(p.blank,1);assert.equal(p.total,2);
  assert.throws(()=>C.csvPlan('氏名,Email\na,a@example.com',C.empty()),/60列/);
  assert.throws(()=>C.csvPlan(csv([row({'氏名':'架空'})]).replace('架空','\uFFFD'),C.empty()),/文字コード/);
});
test('CSV import preserves all original values and does not grant consent',()=>{
  const values=row({'氏名':'架空','Email(1)':'a@example.com','メモ':'a,b\nnext','氏名（カナ）［名］':''});
  const s=C.importCsv(C.empty(),csv([values]),{hash:'1',name:'fiction.csv'},ctx()).state;
  assert.deepEqual(s.raw[0].values,values);assert.equal(s.customers[0].consent,'未確認');
  assert.throws(()=>C.importCsv(s,csv([values]),{hash:'1'},ctx()),/取込済み/);
});
test('both duplicate rows in the same CSV are held for human judgment',()=>{
  const s=C.importCsv(C.empty(),csv([row({'氏名':'架空A','Email(1)':'shared@example.com'}),row({'氏名':'架空B','Email(1)':'shared@example.com'})]),{hash:'2'},ctx()).state;
  assert.equal(s.customers.length,0);assert.equal(s.reviews.length,2);
  const first=C.resolve(s,{reviewId:s.reviews[0].id,mode:'new',reason:'一人目を確認'},ctx()).state;
  const linked=C.resolve(first,{reviewId:s.reviews[1].id,mode:'existing',customerId:first.customers[0].id,reason:'同じ人と確認'},ctx()).state;
  assert.equal(linked.customers.length,1);assert.equal(linked.reviews.filter(x=>x.status==='確認待ち').length,0);
});
test('name+company comparison supports spacing; company ID and blank IDs do not merge',()=>{
  assert.equal(C.matches({name:'架空 一郎',company:'架空社'},[{id:'1',name:'架空一郎',company:'架空社'}]).length,1);
  assert.equal(C.matches({companyId:'X'},[{id:'1',companyId:'X'}]).length,0);
});
test('stopped contact cannot be reactivated by editing or reimporting',()=>{
  let s=C.save(C.empty(),{...agreed,stopped:true},ctx()).state;
  const old=s.customers[0];assert.equal(C.status(s,old).stopped,true);
  assert.throws(()=>C.save(s,{...old,stopped:false},ctx()),/解除/);
  s=C.importCsv(s,csv([row({'氏名':'別表記','Email(1)':'a@example.com'})]),{hash:'3'},ctx()).state;
  assert.equal(s.customers.length,1);assert.equal(s.reviews.length,1);
  s=C.resolve(s,{reviewId:s.reviews[0].id,mode:'new',reason:'別人だが共有アドレス'},ctx()).state;
  assert.equal(C.status(s,s.customers[1]).stopped,true);
});
test('editing address resets consent; optimistic version prevents lost updates',()=>{
  const s=C.save(C.empty(),agreed,ctx()).state,old=s.customers[0];
  const next=C.save(s,{...old,email:'new@example.com'},ctx()).state;
  assert.equal(next.customers[0].consent,'未確認');assert.equal(next.customers[0].consentEvidence,'');
  assert.throws(()=>C.save(next,{...old,memo:'stale'},ctx()),/更新/);
});
test('consent requires evidence and refusal creates a stop entry',()=>{
  assert.throws(()=>C.save(C.empty(),{name:'架空',consent:'同意済み'},ctx()),/証拠/);
  const s=C.save(C.empty(),{name:'架空',email:'a@example.com',consent:'拒否'},ctx()).state;
  assert.equal(s.stops.length,1);assert.equal(s.customers[0].stopped,true);
});
test('manual duplicate registration goes to review and cannot silently overwrite',()=>{
  let s=C.save(C.empty(),agreed,ctx()).state;
  s=C.save(s,{...agreed,name:'別名'},ctx()).state;
  assert.equal(s.customers.length,1);assert.equal(s.reviews.length,1);assert.equal(s.customers[0].name,'架空 一郎');
  s=C.resolve(s,{reviewId:s.reviews[0].id,mode:'existing',customerId:s.customers[0].id,reason:'名刺で確認'},ctx()).state;
  assert.equal(s.customers[0].consent,'同意済み');assert.equal(s.customers[0].name,'架空 一郎');
});
test('image suggestions never infer name, company or consent',()=>{
  assert.deepEqual(C.suggest('架空社\n山田\nhello@example.com\n03-1234-5678'),{email:'hello@example.com',phone:'03-1234-5678'});
  assert.throws(()=>C.save(C.empty(),{name:'架空',imageId:'unregistered'},ctx()),/保存記録/);
});
test('unsupported input and duplicate judgments fail without mutating original state',()=>{
  const s=C.empty();assert.throws(()=>C.save(s,{name:'架空',email:'=BAD'},ctx()),/メール/);assert.equal(s.customers.length,0);
  assert.throws(()=>C.resolve(s,{reviewId:'missing',mode:'new',reason:'test'},ctx()),/処理済み/);
});
test('a stop entered for a duplicate applies immediately, before identity review',()=>{
  const s=C.save(C.empty(),agreed,ctx()).state;
  const next=C.save(s,{name:'別表記',email:'a@example.com',stopped:true},ctx()).state;
  assert.equal(next.reviews.length,1);assert.equal(C.status(next,next.customers[0]).stopped,true);
});
