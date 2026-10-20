import * as t from '@babel/types';
import generator from '@babel/generator';
import vm from 'vm';

const generatedArraysMap = new Map();

// ===================== 配置 =====================
// configure({ sourceCode, dynamicInit, hostname })
//   sourceCode：原始文件文本（动态初值求解要按原始字节取函数源码；局部替换要按原始偏移拼接）
//   dynamicInit：是否启用动态初值求解（任务 2），默认 true（没有 sourceCode 时自动不启用）
// 每次展开都会往 cffRegions 里记一条"原始偏移区间 → 新内容"，供 spliceRegions() 做局部替换（任务 1）。
const cfg = { sourceCode: null, dynamicInit: true, hostname: 'localhost', timeout: 50 };
export const cffRegions = [];
export const dynInitStats = { tried: 0, resolved: 0, failed: [], list: [] };
export function configure(opts = {}) {
    Object.assign(cfg, opts);
    cffRegions.length = 0;
    dynInitStats.tried = 0; dynInitStats.resolved = 0; dynInitStats.failed = []; dynInitStats.list = [];
    dyn.ctx = null; dyn.fp = null; dyn.key = null;
}
function recordRegion(start, end, payload) {
    if (typeof start !== 'number' || typeof end !== 'number') return;
    cffRegions.push({ start, end, ...payload });
}

// 把记录的区间拼回原始代码：被别的区间包住的区间丢掉（外层重新生成时已含内层改动），其余按原始偏移替换。
export function spliceRegions(code, regions = cffRegions) {
    const sorted = [...regions].sort((a, b) => a.start - b.start || b.end - a.end);
    const top = [];
    for (const r of sorted) {
        const last = top[top.length - 1];
        if (last && r.start >= last.start && r.end <= last.end) continue; // 被包含
        if (last && r.start < last.end) throw new Error(`局部替换区间部分重叠: [${last.start},${last.end}) 与 [${r.start},${r.end})`);
        top.push(r);
    }
    let out = '';
    let pos = 0;
    for (const r of top) {
        out += code.slice(pos, r.start);
        out += r.text !== undefined ? r.text : r.nodes.map((n) => generator.default(n).code).join('\n');
        pos = r.end;
    }
    out += code.slice(pos);
    return { code: out, regions: top.length };
}

// ===================== 动态初值求解（任务 2） =====================
// 状态机初值是 `S = X`，`var X = W(字面量...)`。
// 路径 A：W 没有任何外部依赖（纯函数）→ 在空 vm 里直接执行 W 的源码。
// 路径 B：W 依赖外部（Jscrambler 的完整性校验 `NS.K1L(fn,-1,...)`，返回值取决于 fn.toString() 的哈希）
//   → 递归收集 W 引用的局部函数（按原始字节取源码，保证 toString 与原文件一致），打包成自包含片段，
//     在"执行过一遍原文件"的 vm 上下文里运行（前导代码在那里装好了命名空间运行时），超时 50ms。
//   校验函数发现哈希不符会删内置对象（处罚），所以调用前后给内置对象拍指纹：指纹变了 = 被判篡改 → 丢弃。
// 两条路径的结果还必须是该状态机的某个 case 标签。
const dyn = { ctx: null, fp: null, key: null };
const FP_SRC = `[typeof eval, typeof JSON.stringify, Object.getOwnPropertyNames(Object).length, Object.getOwnPropertyNames(Object.prototype).length,
    Object.getOwnPropertyNames(String.prototype).length, Object.getOwnPropertyNames(Function.prototype).length,
    Object.getOwnPropertyNames(Array.prototype).length, Object.getOwnPropertyNames(Math).length].join()`;
function makeSandbox(hostname) {
    const loc = { hostname, host: hostname, href: `https://${hostname}/`, protocol: 'https:', origin: `https://${hostname}`, pathname: '/', search: '', hash: '' };
    const noop = () => {};
    const el = () => ({ style: {}, setAttribute: noop, appendChild: noop, addEventListener: noop });
    return {
        console: { log: noop, warn: noop, error: noop, info: noop, debug: noop },
        setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop, requestAnimationFrame: () => 0,
        navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36', language: 'en', languages: ['en'] },
        location: loc,
        document: { createElement: el, addEventListener: noop, location: loc, head: el(), body: el(), documentElement: el(), querySelector: () => null, getElementsByTagName: () => [] },
        addEventListener: noop, removeEventListener: noop,
        System: { register: noop, import: () => Promise.resolve({}) },
    };
}
const fingerprint = (ctx) => { try { return vm.runInContext(FP_SRC, ctx, { timeout: 200 }); } catch (e) { return 'ERR'; } };
function bootCtx() {
    if (dyn.ctx && dyn.key === cfg.sourceCode) return dyn.ctx;
    const ctx = vm.createContext(makeSandbox(cfg.hostname));
    vm.runInContext('var window = globalThis, self = globalThis, top = globalThis, parent = globalThis;', ctx);
    try { vm.runInContext(cfg.sourceCode, ctx, { timeout: 3000 }); } catch (e) { /* Node 里缺浏览器环境，跑到一半报错是预期的 */ }
    dyn.ctx = ctx; dyn.key = cfg.sourceCode; dyn.fp = fingerprint(ctx);
    return ctx;
}
const isLiteralArg = (a) =>
    t.isNumericLiteral(a) || t.isStringLiteral(a) || t.isBooleanLiteral(a) || t.isNullLiteral(a) ||
    (t.isUnaryExpression(a, { operator: '-' }) && t.isNumericLiteral(a.argument));
