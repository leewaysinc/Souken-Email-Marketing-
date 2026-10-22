import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';

const root=new URL('../',import.meta.url);
const boot=fs.readFileSync(new URL('src/boot.js',root),'utf8');
function guard(){
  const elements=new Map(),listeners={};let timer;
  function element(){return {textContent:'',children:[],appendChild(x){this.children.push(x);},replaceChildren(...xs){this.children=xs;}};}
  const document={createElement:element,getElementById:id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);}};
  const window={location:{reload(){}},addEventListener:(name,fn)=>{listeners[name]=fn;}};
  vm.runInNewContext(boot,{window,document,setTimeout:fn=>{timer=fn;return 1;},clearTimeout:()=>{timer=null;}});
  return {window,elements,listeners,timeout:()=>timer?.()};
}

test('startup guard displays parse failures and preserves the diagnosis after timeout',()=>{
  const g=guard();
  g.listeners.error({message:"Unexpected token '{'",filename:'customer-client.js',lineno:93,colno:28});
  const main=g.elements.get('main');
  assert.match(main.children[0].children[1].textContent,/Unexpected token.*93/);
  g.timeout();
  assert.match(main.children[0].children[1].textContent,/Unexpected token/);
  assert.equal(g.elements.get('side-connection').textContent,'接続未確認');
});

test('startup guard replaces an endless spinner and stops after successful loading',()=>{
  const failed=guard();failed.timeout();
  assert.match(failed.elements.get('main').children[0].children[1].textContent,/時間がかかっています/);
  const passed=guard();passed.window.appBoot.ready();passed.timeout();
  assert.equal(passed.elements.has('main'),false);
});

test('generated HTML keeps shared and client code together in a valid module behind the guard',()=>{
  const html=fs.readFileSync(new URL('gas/Index.html',root),'utf8');
  assert.doesNotMatch(html,/\/\* APP_(CORE|CLIENT|BOOT|CSS) \*\//);
  const scripts=Array.from(html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g));
  assert.equal(scripts.length,2);
  assert.match(scripts[0][2],/window\.appBoot/);
  assert.match(scripts[1][1],/type="module"/);
  for(const source of ['src/core.js','src/client.js'])assert.ok(scripts[1][2].includes(fs.readFileSync(new URL(source,root),'utf8')));
  const result=spawnSync(process.execPath,['--check','--input-type=module'],{input:scripts[1][2],encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});
