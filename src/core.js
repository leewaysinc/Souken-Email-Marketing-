/* Shared by GAS and the local preview. No network or Google dependencies. */
var CustomerCore = (function () {
  'use strict';
  const HEADERS = '会社名,会社名（英名）,会社名（カナ）,部署名,役職,氏名,氏名［姓］,氏名［名］,氏名（カナ）,氏名（カナ）［姓］,氏名（カナ）［名］,国,郵便番号(1),住所(1)［全て］,住所(1)［都道府県］,住所(1)［市区町村］,住所(1)［番地］,住所(1)［ビル名］,TEL-1(1),TEL-2(1),FAX(1),携帯電話(1),Email(1),URL(1),郵便番号(2),住所(2)［全て］,住所(2)［都道府県］,住所(2)［市区町村］,住所(2)［番地］,住所(2)［ビル名］,TEL-1(2),TEL-2(2),FAX(2),携帯電話(2),Email(2),URL(2),重要度区分,VP,CP,ファイル出力済み,タグ,登録日,名刺交換日,人事異動発令日,不達フラグ(住所),不達フラグ(TEL),不達フラグ(FAX),不達フラグ(メール),メモ,自動追記メモ,名刺所有者ユーザID,名刺所有者名,名刺所有者所属部署名,人物ID,名刺ID,会社ID,データ化状況,法人番号,SOC (Sansan Organization Code),（空欄）'.split(',');
  const TABLES = ['customers', 'reviews', 'imports', 'raw', 'events', 'images', 'stops'];
  const FIELD_KEYS = 'company,companyEn,companyKana,department,title,name,familyName,givenName,kana,familyKana,givenKana,country,postal1,address1,prefecture1,city1,street1,building1,phone,phone2_1,fax1,mobile1,email,url1,postal2,address2,prefecture2,city2,street2,building2,phone1_2,phone2_2,fax2,mobile2,email2,url2,importance,vp,cp,fileExported,tags,sansanRegisteredAt,cardExchangedAt,personnelChangeAt,bounceAddress,bouncePhone,bounceFax,bounceEmail,memo,autoMemo,ownerUserId,ownerName,ownerDepartment,personId,cardId,companyId,dataStatus,corporateNumber,soc,reservedColumn'.split(',');
  const CSV_FIELDS = HEADERS.map((label,i)=>({key:FIELD_KEYS[i],label,group:i<5?'会社情報':i<11?'氏名の元表記':i<24?'住所・連絡先1':i<36?'住所・連絡先2':'Sansan管理情報'}));
  const TEXT_FIELDS = FIELD_KEYS.concat(['consentAt','consentMethod','consentEvidence','stopReason']);
  const longField = k => ['memo','autoMemo','address1','address2','tags'].includes(k);
  const copy = x => JSON.parse(JSON.stringify(x));
  const norm = s => String(s || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  const mail = s => String(s || '').trim().toLowerCase(); // Used for conservative matching, never rewrites delivery addresses.
  const emailValid = s => !s || /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(s);
  const structuredName = c => Boolean(c.familyName || c.givenName);
  function displayName(c) { return structuredName(c) ? [c.familyName,c.givenName].filter(Boolean).join(' ') : (c.name || ''); }
  function displayKana(c) { return c.familyKana || c.givenKana ? [c.familyKana,c.givenKana].filter(Boolean).join(' ') : (c.kana || ''); }
  function csvValues(c) { return CSV_FIELDS.map(f=>String(c[f.key] == null ? '' : c[f.key])); }
  function hydrate(state) {
    const records=state.customers.concat(state.reviews.map(r=>r.incoming));
    records.forEach(c=>{
      const raw=state.raw.find(r=>r.batchId===c.batchId && r.record===c.record && c.batchId);
      if(raw)CSV_FIELDS.forEach((f,i)=>{if(c[f.key]===undefined)c[f.key]=String(raw.values[i] == null ? '' : raw.values[i]);});
    });
    return state;
  }
  function empty() { return Object.fromEntries(TABLES.map(k => [k, []])); }
  function parseCsv(input) {
    const text = String(input).replace(/^\uFEFF/, '');
    const rows = []; let row = [], field = '', quoted = false, after = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i+1] === '"') { field += '"'; i++; }
        else if (c === '"') { quoted = false; after = true; }
        else field += c;
      } else if (c === '"' && !field && !after) quoted = true;
      else if (c === ',') { row.push(field); field = ''; after = false; }
      else if (c === '\r' || c === '\n') {
        row.push(field); rows.push(row); row = []; field = ''; after = false;
        if (c === '\r' && text[i+1] === '\n') i++;
      } else {
        if (after || c === '"') throw new Error('CSVの引用符が不正です。取込は行っていません。');
        field += c;
      }
    }
    if (quoted) throw new Error('CSVの引用符が閉じられていません。');
    if (field || row.length || after) { row.push(field); rows.push(row); }
    if (!rows.length) throw new Error('CSVが空です。');
    return rows;
  }
  function csvPlan(text, state) {
    if (String(text).includes('\uFFFD')) throw new Error('読み取れない文字があります。文字コードを選び直してください。');
    const rows = parseCsv(text), headers = rows.shift();
    if (headers.length !== HEADERS.length || headers.some((h,i) => h !== HEADERS[i])) throw new Error('見本のSansan形式（60列）と列名・順番が異なります。原本を変更せず、列対応を確認してください。');
    let blank = 0;
    const items = [];
    rows.forEach((values,i) => {
      if (values.every(v => !v.trim())) { blank++; return; }
      if (values.length !== headers.length) throw new Error('CSVレコード ' + (i+2) + ' の列数が異なります。');
      if (JSON.stringify(values).length > 40000) throw new Error('1行が大きすぎます。レコード ' + (i+2));
      const incoming = Object.assign(Object.fromEntries(CSV_FIELDS.map((f,i)=>[f.key,values[i]])),{source:'Sansan',consent:'未確認',stopped:false});
      items.push({record:i+2,values,incoming});
    });
    if (!items.length) throw new Error('登録できる内容のある行がありません。');
    if (items.length > 200) throw new Error('初期版は1回200件までです。原本を保管したうえで分割出力してください。');
    const pool = state.customers.concat(items.map(x => Object.assign({id:'CSV-'+x.record},x.incoming)));
    items.forEach(x => { x.matches = matches(x.incoming,pool,'CSV-'+x.record); });
    return {headers,items,total:rows.length,blank,candidates:items.filter(x=>x.matches.length).length};
  }
  function matches(c, customers, except) {
    return customers.filter(x => x.id !== except).flatMap(x => {
      const why = [];
      if (c.personId && c.personId === x.personId && c.source === x.source) why.push('人物IDが一致');
      if (c.cardId && c.cardId === x.cardId && c.source === x.source) why.push('名刺IDが一致');
      const emails = [x.email,x.email2].map(mail).filter(Boolean);
      if ([c.email,c.email2].map(mail).filter(Boolean).some(e => emails.includes(e))) why.push('メールが一致');
      if (c.company && x.company && norm(c.company) === norm(x.company)) {
        if (structuredName(c) && structuredName(x)) {
          if (norm(c.familyName)===norm(x.familyName) && norm(c.givenName)===norm(x.givenName)) why.push('姓・名と会社が一致');
        } else if(displayName(c) && norm(displayName(c))===norm(displayName(x))) why.push('氏名の全体表記と会社が一致（姓名未分離を含む）');
      }
      return why.length ? [{id:x.id,name:displayName(x),familyName:x.familyName,givenName:x.givenName,company:x.company,email:x.email,reasons:why}] : [];
    });
  }
  function validate(c) {
    if (![c.familyName,c.givenName,c.name,c.company,c.email].some(v => String(v || '').trim())) throw new Error('姓・名・会社名・メールのいずれかを入力してください。');
    TEXT_FIELDS.forEach(k => { if (String(c[k] || '').length > (longField(k) ? 5000 : 1000)) throw new Error('入力が長すぎます：'+k); });
    if (!emailValid(c.email) || !emailValid(c.email2)) throw new Error('メールの形式を確認してください。');
    if (!['未確認','確認手続中','同意済み','拒否'].includes(c.consent)) throw new Error('同意状態が不正です。');
    if (!['Sansan','手入力','名刺画像','Web','その他'].includes(c.source)) throw new Error('取得経路が不正です。');
    if (c.consent === '同意済み' && (!c.email || !c.consentAt || !c.consentMethod || !c.consentEvidence || !Number.isFinite(Date.parse(c.consentAt)))) throw new Error('同意済みには、メール・有効な同意日時・確認方法・証拠の記録が必要です。');
  }
  function event(s,ctx,type,data) { s.events.push({id:ctx.id('EV'),at:ctx.now,actor:ctx.actor,type,data}); }
  function stop(s,c,ctx,reason) {
    if (!s.stops.some(x => x.customerId === c.id && x.email === mail(c.email))) s.stops.push({id:ctx.id('STOP'),customerId:c.id,email:mail(c.email),at:ctx.now,reason:reason || '画面で停止',actor:ctx.actor});
    c.stopped = true; c.stopAt = c.stopAt || ctx.now;
  }
  function make(c,ctx) { return Object.assign({id:ctx.id('C'),version:1,createdAt:ctx.now,updatedAt:ctx.now,consent:'未確認',stopped:false,source:'手入力'},c); }
  function save(state,input,ctx) {
    const s = copy(state), old = s.customers.find(c => c.id === input.id);
    if (input.id && !old) throw new Error('顧客が見つかりません。一覧を更新してください。');
    if (old && old.version !== Number(input.version)) throw new Error('別の操作で更新されています。一覧を更新してやり直してください。');
    const c = old ? copy(old) : make({},ctx);
    TEXT_FIELDS.forEach(k => { if(Object.prototype.hasOwnProperty.call(input,k))c[k] = String(input[k] == null ? '' : input[k]);else if(!old)c[k]=''; });
    c.source = old ? old.source : (input.source || '手入力');
    c.consent = input.consent || '未確認';
    c.stopped = Boolean(old && old.stopped) || input.stopped === true;
    if (old && old.stopped && input.stopped !== true) throw new Error('この初期版では停止を解除できません。');
    if (old && mail(old.email) !== mail(c.email)) {
      c.consent = '未確認'; c.consentAt = ''; c.consentMethod = ''; c.consentEvidence = '';
    }
    if (c.consent === '拒否') c.stopped = true;
    if (input.imageId) {
      if (!s.images.some(x => x.id === input.imageId)) throw new Error('名刺画像の保存記録が見つかりません。');
      c.imageId = input.imageId;
    }
    validate(c);
    const candidates = matches(c,s.customers,c.id);
    if (!old && candidates.length) {
      // A stop request must take effect even while the person's identity is unresolved.
      if (c.stopped) stop(s,c,ctx,c.stopReason || '重複確認中の停止申出');
      const r = {id:ctx.id('REV'),incoming:c,matches:candidates,status:'確認待ち',at:ctx.now,source:c.source};
      s.reviews.push(r); event(s,ctx,'重複候補の受付',{reviewId:r.id,incoming:c});
      return {state:s,message:'重複候補が見つかりました。「重複確認」で判断してください。',reviewId:r.id};
    }
    c.version = old ? old.version+1 : 1; c.updatedAt = ctx.now;
    if (c.stopped) stop(s,c,ctx,c.stopReason);
    if (old) s.customers[s.customers.findIndex(x=>x.id===c.id)] = c;
    else s.customers.push(c);
    event(s,ctx,old?'顧客編集':'顧客登録',{before:old || null,after:c});
    return {state:s,message:'顧客情報を保存しました。',id:c.id};
  }
  function importCsv(state,text,meta,ctx) {
    const s = copy(state);
    if (s.imports.some(x=>x.hash===meta.hash)) throw new Error('同じ内容のCSVは取込済みです。取込履歴を確認してください。');
    const plan = csvPlan(text,s), batch = Object.assign({id:ctx.id('IMP'),at:ctx.now,actor:ctx.actor,status:'完了',total:plan.total,blank:plan.blank,count:plan.items.length,created:0,pending:0,headers:plan.headers},meta);
    plan.items.forEach(item => {
      const c = make(item.incoming,ctx);
      s.raw.push({id:ctx.id('RAW'),batchId:batch.id,record:item.record,values:item.values});
      c.batchId = batch.id; c.record = item.record;
      // Match the complete file as well as existing customers. Future rows also block auto registration.
      if (item.matches.length || !emailValid(c.email) || !emailValid(c.email2)) {
        s.reviews.push({id:ctx.id('REV'),incoming:c,matches:item.matches,status:'確認待ち',at:ctx.now,source:'Sansan',reason:!emailValid(c.email)||!emailValid(c.email2)?'メール形式の確認が必要':''});
        batch.pending++;
      } else { s.customers.push(c); batch.created++; }
    });
    s.imports.push(batch); event(s,ctx,'CSV取込',{batchId:batch.id,created:batch.created,pending:batch.pending});
    return {state:s,message:batch.created+'件を登録、'+batch.pending+'件を確認待ちにしました。',id:batch.id};
  }
  function resolve(state,input,ctx) {
    const s = copy(state), r = s.reviews.find(x=>x.id===input.reviewId);
    if (!r || r.status !== '確認待ち') throw new Error('この候補は処理済みです。一覧を更新してください。');
    if (!String(input.reason || '').trim()) throw new Error('判断の理由を入力してください。');
    let target;
    if (input.mode === 'existing') {
      target = s.customers.find(x=>x.id===input.customerId);
      if (!target) throw new Error('関連付け先の顧客を選んでください。');
      if (!matches(r.incoming,[target]).length) throw new Error('関連付け先を確認してください。一致する根拠がありません。');
      // Linking a contact never overwrites an existing name, address, consent or stop state.
      if (status(s,r.incoming).stopped) stop(s,target,ctx,'関連付け元の停止を維持');
      target.version++; target.updatedAt = ctx.now;
    } else if (input.mode === 'new') {
      target = make(r.incoming,ctx);
      validate(target);
      target.id = ctx.id('C');
      if (status(s,target).stopped) stop(s,target,ctx,'メールアドレスの既存停止');
      s.customers.push(target);
    } else throw new Error('同じ人または別人を選んでください。');
    r.status = input.mode === 'existing' ? '既存顧客へ関連付け' : '別人として登録';
    r.customerId = target.id; r.reason = input.reason.trim(); r.resolvedAt = ctx.now; r.resolvedBy = ctx.actor;
    event(s,ctx,'重複判断',{reviewId:r.id,customerId:target.id,mode:input.mode,reason:r.reason,incoming:r.incoming});
    return {state:s,message:'判断を保存しました。元データと既存の同意・停止は保持しています。'};
  }
  function status(s,c) {
    const emails = [c.email,c.email2].map(mail).filter(Boolean);
    const stopped = c.stopped || s.stops.some(x=>x.customerId===c.id || (x.email && emails.includes(x.email)));
    const duplicate = matches(c,s.customers,c.id).some(m=>m.reasons.includes('メールが一致')) || s.reviews.some(r=>r.status==='確認待ち' && (matches(c,[r.incoming]).length || r.matches.some(m=>m.id===c.id)));
    const reasons = [];
    if (stopped) reasons.push('配信停止');
    if (duplicate) reasons.push('重複・共有宛先の確認待ち');
    if (!c.email || !emailValid(c.email)) reasons.push('宛先の確認待ち');
    if (c.email2) reasons.push('配信用宛先の選択待ち');
    if (c.consent !== '同意済み' || !c.consentAt || !c.consentMethod || !c.consentEvidence) reasons.push('受信希望の確認待ち');
    return {stopped,duplicate,reasons,label:stopped?'配信停止':reasons.length?'確認待ち':'同意記録あり'};
  }
  function suggest(text) {
    return {email:(String(text).match(/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/i)||[''])[0],phone:(String(text).match(/(?:\+81[\s-]?)?0?\d{1,4}[-ー\s]\d{1,4}[-ー\s]\d{3,4}/)||[''])[0]};
  }
  return {HEADERS,CSV_FIELDS,TEXT_FIELDS,TABLES,empty,parseCsv,csvPlan,matches,validate,save,importCsv,resolve,status,suggest,mail,copy,displayName,displayKana,csvValues,hydrate,longField};
})();
if (typeof module !== 'undefined') module.exports = CustomerCore;