const hasPos = (n) => n && typeof n.start === 'number' && typeof n.end === 'number';

// ===================== 不透明谓词检测 =====================
// Jscrambler 的不透明谓词模式（AST 层面）：
//   NS[NS.method(N)]()          — 如 F69[F69.d_1(3007)]()
//   !NS[NS.method(N)]()         — 如 !F69[F69.d_1(1301)]()
//   NS[prop](NS.method(N))      — 如 k63[g8B](k63.y_L(1042))
// 共同特征：调用者是同一个命名空间对象上的计算属性方法。
// 两个分支都是数字字面量时，属于状态转换里的不透明谓词。
//
// 不是不透明谓词的情况：
//   someVar === someNumber ? A : B    — 直接的变量比较（应继续正常求值展开）
//   someVar ? A : B                   — 简单 truthy 判断
function isOpaquePredicate(testNode) {
    // 剥掉一层 ! 取反
    let node = testNode;
    if (t.isUnaryExpression(node, { operator: '!' })) node = node.argument;
    if (!t.isCallExpression(node)) return false;
    const callee = node.callee;
    if (!t.isMemberExpression(callee) || !callee.computed) return false;
    const obj = callee.object;
    // 模式 1: NS[NS.method(N)]() — 属性是同命名空间的方法调用
    if (t.isCallExpression(callee.property)) {
        const propCall = callee.property;
        if (t.isMemberExpression(propCall.callee) && !propCall.callee.computed &&
            t.isIdentifier(propCall.callee.object) && t.isIdentifier(obj) &&
            propCall.callee.object.name === obj.name) {
            return true;
        }
    }
    // 模式 2: NS[identProp](NS.method(N)) — 属性是标识符变量，参数是同命名空间方法调用
    if (t.isIdentifier(callee.property) && t.isIdentifier(obj) && node.arguments.length >= 1) {
        const arg = node.arguments[0];
        if (t.isCallExpression(arg) && t.isMemberExpression(arg.callee) && !arg.callee.computed &&
            t.isIdentifier(arg.callee.object) && arg.callee.object.name === obj.name) {
            return true;
        }
    }
    return false;
}

// 返回 { value, declPath, call } 或 null
function solveDynamicInit(scope, name, labels) {
    const code = cfg.sourceCode;
    if (!code || !cfg.dynamicInit) return null;
    const b = scope.getBinding(name);
    if (!b || b.constantViolations.length || !b.path.isVariableDeclarator()) return null;
    const call = b.path.node.init;
    if (!t.isCallExpression(call) || !t.isIdentifier(call.callee) || !hasPos(call) || !call.arguments.every(isLiteralArg)) return null;
    const wb = b.path.scope.getBinding(call.callee.name);
    if (!wb || !wb.path.isFunctionDeclaration() || wb.constantViolations.length || !hasPos(wb.path.node)) return null;
    dynInitStats.tried++;
    const fail = (why) => { dynInitStats.failed.push(name + ': ' + why); console.warn(`   |-> [dyn-init] ${name}: ${why}`); return null; };

    // 收集依赖
    const deps = new Map();
    let external = false;
    let ok = true;
    const visit = (fnPath, depth) => {
        if (depth > 4) { ok = false; return; }
        fnPath.traverse({
            ReferencedIdentifier(p) {
                const nm = p.node.name;
                if (deps.has(nm) || nm === call.callee.name) return;
                const db = p.scope.getBinding(nm);
                if (db && (db.scope === fnPath.scope || db.scope.path.isDescendant(fnPath))) return; // 参数/局部
                if (!db || db.scope.path.isProgram()) { external = true; return; }
                const isFn = db.path.isFunctionDeclaration() || (db.path.isFunctionExpression() && db.path.node.id && db.path.node.id.name === nm);
                if (isFn && hasPos(db.path.node)) {
                    deps.set(nm, code.slice(db.path.node.start, db.path.node.end));
                    if (db.path.node.end - db.path.node.start < 400) visit(db.path, depth + 1); // 小函数（包装函数）继续收集
                    return;
                }
                ok = false;
            },
        });
    };
    visit(wb.path, 0);
    if (!ok) return fail('依赖局部变量，无法离线复原');
    const snippet = '(function(){\n' + [...deps].map(([n, src]) => `var ${n} = (${src});`).join('\n') +
        '\n' + code.slice(wb.path.node.start, wb.path.node.end) + '\nreturn ' + code.slice(call.start, call.end) + ';\n})()';

    let v, via, tampered = false;
    try {
        if (!external) {
            via = 'A';
            v = vm.runInContext(snippet, vm.createContext({}), { timeout: cfg.timeout });
        } else {
            via = 'B';
            const ctx = bootCtx();
            try { v = vm.runInContext(snippet, ctx, { timeout: cfg.timeout }); } finally {
                if (fingerprint(ctx) !== dyn.fp) { tampered = true; dyn.ctx = null; }
            }
        }
    } catch (e) { return fail(`路径 ${via} 执行失败: ${String(e && e.message || e).slice(0, 80)}`); }
    if (tampered) return fail(`路径 ${via} 触发了完整性处罚，结果不可信`);
    if (typeof v !== 'number' || !Number.isFinite(v) || !labels.has(v)) return fail(`路径 ${via} 结果 ${String(v)} 不是合法 case`);
    dynInitStats.resolved++;
    dynInitStats.list.push({ name, declStart: b.path.node.start, value: v, via });
    console.log(`   |-> [dyn-init] ${name} = ${v}（路径 ${via}）`);
    return { value: v, declPath: b.path, call };
}

