/** Run setupApp once from the editor after setting the three Script Properties. */
function setupApp() {
  const cfg = config_(); authorize_();
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const db = SpreadsheetApp.openById(cfg.spreadsheetId);
    Object.keys(TABLE_NAMES_).forEach(key => {
      const name = TABLE_NAMES_[key];
      if (!db.getSheetByName(name)) {
        const sh = db.insertSheet(name);
        fitColumns_(sh,COLUMNS_[key].length);
        sh.getRange(1,1,1,COLUMNS_[key].length).setValues([COLUMNS_[key].map(x=>x[1])]);
        sh.setFrozenRows(1); sh.getRange(1,1,1,COLUMNS_[key].length).setBackground('#143c37').setFontColor('#ffffff');
      }
    });
    if (!db.getSheetByName('処理の復旧記録')) db.insertSheet('処理の復旧記録').appendRow(['処理ID','状態','種別','連番','内容']);
    DriveApp.getFolderById(cfg.folderId).getName();
    console.log('初期設定完了。顧客データは登録していません。');
  } finally { lock.releaseLock(); }
}
function doGet() {
  authorize_();
  return HtmlService.createHtmlOutputFromFile('Index').setTitle('顧客データ管理 | 総研').addMetaTag('viewport','width=device-width, initial-scale=1');
}
function showMyAccount() {
  console.log('ALLOWED_USERSに設定するメール：'+Session.getActiveUser().getEmail());
}
function getAppData() {
  return locked_(function(db,actor) { return response_(readState_(db),actor,db); });
}
function initializeApp() {
  setupApp();
  return getAppData();
}
function saveCustomer(input) {
  return mutate_('顧客保存',input,function(s,ctx){return CustomerCore.save(s,input,ctx);});
}
// Private server operation. A future recipient endpoint must verify its signed link
// and explicit confirmation before creating this receipt. Never expose this via google.script.run.
function recordConfirmedOptOut_(input) {
  return mutate_('受信者オプトアウト',input,function(s,ctx){return CustomerCore.confirmOptOut(s,input,ctx);});
}
function resolveDuplicate(input) {
  return mutate_('重複判断',input,function(s,ctx){return CustomerCore.resolve(s,input,ctx);});
}
function importSansan(input) {
  return mutate_('CSV取込',input,function(s,ctx){
    const file = decodeFile_(input,2*1024*1024,['text/csv','application/octet-stream','application/vnd.ms-excel']);
    const text = file.blob.getDataAsString(input.encoding === 'Shift_JIS' ? 'Shift_JIS' : 'UTF-8');
    CustomerCore.csvPlan(text,s);
    if (s.imports.some(x=>x.hash===file.hash)) throw new Error('同じCSVは取込済みです。');
    const archived = archiveFile_(file,ctx,'CSV');
    return CustomerCore.importCsv(s,text,{name:input.name,hash:file.hash,fileId:archived.getId(),encoding:input.encoding || 'UTF-8'},ctx);
  });
}
function readBusinessCard(input) {
  return mutate_('名刺画像受付',input,function(s,ctx){
    const file = decodeFile_(input,5*1024*1024,['image/jpeg','image/png']);
    // Verify file signatures as well as the client-provided MIME type.
    const bytes = file.blob.getBytes().map(x=>(x+256)%256);
    if (input.mime === 'image/jpeg' ? !(bytes[0]===255&&bytes[1]===216&&bytes[2]===255) : !(bytes.slice(0,8).join(',')==='137,80,78,71,13,10,26,10')) throw new Error('JPEGまたはPNGの画像を選んでください。');
    const previous = s.images.find(x=>x.hash===file.hash);
    if (previous && previous.ocrStatus === '読取済み・要確認') return {state:s,message:'保存済みの画像を表示しました。',image:previous};
    const image = previous || {id:ctx.id('IMG'),at:ctx.now,name:input.name,hash:file.hash,fileId:archiveFile_(file,ctx,'名刺').getId(),actor:ctx.actor,text:'',ocrStatus:'未実行'};
    if (!previous) s.images.push(image);
    try {
      const doc = Drive.Files.create({name:'文字読取_'+image.id+'_'+image.name,mimeType:'application/vnd.google-apps.document',parents:[config_().folderId]},file.blob,{ocrLanguage:'ja',fields:'id'});
      image.ocrFileId = doc.id;
      image.text = DocumentApp.openById(doc.id).getBody().getText();
      if (image.text.length > 20000) image.text = image.text.slice(0,20000);
      image.ocrStatus = '読取済み・要確認';
      image.ocrError = '';
    } catch (err) {
      image.ocrStatus = '読取未完了';
      image.ocrError = '画像は保存しました。Drive APIの有効化・権限・画像の鮮明さを確認し、手入力で続けてください。';
    }
    image.suggestions = CustomerCore.suggest(image.text);
    s.events.push({id:ctx.id('EV'),at:ctx.now,actor:ctx.actor,type:'名刺画像受付',data:{imageId:image.id,ocrStatus:image.ocrStatus}});
    return {state:s,message:image.ocrStatus==='読取未完了'?image.ocrError:'読み取った内容を確認し、氏名・会社名を入力してください。',image};
  });
}

