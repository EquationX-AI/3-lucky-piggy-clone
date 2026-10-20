// v4: Scope-based precise trap removal.
// 
// The only 100% unique anchor is the self-destruct function body.
// From there, use babel SCOPE to trace exactly which statements reference
// the same binding — no string matching on single-letter names.
//
// Algorithm:
// 1. Find every self-destruct function (body contains window.opener + about:blank + window.close)
// 2. For each, get its binding in the enclosing scope
// 3. Collect every statement in the same block that references this binding
//    AND matches trap patterns (IIFE, .instance)
// 4. From the IIFE, find which other bindings IT references → collect those too
//    (the probability fn, the bundle checker, the async wrappers, the numeric arrays)
// 5. Remove all collected statements. Never remove a binding still referenced by non-trap code.
// 6. Remove standalone modules that became empty (random filename only).

import * as babel from '@babel/core';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';
import fs from 'fs';

const traverse = _traverse.default ?? _traverse;
const generate = _generate.default ?? _generate;

const input = process.argv[2];
const output = process.argv[3];

const code = fs.readFileSync(input, 'utf8');

// Phase 0: in blocks that contain a self-destruct fn, split comma-merged statements
// so trap code and real code are no longer glued together (semantics preserving).
function isDestruct(fnNode) {
  const b = generate(fnNode.body).code;
  return b.includes('window.opener') && b.includes('about:blank') && b.includes('window.close');
}
const ast0 = babel.parseSync(code, { sourceType: 'script' });
const blocks = new Set();
traverse(ast0, { 'FunctionDeclaration|FunctionExpression'(p) {
  if (!isDestruct(p.node)) return;
  const st = p.getStatementParent(); if (st && st.parentPath) blocks.add(st.parentPath.node);
}});
let splits = 0;
for (const blk of blocks) {
  const out = [];
  for (const st of blk.body) {
    if (t.isExpressionStatement(st) && t.isSequenceExpression(st.expression)) {
      for (const e of st.expression.expressions) out.push(t.expressionStatement(e));
      splits++; continue;
    }
    if (t.isVariableDeclaration(st)) {
      let cur = [];
      for (const d of st.declarations) {
        if (d.init && t.isSequenceExpression(d.init)) {
          if (cur.length) { out.push(t.variableDeclaration(st.kind, cur)); cur = []; }
          const ex = d.init.expressions;
          for (const e of ex.slice(0, -1)) out.push(t.expressionStatement(e));
          cur.push(t.variableDeclarator(d.id, ex[ex.length - 1])); splits++;
        } else cur.push(d);
      }
      if (cur.length) out.push(t.variableDeclaration(st.kind, cur));
      continue;
    }
    out.push(st);
  }
  blk.body = out;
}
console.log(`Phase 0: normalized ${blocks.size} blocks, ${splits} comma-merged statements split`);
const ast = babel.parseSync(generate(ast0, { compact: true }).code, { sourceType: 'script' });


function topStmt(p, block) {
  let cur = p, prev = null;
  while (cur && cur.parentPath && cur.parentPath !== block) { prev = cur; cur = cur.parentPath; }
  if (!(cur && cur.parentPath === block)) return null;
  // multi-declarator var: use the single declarator as the unit
  if (cur.isVariableDeclaration() && cur.node.declarations.length > 1) {
    let q = p;
    while (q && q.parentPath !== cur) q = q.parentPath;
    if (q && q.isVariableDeclarator()) return q;
  }
  return cur;
}

// Step 1: Find self-destruct functions and their statement paths
const sdInfos = []; // { fnPath, stmtPath, name, scope }

traverse(ast, {
  'FunctionDeclaration|FunctionExpression'(path) {
    const bodyCode = generate(path.node.body).code;
    if (!bodyCode.includes('window.opener') ||
        !bodyCode.includes('about:blank') ||
        !bodyCode.includes('window.close')) return;

    let name, bindingScope;
    if (path.isFunctionDeclaration() && path.node.id) {
      name = path.node.id.name;
      bindingScope = path.parentPath.scope;
    } else if (path.parentPath?.isVariableDeclarator()) {
      name = path.parentPath.node.id?.name;
      bindingScope = path.parentPath.scope;
    }
    if (!name) return;

    sdInfos.push({
      fnPath: path,
      stmtPath: path.getStatementParent(),
      name,
      bindingScope,
    });
  }
});

