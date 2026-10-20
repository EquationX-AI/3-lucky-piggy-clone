import * as babel from '@babel/core'; import _t from '@babel/traverse'; import _g from '@babel/generator'; import * as t from '@babel/types'; import fs from 'fs';
const traverse=_t.default??_t, generate=_g.default??_g;
function mods(file){
  const ast=babel.parseSync(fs.readFileSync(file,'utf8'),{sourceType:'script'}); const m=new Map();
  traverse(ast,{CallExpression(p){ if(generate(p.node.callee).code!=='System.register')return;
    const name=p.node.arguments[0].value; const fn=p.get(`arguments.${p.node.arguments.length-1}`);
    const globals=new Set(), exports=[]; let push=0,pop=0;
    fn.traverse({Identifier(ip){ if(!ip.isReferencedIdentifier())return; if(!ip.scope.getBinding(ip.node.name)) globals.add(ip.node.name); },
      CallExpression(cp){ const c=generate(cp.node.callee).code; if(c.endsWith('_RF.push'))push++; if(c.endsWith('_RF.pop'))pop++;
        // module export calls: <exportFn>("Name", ...) where exportFn is the register callback param
        const prm=fn.node.params[0]; if(prm&&t.isIdentifier(cp.node.callee,{name:prm.name})&&cp.scope.getBinding(prm.name)===fn.scope.getBinding(prm.name)){const a=cp.node.arguments[0]; exports.push(t.isStringLiteral(a)?a.value:t.isObjectExpression(a)?'{'+a.properties.map(q=>q.key.name||q.key.value).join(',')+'}':'?');}}});
    m.set(name,{code:generate(p.node,{compact:true}).code,globals,exports,push,pop}); p.skip(); }});
  return m;
}
const A=mods(process.argv[2]), B=mods(process.argv[3]);
let same=0, changed=[], bad=[];
for(const [n,a] of A){ const b=B.get(n); if(!b)continue;
  if(a.code===b.code){same++;continue;}
  const newG=[...b.globals].filter(x=>!a.globals.has(x));
  const ex=JSON.stringify(a.exports)===JSON.stringify(b.exports);
  const rf=a.push===b.push&&a.pop===b.pop;
  changed.push({n:n.replace('chunks:///_virtual/',''),exportsSame:ex,rf:`${b.push}/${b.pop}`,rfSame:rf,newGlobals:newG.join(','),size:`${a.code.length}->${b.code.length}`});
  if(!ex||!rf||newG.length)bad.push(n);
}
console.log(`unchanged modules: ${same}`); console.log(`changed modules: ${changed.length}`); console.table(changed);
console.log(bad.length?`❌ problems: ${bad.join(', ')}`:'✅ all changed modules keep exports, _RF balance, and no new unbound globals');
