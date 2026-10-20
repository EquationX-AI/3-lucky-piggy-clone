// Analyze integrity function computation discrepancy
// Compare pipeline's static computation vs runtime ground truth
import * as babel from '@babel/core';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';
import fs from 'node:fs';

const traverse = _traverse.default ?? _traverse;
const generate = _generate.default ?? _generate;

// Load the CFF output (post-CFF, pre-string decode)
const cffCode = fs.readFileSync('/tmp/fg5-clean/clean-v2/.work/main.cff.js', 'utf8');
const ast = babel.parseSync(cffCode, { sourceType: 'script' });

// Load string table for main
const mainTable = JSON.parse(fs.readFileSync('/tmp/fg5-clean/inspect/strings/main.strings.json', 'utf8'));
const otherTable = JSON.parse(fs.readFileSync('/tmp/fg5-clean/inspect/strings/other.strings.json', 'utf8'));

// Find all V0Q/D6k 4-arg calls
// Pattern: _global.V0Q(expr, num, num, num) or _global.D6k(expr, num, num, num)
const calls = [];
traverse(ast, { noScope: true, CallExpression(path) {
  const n = path.node;
  if (!t.isMemberExpression(n.callee) || !t.isIdentifier(n.callee.object, { name: '_global' })) return;
  const prop = n.callee.computed ? null : n.callee.property.name;
  if (prop !== 'V0Q' && prop !== 'D6k') return;
  if (n.arguments.length !== 4) return;
  
  // Check if args 1,2,3 are numeric literals
  const args = n.arguments;
  if (!t.isNumericLiteral(args[1]) || !t.isNumericLiteral(args[2]) || !t.isNumericLiteral(args[3])) return;
  
  calls.push({
    fn: prop,
    arg0: generate(args[0]).code,
    arg1: args[1].value,
    arg2: args[2].value,  // This is the "encoded" argument (F4)
    arg3: args[3].value,
    line: n.loc?.start?.line || 0,
  });
}});

console.log(`Found ${calls.length} integrity calls with 4 args`);

// Group by arg2 values (the encoded argument that becomes the string index)
const byArg2 = new Map();
for (const c of calls) {
  if (!byArg2.has(c.arg2)) byArg2.set(c.arg2, []);
  byArg2.get(c.arg2).push(c);
}
console.log(`Unique arg2 values: ${byArg2.size}`);

// Now let's understand what the pipeline computes
// The pipeline found: W3=8 → W3=1 → W3=9 → W3=5 → W3=8 (reverse order)
// Steps: XOR 8, XOR 1, XOR 9, XOR 5, ROTATE_RIGHT 8
// In reverse order: ROTATE_RIGHT 8, XOR 5, XOR 9, XOR 1, XOR 8

function rotateRight(v, n) {
  return (v >>> n | v << (32 - n)) >>> 0;
}

function computeForward(v) {
  // Forward: XOR 8 → XOR 1 → XOR 9 → XOR 5 → ROT_RIGHT 8
  v = v ^ 8;
  v = v ^ 1;
  v = v ^ 9;
  v = v ^ 5;
  v = rotateRight(v, 8);
  return v;
}

function computeReverse(v) {
  // Reverse: ROT_RIGHT 8 → XOR 5 → XOR 9 → XOR 1 → XOR 8
  v = rotateRight(v, 8);
  v = v ^ 5;
  v = v ^ 9;
  v = v ^ 1;
  v = v ^ 8;
  return v;
}

// Now, which argument does the transform get applied to?
// The pipeline says "第 3 个参数" = encodedIndex 2 = arg2
// Let's compute for a sample and see if it maps to valid strings

// Sample the first 20 calls
console.log('\n--- Sample calls (first 20) ---');
for (const c of calls.slice(0, 20)) {
  const fwd = computeForward(c.arg2);
  const rev = computeReverse(c.arg2);
  const mainFwd = mainTable[fwd];
  const mainRev = mainTable[rev];
  const otherFwd = otherTable[fwd];
  const otherRev = otherTable[rev];
  console.log(`L${c.line} ${c.fn}(${c.arg0}, ${c.arg1}, ${c.arg2}, ${c.arg3})`);
  console.log(`  forward(${c.arg2}) = ${fwd} → main: ${mainFwd?.slice(0,40) || 'N/A'} | other: ${otherFwd?.slice(0,40) || 'N/A'}`);
  console.log(`  reverse(${c.arg2}) = ${rev} → main: ${mainRev?.slice(0,40) || 'N/A'} | other: ${otherRev?.slice(0,40) || 'N/A'}`);
}

// Check how many map to valid main strings in each direction
let hitMainFwd = 0, hitMainRev = 0, hitOtherFwd = 0, hitOtherRev = 0;
for (const c of calls) {
  const fwd = computeForward(c.arg2);
  const rev = computeReverse(c.arg2);
  if (typeof mainTable[fwd] === 'string') hitMainFwd++;
  if (typeof mainTable[rev] === 'string') hitMainRev++;
  if (typeof otherTable[fwd] === 'string') hitOtherFwd++;
  if (typeof otherTable[rev] === 'string') hitOtherRev++;
}

console.log(`\n--- Hit rates (${calls.length} calls) ---`);
console.log(`main.strings forward: ${hitMainFwd}`);
console.log(`main.strings reverse: ${hitMainRev}`);
console.log(`other.strings forward: ${hitOtherFwd}`);
console.log(`other.strings reverse: ${hitOtherRev}`);

// The puzzle: are the transforms being applied to arg2, or is it a different computation?
// Let's check - maybe the integrity constant is NOT computed via these XOR/rotate transforms
// Maybe it's a simpler computation like: result = C3[2] - h1 - (Z8 + l3) - n6
// where the transform on K5 is separate from the actual value computation

// Let's check if arg2 directly maps to anything
let directMain = 0, directOther = 0;
for (const c of calls) {
  if (typeof mainTable[c.arg2] === 'string') directMain++;
  if (typeof otherTable[c.arg2] === 'string') directOther++;
}
console.log(`\nDirect arg2 → main.strings: ${directMain}`);
console.log(`Direct arg2 → other.strings: ${directOther}`);

// What about XOR with simple values?
for (const xorVal of [0, 5, 8, 9, 13, 12, 4, 1, 3]) {
  let hit = 0;
  for (const c of calls) {
    if (typeof mainTable[c.arg2 ^ xorVal] === 'string') hit++;
  }
  if (hit > hitMainFwd) console.log(`  XOR ${xorVal}: ${hit} hits in main`);
}

