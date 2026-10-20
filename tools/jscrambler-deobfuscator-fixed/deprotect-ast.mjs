// AST 结构化去保护 — 按特征模式删除 Jscrambler 自检、域名锁和通知代码
import * as babel from '@babel/core';
import _traverse from '@babel/traverse';
import * as t from '@babel/types';
import _generate from '@babel/generator';
import fs from 'fs';
const traverse = _traverse.default ?? _traverse;
const generate = _generate.default ?? _generate;

const input = process.argv[2], output = process.argv[3];
const ns = process.argv[4]; // w3Qmi / g0fHR / H6уCk
const code = fs.readFileSync(input, 'utf8');
const ast = babel.parseSync(code, { sourceType: 'script' });
const log = [];

// ======= 1. 找特征变量和函数 =======

// 找 Function.prototype.toString 赋值的变量名
const toStringVarNames = new Set();
// 找 MurmurHash3 工厂函数名（包含 3432918353）
const murmurFactoryNames = new Set();
// 找自检 wrapper 函数名（调用了 toString 变量的 .call）
const selfCheckWrapperNames = new Set();
// 找掩码变量（被 ^= 自身清零的）
const maskVarNames = new Set();
// 找违规码变量（被 = xxx || yyy 赋值的，且后面有 if (xxx && ...) { IIFE }）
const violCodeVarNames = new Set();

// 扫描整个代码找特征
const lines = code.split('\n');
for (let i = 0; i < lines.length; i++) {
  const line = lines[i].trim();
  // Function.prototype.toString 赋值
  const fptMatch = line.match(/^(\w+)\s*=\s*Function\.prototype\.toString;$/);
  if (fptMatch) toStringVarNames.add(fptMatch[1]);
  // 掩码清零
  const maskMatch = line.match(/^(\w+)\s*\^=\s*\1;$/);
  if (maskMatch) maskVarNames.add(maskMatch[1]);
}

// 从 AST 找 MurmurHash 函数（包含常量 3432918353）
traverse(ast, {
  noScope: true,
  NumericLiteral(path) {
    if (path.node.value === 3432918353 || path.node.value === 2971072446) {
      // 往上找最近的函数
      let fn = path.findParent(p => p.isFunctionExpression() || p.isFunctionDeclaration());
      if (fn) {
        // 再往上找赋值
        let assign = fn.findParent(p => p.isAssignmentExpression() || p.isVariableDeclarator());
        if (assign) {
          let id = assign.isAssignmentExpression() ? assign.node.left : assign.node.id;
          if (t.isIdentifier(id)) murmurFactoryNames.add(id.name);
        }
      }
    }
  }
});

// 找自检 wrapper（调用了 toString 变量的 .call 且包含 MurmurHash 引用）
for (const tsVar of toStringVarNames) {
  traverse(ast, {
    noScope: true,
    AssignmentExpression(path) {
      if (!t.isIdentifier(path.node.left)) return;
      if (!t.isFunctionExpression(path.node.right)) return;
      const src = generate(path.node.right).code;
      if (src.includes(tsVar + '.call(')) {
        selfCheckWrapperNames.add(path.node.left.name);
      }
    }
  });
}

// 找违规码变量（X = X || Y 形式）
traverse(ast, {
  noScope: true,
  AssignmentExpression(path) {
    if (!t.isIdentifier(path.node.left)) return;
    if (!t.isLogicalExpression(path.node.right, { operator: '||' })) return;
    if (t.isIdentifier(path.node.right.left) && path.node.right.left.name === path.node.left.name) {
      violCodeVarNames.add(path.node.left.name);
    }
  }
});

log.push('toString变量: ' + [...toStringVarNames]);
log.push('MurmurHash工厂: ' + [...murmurFactoryNames]);
log.push('自检wrapper: ' + [...selfCheckWrapperNames]);
log.push('掩码变量: ' + [...maskVarNames]);
log.push('违规码变量: ' + [...violCodeVarNames]);

// ======= 2. AST 变换：中和自检 =======
let changes = 0;

// 2a. 掩码清零 → noop: VAR ^= VAR → VAR = VAR
traverse(ast, {
  noScope: true,
  AssignmentExpression(path) {
    if (path.node.operator !== '^=') return;
    if (!t.isIdentifier(path.node.left) || !t.isIdentifier(path.node.right)) return;
    if (path.node.left.name === path.node.right.name && maskVarNames.has(path.node.left.name)) {
      path.node.operator = '=';
      changes++;
    }
  }
});