console.log(`Step 1: ${sdInfos.length} self-destruct functions found`);

// Step 2-4: For each self-destruct, collect the full trap statement set
const allToRemove = new Set();
const trapModules = new Set();

for (const sd of sdInfos) {
  const trapSet = new Set();
  trapSet.add(sd.stmtPath); // the destruct fn itself

  // Get the block this function lives in
  const block = sd.stmtPath.parentPath;
  if (!block) continue;
  const siblings = block.get('body');

  // Find the binding of the destruct function
  const binding = sd.bindingScope.getBinding(sd.name);
  if (!binding) {
    // No binding found — remove just the function itself
    allToRemove.add(sd.stmtPath);
    continue;
  }

  // Collect statements that reference this binding
  for (const ref of binding.referencePaths) {
    const refStmt = topStmt(ref, block);
    if (refStmt) {
      trapSet.add(refStmt);
    }
  }

  // Fixpoint: pull in helpers whose every reference lives inside the trap set
  let changed = true;
  while (changed) {
    changed = false;
    const cand = new Map(); // name -> binding
    for (const stmt of trapSet) {
      stmt.traverse({
        Identifier(idPath) {
          const b = idPath.scope.getBinding(idPath.node.name);
          if (!b) return;
          const d = topStmt(b.path, block);
          if (!d || trapSet.has(d)) return;
          cand.set(b, d);
        }
      });
    }
    for (const [b, d] of cand) {
      // the declaring statement may declare several names; all must be trap-only
      const names = Object.keys(t.getBindingIdentifiers(d.node));
      const ok = (names.length ? names : [b.identifier.name]).every(n => {
        const bb = d.scope.getBinding(n) || b;
        return bb.referencePaths.every(r => { const rs = topStmt(r, block); return trapSet.has(rs) || rs === d; });
      });
      if (ok) { trapSet.add(d); changed = true; }
    }
    // referrers: expression statements whose every locally-bound identifier is declared by trap code
    const trapDecl = new Set();
    for (const u of trapSet) for (const n of Object.keys(t.getBindingIdentifiers(u.node))) { const b = u.scope.getBinding(n); if (b) trapDecl.add(b); }
    for (const sib of siblings) {
      if (trapSet.has(sib) || !sib.isExpressionStatement()) continue;
      let local = 0, allTrap = true;
      sib.traverse({ Identifier(ip) {
        if (!ip.isReferencedIdentifier()) return;
        const b = ip.scope.getBinding(ip.node.name);
        if (!b || topStmt(b.path, block) === null) return; // global or nested-local
        if (b.scope !== block.scope && b.scope !== sd.bindingScope) return;
        local++; if (!trapDecl.has(b)) allTrap = false;
      }});
      if (local > 0 && allTrap) { trapSet.add(sib); changed = true; }
    }
  }

  for (const stmt of trapSet) {
    allToRemove.add(stmt);
  }

  // Find module name for reporting
  let moduleName = '?';
  let p = sd.fnPath;
  while (p) {
    if (t.isCallExpression(p.node) && t.isMemberExpression(p.node.callee) &&
        t.isIdentifier(p.node.callee.object, {name:'System'}) &&
        t.isIdentifier(p.node.callee.property, {name:'register'})) {
      const arg = p.node.arguments[0];
      if (t.isStringLiteral(arg)) moduleName = arg.value.replace('chunks:///_virtual/','');
      break;
    }
    p = p.parentPath;
  }
  trapModules.add(moduleName);
  console.log(`  ${moduleName}: ${trapSet.size} stmts (destruct fn '${sd.name}')`);
}

