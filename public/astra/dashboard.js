'use strict';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = value => value === null || value === undefined || value === '' ? null : Number(value);
const money = value => num(value) === null || !Number.isFinite(num(value)) ? '—' : num(value).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
const pct = value => num(value) === null ? '—' : (num(value)*100).toFixed(2)+'%';
const signed = value => num(value) === null ? '—' : (num(value)>0?'+':'')+money(value);
const dt = value => value ? new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}) : '时间未记录';
const cls = value => num(value)>0?'positive':num(value)<0?'negative':'';
const states = {filled:'全部成交',accepted_open:'已受理 · 未完成',rejected:'已拒绝',outcome_unknown:'结果未知',inflight:'提交结果待核对',settled_unfilled:'结算未成交',stopped:'已停止',completed:'已完成',awaiting_model:'等待模型',outside_session:'非交易时段',already_running:'已有原进程运行',no_order:'无新增委托',blocked:'校验阻断',monitoring:'执行已返回',unknown:'结果待核对',running:'执行中',finished:'已返回',retrying:'原进程退避中',partial:'部分资料覆盖'};
const statusName = v => states[v] || v || '未记录';
const badge = (v, text) => `<span class="badge ${['filled','completed','finished'].includes(v)?'':['blocked','unknown','outcome_unknown','rejected'].includes(v)?'red':['accepted_open','stopped','partial'].includes(v)?'amber':'neutral'}">${esc(text||statusName(v))}</span>`;
const phaseName = p => ({conversation:'对话研究',pre:'盘前研究',post:'盘后研究'}[p]||'研究报告');
const modeName = p => ({aggressive:'激进',balanced:'均衡',conservative:'保守',defensive:'防守'}[p]||p||'—');
let decryptKey=null, data=null, currentView='overview';
const pages={trades:0,workflow:0,research:0};
const labels={overview:['总览','投资，一览全局。','让判断、持仓和执行结果彼此对照。'],portfolio:['投资组合','组合的每一面。','仓位、盈亏与退出条件，放在一起看。'],trades:['交易流水','执行，有据可查。','受理、成交和未完成状态，逐笔分清。'],workflow:['流程记录','回看每一步。','从策略检查到成交回读，保留原始周期的脉络。'],research:['研究报告','判断，持续进化。','全部持仓优先，延续关注股，再看市场背景。']};
function from64(s){return Uint8Array.from(atob(s),c=>c.charCodeAt(0));}
async function readBundle(){
  const response=await fetch('./snapshot.enc.json',{cache:'no-store',credentials:'omit'});
  if(!response.ok)throw new Error('加密快照暂不可用，请稍后重试。');
  const bundle=await response.json();
  if(bundle.schema!==1||bundle.cipher!=='AES-256-GCM'||bundle.kdf!=='PBKDF2-SHA256'||bundle.iterations!==600000||bundle.compression!=='gzip'||typeof bundle.data!=='string'||bundle.data.length>20000000)throw new Error('快照格式或版本不受支持。');
  return bundle;
}
async function deriveKey(password,bundle){
  if(!window.crypto?.subtle)throw new Error('请通过 HTTPS 打开网站，并使用支持 Web Crypto 的浏览器。');
  const source=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt:from64(bundle.salt),iterations:bundle.iterations,hash:'SHA-256'},source,{name:'AES-GCM',length:256},false,['decrypt']);
}
async function decryptBundle(bundle,key){
  let raw;
  try{raw=await crypto.subtle.decrypt({name:'AES-GCM',iv:from64(bundle.iv),additionalData:new TextEncoder().encode('astra-github-dashboard-v1'),tagLength:128},key,from64(bundle.data));}
  catch{throw new Error('密码不正确，或快照校验未通过。');}
  if(typeof DecompressionStream==='undefined')throw new Error('请使用新版 Safari、Chrome、Edge 或 Firefox 打开。');
  const bytes=await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  if(bytes.byteLength>30000000)throw new Error('快照过大，已停止读取。');
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(value.simulation_only!==true||!value.snapshot||!Array.isArray(value.orders)||!Array.isArray(value.reports))throw new Error('快照内容校验失败。');
  return value;
}
function toast(text){$('toast').textContent=text;$('toast').hidden=false;setTimeout(()=>$('toast').hidden=true,6500);}
function loggedOut(){decryptKey=null;data=null;klineSelected=null;returns={status:'idle',error:'',bars:new Map(),live:new Map(),loadedAt:0,liveAt:0,view:null};$('password').value='';$('app').hidden=true;$('login-screen').hidden=false;document.title='Astra · 私人投资看板';for(const id of ['view-overview','kline-portfolio','portfolio-content','trades-content','workflow-content','research-content','detail-body'])$(id).replaceChildren();$('detail').close();}
$('login-form').addEventListener('submit',async event=>{
  event.preventDefault();$('login-button').disabled=true;$('login-error').textContent='正在解密快照…';
  let password=$('password').value;$('password').value='';
  try{const bundle=await readBundle();const key=await deriveKey(password,bundle);password='';const value=await decryptBundle(bundle,key);decryptKey=key;data=value;$('login-screen').hidden=true;$('app').hidden=false;$('login-error').textContent='';currentView=labels[location.hash.slice(1)]?location.hash.slice(1):'overview';render();}
  catch(error){$('login-error').textContent=error.message;}
  finally{password='';$('login-button').disabled=false;}
});
$('logout').onclick=()=>loggedOut();
$('refresh').onclick=()=>refresh();
async function refresh(){if(!decryptKey)return;$('refresh').disabled=true;try{const bundle=await readBundle();data=await decryptBundle(bundle,decryptKey);$('notice').hidden=true;render();toast('已读取 GitHub 上最近同步的快照。');}catch(error){$('notice').textContent=error.message+' 当前视图未更新。';$('notice').hidden=false;}finally{$('refresh').disabled=false;}}
function switchView(view){if(!labels[view])return;currentView=view;document.querySelectorAll('.view').forEach(e=>e.hidden=e.id!=='view-'+view);document.querySelectorAll('[data-view]').forEach(e=>e.classList.toggle('active',e.dataset.view===view));$('page-label').textContent=labels[view][0];$('page-title').textContent=labels[view][1];$('page-description').textContent=labels[view][2];document.title='Astra · '+labels[view][0];history.replaceState(null,'','#'+view);}
document.addEventListener('click',event=>{const nav=event.target.closest('[data-view]');if(nav)switchView(nav.dataset.view);const pg=event.target.closest('[data-page]');if(pg){pages[pg.dataset.page]+=Number(pg.dataset.step);renderView(pg.dataset.page);}const order=event.target.closest('[data-order]');if(order)showOrder(data.orders[Number(order.dataset.order)]);const cycle=event.target.closest('[data-cycle]');if(cycle)showCycle(data.cycles[Number(cycle.dataset.cycle)]);const report=event.target.closest('[data-report]');if(report)showReport(data.reports[Number(report.dataset.report)]);const position=event.target.closest('[data-position]');if(position)showPosition(data.snapshot.positions[Number(position.dataset.position)]);const pick=event.target.closest('[data-kline-pick]');if(pick&&data){klineSelected=pick.dataset.klinePick;renderKlines();renderPortfolio();}const range=event.target.closest('[data-kline-range]');if(range&&data){klineRange=Number(range.dataset.klineRange);renderKlines();}const select=event.target.closest('[data-select]');if(select&&data){klineSelected=select.dataset.select;renderKlines();renderPortfolio();$('kline-portfolio').scrollIntoView({behavior:'smooth',block:'start'});}});
function pager(kind,count){let p=pages[kind],last=Math.max(0,Math.ceil(count/20)-1);if(p>last)p=pages[kind]=last;return `<div class="table-foot"><span>共 ${count} 条可核验记录</span><div class="pager"><button data-page="${kind}" data-step="-1" ${p===0?'disabled':''}>← 上一页</button><span>${p+1} / ${last+1}</span><button data-page="${kind}" data-step="1" ${p>=last?'disabled':''}>下一页 →</button></div></div>`;}
/* ---------- K-line panels (overview + portfolio) ---------- */
let klineSelected=null,klineRange=120;
const sortedPositions=()=>[...data.snapshot.positions].sort((a,b)=>(num(b.market_value)||0)-(num(a.market_value)||0));
function klinePosition(){const list=sortedPositions();return list.find(p=>p.stock_code===klineSelected)||list[0]||null;}
function renderKlines(){for(const id of ['kline-overview','kline-portfolio'])renderKline(id);}
function renderKline(id){
  const el=$(id);if(!el||!data)return;
  const list=sortedPositions();
  if(!list.length){el.innerHTML='<div class="kline-empty">暂无持仓。建仓后这里显示持仓 K 线、成本线与买卖点。</div>';return;}
  const p=klinePosition(),total=num(data.snapshot.total_assets),policy=p.exit?.policy||{},cost=num(p.cost_price),quantity=num(p.quantity),pnl=num(p.unrealized_pnl);
  const weight=total>0?num(p.market_value)/total:null,pnlPct=cost>0&&quantity>0&&pnl!==null?pnl/(cost*quantity):null;
  el.innerHTML=`<div class="kline-head"><div class="kline-title"><span class="eyebrow">持仓 K 线 · 日线不复权</span><h2>${esc(p.stock_name)} <small>${esc(p.stock_code)}</small></h2></div><div class="kline-quote" data-k-quote><b>${money(p.last_price)}</b><small>快照价</small></div><div class="kline-range" role="group" aria-label="K 线区间">${[[60,'3月'],[120,'6月'],[250,'1年']].map(([n,t])=>`<button data-kline-range="${n}" class="${klineRange===n?'active':''}" aria-pressed="${klineRange===n}">${t}</button>`).join('')}</div></div>
  <div class="kline-stats"><div><small>持有 / 可卖</small><b>${esc(p.quantity)} / ${esc(p.available_quantity)}</b></div><div><small>持仓成本</small><b>${money(p.cost_price)}</b></div><div><small>浮动盈亏</small><b class="${cls(pnl)}">${signed(pnl)}${pnlPct!==null?` <em>${pnlPct>0?'+':''}${(pnlPct*100).toFixed(2)}%</em>`:''}</b></div><div><small>组合权重</small><b>${pct(weight)}</b></div><div><small>止损 / 支撑</small><b>${policy.stop_price?money(policy.stop_price):'—'} / ${policy.support_price?money(policy.support_price):'—'}</b></div><div><small>持有交易日</small><b>${esc(p.exit?.holding_trading_days??'—')}</b></div></div>
  <div class="kline-chips" role="tablist" aria-label="切换持仓">${list.map(x=>`<button data-kline-pick="${esc(x.stock_code)}" class="${x.stock_code===p.stock_code?'active':''}" role="tab" aria-selected="${x.stock_code===p.stock_code}">${esc(x.stock_name)}</button>`).join('')}</div>
  <div class="kline-chart" data-k-chart><div class="kline-loading">正在加载 K 线…</div></div>
  <p class="kline-foot">行情来自东方财富公开日 K，腾讯日线备用，均为不复权。解锁后浏览器直连，只发送证券代码。▲ 买 / ▼ 卖为快照中的委托，实心 = 有成交；价格取核验成交均价，没有则取委托限价。</p>`;
  drawKline(el,p);
}
async function drawKline(el,p){
  const token=`${p.stock_code}|${klineRange}|${performance.now()}`;el.dataset.token=token;
  const chart=el.querySelector('[data-k-chart]');if(!chart)return;
  try{
    const bars=await AstraKline.load(p.stock_code,260);
    if(el.dataset.token!==token||!chart.isConnected)return;
    const policy=p.exit?.policy||{};
    const orders=data.orders.filter(o=>o.stock_code===p.stock_code).map(o=>({day:o.day,side:o.side,price:num(o.average_fill_price)??num(o.limit_price),quantity:o.quantity,filled:num(o.filled_quantity)||0,state:o.state}));
    const r=AstraKline.render(chart,bars,{show:klineRange,cost:num(p.cost_price),stop:num(policy.stop_price),support:num(policy.support_price),entryDate:p.exit?.entry_date,orders});
    const q=el.querySelector('[data-k-quote]');
    if(q)q.innerHTML=`<b class="${cls(r.change)}">${r.last.close.toFixed(2)}</b><span class="${cls(r.change)}">${r.change===null?'':(r.change>0?'+':'')+r.change.toFixed(2)+'%'}</span><small>${esc(r.last.date)} · ${esc(r.last.source||'东方财富')}</small>`;
  }catch(error){if(el.dataset.token===token&&chart.isConnected)chart.innerHTML=`<div class="kline-loading">K 线暂不可用：${esc(error.message)}</div>`;}
}
function redrawKlines(){if(!data)return;const p=klinePosition();if(!p)return;for(const id of ['kline-overview','kline-portfolio']){const el=$(id);if(el&&el.offsetParent&&el.querySelector('[data-k-chart]'))drawKline(el,p);}}
// Daily candles move during the session: refresh the visible chart every minute (cached 60 s).
setInterval(()=>{if(!document.hidden)redrawKlines();},60_000);
let klineResize=0;window.addEventListener('resize',()=>{clearTimeout(klineResize);klineResize=setTimeout(redrawKlines,150);});
document.addEventListener('keydown',event=>{const row=event.target.closest?.('[data-kline-pick][role="button"]');if(row&&(event.key==='Enter'||event.key===' ')){event.preventDefault();row.click();}});