// 2b. 违规码赋值中和
// 初始化赋值（在 G0U 的 if 分支里）：找 "VIOL = xxx; MASK = MASK;" 模式
traverse(ast, {
  noScope: true,
  ExpressionStatement(path) {
    const expr = path.node.expression;
    if (!t.isAssignmentExpression(expr, { operator: '=' })) return;
    if (!t.isIdentifier(expr.left)) return;
    if (!violCodeVarNames.has(expr.left.name)) return;
    // 检查下一个兄弟是否是掩码 noop
    const next = path.getNextSibling();
    if (next && next.node && t.isExpressionStatement(next.node) &&
        t.isAssignmentExpression(next.node.expression, { operator: '=' }) &&
        t.isIdentifier(next.node.expression.left) && maskVarNames.has(next.node.expression.left.name)) {
      expr.right = t.nullLiteral();
      changes++;
    }
  }
});

// or-assign 中和: VIOL = VIOL || xxx
// 如果 xxx 是对象字面量或函数（兜底赋值，后续代码依赖它的属性），
// 改为 VIOL = xxx（直接赋值，跳过条件），这样既中和了违规码累积，又保留了兜底对象。
// 否则 VIOL = null。
traverse(ast, {
  noScope: true,
  AssignmentExpression(path) {
    if (path.node.operator !== '=') return;
    if (!t.isIdentifier(path.node.left)) return;
    if (!violCodeVarNames.has(path.node.left.name)) return;
    if (t.isLogicalExpression(path.node.right, { operator: '||' }) &&
        t.isIdentifier(path.node.right.left, { name: path.node.left.name })) {
      const rhs = path.node.right.right;
      if (t.isObjectExpression(rhs) || t.isFunctionExpression(rhs) || t.isArrowFunctionExpression(rhs)) {
        // 保留兜底对象: VIOL = VIOL || {get:...} → VIOL = {get:...}
        path.get('right').replaceWith(t.cloneNode(rhs, true));
      } else {
        path.get('right').replaceWith(t.nullLiteral());
      }
      changes++;
    }
  }
});

// 2c. 处罚 if 删除
// CFF 展开后违规码可能被中间变量传递（如 E$D = L__ || xxx），
// 需要追踪：Y = VIOL || xxx → Y 也视为违规码
const extendedViolNames = new Set(violCodeVarNames);
traverse(ast, {
  noScope: true,
  AssignmentExpression(path) {
    if (path.node.operator !== '=') return;
    if (!t.isIdentifier(path.node.left)) return;
    const rhs = path.node.right;
    // Y = VIOL || xxx
    if (t.isLogicalExpression(rhs, { operator: '||' }) && t.isIdentifier(rhs.left) && extendedViolNames.has(rhs.left.name)) {
      extendedViolNames.add(path.node.left.name);
    }
    // Y = VIOL
    if (t.isIdentifier(rhs) && extendedViolNames.has(rhs.name)) {
      extendedViolNames.add(path.node.left.name);
    }
  }
});
const derivedViolNames = new Set([...extendedViolNames].filter(n => !violCodeVarNames.has(n)));
if (derivedViolNames.size > 0) log.push('派生违规码变量: ' + [...derivedViolNames]);

// if (VIOL && ...) { ... } → 删除整个 if（包括派生的违规码变量）
traverse(ast, {
  noScope: true,
  IfStatement(path) {
    const test = path.node.test;
    if (!t.isLogicalExpression(test, { operator: '&&' })) return;
    if (t.isIdentifier(test.left) && extendedViolNames.has(test.left.name)) {
      path.remove();
      changes++;
    }
  }
});

// 2d. 自检 wrapper 函数清空: 把包含 toString.call 的函数体替换为 return 0
// 同时收集引用自检 wrapper 的外层函数名（如 F0vNvw5 引用 h_4lb50）
const outerCheckNames = new Set();
traverse(ast, {
  noScope: true,
  AssignmentExpression(path) {
    if (!t.isIdentifier(path.node.left)) return;
    if (!t.isFunctionExpression(path.node.right)) return;
    const src = generate(path.node.right).code;
    if (selfCheckWrapperNames.has(path.node.left.name)) {
      const params = path.node.right.params;
      path.get('right').replaceWith(
        t.functionExpression(null, params, t.blockStatement([t.returnStatement(t.numericLiteral(0))]))
      );
      changes++;
    } else {
      // 检查外层函数是否引用了自检 wrapper
      for (const name of selfCheckWrapperNames) {
        if (src.includes(name)) {
          outerCheckNames.add(path.node.left.name);
          break;
        }
      }
    }
  }
});

