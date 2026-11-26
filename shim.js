/* Apps Script 의 google.script.run 호출을 Netlify 함수(/api/<함수명>) 호출로 바꿔 주는 어댑터 */
(function () {
  function mk(ok, err) {
    return new Proxy({}, {
      get: function (_, name) {
        if (name === 'withSuccessHandler') return function (f) { return mk(f, err); };
        if (name === 'withFailureHandler') return function (f) { return mk(ok, f); };
        return function () {
          var a = Array.prototype.slice.call(arguments);
          fetch('/api/' + String(name), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a: a }) })
            .then(function (r) { return r.json(); })
            .then(function (j) { if (j.ok) { if (ok) ok(j.d); } else if (err) err(new Error(j.e)); })
            .catch(function (e) { if (err) err(e); });
        };
      }
    });
  }
  window.google = { script: { run: mk(null, null), host: { close: function () {} } } };
})();