function generateCyclicalArray(size, offsetValue, key) {
    let matrix = [];
    for (let row = 0; row < size; row++) {
        matrix[row] = [];
    }

    for (let currentRow = 0; currentRow < size; currentRow++) {
        for (let sourceRow = size - 1; sourceRow >= 0; sourceRow--) {
            let keyIndex = 0;
            let baseOffset = key[keyIndex];
            if (baseOffset === 0) continue;
            let modulus = baseOffset;

            let destCol = (sourceRow + offsetValue * currentRow) % modulus;
            if (matrix[sourceRow]) {
                matrix[currentRow][destCol] = matrix[sourceRow];
            }
        }
    }
    return matrix;
}

function processVarDeclarations(statements, hoistedVars) {
    return statements.flatMap((stmt) => {
        if (!t.isVariableDeclaration(stmt, { kind: 'var' })) {
            return [stmt];
        }
        const assignments = [];
        for (const decl of stmt.declarations) {
            if (t.isIdentifier(decl.id)) {
                hoistedVars.add(decl.id.name);
                if (decl.init) {
                    assignments.push(
                        t.expressionStatement(t.assignmentExpression('=', decl.id, decl.init))
                    );
                }
            }
        }
        return assignments;
    });
}

function areVarsEquivalent(node1, node2) {
    if (t.isIdentifier(node1) && t.isIdentifier(node2)) {
        return node1.name === node2.name;
    }
    return t.isNodesEquivalent(node1, node2);
}