var TABLE_NAMES_ = {customers:'顧客一覧',reviews:'重複確認',imports:'取込履歴',raw:'CSV原行',events:'変更履歴',images:'名刺画像',stops:'停止台帳'};
var COLUMNS_ = {
  customers:null,
  reviews:[['id','候補ID'],['status','状態'],['source','取得経路'],['at','受付日時'],['reason','判断理由'],['customerId','関連顧客ID'],['$json','管理用記録JSON']],
  imports:[['id','取込ID'],['name','ファイル名'],['at','取込日時'],['count','内容あり'],['blank','空行'],['created','新規'],['pending','確認待ち'],['fileId','原本Drive ID'],['$json','管理用記録JSON']],
  raw:[['id','原行ID'],['batchId','取込ID'],['record','CSVレコード番号'],['$json','原値JSON']],
  events:[['id','記録ID'],['at','日時'],['actor','操作者'],['type','操作'],['$json','変更前後JSON']],
  images:[['id','画像ID'],['at','日時'],['name','ファイル名'],['fileId','原本Drive ID'],['ocrStatus','文字読取状態'],['$json','管理用記録JSON']],
  stops:[['id','停止ID'],['customerId','顧客ID'],['email','対象メール'],['at','受付日時'],['optOutAt','オプトアウト日時'],['origin','受付経路'],['receiptId','受信者確認記録ID'],['reason','理由'],['actor','操作者'],['$json','管理用記録JSON']]
};
function config_() {
  // Initialize after all GAS files have loaded; file execution order is not a dependency.
  if(!COLUMNS_.customers)COLUMNS_.customers=[['id','顧客ID']].concat(CustomerCore.CSV_FIELDS.map(f=>[f.key,f.label]),[['source','取得経路'],['consent','購読同意'],['consentAt','同意日・日時'],['consentDateSource','同意日の参照項目'],['consentMethod','同意の確認方法'],['consentEvidence','同意の証拠・記録場所'],['stopped','配信停止'],['stopAt','配信停止記録日時'],['optOutAt','オプトアウト日時'],['stopReason','停止理由'],['updatedAt','更新日時'],['version','版番号'],['$json','管理用記録JSON']]);
  const p = PropertiesService.getScriptProperties();
  const spreadsheetId = p.getProperty('SPREADSHEET_ID'), folderId = p.getProperty('ARCHIVE_FOLDER_ID');
  const allowed = (p.getProperty('ALLOWED_USERS') || '').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
  if (!spreadsheetId || !folderId || !allowed.length) throw new Error('導入設定が未完了です。SPREADSHEET_ID・ARCHIVE_FOLDER_ID・ALLOWED_USERSを設定してください。');
  return {spreadsheetId,folderId,allowed};
}
function authorize_() {
  const actor = Session.getActiveUser().getEmail().toLowerCase();
  if (!actor || !config_().allowed.includes(actor)) throw new Error('このアカウントでは利用できません。許可されたGoogleアカウントで開いてください。');
  return actor;
}
function locked_(fn) {
  const actor = authorize_(), lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const db = SpreadsheetApp.openById(config_().spreadsheetId);
    if (!db.getSheetByName('処理の復旧記録')) throw new Error('先にsetupAppを実行してください。');
    recover_(db);
    return fn(db,actor);
  } finally { lock.releaseLock(); }
}
function mutate_(label,input,fn) {
  if (!input || !/^[a-zA-Z0-9-]{10,100}$/.test(input.operationId || '')) throw new Error('操作番号がありません。画面を再読み込みしてください。');
  return locked_(function(db,actor){
    const s = readState_(db);
    const completed = s.events.find(x=>x.operationId===input.operationId);
    if (completed) {
      const answer=Object.assign(response_(s,actor,db),{message:'保存済みの操作です。再登録はしていません。'});
      if(completed.imageId)answer.image=s.images.find(x=>x.id===completed.imageId);
      return answer;
    }
    const ctx = {actor,now:new Date().toISOString(),id:function(prefix){return prefix+'-'+Utilities.getUuid();}};
    const result = fn(s,ctx);
    if (result.state.customers.length > 2000) throw new Error('初期版の顧客上限2,000件を超えます。拡張が必要です。');
    result.state.events.push({id:ctx.id('EV'),at:ctx.now,actor,type:label+'完了',operationId:input.operationId,imageId:result.image?result.image.id:''});
    persist_(db,result.state,input.operationId);
    const answer = response_(result.state,actor,db); answer.message=result.message;
    if (result.image) answer.image=result.image;
    return answer;
  });
}
function readState_(db) {
  const s = CustomerCore.empty();
  CustomerCore.TABLES.forEach(key=>{
    const sh = db.getSheetByName(TABLE_NAMES_[key]);
    if (!sh) throw new Error('管理シートが不足しています。setupAppを実行してください。');
    const headers=sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
    const jsonColumn=headers.indexOf(COLUMNS_[key].find(c=>c[0]==='$json')[1])+1;
    if(!jsonColumn)throw new Error('管理用記録の列が見つかりません。シートの見出しを確認してください：'+TABLE_NAMES_[key]);
    if (sh.getLastRow()>1) s[key]=sh.getRange(2,jsonColumn,sh.getLastRow()-1,1).getValues().filter(r=>r[0]).map(r=>JSON.parse(r[0]));
  });
  return CustomerCore.hydrate(s);
}
function fitColumns_(sh,count) { if(sh.getMaxColumns()<count)sh.insertColumnsAfter(sh.getMaxColumns(),count-sh.getMaxColumns()); }
function cell_(v) {
  if (v === true) return '停止中'; if (v === false) return '';
  const text = String(v == null ? '' : v);
  return /^[=+\-@'\t\r\n]/.test(text) ? "'"+text : text;
}
function project_(db,state) {
  CustomerCore.hydrate(state);
  CustomerCore.TABLES.forEach(key=>{
    const sh = db.getSheetByName(TABLE_NAMES_[key]), cols=COLUMNS_[key];
    const rows=state[key].map(record=>cols.map(col=>col[0]==='$json'?JSON.stringify(record):cell_(record[col[0]])));
    if (rows.some(r=>r.some(v=>String(v).length>45000))) throw new Error('1セルの保存上限を超えます。管理者に連絡してください。');
    fitColumns_(sh,cols.length);
    sh.getRange(1,1,1,cols.length).setValues([cols.map(c=>c[1])]);
    if (sh.getMaxRows()<rows.length+1) sh.insertRowsAfter(sh.getMaxRows(),rows.length+1-sh.getMaxRows());
    if (rows.length) sh.getRange(2,1,rows.length,cols.length).setNumberFormat('@').setValues(rows);
    if (sh.getLastRow()>rows.length+1) sh.getRange(rows.length+2,1,sh.getLastRow()-rows.length-1,cols.length).clearContent();
  });
  SpreadsheetApp.flush();
}
function persist_(db,state,op) {
  // Write a complete recovery plan before touching the data tables. A retry repairs partial writes.
  const json=JSON.stringify(state), chunks=[];
  Object.keys(state).forEach(key=>state[key].forEach(x=>{if(JSON.stringify(x).length>45000)throw new Error('保存できる記録サイズを超えています。');}));
  for(let i=0;i<json.length;i+=30000) chunks.push(json.slice(i,i+30000));
  const sh=db.getSheetByName('処理の復旧記録');
  const first=sh.getLastRow()+1, rows=chunks.map((x,i)=>[op,'準備','chunk',i,JSON.stringify(x)]);
  rows.push([op,'未反映','commit',chunks.length,'']);
  if(sh.getMaxRows()<first+rows.length) sh.insertRowsAfter(sh.getMaxRows(),first+rows.length-sh.getMaxRows());
  sh.getRange(first,1,rows.length,5).setNumberFormat('@').setValues(rows); SpreadsheetApp.flush();
  project_(db,state);
  sh.getRange(first+chunks.length,2).setValue('反映済み'); SpreadsheetApp.flush();
}
function recover_(db) {
  const sh=db.getSheetByName('処理の復旧記録');
  if(sh.getLastRow()<2)return;
  const rows=sh.getRange(2,1,sh.getLastRow()-1,5).getValues();
  rows.forEach((r,i)=>{
    if(r[2]!=='commit'||r[1]!=='未反映')return;
    const chunks=rows.filter(x=>x[0]===r[0]&&x[2]==='chunk').sort((a,b)=>Number(a[3])-Number(b[3]));
    if(chunks.length!==Number(r[3]))throw new Error('復旧記録が不足しています。操作を停止しました。');
    const state=JSON.parse(chunks.map(x=>JSON.parse(x[4])).join(''));
    project_(db,state); sh.getRange(i+2,2).setValue('反映済み'); SpreadsheetApp.flush();
  });
}
function response_(s,actor,db) {
  return {customers:s.customers,reviews:s.reviews,imports:s.imports,stops:s.stops,images:s.images,events:s.events.slice(-100).reverse(),actor,mode:'gas',spreadsheetUrl:db.getUrl()};
}
function decodeFile_(input,max,mimes) {
  if(!input.name||typeof input.name!=='string'||input.name.length>200||!mimes.includes(input.mime)||typeof input.base64!=='string'||input.base64.length>Math.ceil(max/3)*4+4) throw new Error('ファイルの種類・サイズを確認してください。');
  const bytes=Utilities.base64Decode(input.base64);
  if(!bytes.length||bytes.length>max)throw new Error('ファイルが空か、サイズ上限を超えています。');
  const blob=Utilities.newBlob(bytes,input.mime,input.name);
  const hash=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,bytes).map(x=>('0'+((x+256)%256).toString(16)).slice(-2)).join('');
  return {blob,hash};
}
function archiveFile_(file,ctx,prefix) {
  const folder=DriveApp.getFolderById(config_().folderId);
  const f=folder.createFile(file.blob);f.setName(prefix+'_'+ctx.id('SRC')+'_'+file.blob.getName());
  return f;
}