// Optional account curve: drawn when the snapshot carries nav.history = [{date, total_assets}].
function navCurve(){
  const h=(Array.isArray(data.nav?.history)?data.nav.history:[]).map(p=>({date:String(p?.date||''),v:num(p?.total_assets)})).filter(p=>p.date&&Number.isFinite(p.v)).sort((a,b)=>a.date.localeCompare(b.date));
  if(h.length<2)return '';
  const W=600,H=90,lo=Math.min(...h.map(p=>p.v)),hi=Math.max(...h.map(p=>p.v)),span=hi-lo||hi*0.01||1;
  const pts=h.map((p,i)=>[i/(h.length-1)*W,H-6-((p.v-lo)/span)*(H-14)]);
  const d=pts.map(([x,y],i)=>`${i?'L':'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');
  const up=h.at(-1).v>=h[0].v,color=up?'#e3342f':'#0e9b6a';
  return `<div class="nav-curve"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="账户总资产曲线"><path d="${d}L${W} ${H}L0 ${H}Z" fill="${color}" opacity=".08"/><path d="${d}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg><small>总资产 ${esc(h[0].date)} — ${esc(h.at(-1).date)} · ${h.length} 个点</small></div>`;
}

/* ---------- Portfolio returns ----------
   The snapshot only carries totals, so the daily equity is rebuilt BACKWARD from the account as it
   is now: today's cash + holdings are exact; each earlier day undoes that day's filled orders and
   values the holdings at that day's close. Errors (fees, limit price used when no verified fill
   price exists) therefore accumulate toward the start, where the gap to the initial capital is
   shown instead of hidden. Live prices: one Eastmoney batch request, every 20 s while trading. */
const HS300='1.000300';
let returns={status:'idle',error:'',bars:new Map(),live:new Map(),loadedAt:0,liveAt:0,view:null};
function beijingNow(){const t=new Date(Date.now()+8*3600e3);return{date:t.toISOString().slice(0,10),minute:t.getUTCHours()*60+t.getUTCMinutes(),weekday:t.getUTCDay()};}
function inSession(){const n=beijingNow();return n.weekday>0&&n.weekday<6&&((n.minute>=570&&n.minute<=690)||(n.minute>=780&&n.minute<=900));}
const filledTrades=()=>data.orders.filter(o=>num(o.filled_quantity)>0).map(o=>({day:o.day,code:o.stock_code,side:o.side,qty:num(o.filled_quantity),price:num(o.average_fill_price)??num(o.limit_price),verified:num(o.average_fill_price)>0}));
async function loadReturns(force=false){
  if(!data||returns.status==='loading')return;
  const snapshot=data;
  const request=returns;
  const codes=[...new Set([...snapshot.snapshot.positions.map(p=>p.stock_code),...filledTrades().map(t=>t.code),HS300])];
  const complete=codes.every(code=>request.bars.get(AstraKline.secid(code))?.length);
  if(!force&&complete&&request.loadedAt&&Date.now()-request.loadedAt<10*60e3){
    await refreshLive();
    return;
  }
  request.status='loading';
  request.progress={done:0,total:codes.length};
  renderReturns();
  const failed=[];
  try{
    for(let i=0;i<codes.length;i+=4){
      const batch=codes.slice(i,i+4);
      const results=await Promise.allSettled(batch.map(code=>AstraKline.load(code,260)));
      if(returns!==request||data!==snapshot)return;
      results.forEach((result,index)=>{
        if(result.status==='fulfilled'&&result.value.length)request.bars.set(AstraKline.secid(batch[index]),result.value);
        else failed.push(batch[index]);
      });
      request.progress.done+=batch.length;
      renderReturns();
    }
    request.failed=failed;
    request.loadedAt=Date.now();
    request.status='ready';
    await refreshLive();
  }catch(error){
    if(returns===request&&data===snapshot){
      request.status='error';
      request.view=null;
      request.error=error.message||'收益数据加载失败';
      renderReturns();
    }
  }finally{
    if(returns===request&&data&&data!==snapshot){
      request.status='idle';
      loadReturns();
    }
  }
}
async function refreshLive(){
  if(!data)return;
  const snapshot=data;
  const request=returns;
  try{
    const codes=[...new Set([...snapshot.snapshot.positions.map(p=>p.stock_code),HS300])];
    const quotes=await AstraKline.quotes(codes);
    if(data!==snapshot||returns!==request)return;
    request.live=quotes;
    request.liveAt=Date.now();
    request.error='';
  }catch(error){
    if(data!==snapshot||returns!==request)return;
    request.error=error.message;
  }
  try{
    computeReturns();
    renderReturns();
  }catch(error){
    request.view=null;
    request.status='error';
    request.error='收益计算暂不可用 '+(error.message||'数据未齐备');
    renderReturns();
  }
}
document.addEventListener('click',event=>{
  if(event.target.closest('[data-retry-returns]'))loadReturns(true);
});
function computeReturns(){
  returns.view=null;
  if(!data)return;
  if(!returns.bars.get(HS300)?.length){returns.error='沪深300历史行情未取得，收益对比曲线暂缓。请点击重试。';return;}
  const total=num(data.snapshot.total_assets),ret=num(data.nav.return_since_initial);
  const initial=total>0&&ret!==null&&1+ret>0?total/(1+ret):null;
  if(!Number.isFinite(initial)||initial<=0){returns.error='初始资金或累计收益资料不足，暂缓计算收益曲线。';return;}
  const trades=filledTrades().sort((a,b)=>a.day.localeCompare(b.day));
  const closes=new Map();for(const [id,bars] of returns.bars)closes.set(id,bars);
  const idx=returns.bars.get(HS300),allDays=idx.map(b=>b.date);
  const first=trades.length?trades[0].day:data.snapshot.captured_at.slice(0,10);
  const firstIndex=allDays.findIndex(d=>d>=first);
  const startIndex=firstIndex<0?Math.max(0,allDays.length-1):Math.max(0,firstIndex-1);
  const days=allDays.slice(startIndex);
  const today=beijingNow().date;
  const quoteFor=(id,day)=>{const quote=returns.live.get(id);return quote&&Number.isFinite(quote.time)&&new Date(quote.time+8*3600e3).toISOString().slice(0,10)===day?quote:null;};
  if(days.length&&days.at(-1)<today&&quoteFor(HS300,today))days.push(today);
  if(!days.length){returns.error='缺少可用于收益估值的交易日资料。';return;}
  const priceOn=(code,day)=>{const id=AstraKline.secid(code);if(day===today&&quoteFor(id,day))return quoteFor(id,day).price;const bars=closes.get(id);if(!bars)return null;let px=null;for(const b of bars){if(b.date>day)break;px=b.close;}return px;};
  let cash=num(data.snapshot.available_cash)+num(data.snapshot.frozen_cash);
  const hold=new Map(data.snapshot.positions.map(p=>[p.stock_code,num(p.quantity)]));
  let pending=[...trades];const points=[];let missing=0;const missingCodes=new Set();
  for(let i=days.length-1;i>=0;i--){
    const d=days[i];
    // undo every trade that happened after day d
    while(pending.length&&pending.at(-1).day>d){const t=pending.pop();if(t.side==='BUY'){cash+=t.qty*t.price;hold.set(t.code,(hold.get(t.code)||0)-t.qty);}else{cash-=t.qty*t.price;hold.set(t.code,(hold.get(t.code)||0)+t.qty);}}
    let value=cash,gap=0;
    for(const [code,q] of hold){if(!q)continue;const px=priceOn(code,d);if(px===null){gap++;missingCodes.add(code);continue;}value+=q*px;}
    missing+=gap;points.push({date:d,equity:value,holdings:new Map(hold),cash});
  }
  if(missingCodes.size){returns.error=missingCodes.size+' 只证券缺少历史估值价格，暂缓收益曲线，避免漏算持仓。请点击重试。';return;}
  points.reverse();
  const base=points[0];
  const idxClose=d=>{const id=HS300;if(d===today&&quoteFor(id,d))return quoteFor(id,d).price;return idx.find(b=>b.date===d)?.close??null;};
  const idx0=idxClose(base.date);
  points.forEach(p=>{p.ret=initial?p.equity/initial-1:null;p.bench=idx0?idxClose(p.date)/idx0-1:null;});
  let peak=-Infinity,maxDd=0;for(const p of points){peak=Math.max(peak,p.equity);maxDd=Math.max(maxDd,1-p.equity/peak);}
  const last=points.at(-1),prev=points.at(-2);
  // per-stock today: value change of today's holdings vs yesterday's, net of today's trades
  const perStock=new Map();
  if(prev&&last.date===today){const todayTrades=trades.filter(t=>t.day===today);
    const codes=new Set([...last.holdings.keys(),...prev.holdings.keys()]);
    for(const code of codes){const qNow=last.holdings.get(code)||0,qPrev=prev.holdings.get(code)||0;const pNow=priceOn(code,today),pPrev=priceOn(code,prev.date);if(pNow===null||pPrev===null)continue;
      let pnl=qNow*pNow-qPrev*pPrev;for(const t of todayTrades.filter(t=>t.code===code))pnl+=t.side==='BUY'?-t.qty*t.price:t.qty*t.price;
      const live=returns.live.get(AstraKline.secid(code));perStock.set(code,{pnl,change:live?live.change:(pPrev?(pNow/pPrev-1)*100:null)});}}
  const cost=data.snapshot.positions.reduce((s,p)=>s+num(p.cost_price)*num(p.quantity),0);
  const floating=data.snapshot.positions.reduce((s,p)=>s+(num(p.unrealized_pnl)||0),0);
  returns.view={points,initial,today,last,prev,todayPnl:prev&&last.date===today?last.equity-prev.equity:null,todayPct:prev&&last.date===today?last.equity/prev.equity-1:null,
    cumPnl:initial?last.equity-initial:null,cumPct:last.ret,bench:last.bench,maxDd,floating,floatingPct:cost?floating/cost:null,perStock,
    startGap:initial?base.equity/initial-1:null,missing,unverified:trades.filter(t=>!t.verified).length,tradeCount:trades.length,live:inSession()&&[HS300,...data.snapshot.positions.map(p=>AstraKline.secid(p.stock_code))].every(id=>{const quote=quoteFor(id,today);return quote&&Date.now()-quote.time>=-60000&&Date.now()-quote.time<=180000;})};
}
const yuan=v=>num(v)===null||!Number.isFinite(num(v))?'—':(num(v)>0?'+':num(v)<0?'−':'')+'¥'+Math.abs(num(v)).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
const pctSigned=(v,d=2)=>v===null||!Number.isFinite(v)?'—':(v>0?'+':'')+(v*100).toFixed(d)+'%';
function renderReturns(){
  if(!data)return;
  const v=returns.view,card=$('returns-card');
  const today=$('asset-today');
  if(today)today.innerHTML=v&&v.todayPnl!==null?`<span>今日</span><b class="${cls(v.todayPnl)}">${yuan(v.todayPnl)}</b><b class="${cls(v.todayPct)}">${pctSigned(v.todayPct)}</b><small>${v.live?'实时':'收盘'}</small>`:'';
  if(!card){renderPortfolio();return;}
  if(!v){
    const loading=returns.status==='loading';
    const progress=returns.progress?` · ${returns.progress.done} / ${returns.progress.total}`:'';
    const message=loading?`正在加载历史行情${progress}`:returns.error||'历史行情尚未齐备，请重试加载。';
    card.innerHTML=`<div class="card-top"><span class="card-kicker">组合收益</span><button class="text-link" data-retry-returns ${loading?'disabled':''}>${loading?'加载中':'重试加载'}</button></div>
      <p class="returns-foot">账户快照累计收益 ${pctSigned(data.nav?.return_since_initial)}。曲线将在历史估值资料齐备后显示。</p>
      <div class="kline-loading" role="status">${esc(message)}</div>`;
    return;
  }
  const excess=v.cumPct!==null&&v.bench!==null?v.cumPct-v.bench:null;
  card.innerHTML=`<div class="card-top"><span class="card-kicker">组合收益 · 重建估算 · ${esc(v.points[0].date)} 起</span><span class="badge ${v.live?'':'neutral'}">${v.live?'● 实时估值 · 20 秒':'最近可用行情'}</span></div>
  <div class="returns-grid">
    <div class="r-main"><small>累计收益</small><b class="${cls(v.cumPct)}">${pctSigned(v.cumPct)}</b><span class="${cls(v.cumPnl)}">${yuan(v.cumPnl)}</span></div>
    <div><small>今日盈亏</small><b class="${cls(v.todayPnl)}">${yuan(v.todayPnl)}</b><span class="${cls(v.todayPct)}">${pctSigned(v.todayPct)}</span></div>
    <div><small>持仓浮动盈亏</small><b class="${cls(v.floating)}">${yuan(v.floating)}</b><span class="${cls(v.floatingPct)}">${pctSigned(v.floatingPct)}</span></div>
    <div><small>同期沪深300</small><b class="${cls(v.bench)}">${pctSigned(v.bench)}</b><span class="${cls(excess)}">${excess===null?'—':(excess>=0?'跑赢 ':'跑输 ')+Math.abs(excess*100).toFixed(2)+' 个百分点'}</span></div>
    <div><small>最大回撤 · 按日收盘</small><b>${pctSigned(v.maxDd?-v.maxDd:0)}</b><span>快照：当前距峰值 ${pct(data.nav.drawdown)}</span></div>
  </div>
  <div class="returns-chart" id="returns-chart"></div>
  <p class="returns-foot">曲线以当前账户现金与持仓为准，逐日倒推每天的委托并按当日收盘价估值（今日按最新可用价）。起点 ${esc(v.points[0].date)} 重建市值与初始资金 ${yuan(v.initial).replace('+','')} 相差 ${pctSigned(v.startGap)}。差异可能包含手续费、资金变动或历史资料缺口。${v.unverified}/${v.tradeCount} 笔成交价按委托限价估算。${returns.failed?.length?` ${returns.failed.length} 只证券行情缺失。`:''}</p>`;
  drawReturnsChart($('returns-chart'),v);
  renderPortfolio();
}
function drawReturnsChart(el,v){
  if(!el)return;const pts=v.points;if(pts.length<2){el.innerHTML='<div class="kline-loading" style="min-height:120px">交易天数不足，暂不画曲线</div>';return;}
  const W=Math.max(320,Math.round(el.clientWidth||700)),H=W<560?190:230,m={l:8,r:52,t:14,b:24},iw=W-m.l-m.r,ih=H-m.t-m.b;
  const vals=pts.flatMap(p=>[p.ret,p.bench]).filter(Number.isFinite);let lo=Math.min(0,...vals),hi=Math.max(0,...vals);const pad=(hi-lo)*.12||.005;lo-=pad;hi+=pad;
  const x=i=>m.l+iw*(i/(pts.length-1)),y=r=>m.t+ih*(hi-r)/(hi-lo),f=n=>n.toFixed(1);
  const line=(key,color,dash)=>`<path d="${pts.map((p,i)=>`${i?'L':'M'}${f(x(i))} ${f(y(p[key]))}`).join('')}" fill="none" stroke="${color}" stroke-width="${dash?1.4:2.4}" ${dash?'stroke-dasharray="5 4"':''} stroke-linejoin="round"/>`;
  const up=(v.cumPct||0)>=0,color=up?'#e3342f':'#0e9b6a';
  let svg=`<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="组合收益与沪深300对比"><defs><linearGradient id="r-area" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".16"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>`;
  for(let k=0;k<=4;k++){const r=hi-(hi-lo)*k/4;svg+=`<line class="k-grid" x1="${m.l}" x2="${W-m.r}" y1="${f(y(r))}" y2="${f(y(r))}"/><text class="k-axis" x="${W-m.r+6}" y="${f(y(r)+3.5)}">${(r*100).toFixed(1)}%</text>`;}
  svg+=`<line x1="${m.l}" x2="${W-m.r}" y1="${f(y(0))}" y2="${f(y(0))}" stroke="#9aa7b8" stroke-dasharray="3 4"/>`;
  const step=Math.max(1,Math.ceil(pts.length/7));pts.forEach((p,i)=>{if(i%step===0||i===pts.length-1)svg+=`<text class="k-axis" x="${f(x(i))}" y="${H-6}" text-anchor="${i===0?'start':i===pts.length-1?'end':'middle'}">${esc(p.date.slice(5))}</text>`;});
  svg+=`<path d="${pts.map((p,i)=>`${i?'L':'M'}${f(x(i))} ${f(y(p.ret))}`).join('')}L${f(x(pts.length-1))} ${f(y(0))}L${f(x(0))} ${f(y(0))}Z" fill="url(#r-area)"/>`;
  svg+=line('bench','#7b8a9d',true)+line('ret',color,false);
  pts.forEach((p,i)=>{svg+=`<circle cx="${f(x(i))}" cy="${f(y(p.ret))}" r="${i===pts.length-1?4.5:2.5}" fill="${i===pts.length-1?color:'#fff'}" stroke="${color}" stroke-width="1.6"/>`;});
  svg+=`<line class="k-cursor" x1="0" x2="0" y1="${m.t}" y2="${m.t+ih}" visibility="hidden"/><rect class="k-hit" x="${m.l}" y="${m.t}" width="${iw}" height="${ih}" fill="transparent"/></svg>`;
  el.innerHTML=`<div class="k-legend"><span><i style="background:${color}"></i>组合累计收益</span><span><i class="dash" style="border-color:#7b8a9d"></i>沪深300</span></div>${svg}<div class="k-tip" hidden></div>`;
  const s=el.querySelector('svg'),tip=el.querySelector('.k-tip'),cur=s.querySelector('.k-cursor');
  const move=e=>{const r=s.getBoundingClientRect(),px=(e.clientX-r.left)/r.width*W,i=Math.max(0,Math.min(pts.length-1,Math.round((px-m.l)/iw*(pts.length-1)))),p=pts[i],q=pts[i-1];
    cur.setAttribute('x1',x(i));cur.setAttribute('x2',x(i));cur.setAttribute('visibility','visible');
    tip.innerHTML=`<b>${esc(p.date)}${i===pts.length-1&&v.live?' · 实时':''}</b><div class="row"><span>组合累计</span><span class="${cls(p.ret)}">${pctSigned(p.ret)}</span></div><div class="row"><span>沪深300</span><span class="${cls(p.bench)}">${pctSigned(p.bench)}</span></div><div class="row"><span>当日盈亏</span><span class="${q?cls(p.equity-q.equity):''}">${q?yuan(p.equity-q.equity):'—'}</span></div><div class="row"><span>总资产</span><span>¥${money(p.equity)}</span></div>`;
    tip.hidden=false;const left=x(i)/W*r.width;tip.style.left=`${Math.max(0,left+(x(i)/W>.6?-tip.offsetWidth-12:12))}px`;tip.style.top=`${Math.max(0,e.clientY-r.top-tip.offsetHeight/2)}px`;};
  const hit=s.querySelector('.k-hit');hit.addEventListener('pointermove',move);hit.addEventListener('pointerdown',move);hit.addEventListener('pointerleave',()=>{tip.hidden=true;cur.setAttribute('visibility','hidden');});
}
setInterval(()=>{if(data&&!document.hidden&&inSession())refreshLive();},20_000);
setInterval(()=>{if(data&&!document.hidden)loadReturns();},10*60e3);
window.addEventListener('resize',()=>{clearTimeout(window.__rr);window.__rr=setTimeout(()=>{if(returns.view)drawReturnsChart($('returns-chart'),returns.view);},150);});

function render(){if(!data)return;const age=data.snapshot.age_seconds;const ageText=age===null?'暂无持仓快照':age>=3600?(age/3600).toFixed(1)+' 小时前':Math.floor(age/60)+' 分钟前';$('today').textContent=new Date().toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai',month:'long',day:'numeric',weekday:'short'});$('freshness').textContent='持仓快照 '+dt(data.snapshot.captured_at)+' · '+ageText+' · 非实时账户。网页快照生成于 '+dt(data.generated_at)+'；刷新仅读取已同步快照。';$('session-badge').textContent='只读快照 · 无执行功能';if(data.warnings.length){$('notice').textContent=data.warnings.join('\n');$('notice').hidden=false;}renderOverview();renderPortfolio();renderTrades();renderWorkflow();renderResearch();switchView(currentView);renderKlines();computeReturns();renderReturns();loadReturns();}
const nameFor=code=>data.snapshot.positions.find(p=>p.stock_code===code)?.stock_name||code;
function renderOverview(){const s=data.snapshot, total=num(s.total_assets), market=num(s.market_value), gross=total>0?market/total:0;const today=new Date(data.generated_at).toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});const todayOrders=data.orders.filter(o=>o.day===today);const pending=data.orders.filter(o=>!['filled','rejected','settled_unfilled'].includes(o.state));const last=data.cycles[0], report=data.reports[0];const circumference=2*Math.PI*60;
  $('view-overview').innerHTML=`<div class="hero-grid"><article class="card asset-card"><div class="card-top"><span class="card-kicker">模拟账户总资产</span><span class="badge neutral">CNY / 人民币</span></div><div class="asset-value"><span class="currency">¥</span>${money(total)}</div><div class="asset-meta"><span>相对初始资金 <strong class="${cls(data.nav.return_since_initial)}">${pct(data.nav.return_since_initial)}</strong></span><span>观察回撤 ${pct(data.nav.drawdown)}</span></div><div class="asset-today" id="asset-today"></div>${navCurve()}<div class="mini-metrics"><div><small>股票市值</small><b>${money(s.market_value)}</b></div><div><small>可用资金</small><b>${money(s.available_cash)}</b></div><div><small>冻结资金</small><b>${money(s.frozen_cash)}</b></div></div></article><article class="card allocation-card"><div class="card-top"><span class="card-kicker">资产配置</span><button class="text-link" data-view="portfolio">查看组合 ↗</button></div><div class="allocation-inner"><div class="donut"><svg viewBox="0 0 150 150" role="img" aria-label="股票仓位 ${pct(gross)}"><circle cx="75" cy="75" r="60" fill="none" stroke="#e8eef5" stroke-width="12"/><circle cx="75" cy="75" r="60" fill="none" stroke="#0a66d6" stroke-width="12" stroke-dasharray="${Math.max(0,Math.min(1,gross))*circumference} ${circumference}" stroke-linecap="round"/></svg><div class="donut-label"><b>${(gross*100).toFixed(1)}<small>%</small></b><small>股票仓位</small></div></div><div class="legend"><div class="legend-item"><i></i>股票<b>${s.positions.length} 只</b></div><div class="legend-item"><i></i>非股票余额<b>${pct(1-gross)}</b></div><div class="legend-item">执行配置<b>${esc(data.policy.allowed_modes.map(modeName).join(' / '))}</b></div></div></div></article></div><article id="returns-card" class="card returns-card"></article><div class="metric-grid"><article class="card metric"><span class="metric-label">快照当日委托</span><strong>${todayOrders.length}<small> 笔</small></strong><small>按已保存的委托日期</small></article><article class="card metric"><span class="metric-label">快照当日全部成交</span><strong>${todayOrders.filter(o=>o.state==='filled').length}<small> 笔</small></strong><small>有成交数量核验</small></article><article class="card metric"><span class="metric-label">未完成 / 待核对</span><strong>${pending.length}<small> 笔</small></strong><small>截至各自回读时点</small></article><article class="card metric"><span class="metric-label">已核验研究</span><strong>${data.reports.length}<small> 份</small></strong><small>盘前 · 盘后 · 对话</small></article></div><article id="kline-overview" class="card kline-card"></article><div class="two-column"><article class="card panel"><div class="panel-head"><h2>组合重心</h2><button class="text-link" data-view="portfolio">全部 ${s.positions.length} 只 ↗</button></div>${[...s.positions].sort((a,b)=>num(b.market_value)-num(a.market_value)).slice(0,5).map(p=>`<div class="holding-row" data-kline-pick="${esc(p.stock_code)}" role="button" tabindex="0" title="在 K 线中查看"><span class="ticker-icon">${esc(p.stock_code.replace(/\D/g,'').slice(-2))}</span><div class="holding-info"><b>${esc(p.stock_name)}</b><small>${esc(p.stock_code)}</small></div><div class="holding-bar"><i data-width="${total>0?Math.min(100,num(p.market_value)/total*400):0}"></i></div><span class="holding-weight">${pct(total>0?num(p.market_value)/total:null)}</span></div>`).join('')||'<p class="muted">暂无已保存持仓</p>'}</article><article class="card panel"><div class="panel-head"><h2>最近执行</h2><button class="text-link" data-view="workflow">全部记录 ↗</button></div>${data.cycles.slice(0,4).map(c=>`<div class="timeline-item"><i class="timeline-dot"></i><div><p>${c.source==='hourly_exit_v1'?'持久化退出检查':'Astra 小时流程'} ${badge(c.state)}</p><small>${esc(dt(c.created_at))} · ${c.order_count} 笔委托 / ${c.filled_count} 笔全部成交</small></div></div>`).join('')||'<p class="muted">暂无执行周期</p>'}</article></div><article class="card overview-bottom"><div><span class="eyebrow">LATEST INSIGHT</span><h3>最新研究</h3></div><div><p>${esc(report?.analysis.daily_context||'暂无已核验研究。')}</p><button class="text-link" data-view="research">${report?esc(dt(report.generated_at))+' · 查看完整报告 ↗':'打开报告列表 ↗'}</button></div></article>`;
  document.querySelectorAll('[data-width]').forEach(e=>e.style.width=e.dataset.width+'%');
}
function renderPortfolio(){const query=$('position-search').value.toLowerCase();const rows=data.snapshot.positions.map((p,i)=>({...p,i})).filter(p=>(p.stock_name+p.stock_code).toLowerCase().includes(query));$('position-count').textContent=' / '+data.snapshot.positions.length+' 只';$('portfolio-content').innerHTML=`<div class="table-card"><div class="table-wrap"><table><thead><tr><th>股票 / 代码</th><th class="num">持有 / 可卖</th><th class="num">快照价格</th><th class="num">平台持仓成本</th><th class="num">市值 / 权重</th><th class="num">平台浮动盈亏</th><th class="num">今日盈亏 / 涨跌</th><th>退出状态</th><th></th></tr></thead><tbody>${rows.map(p=>`<tr class="${p.stock_code===(klinePosition()?.stock_code)?'selected':''}"><td><button data-select="${esc(p.stock_code)}" title="在 K 线中查看">${esc(p.stock_name)}<small>${esc(p.stock_code)}</small></button></td><td class="num">${esc(p.quantity)}<small>可卖 ${esc(p.available_quantity)}</small></td><td class="num">${money(p.last_price)}</td><td class="num">${money(p.cost_price)}</td><td class="num">${money(p.market_value)}<small>${pct(num(p.market_value)/num(data.snapshot.total_assets))}</small></td><td class="num ${cls(p.unrealized_pnl)}">${signed(p.unrealized_pnl)}</td>${(()=>{const t=returns.view?.perStock.get(p.stock_code);return t?`<td class="num ${cls(t.pnl)}">${yuan(t.pnl)}<small class="${cls(t.change)}">${t.change===null||!Number.isFinite(t.change)?'—':(t.change>0?'+':'')+t.change.toFixed(2)+'%'}</small></td>`:'<td class="num muted">—</td>';})()}<td>${badge(p.exit.block_adds?'stopped':'monitoring',p.exit.block_adds?'暂停加仓':'查看退出条件')}<small>${p.exit.holding_trading_days??'—'} 个交易日</small></td><td><button class="text-link" data-position="${p.i}">详情 ↗</button></td></tr>`).join('')}</tbody></table></div><div class="table-foot"><span>${rows.length} 只 · 平台持仓成本不等于已核验成交均价</span><span>快照 ${esc(dt(data.snapshot.captured_at))}</span></div></div>`;}
function renderTrades(){let q=$('trade-search').value.toLowerCase(),filter=$('trade-filter').value;let rows=data.orders.map((o,i)=>({...o,i})).filter(o=>(o.stock_code+nameFor(o.stock_code)+o.day).toLowerCase().includes(q)).filter(o=>filter==='all'||filter===o.state||filter===o.side||(filter==='pending'&&!['filled','rejected','settled_unfilled'].includes(o.state)));const foot=pager('trades',rows.length);rows=rows.slice(pages.trades*20,pages.trades*20+20);$('trades-content').innerHTML=`<div class="table-card"><div class="table-wrap"><table><thead><tr><th>日期 / 代码</th><th>方向</th><th class="num">委托数量</th><th class="num">委托限价</th><th class="num">已成交数量</th><th class="num">成交均价</th><th>状态 / 回读时间</th><th></th></tr></thead><tbody>${rows.map(o=>`<tr><td>${esc(nameFor(o.stock_code))}<small>${esc(o.day)} · ${esc(o.stock_code)}</small></td><td class="${o.side==='BUY'?'positive':'negative'}">${o.side==='BUY'?'买入':'卖出'}</td><td class="num">${esc(o.quantity)}</td><td class="num">${money(o.limit_price)}</td><td class="num">${esc(o.filled_quantity)}</td><td class="num">${money(o.average_fill_price)}<small>${o.average_fill_price?'独立成交证据':'暂无核验均价'}</small></td><td>${badge(o.state)}<small>${esc(dt(o.reconciled_at||o.observed_at))}</small></td><td><button class="text-link" data-order="${o.i}">详情 ↗</button></td></tr>`).join('')||'<tr><td colspan="8">没有匹配的交易记录</td></tr>'}</tbody></table></div>${foot}</div>`;}
function renderWorkflow(){const q=$('cycle-search').value.toLowerCase();let rows=data.cycles.map((c,i)=>({...c,i})).filter(c=>(c.id+c.created_at).toLowerCase().includes(q));const foot=pager('workflow',rows.length);rows=rows.slice(pages.workflow*20,pages.workflow*20+20);$('workflow-content').innerHTML=`<div class="table-card">${rows.map(c=>`<button class="cycle-row" data-cycle="${c.i}"><div class="cycle-time">${esc(dt(c.created_at))}<small>${c.order_count} 笔委托 · ${c.filled_count} 笔全部成交</small></div><div class="cycle-copy"><h3>${c.source==='hourly_exit_v1'?'确定性退出 · 零模型调用':c.model_verified?'Astra 分析 · 回执已核验':'流程检查 · 未核验到完成模型'} ${badge(c.state)}</h3><p>${esc(c.reason||c.hold_reason||c.market_view||'查看该周期的记录与跳过目标')}</p></div><span>↗</span></button>`).join('')||'<div class="empty">没有匹配的周期</div>'}${foot}</div>`;}
function renderResearch(){const filter=$('report-filter').value;let rows=data.reports.map((r,i)=>({...r,i})).filter(r=>filter==='all'||r.phase===filter);const foot=pager('research',rows.length);rows=rows.slice(pages.research*20,pages.research*20+20);$('research-content').innerHTML=rows.map(r=>`<button class="card report-card" data-report="${r.i}"><div class="card-top"><span class="eyebrow">${r.phase==='pre'?'BEFORE THE BELL':r.phase==='post'?'AFTER THE CLOSE':'CONVERSATION'}</span>${badge(r.status,'哈希与回执已核验')}</div><h3>${esc(r.trade_date)} · ${phaseName(r.phase)}</h3><p>${esc(r.analysis.daily_context)}</p><small>${esc(dt(r.generated_at))} · ${r.analysis.holdings_review?.length??0} 只持仓研究</small><div class="report-bottom"><span>研究倾向 ${esc(modeName(r.analysis.market_mode))}</span><span>阅读报告 ↗</span></div></button>`).join('')||'<div class="empty">暂无该阶段的已核验报告</div>';$('research-content').insertAdjacentHTML('beforeend',foot);}
function renderView(v){({trades:renderTrades,workflow:renderWorkflow,research:renderResearch}[v]||(()=>{}))();}
$('position-search').oninput=()=>data&&renderPortfolio();$('trade-search').oninput=$('trade-filter').onchange=()=>{pages.trades=0;if(data)renderTrades();};$('cycle-search').oninput=()=>{pages.workflow=0;if(data)renderWorkflow();};$('report-filter').onchange=()=>{pages.research=0;if(data)renderResearch();};
const fieldNames={code:'证券代码',name:'名称',stock_code:'证券代码',stock_name:'名称',thesis:'判断',thesis_change:'判断变化',change_from_previous:'相对前次变化',risk:'风险',risks:'风险',next_check:'下一次验证条件',evidence_ids:'证据编号',daily_context:'市场背景',holdings_review:'全部持仓复核',watchlist:'延续关注股',macro_points:'国内外背景传导',retrospective:'相对前次判断的复核',limitations:'资料缺口与限制',lesson_reviews:'交易复盘',market_mode:'研究倾向',catalyst:'催化',invalidation:'反证条件',topic:'主题',impact:'影响',transmission:'传导路径',assessment:'评价',lesson:'经验假设',as_of:'研究采集时间',reference_trade_date:'榜单参考交易日',snapshot_at:'持仓快照时间',research_timing:'研究时段说明',holdings_status:'持仓资料状态',scope:'资料范围',generated_at:'生成时间',captured_at:'采集时间',account_captured_at:'账户快照时间',holdings_snapshot_at:'持仓快照时间',snapshot_age_seconds:'快照年龄（秒）',reference_date:'参考日期',title:'标题',reason:'原因',exit_rule:'退出条件',holding_trading_days:'持有交易日数',entry_date:'入场日期',stop_price:'止损检查价',support_price:'支撑检查价',support_checks:'支撑确认次数',trailing_drawdown:'追踪回撤比例',max_holding_trading_days:'最长持有交易日',stagnation_trading_days:'停滞检查起始日',reduction_fraction:'单次减仓比例',policy_source:'退出政策来源',observed_at:'退出检查时间',block_adds:'暂停加仓',peak_hourly_price:'生命周期最高小时检查价',policy:'原入场退出政策'};
function structured(value,depth=0){if(value===null||value===undefined)return '<p>未记录 / 未知</p>';if(typeof value!=='object')return '<p>'+esc(typeof value==='boolean'?(value?'是':'否'):value)+'</p>';if(Array.isArray(value))return value.length?value.map(v=>`<div class="detail-item">${structured(v,depth+1)}</div>`).join(''):'<p class="muted">无条目</p>';return Object.entries(value).filter(([k])=>!['request_sha256','lesson_id'].includes(k)).map(([k,v])=>`<div class="detail-field"><b>${esc(fieldNames[k]||k)}</b>${structured(v,depth+1)}</div>`).join('');}
function openDetail(title,kicker,content){$('detail-kicker').textContent=kicker;$('detail-body').innerHTML='<h2>'+esc(title)+'</h2>'+content;$('detail').showModal();}
$('close-detail').onclick=()=>$('detail').close();$('detail').addEventListener('click',e=>{if(e.target===$('detail')){const r=$('detail').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$('detail').close();}});
function showPosition(p){openDetail(p.stock_name+' / '+p.stock_code,'POSITION / SAVED SNAPSHOT',`<div class="detail-block">${structured({'快照时间':dt(data.snapshot.captured_at),'持有数量':p.quantity,'可卖数量':p.available_quantity,'平台浮动盈亏':p.unrealized_pnl})}</div><div class="detail-block"><h3>原持仓退出条件</h3>${structured(p.exit)}</div>`);}
function showOrder(o){openDetail((o.side==='BUY'?'买入 ':'卖出 ')+o.stock_code,'ORDER / '+statusName(o.state),`<div class="detail-block">${structured({'委托日期':o.day,'委托数量':o.quantity,'委托限价':o.limit_price,'已成交数量':o.filled_quantity,'核验成交均价':o.average_fill_price,'回读时间':dt(o.reconciled_at||o.observed_at),'追加历史成交核验证据':o.reconciled_from_history,'入场或退出理由':o.reason,'原退出条件':o.exit_rule,'本地委托 ID':o.id,'周期':o.cycle_id})}</div>`);}
function showCycle(c){const orders=data.orders.filter(o=>o.cycle_id===c.id);openDetail(dt(c.created_at)+' · '+statusName(c.state),'CYCLE / '+c.id,`<div class="detail-block">${structured({'来源':c.source,'模型回执已核验':c.model_verified,'执行状态':statusName(c.result_status||c.state),'停止原因':c.reason,'市场判断':c.market_view,'执行配置':c.strategy_mode?modeName(c.strategy_mode):null,'配置理由':c.strategy_reason,'持有理由':c.hold_reason,'未提交目标':c.skipped_targets})}</div><div class="detail-block"><h3>本周期委托</h3>${orders.map(o=>`<div class="detail-item">${esc(o.stock_code)} · ${o.side==='BUY'?'买入':'卖出'} ${esc(o.quantity)} 股 ${badge(o.state)}<p class="muted">成交 ${esc(o.filled_quantity)} 股 · 限价 ${money(o.limit_price)}</p></div>`).join('')||'<p>本周期没有委托记录。</p>'}</div><div class="detail-field"><b>请求 SHA256</b><p>${esc(c.request_sha256)}</p></div>`);}
function showReport(r){openDetail(r.trade_date+' · '+phaseName(r.phase),'VERIFIED RESEARCH / '+dt(r.generated_at),`<div class="detail-block"><h3>资料与持仓快照时点</h3>${structured(r.research)}${structured({'缺失来源':r.missing_sources,'研究输入范围':r.input_budget})}</div>${Object.entries(r.analysis).filter(([k])=>k!=='request_sha256').map(([k,v])=>`<div class="detail-block"><h3>${esc(fieldNames[k]||k)}</h3>${structured(v)}</div>`).join('')}<div class="detail-field"><b>报告 SHA256</b><p>${esc(r.report_sha256)}</p></div>`);}
loggedOut();
