'use strict';
const $ = (q,root=document) => root.querySelector(q);
const esc = x => String(x == null ? '' : x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let data = CustomerCore.empty(), view = 'customers', query = '', filter = 'all', page = 0, csvFile = null, imageFile = null, imageUrl = '', busy = false;
const operationIds = new Map();
const uuid = () => crypto.randomUUID();
const date = x => x ? new Date(x).toLocaleString('ja-JP',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '—';
const customerName = CustomerCore.displayName;
function buildCustomerFields(c={}) {
  const labels={familyName:'姓',givenName:'名',familyKana:'姓（カナ）',givenKana:'名（カナ）',name:'氏名（元の全体表記）',kana:'氏名カナ（元の全体表記）'};
  const field=f=>'<label>'+esc(labels[f.key]||f.label)+(CustomerCore.longField(f.key)?'<textarea name="'+f.key+'" rows="3" maxlength="5000"></textarea>':'<input name="'+f.key+'" type="'+(['email','email2'].includes(f.key)?'email':'text')+'" maxlength="1000">')+'</label>';
  const shown=CustomerCore.PRIMARY_FIELDS.map(key=>CustomerCore.CSV_FIELDS.find(f=>f.key===key)).concat(CustomerCore.CSV_FIELDS.filter(f=>!CustomerCore.PRIMARY_FIELDS.includes(f.key)&&CustomerCore.fieldVisible(f.key,c)));
  const optional=CustomerCore.CSV_FIELDS.filter(f=>!CustomerCore.fieldVisible(f.key,c));
  $('#sansan-fields').innerHTML='<div class="form-grid">'+shown.map(field).join('')+'</div>'+(optional.length?'<details><summary>未入力の追加項目を表示（'+optional.length+'項目）</summary><p class="help">必要になった項目はここから入力できます。入力済みの項目は次回から常に表示します。</p><div class="form-grid">'+optional.map(field).join('')+'</div></details>':'');
}
function consentDateView() {
  const form=$('#customer-form'),card=form.elements.consent.value==='名刺交換のみ',input=form.elements.consentAt;
  input.type=card?'text':'datetime-local';input.readOnly=card;
  $('#consent-date-hint').textContent=card?'名刺交換日を優先し、空欄なら登録日を使います。両方とも空欄なら未記録です。':'受信希望を確認した日時を記録します。';
  if(card)input.value=CustomerCore.cardConsent({consent:'名刺交換のみ',cardExchangedAt:form.elements.cardExchangedAt.value,sansanRegisteredAt:form.elements.sansanRegisteredAt.value}).consentAt;
}
function tell(message,error=false) { const n=$('#notice');n.textContent=message;n.className=error?'error':'';n.hidden=false;clearTimeout(tell.timer);tell.timer=setTimeout(()=>n.hidden=true,error?15000:6500); }
async function api(method,payload) {
  const mutation = method !== 'getAppData';
  const key = method + JSON.stringify(payload || {});
  if(mutation){if(!operationIds.has(key))operationIds.set(key,uuid());payload=Object.assign({},payload,{operationId:operationIds.get(key)});}
  let result;
  if (typeof google !== 'undefined' && google.script && google.script.run) {
    result = await new Promise((resolve,reject)=>google.script.run.withSuccessHandler(resolve).withFailureHandler(e=>reject(new Error(e.message || String(e))))[method](payload));
  } else {
    const r=await fetch('/api/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload || {})});
    result=await r.json(); if(!r.ok)throw new Error(result.error || '通信に失敗しました。');
  }
  if(mutation)operationIds.delete(key);
  return result;
}
function connection() {
  $('#mode-banner').className='mode-banner'+(data.mode==='gas'?'':' demo');
  $('#mode-banner').textContent=data.mode==='gas'?'● スプレッドシート連携中 · '+data.actor:'画面確認用デモ · スプレッドシート未接続 · 入力内容はこのローカルサーバーの終了で消えます';
  $('#side-connection').textContent=data.mode==='gas'?'Googleスプレッドシート連携':'ローカルデモ';
  const link=$('#sheet-link');link.hidden=!data.spreadsheetUrl;
  if(data.spreadsheetUrl && /^https:\/\/docs\.google\.com\/spreadsheets\//.test(data.spreadsheetUrl))link.href=data.spreadsheetUrl;
  $('#review-count').textContent=data.reviews.filter(x=>x.status==='確認待ち').length;
}
async function refresh() { data=await api('getAppData');connection();render();window.appBoot.ready(); }
function heading(title,description,actions='') { return `<div class="page-heading"><div><div class="eyebrow">CUSTOMER WORKSPACE</div><h1>${title}</h1><p class="subtext">${description}</p></div><div class="heading-actions">${actions}</div></div>`; }
function pill(label,tone='') {return `<span class="pill ${tone}">${esc(label)}</span>`;}
function status(c) {return CustomerCore.status(data,c);}
function customerRows() {
  let list=data.customers.filter(c=>[customerName(c),CustomerCore.displayKana(c),c.id,...CustomerCore.csvValues(c)].some(v=>String(v||'').toLowerCase().includes(query.toLowerCase())));
  list=list.filter(c=>filter==='all'||filter==='stopped'&&status(c).stopped||filter==='pending'&&!status(c).stopped&&status(c).reasons.length||filter==='agreed'&&!status(c).reasons.length);
  list.sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||''));
  const pages=Math.max(1,Math.ceil(list.length/20));page=Math.min(page,pages-1);
  $('#customer-rows').innerHTML=list.slice(page*20,page*20+20).map(c=>{
    const st=status(c);
    return `<tr><td><div class="person-cell"><span class="person-initial">${esc((customerName(c)||c.company||'?').slice(0,1))}</span><div><span class="name">${esc(customerName(c)||'氏名未入力')}</span><span class="secondary">${esc(c.id.slice(0,12))}</span></div></div></td><td>${esc(c.company||'—')}<div class="secondary">${esc(c.department||'')}</div></td><td>${esc(c.email||'未登録')}</td><td>${pill(c.source,'source')}</td><td title="${esc(st.reasons.join(' / '))}">${pill(st.label,st.stopped?'red':st.reasons.length?'amber':'green')}</td><td><button class="button text" data-edit="${esc(c.id)}">編集 ↗</button></td></tr>`;
  }).join('')||'<tr><td colspan="6"><div class="empty">条件に合う顧客がいません。<br>「顧客を登録」または「CSVを取り込む」から追加できます。</div></td></tr>';
  $('#table-total').textContent=list.length+' 件中 '+(list.length?page*20+1:0)+'–'+Math.min(page*20+20,list.length)+' 件を表示';
  $('#page-label').textContent=(page+1)+' / '+pages;$('#prev-page').disabled=page===0;$('#next-page').disabled=page>=pages-1;
}
function render() {
  document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
  const main=$('#main');
  if(view==='customers') {
    const counts=[data.customers.length,data.customers.filter(c=>!status(c).reasons.length).length,data.reviews.filter(r=>r.status==='確認待ち').length,data.customers.filter(c=>status(c).stopped).length];
    main.innerHTML=heading('顧客一覧','名刺や登録情報を、一人ひとりの顧客につなげる。','<button class="button" data-view="import">↥ CSVを取り込む</button><button class="button primary" data-new>＋ 顧客を登録</button>')+
    `<section class="stats" aria-label="登録状況">${['登録顧客','同意記録あり','重複確認待ち','配信停止'].map((t,i)=>`<div class="stat"><span class="label">${t}</span><span class="stat-icon">${['▦','✓','◈','⊖'][i]}</span><div class="value">${counts[i]}<small>${i===2?'件':'人'}</small></div><span class="stat-note">${['登録済みの顧客','配信時には別途確認が必要','判断を待っている登録','再取込後も停止を維持'][i]}</span></div>`).join('')}</section>
    <section class="panel"><div class="panel-head"><h3>すべての顧客</h3><button class="button text" data-refresh>↻ 最新の情報に更新</button></div><div class="toolbar"><div class="search"><input id="search" aria-label="顧客を検索" placeholder="Sansanの全項目から検索" value="${esc(query)}"></div><select id="status-filter" aria-label="状態で絞り込む"><option value="all">すべての状態</option><option value="pending">確認待ち</option><option value="agreed">同意記録あり</option><option value="stopped">配信停止</option></select></div><div class="table-wrap"><table><thead><tr><th>氏名 / 顧客ID</th><th>会社 / 部署</th><th>メールアドレス</th><th>取得経路</th><th>管理状態</th><th></th></tr></thead><tbody id="customer-rows"></tbody></table></div><div class="table-foot"><span id="table-total"></span><div class="pagination"><button class="button" id="prev-page" aria-label="前のページ">‹</button><span id="page-label"></span><button class="button" id="next-page" aria-label="次のページ">›</button></div></div></section><div class="info-strip">ⓘ <span><strong>登録と購読同意は別々に管理します。</strong> 名刺交換・CSV取込だけでは「同意済み」になりません。</span></div>`;
    $('#status-filter').value=filter;customerRows();
  } else if(view==='import') {
    main.innerHTML=heading('Sansan CSV取込','原本を残し、重複候補を確認してから登録します。')+`<div class="two-col"><section class="panel"><div class="panel-head"><h3>CSVファイルを選択</h3>${pill('Sansan形式 · 60列','source')}</div><div class="panel-body"><label class="drop-zone"><div class="drop-icon">↥</div><h3>Sansanから出力したCSV</h3><p class="help">初期版：内容のある行200件まで・2MBまで</p><input id="csv-input" type="file" accept=".csv,text/csv" aria-label="Sansan CSVファイル"></label><label>文字コード<select id="encoding"><option value="UTF-8">UTF-8</option><option value="Shift_JIS">Shift_JIS（文字が読めない場合）</option></select></label><div id="csv-preview"><p class="note">列名と順番が見本と異なる場合は、登録を止めて確認します。</p></div></div></section><section class="panel"><div class="panel-head"><h3>取込の流れ</h3></div><div class="panel-body"><ol class="steps"><li><strong>ファイルを選んで内容を確認</strong>件数・空行・重複候補を表示します。</li><li><strong>原CSVを保管して登録</strong>元の60列と原本を保持。重複候補は確認待ちにします。</li><li><strong>同じ人かを判断</strong>「重複確認」で既存顧客への関連付け、または別人の登録を選びます。</li></ol><p class="note amber">停止中の顧客は、CSVを入れ直しても停止を維持します。購読同意は自動で付けません。</p></div></section></div>`;
    csvFile=null;
  } else if(view==='image') {
    main.innerHTML=heading('名刺から登録','スマホで撮影。読み取った内容を確認して、顧客として登録します。')+`<div class="two-col"><section class="panel"><div class="panel-head"><h3>名刺を撮影・選択</h3>${pill('JPEG / PNG','source')}</div><div class="panel-body"><label class="drop-zone"><div class="drop-icon">▣</div><h3>名刺の画像を選ぶ</h3><p class="help">明るい場所で、名刺全体をまっすぐ撮影してください。</p><input id="image-input" type="file" accept="image/jpeg,image/png" capture="environment" aria-label="名刺画像を撮影または選択"></label><p class="help">保存済み写真を選ぶ場合は、下の「写真から選ぶ」を使えます。</p><label>写真から選ぶ<input id="photo-input" type="file" accept="image/jpeg,image/png" aria-label="写真から選ぶ"></label><div id="image-preview"></div><button class="button primary" id="read-image" disabled>画像を保存して文字を読み取る</button><p class="file-meta">5MBまで。原画像と読取結果を設定したGoogle Driveフォルダに保存します。</p></div></section><section class="panel"><div class="panel-head"><h3>確認してから登録</h3></div><div class="panel-body"><ol class="steps"><li><strong>Googleで文字を読み取る</strong>画像をGoogleドキュメントへ変換して読み取ります。初回にDrive APIの設定が必要です。</li><li><strong>読み間違いを確認</strong>メール・電話は入力候補を表示。氏名・会社・部署を確認して入力します。</li><li><strong>重複を確認して保存</strong>既存のCSV・手入力データとも照合します。画像から購読同意は付けません。</li></ol><div id="ocr-result"></div></div></section></div>`;
    imageFile=null;
  } else if(view==='reviews') {
    const pending=data.reviews.filter(r=>r.status==='確認待ち');
    main.innerHTML=heading('重複確認','同じ人かもしれない登録を、人の判断で確認します。')+`<p class="note">同じ人なら既存顧客へ取得履歴を追加します。氏名・メール・同意・停止を自動で上書きしません。候補が同じCSV内にある場合は、まず片方を確認して登録してから、もう片方を関連付けられます。</p>`+(pending.length?pending.map(r=>{
      const current=CustomerCore.matches(r.incoming,data.customers);
      return `<article class="review-card" data-review="${esc(r.id)}"><div>${pill('確認待ち','amber')} <span class="file-meta">${esc(r.source)} · ${date(r.at)}</span></div><div class="review-grid"><div class="compare-box"><h3>新しく入ってきた情報</h3><strong>${esc(customerName(r.incoming)||'氏名未入力')}</strong>${esc(r.incoming.company)}<br>${esc(r.incoming.email||'メール未入力')}<br><span class="secondary">${esc(r.reason||'')}</span></div><div class="compare-box"><h3>既存顧客の候補</h3>${current.length?current.map(c=>`<strong>${esc(customerName(c))} / ${esc(c.company)}</strong>${esc(c.email)}<br><span class="file-meta">${esc(c.reasons.join('・'))}</span>`).join('<hr>'):'現在の一覧には一致候補がありません。同じCSV内の別行、または形式不備を確認してください。'}</div></div><label>判断の理由<input class="review-reason" placeholder="名刺の内容を確認して同じ人と判断、など" maxlength="1000"></label><div class="review-actions"><select class="review-target" aria-label="関連付け先の顧客"><option value="">関連付け先を選択</option>${current.map(c=>`<option value="${esc(c.id)}">${esc(customerName(c))} / ${esc(c.company)}</option>`).join('')}</select><button class="button primary" data-resolve="existing" ${current.length?'':'disabled'}>同じ人・関連付ける</button><button class="button" data-resolve="new">別人・新しく登録</button></div><p class="file-meta">${esc(r.id)}</p></article>`;
    }).join(''):'<div class="panel empty">確認待ちの候補はありません。</div>');
  } else {
    main.innerHTML=heading('取込・変更履歴','いつ、誰が、どの情報を登録・変更したかを確認できます。')+`<section class="panel"><div class="panel-head"><h3>CSV取込履歴</h3></div><div class="table-wrap"><table><thead><tr><th>ファイル</th><th>日時</th><th>新規登録</th><th>確認待ち</th><th>空行</th><th>原本</th></tr></thead><tbody>${data.imports.slice().reverse().map(x=>`<tr><td>${esc(x.name)}</td><td>${date(x.at)}</td><td>${x.created}件</td><td>${x.pending}件</td><td>${x.blank}件</td><td>${x.fileId?`<a href="https://drive.google.com/file/d/${encodeURIComponent(x.fileId)}/view" target="_blank" rel="noopener">開く ↗</a>`:'デモ内のみ'}</td></tr>`).join('')||'<tr><td colspan="6" class="empty">取込履歴はありません。</td></tr>'}</tbody></table></div></section><div style="height:24px"></div><section class="panel"><div class="panel-head"><h3>最近の変更（最大100件）</h3></div><div class="table-wrap"><table><thead><tr><th>日時</th><th>操作</th><th>担当者</th><th>記録ID</th></tr></thead><tbody>${data.events.map(x=>`<tr><td>${date(x.at)}</td><td>${esc(x.type)}</td><td>${esc(x.actor)}</td><td class="secondary">${esc(x.id.slice(0,18))}</td></tr>`).join('')||'<tr><td colspan="4" class="empty">変更履歴はありません。</td></tr>'}</tbody></table></div></section>`;
  }
}
function openEditor(c={}) {
  const form=$('#customer-form');buildCustomerFields(c);form.reset();$('#form-error').hidden=true;
  Array.from(form.elements).forEach(el=>{if(el.name && el.type!=='checkbox')el.value=c[el.name] || '';});
  form.elements.source.value=c.source || '手入力';form.elements.consent.value=c.consent || '名刺交換のみ';form.elements.source.disabled=Boolean(c.id);
  form.elements.version.value=c.version || '';
  const stopped=c.id?status(c).stopped:Boolean(c.stopped);form.elements.stopped.checked=stopped;form.elements.stopped.disabled=true;
  consentDateView();
  if(c.consentAt&&form.elements.consent.value!=='名刺交換のみ'){const d=new Date(c.consentAt);if(!isNaN(d))form.elements.consentAt.value=new Date(d-d.getTimezoneOffset()*60000).toISOString().slice(0,16);}
  const optOutAt=c.id?status(c).optOutAt:(c.optOutAt || '');
  $('#opt-out-at').value=optOutAt?new Date(optOutAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',hour12:false})+'（日本時間）':'未記録';
  $('#editor-title').textContent=c.id?'顧客情報を編集':'顧客を登録';
  $('#editor-hint').textContent=(c.id?'顧客IDは維持されます。メール変更時は、同意を未確認へ戻します。':c.imageId?'名刺画像の読取候補です。姓・名・会社・メールを確認して保存してください。':'姓・名・会社名・メールのいずれかを入力してください。保存時に重複を確認します。')+(c.name&&!c.familyName&&!c.givenName?' この登録は姓名が未分離です。元の全体表記を確認し、姓・名を入力してください。':'');
  $('#editor').showModal();
}
async function filePayload(file) {
  const buf=await file.arrayBuffer();let binary='';const bytes=new Uint8Array(buf);
  for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return {name:file.name,mime:file.type,base64:btoa(binary)};
}
async function csvPreview() {
  const target=$('#csv-preview');if(!csvFile)return;
  try {
    const text=new TextDecoder($('#encoding').value==='Shift_JIS'?'shift-jis':'utf-8',{fatal:true}).decode(await csvFile.arrayBuffer());
    const p=CustomerCore.csvPlan(text,data);
    target.innerHTML=`<h3>${esc(csvFile.name)}</h3><div class="preview-summary"><span><b>${p.items.length}</b>件</span><span><b>${p.candidates}</b>重複候補</span><span><b>${p.blank}</b>空行</span></div><div class="table-wrap"><table><thead><tr><th>氏名</th><th>会社</th><th>確認</th></tr></thead><tbody>${p.items.slice(0,8).map(x=>`<tr><td>${esc(customerName(x.incoming)||'未入力')}</td><td>${esc(x.incoming.company)}</td><td>${pill(x.matches.length?'重複候補':'新規候補',x.matches.length?'amber':'green')}</td></tr>`).join('')}</tbody></table></div><p class="file-meta">先頭8件を表示。登録時に最新データで再照合します。</p><label class="stop-box"><input id="confirm-import" type="checkbox"><span>内容と保存先を確認しました。原CSVを保管して登録します。</span></label><button class="button primary" id="commit-import">原本を保存して取り込む</button>`;
  } catch(e){target.innerHTML=`<div class="inline-error">${esc(e.message)}</div>`;}
}
async function act(task) {
  if(busy)return;busy=true;document.body.setAttribute('aria-busy','true');
  const buttons=Array.from(document.querySelectorAll('button:not(:disabled)'));buttons.forEach(b=>b.disabled=true);
  try{await task();}catch(e){tell(e.message,true);}finally{busy=false;buttons.forEach(b=>{if(b.isConnected)b.disabled=false;});document.body.removeAttribute('aria-busy');}
}
document.addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b||busy)return;
  if(b.dataset.view){view=b.dataset.view;render();}
  if(b.hasAttribute('data-new'))openEditor();
  if(b.dataset.edit)openEditor(data.customers.find(c=>c.id===b.dataset.edit));
  if(b.hasAttribute('data-close'))$('#editor').close();
  if(b.hasAttribute('data-refresh'))act(refresh);
  if(b.hasAttribute('data-initialize'))act(async()=>{data=await api('initializeApp');connection();render();tell('管理用のシートを作成しました。');});
  if(b.id==='prev-page'||b.id==='next-page'){page+=b.id==='next-page'?1:-1;customerRows();}
  if(b.id==='commit-import')act(async()=>{
    if(!$('#confirm-import').checked)throw new Error('内容と原本の保存を確認し、チェックしてください。');
    const input=await filePayload(csvFile);input.mime='text/csv';input.encoding=$('#encoding').value;
    data=await api('importSansan',input);tell(data.message);view='history';connection();render();
  });
  if(b.dataset.resolve)act(async()=>{
    const card=b.closest('[data-review]');
    data=await api('resolveDuplicate',{reviewId:card.dataset.review,mode:b.dataset.resolve,customerId:$('.review-target',card).value,reason:$('.review-reason',card).value});
    tell(data.message);connection();render();
  });
  if(b.id==='read-image')act(async()=>{
    const result=await api('readBusinessCard',await filePayload(imageFile));data=result;connection();
    const image=result.image;
    if(!image){throw new Error('画像の処理状態を確認してください。履歴を更新してから再試行してください。');}
    $('#ocr-result').innerHTML=`<p class="note">${esc(result.message)}</p><label>読取結果（要確認）<textarea readonly rows="8">${esc(image.text||'デモでは文字読取を実行しません。GAS版で利用できます。')}</textarea></label><button class="button primary" id="use-card">内容を確認して入力する</button>`;
    $('#use-card').onclick=()=>openEditor(Object.assign({source:'名刺画像',imageId:image.id,consent:'名刺交換のみ'},image.suggestions||{}));
    tell(result.message);
  });
});
document.addEventListener('input',e=>{if(e.target.id==='search'){query=e.target.value;page=0;customerRows();}if(['cardExchangedAt','sansanRegisteredAt'].includes(e.target.name))consentDateView();});
document.addEventListener('change',async e=>{
  if(e.target.name==='consent')consentDateView();
  if(e.target.id==='status-filter'){filter=e.target.value;page=0;customerRows();}
  if(e.target.id==='csv-input'){csvFile=e.target.files[0];if(csvFile&&csvFile.size>2*1024*1024){csvFile=null;tell('CSVは2MBまでです。',true);return;}await csvPreview();}
  if(e.target.id==='encoding')await csvPreview();
  if(['image-input','photo-input'].includes(e.target.id)) {
    const f=e.target.files[0];if(!f)return;
    if(!['image/jpeg','image/png'].includes(f.type)||f.size>5*1024*1024){tell('5MB以下のJPEG・PNGを選んでください。',true);return;}
    imageFile=f;if(imageUrl)URL.revokeObjectURL(imageUrl);imageUrl=URL.createObjectURL(f);
    const img=document.createElement('img');img.src=imageUrl;img.alt='選択した名刺';img.className='image-preview';$('#image-preview').replaceChildren(img);$('#read-image').disabled=false;$('#ocr-result').replaceChildren();
  }
});
buildCustomerFields();
$('#customer-form').addEventListener('submit',e=>{
  e.preventDefault();act(async()=>{
    const form=e.target,input=Object.fromEntries(new FormData(form));input.source=form.elements.source.value;input.stopped=form.elements.stopped.checked;
    if(input.consentAt&&input.consent!=='名刺交換のみ')input.consentAt=new Date(input.consentAt).toISOString();
    try {data=await api('saveCustomer',input);$('#editor').close();tell(data.message);connection();render();}
    catch(err){$('#form-error').textContent=err.message;$('#form-error').hidden=false;$('#form-error').scrollIntoView({block:'nearest'});}
  });
});
refresh().catch(e=>{
  window.appBoot.ready();
  const needsSetup=/setupApp/.test(e.message);
  $('#main').innerHTML='<div class="panel empty"><h2>'+(needsSetup?'最初の設定を行います':'読み込めませんでした')+'</h2><p>'+esc(needsSetup?'接続先のスプレッドシートに、顧客一覧と履歴用の管理シートを作成します。既存のシートは削除しません。':e.message)+'</p><button class="button '+(needsSetup?'primary':'')+'" '+(needsSetup?'data-initialize':'data-refresh')+'>'+(needsSetup?'管理シートを作成して始める':'再読込')+'</button></div>';
  if(!needsSetup)tell(e.message,true);
});
