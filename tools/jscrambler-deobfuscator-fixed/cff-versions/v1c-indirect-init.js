import * as t from '@babel/types';
import generator from '@babel/generator';

const generatedArraysMap = new Map();

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

                // 间接初始值解析：state = otherVar → 找 otherVar 的数字赋值
                if (initialStateInfo === null) {
                    const svName = t.isIdentifier(stateVar) ? stateVar.name : null;
                    if (svName) {
                        let rhsName = null;
                        // 在最近 5 个前置兄弟里找 state = otherVar
                        for (let i = path.key - 1; i >= Math.max(0, path.key - 5); i--) {
                            const sib = path.getSibling(i);
                            if (!sib || !sib.node) continue;
                            const nd = sib.node;
                            if (t.isVariableDeclaration(nd)) {
                                for (const d of nd.declarations) {
                                    if (t.isIdentifier(d.id) && d.id.name === svName && d.init && t.isIdentifier(d.init)) {
                                        rhsName = d.init.name;
                                    }
                                }
                            }
                            if (t.isExpressionStatement(nd) && t.isAssignmentExpression(nd.expression, {operator:'='})
                                && t.isIdentifier(nd.expression.left) && nd.expression.left.name === svName
                                && t.isIdentifier(nd.expression.right)) {
                                rhsName = nd.expression.right.name;
                            }
                            if (rhsName) break;
                        }
                        // 在最近 20 个兄弟里找 otherVar = 数字
                        if (rhsName) {
                            for (let j = path.key - 1; j >= Math.max(0, path.key - 20); j--) {
                                const sib = path.getSibling(j);
                                if (!sib || !sib.node) continue;
                                const nd = sib.node;
                                if (t.isVariableDeclaration(nd)) {
                                    for (const d of nd.declarations) {
                                        if (t.isIdentifier(d.id) && d.id.name === rhsName && d.init && t.isNumericLiteral(d.init)) {
                                            console.log(`   |-> Resolved indirect: ${svName} via ${rhsName} = ${d.init.value}`);
                                            initialStateInfo = { id: d.init.value, raw: String(d.init.value) };
                                        }
                                    }
                                }
                                if (t.isExpressionStatement(nd) && t.isAssignmentExpression(nd.expression, {operator:'='})
                                    && t.isIdentifier(nd.expression.left) && nd.expression.left.name === rhsName
                                    && t.isNumericLiteral(nd.expression.right)) {
                                    console.log(`   |-> Resolved indirect: ${svName} via ${rhsName} = ${nd.expression.right.value}`);
                                    initialStateInfo = { id: nd.expression.right.value, raw: String(nd.expression.right.value) };
                                }
                                if (initialStateInfo) break;
                            }
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
                    path.replaceWithMultiple(newNodes);
                    if (initializerPath && !inLoopInitializer) {
                        if (initializerPath.isVariableDeclaration()) {
                            const declarators = initializerPath.node.declarations;
                            if (declarators.length === 1) {
                                initializerPath.remove();
                            } else {
                                const declIndex = declarators.findIndex((d) =>
                                    areVarsEquivalent(d.id, stateVar)
                                );
                                if (declIndex > -1) declarators.splice(declIndex, 1);
                            }
                        } else {
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
