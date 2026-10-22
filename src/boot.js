/* Keep this guard independent of the application bundle so startup errors remain visible. */
(function () {
  var complete = false;
  function failure(message) {
    if (complete) return;
    clearTimeout(timer);
    var main = document.getElementById('main');
    var box = document.createElement('div'); box.className = 'panel empty';
    var title = document.createElement('h2'); title.textContent = '読み込めませんでした';
    var detail = document.createElement('p'); detail.textContent = message;
    var button = document.createElement('button'); button.className = 'button'; button.textContent = '画面を再読み込み';
    button.onclick = function () { window.location.reload(); };
    box.appendChild(title); box.appendChild(detail); box.appendChild(button); main.replaceChildren(box);
    document.getElementById('mode-banner').textContent = '読込を完了できませんでした';
    document.getElementById('side-connection').textContent = '接続未確認';
  }
  window.appBoot = {
    ready: function () { complete = true; clearTimeout(timer); },
    fail: failure
  };
  window.addEventListener('error', function (event) {
    failure('画面の起動処理でエラーが発生しました。詳細：' + event.message + '（' + event.filename.split('/').pop().split('?')[0] + '、行 ' + event.lineno + '、列 ' + event.colno + '）');
  });
  var timer = setTimeout(function () {
    failure('読込に時間がかかっています。画面を再読み込みしてください。解消しない場合は、この表示を担当者にお知らせください。');
  }, 45000);
}());
