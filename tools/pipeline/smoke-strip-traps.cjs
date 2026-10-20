const fs=require('fs'), vm=require('vm');
function run(file){
  const regs=new Map();
  const mk=(name)=>{ const f=function(){return P(name+'()')}; return new Proxy(f,{get(t,k){ if(k===Symbol.toPrimitive)return ()=>1; if(k==='prototype')return t.prototype||(t.prototype={}); return P(name+'.'+String(k)); }, apply(){return P(name+'()')}, construct(){return P('new '+name)} }); };
  const cache=new Map(); function P(n){ if(!cache.has(n)) cache.set(n,mk(n)); return cache.get(n); }
  const timers=[]; const sandbox={System:{register(name,deps,fn){regs.set(name,{deps,fn});}}, console:{log(){},warn(){},error(){}},
    window:P('window'), document:P('document'), location:{href:'https://x/bt/',pathname:'/bt/',origin:'https://x',host:'x'}, navigator:{userAgent:'x',language:'en'},
    setTimeout:(f)=>{timers.push(f);return 1}, setInterval:()=>1, clearTimeout(){}, XMLHttpRequest:function(){return P('xhr')}, Promise, Math, JSON, Date, Object, Array, String, Number, Boolean, RegExp, Error, Symbol, Map, Set, WeakMap, parseInt, parseFloat, isNaN, globalThis:null, LobbyData:undefined};
  sandbox.globalThis=sandbox; vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(file,'utf8'),sandbox);
  const res={};
  for(const [name,{fn}] of regs){
    const exp=[]; const exportFn=(k,v)=>{ if(typeof k==='string')exp.push(k); else if(k&&typeof k==='object')exp.push(...Object.keys(k)); return v; };
    try{ const decl=fn(exportFn,{}); 
      const helpers={applyDecoratedDescriptor:(t,k,d,desc)=>desc,inheritsLoose:(a,b)=>{a.prototype=Object.create(b&&b.prototype||{});},initializerDefineProperty(){},assertThisInitialized:x=>x,createClass:(c)=>c,asyncToGenerator:f=>function(){return Promise.resolve()},regeneratorRuntime:()=>({mark:f=>f,wrap:()=>({})}),createForOfIteratorHelperLoose:()=>()=>({done:true})};
      (decl.setters||[]).forEach(s=>{ if(s) s(new Proxy(helpers,{get:(t,k)=>k in t?t[k]:P('dep.'+String(k))})); });
      decl.execute&&decl.execute(); res[name]={ok:true,exp:exp.sort().join(',')}; }
    catch(e){ res[name]={ok:false,err:String(e.message).slice(0,80),exp:exp.sort().join(',')}; }
  }
  return {res,timers:timers.length};
}
const A=run(process.argv[2]), B=run(process.argv[3]);
let okA=0,okB=0,diff=[];
for(const n of Object.keys(A.res)){ const a=A.res[n],b=B.res[n]; if(a.ok)okA++; if(b&&b.ok)okB++;
  if(!b||a.ok!==b.ok||a.exp!==b.exp) diff.push({n:n.replace('chunks:///_virtual/',''),orig:a.ok?'ok':a.err,stripped:b?(b.ok?'ok':b.err):'missing',expSame:b&&a.exp===b.exp}); }
console.log(`modules executed OK: original ${okA}/${Object.keys(A.res).length}, stripped ${okB}/${Object.keys(B.res).length}`);
console.log(`timers scheduled during load: original ${A.timers}, stripped ${B.timers}`);
console.log(diff.length?diff:'no behavioral differences in module execution/exports');