console.log(`\nStep 5: Removing ${allToRemove.size} units total`);
// bindings declared by trap units
const trapIds = new Set();
for (const u of allToRemove) {
  for (const n of Object.keys(t.getBindingIdentifiers(u.node))) {
    const b = u.scope.getBinding(n); if (b) trapIds.add(b.identifier);
  }
}
function refsTrap(exprPath) {
  let hit = false;
  exprPath.traverse({ Identifier(ip) { const b = ip.scope.getBinding(ip.node.name); if (b && trapIds.has(b.identifier)) { hit = true; ip.stop(); } } });
  if (exprPath.isIdentifier()) { const b = exprPath.scope.getBinding(exprPath.node.name); if (b && trapIds.has(b.identifier)) hit = true; }
  return hit;
}
let keptSide = 0;
for (const u of allToRemove) {
  if (u.removed) continue;
  // var X = (sideEffect1, sideEffect2, trapValue)  -> keep side effects
  const init = u.isVariableDeclarator() ? u.get('init')
    : (u.isVariableDeclaration() && u.node.declarations.length === 1 ? u.get('declarations.0.init') : null);
  if (init && init.node && init.isSequenceExpression()) {
    const keep = init.node.expressions.slice(0, -1);
    if (keep.length) {
      const target = u.isVariableDeclarator() ? u : u.get('declarations.0');
      target.node.init = keep.length === 1 ? keep[0] : t.sequenceExpression(keep);
      keptSide++; continue;
    }
  }
  // a, b, trapCall  -> keep non-trap parts
  if (u.isExpressionStatement() && u.get('expression').isSequenceExpression()) {
    const parts = u.get('expression.expressions');
    const keep = parts.filter(e => !refsTrap(e)).map(e => e.node);
    if (keep.length) { u.node.expression = keep.length === 1 ? keep[0] : t.sequenceExpression(keep); keptSide++; continue; }
  }
  u.remove();
}
console.log(`  kept side effects in ${keptSide} merged units`);

// Step 6: Remove empty standalone trap modules (random filenames only)
let emptyRemoved = 0;
traverse(ast, {
  CallExpression(path) {
    if (!t.isMemberExpression(path.node.callee)) return;
    if (!t.isIdentifier(path.node.callee.object, {name:'System'})) return;
    if (!t.isIdentifier(path.node.callee.property, {name:'register'})) return;

    const name = t.isStringLiteral(path.node.arguments[0])
      ? path.node.arguments[0].value.replace('chunks:///_virtual/','') : '';
    // Only auto-remove random-named modules
    if (!trapModules.has(name)) return;

    const cb = path.node.arguments[path.node.arguments.length - 1];
    if (!t.isFunctionExpression(cb)) return;
    const ret = cb.body.body.find(s => t.isReturnStatement(s));
    if (!ret?.argument) return;
    const exec = ret.argument.properties?.find(p => t.isIdentifier(p.key, {name:'execute'}));
    if (!exec?.value?.body) return;

    const meaningful = exec.value.body.body.filter(s => {
      const sc = generate(s).code;
      return !sc.includes('_RF.push') && !sc.includes('_RF.pop') && sc.trim().length > 1;
    });
    if (meaningful.length === 0) {
      // keep the registration: other modules (main) list it as a dependency
      if (process.argv.includes('--drop-empty')) { path.getStatementParent()?.remove(); }
      emptyRemoved++;
    }
  }
});
console.log(`Step 6: ${emptyRemoved} standalone trap modules emptied (registration kept${process.argv.includes('--drop-empty')?', then dropped':''})`);

// Generate
const result = generate(ast, { compact: process.argv.includes('--pretty') ? false : true }).code;
fs.writeFileSync(output, result, 'utf8');

// Verify
const remaining = {
  'about:blank': (result.match(/about:blank/g)||[]).length,
  'window.close': (result.match(/window\.close/g)||[]).length,
  'window.opener': (result.match(/window\.opener/g)||[]).length,
  'getInfoWithPath': (result.match(/getInfoWithPath/g)||[]).length,
};

// Count modules
const origMods = (code.match(/System\.register\(/g)||[]).length;
const stripMods = (result.match(/System\.register\(/g)||[]).length;

console.log(`\n=== RESULTS ===`);
console.log(`Size: ${code.length} → ${result.length} (${((code.length-result.length)/code.length*100).toFixed(1)}% removed)`);
console.log(`Modules: ${origMods} → ${stripMods} (${origMods-stripMods} removed)`);
console.log(`\nResidue check:`);
for (const [k,v] of Object.entries(remaining)) {
  console.log(`  ${k.padEnd(18)}: ${v} ${v===0?'✅':'❌'}`);
}