// 2d2. 清空自检容器：IIFE 和引用了违规码变量的 _global[N] 函数
// CFF 展开后有两类容器：
//   a. _global[385532] = (function(){...h_4lb50...})()  ← IIFE（立即调用）
//   b. _global[412913] = function(){...F0vNvw5...违规码...}  ← 延迟调用的函数
// 策略 1: 从 h_4lb50 赋值往上找 IIFE
traverse(ast, {
  noScope: true,
  AssignmentExpression(path) {
    if (!t.isIdentifier(path.node.left)) return;
    if (!selfCheckWrapperNames.has(path.node.left.name)) return;
    let p = path.parentPath;
    while (p) {
      if (p.isCallExpression() && p.get('callee').isFunctionExpression()) {
        const iifeFn = p.get('callee');
        iifeFn.get('body').replaceWith(t.blockStatement([t.returnStatement(t.objectExpression([]))]));
        changes++;
        log.push('清空自检容器 IIFE → return {}');
        break;
      }
      p = p.parentPath;
    }
  }
});
// 策略 2: 不再清空违规码容器 IIFE（因为它导出的 F0vNvw5 也被业务逻辑调用）
// 处罚效果已被策略 2b/2c/2d/2e/2f/2g 的规则逐条中和

// 2e. MurmurHash 工厂清空
traverse(ast, {
  noScope: true,
  AssignmentExpression(path) {
    if (!t.isIdentifier(path.node.left)) return;
    if (!murmurFactoryNames.has(path.node.left.name)) return;
    if (!t.isFunctionExpression(path.node.right)) return;
    const params = path.node.right.params;
    path.get('right').replaceWith(
      t.functionExpression(null, params, t.blockStatement([t.returnStatement(t.numericLiteral(0))]))
    );
    changes++;
  }
});

// 2f. X0gnGEw 域名锁清空
traverse(ast, {
  noScope: true,
  FunctionDeclaration(path) {
    if (!path.node.id) return;
    if (path.node.id.name === 'X0gnGEw') {
      path.get('body').replaceWith(t.blockStatement([t.returnStatement(t.booleanLiteral(true))]));
      changes++;
    }
    // 其他域名锁（长函数含 delete）
    const src = generate(path.node).code;
    if (src.length > 5000 && src.includes('delete ') && path.node.id.name !== 'X0gnGEw') {
      path.get('body').replaceWith(t.blockStatement([t.returnStatement(t.booleanLiteral(true))]));
      changes++;
      log.push('域名锁(非X0gnGEw): ' + path.node.id.name);
    }
  }
});

// 2g. u36hk03 通知函数中和（如果存在）
traverse(ast, {
  noScope: true,
  ObjectProperty(path) {
    if (t.isIdentifier(path.node.key, { name: 'u36hk03' }) || 
        t.isStringLiteral(path.node.key, { value: 'u36hk03' })) {
      if (t.isFunctionExpression(path.node.value)) {
        path.get('value').replaceWith(
          t.functionExpression(null, path.node.value.params, t.blockStatement([]))
        );
        changes++;
        log.push('清空 u36hk03');
      }
    }
  }
});

// ======= 3. 命名空间修复 =======
// 第一条语句 const _global = globalThis → var _global = NS
const firstStmt = ast.program.body[0];
if (t.isVariableDeclaration(firstStmt, { kind: 'const' })) {
  const decl = firstStmt.declarations[0];
  if (t.isIdentifier(decl.id, { name: '_global' }) && t.isIdentifier(decl.init, { name: 'globalThis' })) {
    firstStmt.kind = 'var';
    decl.init = t.identifier(ns);
    changes++;
  }
}

// ======= 4. 生成输出 =======
const out = generate(ast).code;
fs.writeFileSync(output, out);
for (const l of log) console.log(l);
console.log(`去保护(AST): ${changes} 处, ${out.length} 字符`);
