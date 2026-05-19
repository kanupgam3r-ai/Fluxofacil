import { useState, useEffect, useReducer, useCallback } from "react";

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const PAY = ["dinheiro", "pix", "débito", "crédito", "cheque", "boleto"];
const PAY_LABEL = { dinheiro: "Dinheiro", pix: "Pix", débito: "Débito", crédito: "Crédito", cheque: "Cheque", boleto: "Boleto" };
const PAY_ICON  = { dinheiro: "💵", pix: "📱", débito: "💳", crédito: "💳", cheque: "📄", boleto: "🔖" };
const TX_LABEL  = { entrada: "Entrada", recebimento: "Recebimento", saida: "Saída" };

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const fmt     = v  => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v ?? 0);
const fmtTs   = d  => new Date(d).toLocaleString("pt-BR", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" });
const fmtFull = d  => new Date(d).toLocaleDateString("pt-BR", { weekday:"long", day:"numeric", month:"long", year:"numeric" });
const uid     = () => Math.random().toString(36).slice(2, 10);

// ─── CASH ENGINE (pure) ───────────────────────────────────────────────────────
// Rules:
//  - Only "dinheiro" moves physical cash.
//  - Entrada/Recebimento (dinheiro): first recomposes fund deficit → then fills saldoOperacional.
//  - Saída (dinheiro): drains saldoOperacional first; fund only consumed when operational runs dry.
function applyTx(sess, tx) {
  let { fundoAtual, fundoInicial, valorUsadoFundo, saldoOperacional } = sess;

  if (tx.tipo === "saida") {
    if (tx.pagamento === "dinheiro") {
      if (saldoOperacional >= tx.valor) {
        saldoOperacional -= tx.valor;
      } else {
        const deficit = tx.valor - saldoOperacional;
        saldoOperacional = 0;
        fundoAtual      = Math.max(0, fundoAtual - deficit);
        valorUsadoFundo += deficit;
      }
    }
  } else {
    if (tx.pagamento === "dinheiro") {
      const faltaFundo = fundoInicial - fundoAtual;
      if (faltaFundo > 0) {
        const recompoe   = Math.min(tx.valor, faltaFundo);
        fundoAtual      += recompoe;
        valorUsadoFundo  = Math.max(0, valorUsadoFundo - recompoe);
        saldoOperacional += tx.valor - recompoe;
      } else {
        saldoOperacional += tx.valor;
      }
    }
  }

  return { ...sess, fundoAtual, valorUsadoFundo, saldoOperacional };
}

function makeSession(fundoInicial) {
  return {
    id: uid(), openedAt: new Date().toISOString(), closedAt: null,
    fundoInicial, fundoAtual: fundoInicial,
    valorUsadoFundo: 0, saldoOperacional: 0,
    status: "open", caixaReal: null, diferenca: null,
  };
}

function getInitial() {
  try {
    const raw = localStorage.getItem("ff_v3");
    if (raw) return JSON.parse(raw);
  } catch {}
  return {
    loggedIn: false, screen: "dashboard",
    settings: { empresa: "Minha Empresa", usaFundo: true, fundoPadrao: 200 },
    session: makeSession(200), transactions: [],
    modal: null, toast: null,
  };
}

// ─── REDUCER ─────────────────────────────────────────────────────────────────
function reducer(st, a) {
  switch (a.type) {
    case "LOGIN": {
      const fundo = a.usaFundo ? (a.fundo || 0) : 0;
      return {
        ...st, loggedIn: true, screen: "dashboard", transactions: [],
        settings: { empresa: a.empresa || "Minha Empresa", usaFundo: a.usaFundo, fundoPadrao: fundo },
        session: makeSession(fundo),
      };
    }
    case "ADD_TX": {
      const tx     = { ...a.tx, id: uid(), createdAt: new Date().toISOString() };
      const newSes = applyTx(st.session, tx);
      return { ...st, transactions: [...st.transactions, tx], session: newSes, modal: null };
    }
    case "DEL_TX": {
      const remaining = st.transactions.filter(t => t.id !== a.id);
      const rebuilt   = remaining.reduce((s, t) => applyTx(s, t), makeSession(st.session.fundoInicial));
      return { ...st, transactions: remaining, session: { ...rebuilt, status: st.session.status } };
    }
    case "CLOSE":
      return { ...st, session: { ...st.session, status:"closed", closedAt:new Date().toISOString(), caixaReal:a.caixaReal, diferenca:a.diferenca }, modal:null };
    case "NEW_SESSION": {
      const f = st.settings.usaFundo ? st.settings.fundoPadrao : 0;
      return { ...st, transactions: [], session: makeSession(f), modal: null };
    }
    case "SAVE_SETTINGS":   return { ...st, settings: a.settings };
    case "SET_MODAL":       return { ...st, modal: a.modal };
    case "SET_SCREEN":      return { ...st, screen: a.screen };
    case "TOAST":           return { ...st, toast: a.msg };
    case "CLEAR_TOAST":     return { ...st, toast: null };
    default:                return st;
  }
}

// ─── PDF / PRINT ──────────────────────────────────────────────────────────────
function printReport({ session, transactions, settings }) {
  const totalE = transactions.filter(t => t.tipo==="entrada").reduce((s,t)=>s+t.valor,0);
  const totalR = transactions.filter(t => t.tipo==="recebimento").reduce((s,t)=>s+t.valor,0);
  const totalS = transactions.filter(t => t.tipo==="saida").reduce((s,t)=>s+t.valor,0);
  const byPay  = PAY.map(p=>({
    p,
    ent: transactions.filter(t=>t.pagamento===p && t.tipo!=="saida").reduce((s,t)=>s+t.valor,0),
    sai: transactions.filter(t=>t.pagamento===p && t.tipo==="saida").reduce((s,t)=>s+t.valor,0),
  })).filter(x=>x.ent>0||x.sai>0);

  const txRows = [...transactions].reverse().map(t=>`
    <tr>
      <td>${fmtTs(t.createdAt)}</td>
      <td>${t.cliente}</td>
      <td><span class="b b-${t.tipo}">${TX_LABEL[t.tipo]}</span></td>
      <td>${PAY_ICON[t.pagamento]} ${PAY_LABEL[t.pagamento]}</td>
      <td class="${t.tipo==="saida"?"neg":"pos"}">${t.tipo==="saida"?"-":"+"}${fmt(t.valor)}</td>
    </tr>`).join("");

  const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
  <title>Fechamento — ${settings.empresa}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#111;background:#fff;padding:32px}
    .hdr{border-bottom:3px solid #00c47a;padding-bottom:14px;margin-bottom:22px;display:flex;justify-content:space-between;align-items:flex-end}
    .logo{font-size:24px;font-weight:900;color:#00c47a}
    .empresa{font-size:15px;font-weight:700;margin-bottom:2px}
    .data{font-size:12px;color:#666}
    h2{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#888;margin:18px 0 6px}
    .row{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #eee;font-size:13px}
    .row.big{font-weight:700;font-size:14px;border-bottom:2px solid #ccc}
    .pos{color:#00a86b;font-weight:600} .neg{color:#e53935;font-weight:600} .warn{color:#d97706;font-weight:600}
    table{width:100%;border-collapse:collapse;margin-top:6px;font-size:12px}
    th{text-align:left;padding:8px 6px;background:#f5f5f5;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#555}
    td{padding:7px 6px;border-bottom:1px solid #f0f0f0;vertical-align:middle}
    .b{display:inline-block;padding:2px 8px;border-radius:99px;font-size:10px;font-weight:700}
    .b-entrada{background:#e6f9f2;color:#00a86b} .b-recebimento{background:#e6f0ff;color:#4444cc} .b-saida{background:#fff0f0;color:#e53935}
    .box{background:#f9fafb;border:2px solid #e5e7eb;border-radius:10px;padding:14px 18px;margin-top:18px}
    .footer{margin-top:40px;font-size:11px;color:#aaa;text-align:center;border-top:1px solid #eee;padding-top:14px}
    @media print{body{padding:16px}}
  </style></head><body>
  <div class="hdr">
    <div><div class="logo">fluxofácil</div><div class="empresa">${settings.empresa}</div><div class="data">${fmtFull(new Date())}</div></div>
    <div style="text-align:right"><div style="font-size:11px;color:#999">Gerado em</div><div style="font-weight:600">${new Date().toLocaleString("pt-BR")}</div></div>
  </div>

  ${settings.usaFundo ? `
  <h2>Fundo de Caixa</h2>
  <div class="row"><span>Fundo inicial</span><span class="warn">${fmt(session.fundoInicial)}</span></div>
  <div class="row"><span>Fundo atual</span><span class="warn">${fmt(session.fundoAtual)}</span></div>
  ${session.valorUsadoFundo>0?`<div class="row"><span>Utilizado do fundo</span><span class="neg">- ${fmt(session.valorUsadoFundo)}</span></div>`:""}
  ` : ""}

  <h2>Resumo Financeiro</h2>
  <div class="row"><span>Total entradas</span><span class="pos">+ ${fmt(totalE)}</span></div>
  <div class="row"><span>Total recebimentos</span><span class="pos">+ ${fmt(totalR)}</span></div>
  <div class="row"><span>Total saídas</span><span class="neg">- ${fmt(totalS)}</span></div>
  <div class="row big"><span>Saldo operacional</span><span class="${session.saldoOperacional>=0?"pos":"neg"}">${fmt(session.saldoOperacional)}</span></div>

  ${byPay.length ? `
  <h2>Por Forma de Pagamento</h2>
  ${byPay.map(({p,ent,sai})=>`<div class="row"><span>${PAY_ICON[p]} ${PAY_LABEL[p]}</span><span>${ent>0?`<span class="pos">+${fmt(ent)}</span>`:""} ${sai>0?`<span class="neg">-${fmt(sai)}</span>`:""}</span></div>`).join("")}
  ` : ""}

  ${session.caixaReal!==null ? `
  <div class="box">
    <h2 style="margin-top:0;margin-bottom:10px">Resultado do Fechamento</h2>
    <div class="row"><span>Caixa esperado</span><span style="font-weight:700">${fmt(session.fundoAtual+session.saldoOperacional)}</span></div>
    <div class="row"><span>Caixa real contado</span><span style="font-weight:700">${fmt(session.caixaReal)}</span></div>
    <div class="row big"><span>${session.diferenca>=0?"✅ Sobra":"⚠️ Falta"}</span><span class="${session.diferenca>=0?"pos":"neg"}" style="font-size:18px">${fmt(Math.abs(session.diferenca))}</span></div>
  </div>` : ""}

  <h2>Movimentações (${transactions.length})</h2>
  <table><thead><tr><th>Horário</th><th>Cliente</th><th>Tipo</th><th>Pagamento</th><th>Valor</th></tr></thead>
  <tbody>${txRows}</tbody></table>
  <div class="footer">fluxofácil · Fechamento de caixa · ${new Date().toLocaleString("pt-BR")}</div>
  </body></html>`;

  const w = window.open("","_blank");
  w.document.write(html);
  w.document.close();
  setTimeout(()=>w.print(), 500);
}

// ─── STYLES ──────────────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:wght@300;400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0b0d10; --s1:#141720; --s2:#1c1f2b; --s3:#22263200;
  --bd:#272c3a;
  --g:#00e5a0; --g2:#00b87a; --g3:#0a2218;
  --r:#ff4d6d; --r2:#2d0915;
  --y:#ffd166; --y2:#2d2000;
  --b:#4cc9f0; --b2:#012433;
  --tx:#eef0f4; --tx2:#8b95a8;
  --rad:14px; --rads:9px;
}
html,body{height:100%;-webkit-tap-highlight-color:transparent}
body{background:var(--bg);color:var(--tx);font-family:'DM Sans',sans-serif;font-size:15px;-webkit-font-smoothing:antialiased}

/* APP SHELL */
.app{max-width:430px;margin:0 auto;min-height:100vh;display:flex;flex-direction:column;background:var(--bg)}

/* HEADER */
.hdr{padding:18px 18px 10px;display:flex;justify-content:space-between;align-items:center;flex-shrink:0}
.logo{font-family:'Syne',sans-serif;font-weight:800;font-size:20px;color:var(--g);letter-spacing:-.5px;line-height:1}
.logo em{color:var(--tx);font-style:normal}
.hdr-co{font-family:'Syne',sans-serif;font-weight:700;font-size:13px;text-align:right}
.hdr-dt{font-size:11px;color:var(--tx2);text-align:right;margin-top:2px}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;background:var(--g);box-shadow:0 0 6px var(--g)}
.dot.off{background:var(--r);box-shadow:0 0 6px var(--r)}

/* CONTENT */
.page{flex:1;padding:4px 16px 96px;overflow-y:auto}

/* BOTTOM NAV */
.bnav{position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:100%;max-width:430px;background:var(--s1);border-top:1px solid var(--bd);display:flex;z-index:100}
.nb{flex:1;padding:11px 0 10px;display:flex;flex-direction:column;align-items:center;gap:3px;background:none;border:none;cursor:pointer;color:var(--tx2);font-size:10px;font-family:'DM Sans',sans-serif;transition:color .18s}
.nb.on{color:var(--g)}
.nb svg{width:21px;height:21px}

/* CARDS */
.card{background:var(--s1);border:1px solid var(--bd);border-radius:var(--rad);padding:15px 16px;margin-bottom:10px}
.clbl{font-size:10px;color:var(--tx2);text-transform:uppercase;letter-spacing:.9px;margin-bottom:5px;font-family:'Syne',sans-serif;font-weight:600}
.cval{font-family:'Syne',sans-serif;font-weight:800;font-size:28px;letter-spacing:-1px;line-height:1}
.cnote{font-size:11px;color:var(--tx2);margin-top:6px}

/* GRID */
.g2{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}
.g3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:7px;margin-bottom:10px}
.mc{background:var(--s1);border:1px solid var(--bd);border-radius:var(--rads);padding:12px 13px}
.mc .ml{font-size:10px;color:var(--tx2);text-transform:uppercase;letter-spacing:.7px;margin-bottom:4px;font-family:'Syne',sans-serif;font-weight:600}
.mc .mv{font-family:'Syne',sans-serif;font-weight:700;font-size:14px}

/* FUND */
.fund{background:var(--s1);border:1px solid var(--bd);border-radius:var(--rad);padding:13px 15px;margin-bottom:10px}
.fund-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:9px}
.fund-lbl{font-size:10px;color:var(--tx2);text-transform:uppercase;letter-spacing:.9px;font-family:'Syne',sans-serif;font-weight:600}
.fund-val{font-family:'Syne',sans-serif;font-weight:800;font-size:18px;color:var(--y)}
.fund-track{height:5px;background:var(--bd);border-radius:99px;overflow:hidden}
.fund-fill{height:100%;background:var(--y);border-radius:99px;transition:width .6s cubic-bezier(.4,0,.2,1)}
.fund-foot{display:flex;justify-content:space-between;align-items:center;margin-top:6px}
.fund-used{font-size:11px;color:var(--r)}
.fund-pct{font-size:11px;color:var(--tx2)}

/* ACTION GRID */
.acts{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-bottom:14px}
.ab{padding:13px 12px;border-radius:var(--rads);border:none;cursor:pointer;font-family:'Syne',sans-serif;font-weight:700;font-size:13px;display:flex;align-items:center;gap:8px;transition:transform .12s,opacity .12s;text-align:left}
.ab:active{transform:scale(.96);opacity:.85}
.ab .ico{font-size:18px;flex-shrink:0}
.ab-e{background:var(--g3);color:var(--g);border:1px solid var(--g2)}
.ab-r{background:var(--b2);color:var(--b);border:1px solid #1a5a70}
.ab-s{background:var(--r2);color:var(--r);border:1px solid #661a2a}
.ab-f{background:var(--y2);color:var(--y);border:1px solid #806600;grid-column:span 2;justify-content:center}

/* SECTION TITLE */
.st{font-family:'Syne',sans-serif;font-weight:700;font-size:11px;color:var(--tx2);text-transform:uppercase;letter-spacing:1.2px;margin:6px 0 9px}

/* TX ITEM */
.tx{background:var(--s1);border:1px solid var(--bd);border-radius:var(--rads);padding:11px 13px;margin-bottom:7px;display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
.tx-l{flex:1;min-width:0}
.tx-name{font-weight:500;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tx-meta{font-size:11px;color:var(--tx2);margin-top:3px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.tx-desc{font-size:11px;color:var(--tx2);margin-top:2px;font-style:italic;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tx-r{display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0}
.tx-val{font-family:'Syne',sans-serif;font-weight:800;font-size:14px}
.g{color:var(--g)} .red{color:var(--r)} .yel{color:var(--y)} .blu{color:var(--b)}
.tx-del{background:none;border:none;cursor:pointer;color:var(--tx2);font-size:13px;padding:2px 4px;border-radius:4px;line-height:1;transition:color .15s}
.tx-del:hover{color:var(--r)}

/* BADGE */
.bdg{display:inline-block;font-size:10px;padding:2px 7px;border-radius:99px;font-weight:700;font-family:'Syne',sans-serif}
.bdg-e{background:var(--g3);color:var(--g)}
.bdg-r{background:var(--b2);color:var(--b)}
.bdg-s{background:var(--r2);color:var(--r)}

/* MODAL */
.ov{position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:300;display:flex;align-items:flex-end;justify-content:center;animation:fi .15s ease}
.modal{background:var(--s1);border-radius:22px 22px 0 0;padding:22px 18px 36px;width:100%;max-width:430px;max-height:92vh;overflow-y:auto;border-top:1px solid var(--bd);animation:su .25s cubic-bezier(.4,0,.2,1)}
.mhdl{width:38px;height:4px;background:var(--bd);border-radius:99px;margin:0 auto 18px}
.mtitle{font-family:'Syne',sans-serif;font-weight:800;font-size:19px;margin-bottom:18px}
@keyframes fi{from{opacity:0}to{opacity:1}}
@keyframes su{from{transform:translateY(36px);opacity:0}to{transform:translateY(0);opacity:1}}

/* FORM */
.fld{margin-bottom:13px}
.fld label{display:block;font-size:11px;color:var(--tx2);margin-bottom:6px;text-transform:uppercase;letter-spacing:.7px;font-family:'Syne',sans-serif;font-weight:600}
.fld input,.fld textarea,.fld select{width:100%;background:var(--s2);border:1px solid var(--bd);border-radius:var(--rads);padding:12px 13px;color:var(--tx);font-size:15px;font-family:'DM Sans',sans-serif;outline:none;transition:border-color .18s;-webkit-appearance:none}
.fld input:focus,.fld textarea:focus,.fld select:focus{border-color:var(--g)}
.fld select option{background:var(--s2)}

/* CHIPS */
.chips{display:flex;flex-wrap:wrap;gap:7px}
.chip{padding:8px 13px;border-radius:99px;border:1px solid var(--bd);background:var(--s2);color:var(--tx2);font-size:13px;cursor:pointer;transition:all .15s;font-family:'DM Sans',sans-serif;user-select:none}
.chip.on{background:var(--g);color:#000;border-color:var(--g);font-weight:600}

/* BUTTONS */
.btn{width:100%;padding:14px;border:none;border-radius:var(--rads);font-family:'Syne',sans-serif;font-weight:700;font-size:15px;cursor:pointer;transition:opacity .15s,transform .1s;margin-top:7px;display:flex;align-items:center;justify-content:center;gap:7px}
.btn:active{transform:scale(.98)}
.btn-g{background:var(--g);color:#000}
.btn-gh{background:transparent;color:var(--tx2);border:1px solid var(--bd)}
.btn-r{background:transparent;color:var(--r);border:1px solid #661a2a}
.btn-y{background:var(--y2);color:var(--y);border:1px solid #806600}

/* FECH ROWS */
.fr{display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid var(--bd);font-size:14px}
.fr:last-child{border-bottom:none}
.fr.big{font-family:'Syne',sans-serif;font-weight:700;font-size:15px;padding-top:12px}

/* FILTERS */
.filters{display:flex;gap:7px;overflow-x:auto;padding-bottom:4px;margin-bottom:11px;scrollbar-width:none;-webkit-overflow-scrolling:touch}
.filters::-webkit-scrollbar{display:none}
.fc{white-space:nowrap;padding:7px 13px;border-radius:99px;border:1px solid var(--bd);background:var(--s2);color:var(--tx2);font-size:12px;cursor:pointer;transition:all .15s;font-family:'DM Sans',sans-serif;flex-shrink:0}
.fc.on{background:var(--g);color:#000;border-color:var(--g);font-weight:600}

/* DIV */
.div{height:1px;background:var(--bd);margin:12px 0}

/* TOAST */
.toast{position:fixed;top:18px;left:50%;transform:translateX(-50%);background:var(--s2);border:1px solid var(--g);color:var(--g);border-radius:99px;padding:10px 20px;font-size:13px;z-index:999;white-space:nowrap;box-shadow:0 8px 32px rgba(0,0,0,.5);animation:td .2s ease;font-family:'Syne',sans-serif;font-weight:600;pointer-events:none}
.toast.err{border-color:var(--r);color:var(--r)}
@keyframes td{from{opacity:0;transform:translateX(-50%) translateY(-8px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}

/* ERROR BOX */
.ebox{background:var(--r2);color:var(--r);font-size:13px;padding:10px 13px;border-radius:var(--rads);margin-bottom:13px;border:1px solid #661a2a}

/* LOGIN */
.login{display:flex;flex-direction:column;justify-content:center;align-items:center;min-height:100vh;padding:32px 24px}
.l-logo{font-family:'Syne',sans-serif;font-weight:800;font-size:44px;color:var(--g);line-height:1}
.l-logo em{color:var(--tx);font-style:normal}
.l-sub{color:var(--tx2);font-size:14px;margin:8px 0 40px;text-align:center;line-height:1.6}
.l-box{width:100%;max-width:340px}
.l-foot{margin-top:28px;font-size:12px;color:var(--tx2);text-align:center;line-height:1.7}

/* TOGGLE */
.trow{display:flex;justify-content:space-between;align-items:center;padding:13px 0;border-bottom:1px solid var(--bd)}
.tog{width:46px;height:26px;border-radius:99px;background:var(--bd);border:none;cursor:pointer;position:relative;transition:background .2s;flex-shrink:0}
.tog.on{background:var(--g)}
.tog::after{content:'';position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;transition:transform .2s}
.tog.on::after{transform:translateX(20px)}

/* EMPTY */
.empty{text-align:center;padding:48px 20px;color:var(--tx2);font-size:14px;line-height:1.7}
.empty-ico{font-size:44px;margin-bottom:12px}

/* CLOSED BANNER */
.cb{background:var(--r2);border:1px solid #661a2a;border-radius:var(--rads);padding:10px 14px;margin-bottom:12px;font-size:13px;color:var(--r);display:flex;justify-content:space-between;align-items:center}

/* RESULT BOX */
.rbox{border-radius:var(--rads);padding:12px 14px;display:flex;justify-content:space-between;align-items:center;margin-top:4px}

/* SCROLLBAR */
::-webkit-scrollbar{width:3px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--bd);border-radius:99px}
`;

// ─── ICONS ───────────────────────────────────────────────────────────────────
const IcoHome = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
    <polyline points="9 22 9 12 15 12 15 22"/>
  </svg>
);
const IcoList = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
    <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
  </svg>
);
const IcoCog = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
  </svg>
);

// ─── TOAST ───────────────────────────────────────────────────────────────────
function Toast({ msg }) {
  if (!msg) return null;
  const isErr = msg.startsWith("!");
  return <div className={`toast${isErr?" err":""}`}>{isErr ? msg.slice(1) : msg}</div>;
}

// ─── TX FORM MODAL ────────────────────────────────────────────────────────────
function TxModal({ tipo, onClose, onSave }) {
  const [cliente,   setCliente]   = useState("");
  const [valor,     setValor]     = useState("");
  const [pagamento, setPagamento] = useState("dinheiro");
  const [descricao, setDescricao] = useState("");
  const [obs,       setObs]       = useState("");
  const [err,       setErr]       = useState("");

  const TITLES = { entrada:"➕ Nova Entrada", recebimento:"💰 Recebimento", saida:"➖ Nova Saída" };

  const save = () => {
    if (!cliente.trim()) { setErr("Informe o nome do cliente."); return; }
    const v = parseFloat(valor.replace(",", "."));
    if (!v || v <= 0) { setErr("Informe um valor válido."); return; }
    onSave({ tipo, cliente: cliente.trim(), valor: v, pagamento, descricao: descricao.trim(), observacao: obs.trim() });
  };

  return (
    <div className="ov" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="mhdl"/>
        <div className="mtitle">{TITLES[tipo]}</div>
        {err && <div className="ebox">{err}</div>}

        <div className="fld">
          <label>Cliente / Nome *</label>
          <input autoFocus placeholder="Ex: João Silva" value={cliente}
            onChange={e=>setCliente(e.target.value)} onKeyDown={e=>e.key==="Enter"&&save()}/>
        </div>
        <div className="fld">
          <label>Valor (R$) *</label>
          <input type="number" inputMode="decimal" placeholder="0.00"
            value={valor} onChange={e=>setValor(e.target.value)}/>
        </div>
        <div className="fld">
          <label>Forma de Pagamento</label>
          <div className="chips">
            {PAY.map(p=>(
              <button key={p} className={`chip${pagamento===p?" on":""}`} onClick={()=>setPagamento(p)}>
                {PAY_ICON[p]} {PAY_LABEL[p]}
              </button>
            ))}
          </div>
        </div>
        <div className="fld">
          <label>Descrição (opcional)</label>
          <input placeholder="Ex: Venda produto X" value={descricao} onChange={e=>setDescricao(e.target.value)}/>
        </div>
        <div className="fld">
          <label>Observação (opcional)</label>
          <input placeholder="Notas adicionais" value={obs} onChange={e=>setObs(e.target.value)}/>
        </div>
        <button className="btn btn-g" onClick={save}>Salvar</button>
        <button className="btn btn-gh" onClick={onClose}>Cancelar</button>
      </div>
    </div>
  );
}

// ─── FECHAMENTO MODAL ─────────────────────────────────────────────────────────
function FechModal({ session, transactions, settings, onClose, onConfirm }) {
  const [realStr, setRealStr] = useState(
    session.caixaReal !== null ? String(session.caixaReal) : ""
  );

  const totalE  = transactions.filter(t=>t.tipo==="entrada").reduce((s,t)=>s+t.valor,0);
  const totalR  = transactions.filter(t=>t.tipo==="recebimento").reduce((s,t)=>s+t.valor,0);
  const totalS  = transactions.filter(t=>t.tipo==="saida").reduce((s,t)=>s+t.valor,0);
  const caixaEsp = session.fundoAtual + session.saldoOperacional;
  const real     = parseFloat(realStr.replace(",",".")) || 0;
  const dif      = real - caixaEsp;

  const byPay = PAY.map(p=>({
    p,
    tot: transactions.filter(t=>t.pagamento===p).reduce((s,t)=>s+(t.tipo==="saida"?-t.valor:t.valor),0),
  })).filter(x=>x.tot!==0);

  return (
    <div className="ov" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="modal">
        <div className="mhdl"/>
        <div className="mtitle">🔒 Fechamento de Caixa</div>
        <div style={{fontSize:12,color:"var(--tx2)",marginBottom:16,fontFamily:"Syne,sans-serif"}}>
          {settings.empresa} · {new Date().toLocaleDateString("pt-BR")}
        </div>

        {/* Fundo */}
        {settings.usaFundo && <>
          <div className="st">Fundo de Caixa</div>
          <div className="fr"><span>Fundo inicial</span><span className="yel">{fmt(session.fundoInicial)}</span></div>
          <div className="fr"><span>Fundo atual</span><span className="yel">{fmt(session.fundoAtual)}</span></div>
          {session.valorUsadoFundo>0 && <div className="fr"><span>Utilizado do fundo</span><span className="red">- {fmt(session.valorUsadoFundo)}</span></div>}
          <div className="div"/>
        </>}

        {/* Resumo */}
        <div className="st">Resumo</div>
        <div className="fr"><span>Total entradas</span><span className="g">+ {fmt(totalE)}</span></div>
        <div className="fr"><span>Total recebimentos</span><span className="blu">+ {fmt(totalR)}</span></div>
        <div className="fr"><span>Total saídas</span><span className="red">- {fmt(totalS)}</span></div>
        <div className="fr big">
          <span>Saldo operacional</span>
          <span className={session.saldoOperacional>=0?"g":"red"}>{fmt(session.saldoOperacional)}</span>
        </div>

        {/* Por pagamento */}
        {byPay.length>0 && <>
          <div className="div"/>
          <div className="st">Por Pagamento</div>
          {byPay.map(({p,tot})=>(
            <div className="fr" key={p} style={{fontSize:13}}>
              <span>{PAY_ICON[p]} {PAY_LABEL[p]}</span>
              <span className={tot>=0?"g":"red"}>{fmt(tot)}</span>
            </div>
          ))}
        </>}

        <div className="div"/>
        <div className="fr big">
          <span>Caixa esperado</span>
          <span style={{fontFamily:"Syne,sans-serif",fontWeight:800}}>{fmt(caixaEsp)}</span>
        </div>

        {/* Input real */}
        <div className="fld" style={{marginTop:14}}>
          <label>Caixa Real Contado (R$)</label>
          <input type="number" inputMode="decimal" placeholder="0.00"
            value={realStr} onChange={e=>setRealStr(e.target.value)}/>
        </div>
        {realStr && (
          <div className="rbox" style={{
            background: dif>=0?"var(--g3)":"var(--r2)",
            border:`1px solid ${dif>=0?"var(--g2)":"#661a2a"}`,
            marginBottom:4,
          }}>
            <span style={{fontSize:13,color:dif>=0?"var(--g)":"var(--r)"}}>
              {dif>=0?"✅ Sobra":"⚠️ Falta"}
            </span>
            <span style={{fontFamily:"Syne,sans-serif",fontWeight:800,fontSize:20,color:dif>=0?"var(--g)":"var(--r)"}}>
              {fmt(Math.abs(dif))}
            </span>
          </div>
        )}

        <button className="btn btn-y" onClick={()=>onConfirm({caixaReal:real,diferenca:dif})}>
          Confirmar Fechamento
        </button>
        <button className="btn btn-g" style={{background:"#0a2218",color:"var(--g)",border:"1px solid var(--g2)"}}
          onClick={()=>printReport({session,transactions,settings})}>
          🖨️ Imprimir / Gerar PDF
        </button>
        <button className="btn btn-gh" onClick={onClose}>Fechar</button>
      </div>
    </div>
  );
}

// ─── TX ITEM ─────────────────────────────────────────────────────────────────
function TxItem({ tx, onDelete }) {
  const isPos = tx.tipo !== "saida";
  const bdg   = tx.tipo==="entrada"?"bdg-e":tx.tipo==="recebimento"?"bdg-r":"bdg-s";
  return (
    <div className="tx">
      <div className="tx-l">
        <div className="tx-name">{tx.cliente}</div>
        <div className="tx-meta">
          <span className={`bdg ${bdg}`}>{TX_LABEL[tx.tipo]}</span>
          <span>{PAY_ICON[tx.pagamento]} {PAY_LABEL[tx.pagamento]}</span>
          <span>{fmtTs(tx.createdAt)}</span>
        </div>
        {tx.descricao && <div className="tx-desc">{tx.descricao}</div>}
      </div>
      <div className="tx-r">
        <span className={`tx-val ${isPos?"g":"red"}`}>
          {isPos?"+":"-"}{fmt(tx.valor)}
        </span>
        {onDelete && (
          <button className="tx-del" onClick={()=>onDelete(tx.id)} title="Excluir">✕</button>
        )}
      </div>
    </div>
  );
}

// ─── DASHBOARD ───────────────────────────────────────────────────────────────
function Dashboard({ state, dispatch }) {
  const { session, transactions, settings, modal } = state;
  const recent  = [...transactions].reverse().slice(0, 6);
  const totalE  = transactions.filter(t=>t.tipo==="entrada").reduce((s,t)=>s+t.valor,0);
  const totalR  = transactions.filter(t=>t.tipo==="recebimento").reduce((s,t)=>s+t.valor,0);
  const totalS  = transactions.filter(t=>t.tipo==="saida").reduce((s,t)=>s+t.valor,0);
  const pct     = session.fundoInicial>0 ? Math.max(0,(session.fundoAtual/session.fundoInicial)*100) : 100;
  const closed  = session.status==="closed";

  const saveTx = useCallback(tx=>{
    dispatch({type:"ADD_TX",tx});
    dispatch({type:"TOAST",msg:`${TX_LABEL[tx.tipo]} registrada!`});
  },[dispatch]);

  const doClose = useCallback(({caixaReal,diferenca})=>{
    dispatch({type:"CLOSE",caixaReal,diferenca});
    dispatch({type:"TOAST",msg:"Caixa fechado com sucesso!"});
  },[dispatch]);

  const delTx = id => {
    if (confirm("Excluir esta movimentação?")) dispatch({type:"DEL_TX",id});
  };

  // Payment breakdown (only non-zero)
  const payBreak = PAY.map(p=>({
    p,
    tot: transactions.filter(t=>t.pagamento===p).reduce((s,t)=>s+(t.tipo==="saida"?-t.valor:t.valor),0),
  })).filter(x=>x.tot!==0);

  return (
    <>
      {/* Closed banner */}
      {closed && (
        <div className="cb">
          <span>🔒 Caixa fechado em {session.closedAt ? fmtTs(session.closedAt) : ""}</span>
          <button className="btn btn-gh" style={{width:"auto",padding:"6px 12px",fontSize:12,marginTop:0}}
            onClick={()=>{if(confirm("Abrir novo caixa?")) dispatch({type:"NEW_SESSION"})}}>
            Novo Caixa
          </button>
        </div>
      )}

      {/* Fundo */}
      {settings.usaFundo && (
        <div className="fund">
          <div className="fund-top">
            <span className="fund-lbl">🏦 Fundo de Caixa</span>
            <span className="fund-val">{fmt(session.fundoAtual)}</span>
          </div>
          <div className="fund-track">
            <div className="fund-fill" style={{width:`${pct}%`}}/>
          </div>
          <div className="fund-foot">
            {session.valorUsadoFundo>0
              ? <span className="fund-used">⚠️ {fmt(session.valorUsadoFundo)} utilizados</span>
              : <span className="fund-used" style={{color:"var(--tx2)"}}>Fundo intacto</span>}
            <span className="fund-pct">{pct.toFixed(0)}%</span>
          </div>
        </div>
      )}

      {/* Saldo operacional */}
      <div className="card" style={{
        background:"linear-gradient(135deg,#091c12 0%,#0b130c 100%)",
        borderColor: session.saldoOperacional<0?"var(--r)":"#1a3a28"
      }}>
        <div className="clbl">Saldo Operacional</div>
        <div className="cval" style={{color:session.saldoOperacional>=0?"var(--g)":"var(--r)"}}>
          {fmt(session.saldoOperacional)}
        </div>
        <div className="cnote">Dinheiro físico disponível — fundo separado</div>
      </div>

      {/* Stats grid */}
      <div className="g2">
        <div className="mc"><div className="ml">Entradas</div><div className="mv g">{fmt(totalE)}</div></div>
        <div className="mc"><div className="ml">Recebimentos</div><div className="mv blu">{fmt(totalR)}</div></div>
      </div>
      <div className="g2">
        <div className="mc"><div className="ml">Saídas</div><div className="mv red">{fmt(totalS)}</div></div>
        <div className="mc"><div className="ml">Saldo Líquido</div><div className="mv yel">{fmt(totalE+totalR-totalS)}</div></div>
      </div>

      {/* Payment breakdown */}
      {payBreak.length>0 && (
        <>
          <div className="st">Por Pagamento</div>
          <div className="g3">
            {payBreak.map(({p,tot})=>(
              <div className="mc" key={p}>
                <div className="ml">{PAY_ICON[p]} {PAY_LABEL[p]}</div>
                <div className="mv" style={{color:tot>=0?"var(--g)":"var(--r)",fontSize:13}}>{fmt(tot)}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Action buttons */}
      {!closed && (
        <div className="acts">
          <button className="ab ab-e" onClick={()=>dispatch({type:"SET_MODAL",modal:"entrada"})}>
            <span className="ico">➕</span>Nova Entrada
          </button>
          <button className="ab ab-r" onClick={()=>dispatch({type:"SET_MODAL",modal:"recebimento"})}>
            <span className="ico">💰</span>Recebimento
          </button>
          <button className="ab ab-s" onClick={()=>dispatch({type:"SET_MODAL",modal:"saida"})}>
            <span className="ico">➖</span>Nova Saída
          </button>
          <button className="ab ab-f" onClick={()=>dispatch({type:"SET_MODAL",modal:"fechamento"})}>
            🔒 Fechar Caixa
          </button>
        </div>
      )}

      {/* Print button when closed */}
      {closed && (
        <button className="btn btn-g" style={{background:"#0a2218",color:"var(--g)",border:"1px solid var(--g2)"}}
          onClick={()=>printReport({session,transactions,settings})}>
          🖨️ Imprimir Relatório
        </button>
      )}

      {/* Recent transactions */}
      <div className="st" style={{marginTop:14}}>Últimas Movimentações</div>
      {recent.length===0
        ? <div className="empty">
            <div className="empty-ico">📭</div>
            Nenhuma movimentação ainda.<br/>Use os botões acima para começar.
          </div>
        : recent.map(tx=>(
            <TxItem key={tx.id} tx={tx} onDelete={!closed ? delTx : null}/>
          ))
      }

      {/* Modals */}
      {(modal==="entrada"||modal==="recebimento"||modal==="saida") && (
        <TxModal tipo={modal} onClose={()=>dispatch({type:"SET_MODAL",modal:null})} onSave={saveTx}/>
      )}
      {modal==="fechamento" && (
        <FechModal
          session={session} transactions={transactions} settings={settings}
          onClose={()=>dispatch({type:"SET_MODAL",modal:null})}
          onConfirm={doClose}
        />
      )}
    </>
  );
}

// ─── TRANSACTIONS SCREEN ──────────────────────────────────────────────────────
function TxScreen({ transactions, session, dispatch }) {
  const [tipo, setTipo] = useState("todos");
  const [pag,  setPag]  = useState("todos");
  const closed = session.status==="closed";

  const list = [...transactions].reverse().filter(t=>{
    if (tipo!=="todos" && t.tipo!==tipo)      return false;
    if (pag !=="todos" && t.pagamento!==pag)  return false;
    return true;
  });

  const total = list.reduce((s,t)=>s+(t.tipo==="saida"?-t.valor:t.valor),0);

  const delTx = id => {
    if (confirm("Excluir esta movimentação?")) dispatch({type:"DEL_TX",id});
  };

  return (
    <>
      <div className="st">Tipo</div>
      <div className="filters">
        {["todos","entrada","recebimento","saida"].map(f=>(
          <button key={f} className={`fc${tipo===f?" on":""}`} onClick={()=>setTipo(f)}>
            {f==="todos"?"Todos":TX_LABEL[f]}
          </button>
        ))}
      </div>

      <div className="st">Pagamento</div>
      <div className="filters">
        {["todos",...PAY].map(p=>(
          <button key={p} className={`fc${pag===p?" on":""}`} onClick={()=>setPag(p)}>
            {p==="todos"?"Todos":`${PAY_ICON[p]} ${PAY_LABEL[p]}`}
          </button>
        ))}
      </div>

      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
        <span style={{fontSize:12,color:"var(--tx2)"}}>
          {list.length} mov.
        </span>
        <span style={{fontFamily:"Syne,sans-serif",fontWeight:700,fontSize:14,color:total>=0?"var(--g)":"var(--r)"}}>
          {fmt(total)}
        </span>
      </div>

      {list.length===0
        ? <div className="empty"><div className="empty-ico">🔍</div>Nenhum resultado encontrado.</div>
        : list.map(tx=>(
            <TxItem key={tx.id} tx={tx} onDelete={!closed?delTx:null}/>
          ))
      }
    </>
  );
}

// ─── SETTINGS SCREEN ─────────────────────────────────────────────────────────
function SettingsScreen({ settings, session, dispatch }) {
  const [loc, setLoc] = useState({...settings});
  const set = (k,v) => setLoc(s=>({...s,[k]:v}));

  return (
    <>
      <div className="st">Empresa</div>
      <div className="card">
        <div className="fld" style={{marginBottom:0}}>
          <label>Nome da Empresa</label>
          <input value={loc.empresa} onChange={e=>set("empresa",e.target.value)} placeholder="Minha Empresa"/>
        </div>
      </div>

      <div className="st">Fundo de Caixa</div>
      <div className="card">
        <div className="trow">
          <div>
            <div style={{fontWeight:500,fontSize:14}}>Usar Fundo de Caixa</div>
            <div style={{fontSize:12,color:"var(--tx2)",marginTop:2}}>Reserva física separada para troco</div>
          </div>
          <button className={`tog${loc.usaFundo?" on":""}`} onClick={()=>set("usaFundo",!loc.usaFundo)}/>
        </div>
        {loc.usaFundo && (
          <div className="fld" style={{marginTop:14,marginBottom:0}}>
            <label>Valor Padrão do Fundo (R$)</label>
            <input type="number" value={loc.fundoPadrao}
              onChange={e=>set("fundoPadrao",parseFloat(e.target.value)||0)} placeholder="200"/>
          </div>
        )}
      </div>

      <div className="st">Sessão Atual</div>
      <div className="card">
        <div className="fr">
          <span style={{color:"var(--tx2)"}}>Aberto em</span>
          <span style={{fontSize:13}}>{fmtTs(session.openedAt)}</span>
        </div>
        {settings.usaFundo && (
          <div className="fr">
            <span style={{color:"var(--tx2)"}}>Fundo atual</span>
            <span className="yel" style={{fontFamily:"Syne,sans-serif",fontWeight:700}}>{fmt(session.fundoAtual)}</span>
          </div>
        )}
        <div className="fr">
          <span style={{color:"var(--tx2)"}}>Saldo operacional</span>
          <span className="g" style={{fontFamily:"Syne,sans-serif",fontWeight:700}}>{fmt(session.saldoOperacional)}</span>
        </div>
        <div className="fr">
          <span style={{color:"var(--tx2)"}}>Status</span>
          <span style={{fontFamily:"Syne,sans-serif",fontWeight:700,color:session.status==="open"?"var(--g)":"var(--r)"}}>
            <span className={`dot${session.status==="closed"?" off":""}`}/>
            {session.status==="open"?"Aberto":"Fechado"}
          </span>
        </div>
        {session.caixaReal!==null && (
          <div className="fr">
            <span style={{color:"var(--tx2)"}}>Contagem final</span>
            <span style={{fontFamily:"Syne,sans-serif",fontWeight:700}}>{fmt(session.caixaReal)}</span>
          </div>
        )}
        {session.diferenca!==null && (
          <div className="fr">
            <span style={{color:"var(--tx2)"}}>Diferença</span>
            <span className={session.diferenca>=0?"g":"red"} style={{fontFamily:"Syne,sans-serif",fontWeight:700}}>
              {session.diferenca>=0?"+ ":"- "}{fmt(Math.abs(session.diferenca))}
            </span>
          </div>
        )}
      </div>

      <button className="btn btn-g" onClick={()=>{
        dispatch({type:"SAVE_SETTINGS",settings:loc});
        dispatch({type:"TOAST",msg:"Configurações salvas!"});
      }}>
        Salvar Configurações
      </button>

      <button className="btn btn-r" style={{marginTop:8}} onClick={()=>{
        if (confirm("Abrir novo caixa? As movimentações atuais serão apagadas.")) {
          dispatch({type:"SAVE_SETTINGS",settings:loc});
          dispatch({type:"NEW_SESSION"});
          dispatch({type:"TOAST",msg:"Novo caixa aberto!"});
          dispatch({type:"SET_SCREEN",screen:"dashboard"});
        }
      }}>
        Abrir Novo Caixa
      </button>

      <div style={{marginTop:24,padding:"14px 0",borderTop:"1px solid var(--bd)"}}>
        <div style={{fontSize:11,color:"var(--tx2)",textAlign:"center",lineHeight:1.8}}>
          <strong style={{color:"var(--g)"}}>fluxofácil</strong> · Controle de caixa para pequenos negócios<br/>
          💾 Dados salvos localmente no dispositivo
        </div>
      </div>
    </>
  );
}

// ─── LOGIN SCREEN ─────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [empresa,  setEmpresa]  = useState("");
  const [usaFundo, setUsaFundo] = useState(true);
  const [fundo,    setFundo]    = useState("200");

  return (
    <div className="login">
      <div className="l-logo">fluxo<em>fácil</em></div>
      <div className="l-sub">
        Fechamento de caixa simples e rápido<br/>
        para pequenos negócios
      </div>

      <div className="l-box">
        <div className="fld">
          <label>Nome da Empresa</label>
          <input placeholder="Ex: Padaria do João" value={empresa} onChange={e=>setEmpresa(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&onLogin({empresa:empresa.trim()||"Minha Empresa",usaFundo,fundo:parseFloat(fundo)||0})}/>
        </div>

        <div className="card" style={{marginBottom:13}}>
          <div className="trow">
            <div>
              <div style={{fontWeight:500}}>Usar Fundo de Caixa</div>
              <div style={{fontSize:12,color:"var(--tx2)",marginTop:2}}>Reserva separada para troco e emergências</div>
            </div>
            <button className={`tog${usaFundo?" on":""}`} onClick={()=>setUsaFundo(u=>!u)}/>
          </div>
          {usaFundo && (
            <div className="fld" style={{marginTop:14,marginBottom:0}}>
              <label>Valor do Fundo Inicial (R$)</label>
              <input type="number" inputMode="decimal" placeholder="200.00"
                value={fundo} onChange={e=>setFundo(e.target.value)}/>
            </div>
          )}
        </div>

        <button className="btn btn-g"
          onClick={()=>onLogin({empresa:empresa.trim()||"Minha Empresa",usaFundo,fundo:parseFloat(fundo)||0})}>
          Abrir Caixa →
        </button>
      </div>

      <div className="l-foot">
        💾 Dados salvos localmente no dispositivo<br/>
        <span style={{color:"var(--g)",opacity:.7}}>fluxofácil · controle de caixa</span>
      </div>
    </div>
  );
}

// ─── BOTTOM NAV ──────────────────────────────────────────────────────────────
function BNav({ screen, go }) {
  const items = [
    { id:"dashboard",    icon:<IcoHome/>, label:"Início" },
    { id:"transactions", icon:<IcoList/>, label:"Movimentos" },
    { id:"settings",     icon:<IcoCog/>,  label:"Config" },
  ];
  return (
    <nav className="bnav">
      {items.map(({id,icon,label})=>(
        <button key={id} className={`nb${screen===id?" on":""}`} onClick={()=>go(id)}>
          {icon}{label}
        </button>
      ))}
    </nav>
  );
}

// ─── APP ROOT ────────────────────────────────────────────────────────────────
export default function App() {
  const [state, dispatch] = useReducer(reducer, null, getInitial);

  // Persist
  useEffect(()=>{
    try { localStorage.setItem("ff_v3", JSON.stringify(state)); } catch {}
  }, [state]);

  // Auto-clear toast
  useEffect(()=>{
    if (!state.toast) return;
    const t = setTimeout(()=>dispatch({type:"CLEAR_TOAST"}), 2500);
    return ()=>clearTimeout(t);
  }, [state.toast]);

  // Login screen
  if (!state.loggedIn) {
    return (
      <>
        <style>{CSS}</style>
        <div className="app">
          <LoginScreen onLogin={p=>dispatch({type:"LOGIN",...p})}/>
        </div>
      </>
    );
  }

  const { screen, session, transactions, settings } = state;
  const today = new Date().toLocaleDateString("pt-BR",{weekday:"short",day:"2-digit",month:"short"});

  return (
    <>
      <style>{CSS}</style>
      <div className="app">
        <Toast msg={state.toast}/>

        <header className="hdr">
          <div className="logo">fluxo<em>fácil</em></div>
          <div>
            <div className="hdr-co">
              <span className={`dot${session.status==="closed"?" off":""}`}/>
              {settings.empresa}
            </div>
            <div className="hdr-dt">{today}</div>
          </div>
        </header>

        <div className="page">
          {screen==="dashboard"    && <Dashboard state={state} dispatch={dispatch}/>}
          {screen==="transactions" && <TxScreen transactions={transactions} session={session} dispatch={dispatch}/>}
          {screen==="settings"     && <SettingsScreen settings={settings} session={session} dispatch={dispatch}/>}
        </div>

        <BNav screen={screen} go={s=>dispatch({type:"SET_SCREEN",screen:s})}/>
      </div>
    </>
  );
}
