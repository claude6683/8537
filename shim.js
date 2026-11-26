/* 페이지가 부르는 google.script.run.<함수>(…) 를 정적 파일(data/<함수>/<인자>.json) 읽기로 바꿔 주는 어댑터.
   모의거래(tx_state/tx_order/tx_reset)는 이 브라우저(localStorage)에 저장한다. */
(function () {
  var TX_START = 10000000;
  var TX_SYMS = [
    { id: 'QQQM', name: 'QQQM', code: 'QQQM', dec: 2 },
    { id: 'NVDA', name: 'NVDA (엔비디아)', code: 'NVDA', dec: 2 },
    { id: 'TQQQ', name: 'TQQQ', code: 'TQQQ', dec: 2 }
  ];
  var SK = '8537-tx-state';
  // 이사 전(Netlify)에 잡아 둔 모의 포지션. 이 브라우저에 저장된 게 없을 때만 시작값으로 쓴다.
  var SEED = {"realized":-104.8,"pos":{"QQQM":{"q":76,"a":302.28,"t":1795679190705},"NVDA":{"q":64,"a":191.13,"t":1795679191117},"TQQQ":{"q":21,"a":54.25,"t":1795679191533}},"hist":[[1795679191939,"TQQQ","L",20,54.25,49.01,-104.8],[1795679190301,"QQQM","L",76,300,300,0],[1795679189446,"QQQM","L",76,287.17,287.17,0]]};
  var BASE = (function () { var s = document.currentScript && document.currentScript.src; return s ? s.replace(/[^\/]*$/, '') : ''; })();

  function getJSON(url) {
    return fetch(url + (url.indexOf('?') < 0 ? '?' : '&') + 't=' + Math.floor(Date.now() / 60000))
      .then(function (r) { if (!r.ok) throw new Error('데이터 없음 (' + r.status + ')'); return r.json(); });
  }
  function dataUrl(fn, a) {
    var k = a.map(function (x) { return x == null ? '' : String(x); }).join('_') || 'x';
    return BASE + 'data/' + fn + '/' + encodeURIComponent(k) + '.json';
  }

  /* ----- 모의거래: 브라우저 저장 ----- */
  function txLoad() {
    try { var v = JSON.parse(localStorage.getItem(SK) || 'null'); if (v && v.pos && Array.isArray(v.hist) && isFinite(v.realized)) return Promise.resolve(v); } catch (e) {}
    return Promise.resolve(JSON.parse(JSON.stringify(SEED)));
  }
  function txSave(st) { try { localStorage.setItem(SK, JSON.stringify(st)); } catch (e) {} }
  function txView(st) { return { startUsd: TX_START, syms: TX_SYMS, realized: st.realized, pos: st.pos, hist: st.hist }; }
  function txApply(st, s, q, price) {
    var p = st.pos[s.id];
    if (!p || !p.q) { st.pos[s.id] = { q: q, a: price, t: Date.now() }; return; }
    if ((p.q > 0) === (q > 0)) { var tot = Math.abs(p.q) + Math.abs(q); p.a = (p.a * Math.abs(p.q) + price * Math.abs(q)) / tot; p.q = Math.round((p.q + q) * 1e6) / 1e6; return; }
    var close = Math.min(Math.abs(q), Math.abs(p.q)), dir = p.q > 0 ? 1 : -1, pnl = (price - p.a) * close * dir;
    st.realized += pnl;
    st.hist.unshift([Date.now(), s.id, dir > 0 ? 'L' : 'S', Math.round(close * 1e6) / 1e6, p.a, price, Math.round(pnl * 100) / 100]);
    if (st.hist.length > 100) st.hist.length = 100;
    var rest = Math.round((p.q + q) * 1e6) / 1e6;
    if (Math.abs(rest) < 1e-9) delete st.pos[s.id];
    else if ((rest > 0) === (p.q > 0)) p.q = rest;
    else st.pos[s.id] = { q: rest, a: price, t: Date.now() };
  }
  var LOCAL = {
    tx_state: function () { return txLoad().then(txView); },
    tx_reset: function () { var st = { realized: 0, pos: {}, hist: [] }; txSave(st); return Promise.resolve(txView(st)); },
    tx_order: function (id, side, price, qty) {
      var s = TX_SYMS.filter(function (x) { return x.id === id; })[0];
      if (!s) return Promise.reject(new Error('종목 없음'));
      qty = Number(qty); if (!(qty > 0) || !isFinite(qty) || qty < 0.000001) return Promise.reject(new Error('수량을 확인하세요'));
      if (side !== 'buy' && side !== 'sell') return Promise.reject(new Error('주문 구분 오류'));
      var pr = (price === null || price === undefined || price === '')
        ? getJSON(dataUrl('tx_quotes', [])).then(function (q) { return +q[id]; })
        : Promise.resolve(Number(price));
      return pr.then(function (px) {
        if (!(px > 0)) throw new Error('가격을 확인하세요');
        return txLoad().then(function (st) {
          txApply(st, s, Math.round(qty * 1e6) / 1e6 * (side === 'buy' ? 1 : -1), px);
          txSave(st); return txView(st);
        });
      });
    }
  };

  function mk(ok, err) {
    return new Proxy({}, {
      get: function (_, name) {
        if (name === 'withSuccessHandler') return function (f) { return mk(f, err); };
        if (name === 'withFailureHandler') return function (f) { return mk(ok, f); };
        return function () {
          var a = Array.prototype.slice.call(arguments), fn = String(name);
          while (a.length && a[a.length - 1] === undefined) a.pop();
          var p = LOCAL[fn] ? LOCAL[fn].apply(null, a) : getJSON(dataUrl(fn, a));
          p.then(function (d) { if (ok) ok(d); }).catch(function (e) { if (err) err(e); });
        };
      }
    });
  }
  window.google = { script: { run: mk(null, null), host: { close: function () {} } } };
})();