export const controlFlowUnflattener = {
    priority: 200,
    visitor: {
        AssignmentExpression(path) {
            const left = path.get('left');
            const right = path.get('right');

            if (!right.isCallExpression()) return;
            const args = right.get('arguments');
            if (
                args.length !== 3 ||
                !args[0].isNumericLiteral() ||
                !args[1].isNumericLiteral() ||
                !args[2].isArrayExpression()
            )
                return;

            const arrayArgElements = args[2].get('elements');
            if (arrayArgElements.length !== 1 || !arrayArgElements[0].isNumericLiteral()) return;

            const callee = right.get('callee');
            if (!callee.isFunction()) return;

            let returnStmtPath;
            callee.get('body').traverse({
                ReturnStatement(p) {
                    if (p.getFunctionParent().node === callee.node) {
                        if (p.get('argument').isObjectExpression()) {
                            returnStmtPath = p;
                            p.stop();
                        }
                    }
                },
            });
            if (!returnStmtPath) return;

            const objectProperties = returnStmtPath.get('argument.properties');
            if (objectProperties.length !== 1 || !objectProperties[0].isObjectProperty()) return;

            const objectPropertyPath = objectProperties[0];
            const propertyKeyNode = objectPropertyPath.get('key');
            if (!propertyKeyNode.isIdentifier()) return;
            const propertyName = propertyKeyNode.node.name;

            const baseIdentifierCode = generator.default(left.node).code;
            const fullKey = `${baseIdentifierCode}.${propertyName}`;

            const arg1 = args[0].node.value;
            const arg2 = args[1].node.value;
            const arg3 = [arrayArgElements[0].node.value];

            console.log(
                ` |-> Found cyclical array generator. Base object: "${baseIdentifierCode}", Property: "${propertyName}"`
            );
            console.log(`   |-> Arguments: size=${arg1}, offset=${arg2}, key=[${arg3}]`);

            const realArray = generateCyclicalArray(arg1, arg2, arg3);
            generatedArraysMap.set(fullKey, realArray);
            console.log(`   |-> In-memory array generated and stored for key: "${fullKey}"`);

            const parentStatement = path.findParent((p) => p.isStatement());
            if (parentStatement) {
                recordRegion(parentStatement.node.start, parentStatement.node.end, { text: '' });
                parentStatement.remove();
            }
        },

        ForStatement: {
            exit(path) {
                const { node } = path;
                if (node.update) return;
                if (!t.isBinaryExpression(node.test, { operator: '!==' })) return;
                const stateObjectToIdMap = new Map();
                let nextStateId = 0;

                const resolveAndGetStateId = (node) => {
                    const raw = generator.default(node).code;
                    if (t.isNumericLiteral(node)) {
                        const id = node.value;
                        return { id, raw };
                    }
                    if (t.isMemberExpression(node)) {
                        const indices = [];
                        let baseObjectNode = node;
                        while (
                            t.isMemberExpression(baseObjectNode) &&
                            baseObjectNode.computed &&
                            t.isNumericLiteral(baseObjectNode.property)
                        ) {
                            indices.unshift(baseObjectNode.property.value);
                            baseObjectNode = baseObjectNode.object;
                        }

                        const baseKey = generator.default(baseObjectNode).code;
                        if (generatedArraysMap.has(baseKey)) {
                            try {
                                let stateObj = generatedArraysMap.get(baseKey);
                                for (const index of indices) {
                                    stateObj = stateObj[index];
                                }
                                if (stateObj === undefined) return { id: null, raw };

                                if (stateObjectToIdMap.has(stateObj)) {
                                    return { id: stateObjectToIdMap.get(stateObj), raw };
                                } else {
                                    const newId = nextStateId++;
                                    stateObjectToIdMap.set(stateObj, newId);
                                    return { id: newId, raw };
                                }
                            } catch (e) {
                                return { id: null, raw };
                            }
                        }
                    }
                    return { id: null, raw };
                };

                let stateVar, terminalValueNode;
                const { left, right } = node.test;
                if (t.isIdentifier(left) || t.isMemberExpression(left)) {
                    stateVar = left;
                    terminalValueNode = right;
                } else if (t.isIdentifier(right) || t.isMemberExpression(right)) {
                    stateVar = right;
                    terminalValueNode = left;
                } else {
                    return;
                }

                const terminalInfo = resolveAndGetStateId(terminalValueNode);
                if (terminalInfo.id === null) return;
                const terminalId = terminalInfo.id;

                let switchStatement;
                if (t.isBlockStatement(node.body)) {
                    if (node.body.body.length !== 1 || !t.isSwitchStatement(node.body.body[0]))
                        return;
                    switchStatement = node.body.body[0];
                } else if (t.isSwitchStatement(node.body)) {
                    switchStatement = node.body;
                } else {
                    return;
                }

                if (!areVarsEquivalent(switchStatement.discriminant, stateVar)) return;
                console.log(` |-> Found state machine with terminal value: ${terminalInfo.raw}`);

                let initialStateInfo = null;
                let initializerPath = null;
                let inLoopInitializer = false;

                const findInitialState = (initNode, path) => {
                    let valueInfo = null;
                    if (t.isVariableDeclaration(initNode)) {
                        for (const declarator of initNode.declarations) {
                            if (areVarsEquivalent(declarator.id, stateVar) && declarator.init) {
                                valueInfo = resolveAndGetStateId(declarator.init);
                                if (valueInfo.id !== null) break;
                            }
                        }
                    } else if (t.isExpressionStatement(initNode)) {
                        const expr = initNode.expression;
                        if (
                            t.isAssignmentExpression(expr, { operator: '=' }) &&
                            areVarsEquivalent(expr.left, stateVar)
                        ) {
                            valueInfo = resolveAndGetStateId(expr.right);
                        }
                    }
                    if (valueInfo && valueInfo.id !== null) {
                        initialStateInfo = valueInfo;
                        initializerPath = path;
                        return true;
                    }
                    return false;
                };

                if (node.init && findInitialState(node.init, path)) {
                    inLoopInitializer = true;
                } else {
                    for (let i = path.key - 1; i >= 0; i--) {
                        const siblingPath = path.getSibling(i);
                        if (!siblingPath.node) continue;
                        if (findInitialState(siblingPath.node, siblingPath)) break;
                        const siblingNode = siblingPath.node;
                        if (
                            t.isForStatement(siblingNode) ||
                            t.isWhileStatement(siblingNode) ||
                            t.isDoWhileStatement(siblingNode) ||
                            t.isIfStatement(siblingNode) ||
                            t.isReturnStatement(siblingNode) ||
                            t.isSwitchStatement(siblingNode)
                        ) {
                            break;
                        }
                    }
                }

                // 任务 2：初值是变量（S = X，X = W(...)）→ 动态求解
                if (initialStateInfo === null && cfg.sourceCode && cfg.dynamicInit && t.isIdentifier(stateVar)) {
                    const fromNode = (nd) => {
                        if (t.isVariableDeclaration(nd)) {
                            for (const d of nd.declarations) if (areVarsEquivalent(d.id, stateVar) && t.isIdentifier(d.init)) return d.init;
                        } else if (t.isExpressionStatement(nd) && t.isAssignmentExpression(nd.expression, { operator: '=' }) &&
                            areVarsEquivalent(nd.expression.left, stateVar) && t.isIdentifier(nd.expression.right)) return nd.expression.right;
                        return null;
                    };
                    let identInit = null, identPath = null, identInLoop = false;
                    if (node.init && (identInit = fromNode(node.init))) { identPath = path; identInLoop = true; }
                    else {
                        for (let i = path.key - 1; i >= 0; i--) {
                            const sp = path.getSibling(i);
                            if (!sp.node) continue;
                            if ((identInit = fromNode(sp.node))) { identPath = sp; break; }
                            if (t.isLoop(sp.node) || t.isIfStatement(sp.node) || t.isReturnStatement(sp.node) || t.isSwitchStatement(sp.node)) break;
                        }
                    }
                    if (identInit) {
                        const labels = new Set(switchStatement.cases.filter((c) => t.isNumericLiteral(c.test)).map((c) => c.test.value));
                        const solved = solveDynamicInit(path.scope, identInit.name, labels);
                        if (solved) {
                            initialStateInfo = { id: solved.value, raw: `${identInit.name}=${solved.value}` };
                            initializerPath = identPath;
                            inLoopInitializer = identInLoop;
                            // 把完整性校验调用换成常量：函数被改写后 toString 变了，留着调用运行时会触发处罚
                            const { call } = solved;
                            recordRegion(call.start, call.end, { text: String(solved.value) });
                            solved.declPath.get('init').replaceWith(t.numericLiteral(solved.value));
                        }
                    }
                }

                if (initialStateInfo === null) {
                    console.log('   |-> Could not determine initial state.');
                    return;
                }
                const initialId = initialStateInfo.id;
                console.log(`   |-> Initial state: ${initialStateInfo.raw}`);

                const caseMap = new Map();
                for (const switchCase of switchStatement.cases) {
                    if (!switchCase.test) continue;
                    const caseInfo = resolveAndGetStateId(switchCase.test);
                    if (caseInfo.id === null) continue;
                    const caseBody = switchCase.consequent.filter(
                        (stmt) => !t.isBreakStatement(stmt)
                    );
                    caseMap.set(caseInfo.id, caseBody);
                }
                console.log(`   |-> Found ${caseMap.size} switch cases`);

                function getStateUpdateRhs(body) {
                    const lastStmt = body.length > 0 ? body[body.length - 1] : null;
                    if (!lastStmt) return null;
                    if (t.isExpressionStatement(lastStmt)) {
                        const expr = lastStmt.expression;
                        if (t.isSequenceExpression(expr)) {
                            const lastInSequence = expr.expressions[expr.expressions.length - 1];
                            if (
                                t.isAssignmentExpression(lastInSequence, { operator: '=' }) &&
                                areVarsEquivalent(lastInSequence.left, stateVar)
                            ) {
                                return lastInSequence.right;
                            }
                        } else if (
                            t.isAssignmentExpression(expr, { operator: '=' }) &&
                            areVarsEquivalent(expr.left, stateVar)
                        ) {
                            return expr.right;
                        }
                    }
                    if (t.isVariableDeclaration(lastStmt)) {
                        const lastDeclarator =
                            lastStmt.declarations[lastStmt.declarations.length - 1];
                        if (
                            lastDeclarator &&
                            areVarsEquivalent(lastDeclarator.id, stateVar) &&
                            lastDeclarator.init
                        ) {
                            return lastDeclarator.init;
                        }
                    }
                    return null;
                }

                function getSuccessorIds(id, recursionStack) {
                    if (id === terminalId) return [];
                    if (recursionStack && recursionStack.has(id)) return [];
                    const body = caseMap.get(id);
                    if (!body) return [];
                    const stateUpdateRhs = getStateUpdateRhs(body);
                    if (!stateUpdateRhs) return [];
                    const info = resolveAndGetStateId(stateUpdateRhs);
                    if (info.id !== null) return [info.id];
                    const result = [];
                    if (t.isConditionalExpression(stateUpdateRhs)) {
                        const consequent = resolveAndGetStateId(stateUpdateRhs.consequent);
                        const alternate = resolveAndGetStateId(stateUpdateRhs.alternate);
                        if (consequent.id !== null) result.push(consequent.id);
                        if (alternate.id !== null) result.push(alternate.id);
                    }
                    return result;
                }

                // 方向①：后支配树（Cooper-Harvey-Kennedy，在反向 CFG 上求支配树）。
                // 节点 = case；return 的 case 和跳到终止值的边都指向虚拟出口 EXIT。
                // 条件节点的直接后支配点 = 两个分支必然汇合的第一个 case；为 EXIT 表示两边都不会汇合（各自 return/结束）。
                const EXIT = Symbol('exit');
                function cfgSuccessors(id) {
                    const body = caseMap.get(id);
                    if (!body) return [];
                    const last = body.length > 0 ? body[body.length - 1] : null;
                    if (t.isReturnStatement(last)) return [EXIT];
                    return getSuccessorIds(id, null).map((s) => (s === terminalId ? EXIT : s)).filter((s) => s === EXIT || caseMap.has(s));
                }
                const postDom = (() => {
                    const preds = new Map(); // 原图前驱 = 反向图后继
                    preds.set(EXIT, []);
                    for (const id of caseMap.keys()) preds.set(id, []);
                    const succ = new Map();
                    for (const id of caseMap.keys()) {
                        const ss = [...new Set(cfgSuccessors(id))];
                        succ.set(id, ss);
                        for (const s of ss) preds.get(s).push(id);
                    }
                    // 反向图从 EXIT 出发的后序编号
                    const order = new Map();
                    const visited = new Set([EXIT]);
                    const stack = [[EXIT, 0]];
                    let n = 0;
                    while (stack.length) {
                        const top = stack[stack.length - 1];
                        const ps = preds.get(top[0]);
                        if (top[1] < ps.length) {
                            const nx = ps[top[1]++];
                            if (!visited.has(nx)) { visited.add(nx); stack.push([nx, 0]); }
                        } else { order.set(top[0], n++); stack.pop(); }
                    }
                    const rpo = [...order.keys()].sort((a, b) => order.get(b) - order.get(a));
                    const idom = new Map([[EXIT, EXIT]]);
                    const intersect = (a, b) => {
                        while (a !== b) {
                            while (order.get(a) < order.get(b)) a = idom.get(a);
                            while (order.get(b) < order.get(a)) b = idom.get(b);
                        }
                        return a;
                    };
                    let changed = true;
                    while (changed) {
                        changed = false;
                        for (const b of rpo) {
                            if (b === EXIT) continue;
                            let nd = null;
                            for (const s of succ.get(b)) {
                                if (!idom.has(s)) continue;
                                nd = nd === null ? s : intersect(s, nd);
                            }
                            if (nd !== null && idom.get(b) !== nd) { idom.set(b, nd); changed = true; }
                        }
                    }
                    return idom;
                })();
                // 返回 { join }：join 为 case id；null 表示汇合点是虚拟出口（不汇合）；undefined 表示算不出（到不了出口的死循环区）
                function findMergePoint(branchId) {
                    if (!postDom.has(branchId)) return undefined;
                    const ipd = postDom.get(branchId);
                    return ipd === EXIT ? null : ipd;
                }

                let success = true;
                const hoistedVars = new Set();
                const visitedCases = new Set(); // 方向②：只记录访问过的 case（覆盖率用），不缓存展开结果

                // ---- 循环结构化（配合方向①）----
                // 原实现在递归栈上遇到祖先 case 时静默返回空，等于把回边（循环）删掉。
                // 现在：进入一个能绕回自身的 case（循环头）时生成 `label: for (;;) { ... }`，
                // 回到循环头 → continue label；走到循环出口（follow）→ break label；
                // 循环里走到终止值 → break 整个状态机的外层标签。无法这样表达的回边 → 放弃本状态机。
                const loopStack = []; // { header, follow, label, members }
                const onPath = new Set();
                let smLabel = null;
                let budget = 50 * caseMap.size + 2000; // 防止复制爆炸
                const getSmLabel = () => (smLabel = smLabel || path.scope.generateUidIdentifier('sm'));
                const blockedSet = () => {
                    const b = new Set([terminalId]);
                    for (const L of loopStack) { b.add(L.header); if (L.follow !== null) b.add(L.follow); }
                    return b;
                };
                const realSuccs = (id) => cfgSuccessors(id).filter((s) => s !== EXIT);
                function reach(fromList, blocked) {
                    const seen = new Set();
                    const q = [...fromList];
                    while (q.length) {
                        const x = q.pop();
                        if (seen.has(x) || blocked.has(x) || !caseMap.has(x)) continue;
                        seen.add(x);
                        q.push(...realSuccs(x));
                    }
                    return seen;
                }
                // 返回 null 表示不是循环头；否则返回 { members, follow }（follow=null 表示只能靠 return/终止离开）
                function loopInfo(x) {
                    const blocked = blockedSet();
                    const fwd = reach(realSuccs(x), new Set([...blocked, x]));
                    if (!realSuccs(x).includes(x) && ![...fwd].some((n) => realSuccs(n).includes(x))) return null;
                    // 成员：x 可达且能回到 x 的节点
                    const members = new Set([x]);
                    let grew = true;
                    while (grew) {
                        grew = false;
                        for (const n of fwd) {
                            if (members.has(n)) continue;
                            if (realSuccs(n).some((s) => members.has(s))) { members.add(n); grew = true; }
                        }
                    }
                    const exits = new Set();
                    for (const m of members) for (const s of cfgSuccessors(m)) {
                        if (s === EXIT || members.has(s) || blocked.has(s)) continue;
                        exits.add(s);
                    }
                    let follow = null;
                    for (const e of exits) {
                        if (follow === null) { follow = e; continue; }
                        // 在后支配树上求公共祖先
                        const anc = new Set();
                        for (let a = follow; a !== undefined; a = a === EXIT ? undefined : postDom.get(a)) anc.add(a);
                        let b = e;
                        while (b !== undefined && !anc.has(b)) b = b === EXIT ? undefined : postDom.get(b);
                        if (b === undefined) return { error: true };
                        follow = b;
                    }
                    if (follow === EXIT) follow = null;
                    if (follow !== null && members.has(follow)) return { error: true };
                    return { members, follow };
                }
                function jumpTo(id) {
                    for (let i = loopStack.length - 1; i >= 0; i--) {
                        const L = loopStack[i];
                        if (id === L.header) return t.continueStatement(t.cloneNode(L.label));
                        if (id === L.follow) return t.breakStatement(t.cloneNode(L.label));
                    }
                    return null;
                }

                function unflatten(currentId, stopId = null) {
                    if (!success) return null;
                    if (--budget < 0) { success = false; return null; }
                    if (stopId !== null && currentId === stopId) return [];
                    if (currentId === terminalId) {
                        return loopStack.length > 0 ? [t.breakStatement(t.cloneNode(getSmLabel()))] : [];
                    }
                    const jump = jumpTo(currentId);
                    if (jump) return [jump];
                    if (onPath.has(currentId)) {
                        console.warn('   |-> Unstructured back edge to case ' + currentId + '. Aborting unflatten.');
                        success = false;
                        return null;
                    }
                    if (!caseMap.has(currentId)) { success = false; return null; }
                    const info = loopInfo(currentId);
                    if (info && info.error) {
                        console.warn('   |-> Loop at case ' + currentId + ' has no single follow. Aborting unflatten.');
                        success = false;
                        return null;
                    }
                    if (!info) return unflattenNode(currentId, stopId);
                    const label = path.scope.generateUidIdentifier('loop');
                    loopStack.push({ header: currentId, follow: info.follow, label });
                    const bodyNodes = unflattenNode(currentId, null);
                    loopStack.pop();
                    if (!success) return null;
                    const loop = t.labeledStatement(label, t.forStatement(null, null, null, t.blockStatement(bodyNodes)));
                    const result = [loop];
                    if (info.follow !== null) {
                        const rest = unflatten(info.follow, stopId);
                        if (!success) return null;
                        result.push(...rest);
                    }
                    return result;
                }

                function unflattenNode(currentId, stopId) {
                    const caseBody = caseMap.get(currentId);
                    visitedCases.add(currentId);
                    onPath.add(currentId);
                    try {
                        return unflattenNodeInner(currentId, caseBody, stopId);
                    } finally {
                        onPath.delete(currentId);
                    }
                }

                function unflattenNodeInner(currentId, caseBody, stopId) {
                    const lastStmtInCase =
                        caseBody.length > 0 ? caseBody[caseBody.length - 1] : null;

                    if (t.isReturnStatement(lastStmtInCase)) {
                        return processVarDeclarations(caseBody, hoistedVars).map((n) => t.cloneNode(n, true));
                    }
                    let stateUpdateRhs = getStateUpdateRhs(caseBody);
                    if (!stateUpdateRhs) {
                        success = false;
                        return null;
                    }
                    const lastStmt = caseBody[caseBody.length - 1];
                    const bodyWithoutUpdate = caseBody.slice(0, -1);
                    if (t.isExpressionStatement(lastStmt) && t.isSequenceExpression(lastStmt.expression)) {
                        bodyWithoutUpdate.push(...lastStmt.expression.expressions.slice(0, -1).map((e) => t.expressionStatement(e)));
                    } else if (t.isVariableDeclaration(lastStmt) && lastStmt.declarations.length > 1) {
                        bodyWithoutUpdate.push(t.variableDeclaration(lastStmt.kind, lastStmt.declarations.slice(0, -1)));
                    }
                    const processedBody = processVarDeclarations(bodyWithoutUpdate, hoistedVars).map((n) => t.cloneNode(n, true));

                    function distributeMemberOverConditional(node) {
                        const indices = [];
                        let cur = node;
                        while (t.isMemberExpression(cur) && cur.computed && t.isNumericLiteral(cur.property)) {
                            indices.unshift(cur.property);
                            cur = cur.object;
                        }
                        if (!t.isConditionalExpression(cur)) return node;
                        const applyIndices = (branch) =>
                            indices.reduce((acc, idx) => t.memberExpression(acc, idx, true), branch);
                        return t.conditionalExpression(cur.test, applyIndices(cur.consequent), applyIndices(cur.alternate));
                    }
                    if (t.isMemberExpression(stateUpdateRhs)) stateUpdateRhs = distributeMemberOverConditional(stateUpdateRhs);

                    const nextStateInfo = resolveAndGetStateId(stateUpdateRhs);
                    if (nextStateInfo.id !== null) {
                        const nextBlock = unflatten(nextStateInfo.id, stopId);
                        if (!success) return null;
                        return [...processedBody, ...nextBlock];
                    }
                    if (!t.isConditionalExpression(stateUpdateRhs)) {
                        success = false;
                        return null;
                    }
                    const test = t.cloneNode(stateUpdateRhs.test, true);
                    const trueBranchInfo = resolveAndGetStateId(stateUpdateRhs.consequent);
                    const falseBranchInfo = resolveAndGetStateId(stateUpdateRhs.alternate);
                    if (trueBranchInfo.id === null || falseBranchInfo.id === null) {
                        success = false;
                        return null;
                    }

                    // ---- 不透明谓词：保留三元赋值，不静态选分支 ----
                    // Jscrambler 的不透明谓词（NS[NS.method(N)]() 等）的返回值依赖运行时环境
                    // （Function.prototype.toString 的 MurmurHash、域名检查等）。
                    // pipeline 在 Node.js 里跑时 location.host 不对 → 谓词在 vm 里走错分支 → 代码被丢弃。
                    // 对策：保留原始三元赋值 `stateVar = predicate ? A : B`，
                    // 然后用 `if (stateVar === A) { ...A路径... } else { ...B路径... }` 让运行时自己选。
                    if (isOpaquePredicate(stateUpdateRhs.test)) {
                        console.log(`   |-> Opaque predicate detected in case ${currentId}: preserving ternary assignment`);
                        const joinId = findMergePoint(currentId);
                        if (joinId === undefined) {
                            console.warn('   |-> No post-dominator for opaque-predicate case ' + currentId + '. Aborting unflatten.');
                            success = false;
                            return null;
                        }
                        // 保留原始三元赋值：stateVar = predicate ? A : B
                        const preservedAssign = t.expressionStatement(
                            t.assignmentExpression('=',
                                t.cloneNode(stateVar, true),
                                t.cloneNode(stateUpdateRhs, true)
                            )
                        );
                        // 运行时根据 stateVar 的值选择分支
                        const branchStopId = joinId !== null ? joinId : stopId;
                        const trueBranchBody = unflatten(trueBranchInfo.id, branchStopId);
                        if (!success) return null;
                        const falseBranchBody = unflatten(falseBranchInfo.id, branchStopId);
                        if (!success) return null;
                        // 用 stateVar === trueValue 做判断（而非直接用谓词做 if test）
                        const trueValue = stateUpdateRhs.consequent;
                        const branchTest = t.binaryExpression('===',
                            t.cloneNode(stateVar, true),
                            t.cloneNode(trueValue, true)
                        );
                        const ifStatement = t.ifStatement(
                            branchTest,
                            t.blockStatement(trueBranchBody),
                            falseBranchBody.length > 0
                                ? falseBranchBody.length === 1 && t.isIfStatement(falseBranchBody[0])
                                    ? falseBranchBody[0]
                                    : t.blockStatement(falseBranchBody)
                                : null
                        );
                        // stateVar 需要在展开后的代码中可用（只有 Identifier 型需要 hoist）
                        if (t.isIdentifier(stateVar)) hoistedVars.add(stateVar.name);
                        const tailNodes = joinId !== null ? unflatten(joinId, stopId) : [];
                        if (!success) return null;
                        return [...processedBody, preservedAssign, ifStatement, ...tailNodes];
                    }

                    // ---- 普通条件分支：直接用 test 做 if 判断（原有逻辑） ----
                    const joinId = findMergePoint(currentId);
                    if (joinId === undefined) {
                        console.warn('   |-> No post-dominator for case ' + currentId + ' (cannot reach exit). Aborting unflatten.');
                        success = false;
                        return null;
                    }
                    const branchStopId = joinId !== null ? joinId : stopId;
                    const trueBranchBody = unflatten(trueBranchInfo.id, branchStopId);
                    if (!success) return null;
                    const falseBranchBody = unflatten(falseBranchInfo.id, branchStopId);
                    if (!success) return null;
                    const ifStatement = t.ifStatement(
                        test,
                        t.blockStatement(trueBranchBody),
                        falseBranchBody.length > 0
                            ? falseBranchBody.length === 1 && t.isIfStatement(falseBranchBody[0])
                                ? falseBranchBody[0]
                                : t.blockStatement(falseBranchBody)
                            : null
                    );
                    const tailNodes = joinId !== null ? unflatten(joinId, stopId) : [];
                    if (!success) return null;
                    return [...processedBody, ifStatement, ...tailNodes];
                }

                // 方向③：线性路径优化。所有 case 都是 return 或直接赋值（state = N）时，
                // 从初值开始模拟执行，按访问顺序拼接 case 体；遇到重复 case（死循环）或缺 case 就放弃，交给递归展开。
                function linearize() {
                    for (const body of caseMap.values()) {
                        const last = body.length > 0 ? body[body.length - 1] : null;
                        if (t.isReturnStatement(last)) continue;
                        const rhs = getStateUpdateRhs(body);
                        if (!rhs || resolveAndGetStateId(rhs).id === null) return null;
                    }
                    const out = [];
                    const seen = new Set();
                    let cur = initialId;
                    while (cur !== terminalId) {
                        if (seen.has(cur) || !caseMap.has(cur)) return null;
                        seen.add(cur);
                        visitedCases.add(cur);
                        const body = caseMap.get(cur);
                        const last = body.length > 0 ? body[body.length - 1] : null;
                        if (t.isReturnStatement(last)) {
                            out.push(...processVarDeclarations(body, hoistedVars));
                            return out;
                        }
                        const without = body.slice(0, -1);
                        if (t.isExpressionStatement(last) && t.isSequenceExpression(last.expression)) {
                            without.push(...last.expression.expressions.slice(0, -1).map((e) => t.expressionStatement(e)));
                        } else if (t.isVariableDeclaration(last) && last.declarations.length > 1) {
                            without.push(t.variableDeclaration(last.kind, last.declarations.slice(0, -1)));
                        }
                        out.push(...processVarDeclarations(without, hoistedVars));
                        cur = resolveAndGetStateId(getStateUpdateRhs(body)).id;
                    }
                    return out;
                }
                let unflattenedBody = linearize();
                if (unflattenedBody) {
                    console.log('   |-> Linear state machine, simulated in order.');
                } else {
                    hoistedVars.clear();
                    visitedCases.clear();
                    unflattenedBody = unflatten(initialId, null);
                    if (success && unflattenedBody && smLabel) unflattenedBody = [t.labeledStatement(smLabel, t.blockStatement(unflattenedBody))];
                }

                // 覆盖率检查：统计展平后实际覆盖了多少 case
                if (success && unflattenedBody) {
                    const totalCases = caseMap.size;
                    const coveredCases = visitedCases.size;
                    const coverage = coveredCases / totalCases;
                    console.log('   |-> Coverage check: ' + coveredCases + '/' + totalCases + ' (' + (coverage*100).toFixed(0) + '%)');
                    if (coverage < 0.8 && totalCases > 10) {
                        console.warn(`   |-> Coverage too low: ${coveredCases}/${totalCases} (${(coverage*100).toFixed(0)}%). Keeping original.`);
                        success = false;
                    }
                }

                if (success && unflattenedBody) {
                    const newNodes = [];
                    if (hoistedVars.size > 0) {
                        const declarators = Array.from(hoistedVars).map((varName) =>
                            t.variableDeclarator(t.identifier(varName))
                        );
                        newNodes.push(t.variableDeclaration('var', declarators));
                    }
                    newNodes.push(...unflattenedBody);
                    console.log(
                        `   |-> Successfully unflattened state machine. Generated ${newNodes.length} nodes.`
                    );
                    // 任务 1：记录本状态机在原始代码里的区间和替换后的节点（父节点不是语句列表时要包一层块）
                    const inList = Array.isArray(path.container);
                    recordRegion(node.start, node.end, { nodes: inList ? newNodes : [t.blockStatement(newNodes)] });
                    path.replaceWithMultiple(newNodes);
                    if (initializerPath && !inLoopInitializer) {
                        const initNode = initializerPath.node;
                        if (initializerPath.isVariableDeclaration()) {
                            const declarators = initializerPath.node.declarations;
                            if (declarators.length === 1) {
                                recordRegion(initNode.start, initNode.end, { text: '' });
                                initializerPath.remove();
                            } else {
                                const declIndex = declarators.findIndex((d) =>
                                    areVarsEquivalent(d.id, stateVar)
                                );
                                if (declIndex > -1) declarators.splice(declIndex, 1);
                                recordRegion(initNode.start, initNode.end, { nodes: [initNode] });
                            }
                        } else {
                            recordRegion(initNode.start, initNode.end, { text: '' });
                            initializerPath.remove();
                        }
                    }
                } else {
                    console.warn('   |-> Failed to unflatten state machine. Reverting changes.');
                }
            },
        },
    },
};
