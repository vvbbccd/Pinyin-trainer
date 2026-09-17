/**
 * Dev test for the pinyin engine (pure logic, no DOM, no dependencies).
 * Run:  node tools/tests/test_pinyin.mjs      (or: npm test)
 */
import {
  checkAnswer, toToneMarks, toToneNumbers, toPlain, splitSyllables,
  segmentLetters, parseInput, encodeSyllable, normalizeBase, decodeSyllable,
} from '../../assets/js/pinyin.js';

let passed = 0;
let failed = 0;
const failures = [];

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) { passed += 1; return; }
  failed += 1;
  failures.push(`${label}\n      expected ${b}\n      actual   ${a}`);
}

function ok(condition, label) {
  if (condition) { passed += 1; return; }
  failed += 1;
  failures.push(label);
}

/* ------------------------------------------------------------ encoding --- */

eq(toToneMarks('xue2 xiao4'), 'xué xiào', 'numbers -> marks');
eq(toToneMarks('xué xiào'), 'xué xiào', 'marks -> marks (idempotent)');
eq(toToneMarks('ni3 hao3'), 'nǐ hǎo', 'ni3 hao3');
eq(toToneMarks('lv4'), 'lǜ', 'lv4 -> lǜ');
eq(toToneNumbers('xué xiào'), 'xue2xiao4', 'marks -> numbers');
eq(toToneNumbers('nǐ hǎo'), 'ni3hao3', 'ni3hao3');
eq(toToneNumbers('péng you'), 'peng2you5', 'neutral becomes 5');
eq(toPlain('xué xiào'), 'xuexiao', 'marks -> plain');
eq(toPlain('nǚ ér'), 'nuer', 'ü -> u in plain');

eq(encodeSyllable('liu', 2), 'liú', 'mark placement: iu -> u');
eq(encodeSyllable('gui', 4), 'guì', 'mark placement: ui -> i');
eq(encodeSyllable('hao', 3), 'hǎo', 'mark placement: a');
eq(encodeSyllable('xue', 2), 'xué', 'mark placement: e');
eq(encodeSyllable('shuo', 1), 'shuō', 'mark placement: o');
eq(encodeSyllable('nü', 3), 'nǚ', 'mark placement: ü');
eq(encodeSyllable('men', null), 'men', 'neutral has no mark');

eq(normalizeBase('lü', false), 'lu', 'lenient ü -> u');
eq(normalizeBase('lü', true), 'lv', 'strict ü -> v');
eq(decodeSyllable('xué').tone, 2, 'decode tone from mark');
eq(decodeSyllable('xue2').tone, 2, 'decode tone from digit');
eq(decodeSyllable('men').tone, null, 'decode neutral');

/* -------------------------------------------------------- segmentation --- */

eq(segmentLetters('xuexiao'), ['xue', 'xiao'], 'segment xuexiao');
eq(segmentLetters('nihaoma'), ['ni', 'hao', 'ma'], 'segment nihaoma');
eq(segmentLetters('zhongguo'), ['zhong', 'guo'], 'segment zhongguo');
eq(segmentLetters('xian'), ['xian'], 'xian stays one syllable');
eq(segmentLetters('women'), ['wo', 'men'], 'segment women');
eq(segmentLetters('lvyou'), ['lu', 'you'], 'segment lvyou (ür travel)');
ok(segmentLetters('qqqq') === null, 'gibberish does not segment');

eq(splitSyllables('xué xiào').map((s) => s.display), ['xué', 'xiào'], 'split + display');

/* --------------------------------------------------- answer checking ---- */

const gz = (input, pinyin, options = {}) => checkAnswer(input, pinyin, options);

// 学校 xué xiào
ok(gz('xue2xiao4', 'xué xiào').correct, 'numbers, no space');
ok(gz('xué xiào', 'xué xiào').correct, 'marks, spaced');
ok(gz('xuéxiào', 'xué xiào').correct, 'marks, unspaced');
ok(gz('xue xiao', 'xué xiào').correct === false, 'missing tones rejected when required');
ok(gz('xue xiao', 'xué xiào', { requireTones: false }).correct, 'missing tones accepted when optional');
ok(gz('XUE2XIAO4', 'xué xiào').correct, 'uppercase accepted');
ok(gz('xue2xiao1', 'xué xiào').correct === false, 'wrong tone rejected');
ok(gz('xue2xiao', 'xué xiào').correct === false, 'one missing tone rejected');
ok(gz('xue1xiao4', 'xué xiào').correct === false, 'wrong first tone rejected');

// honest failure detail
const wrongTone = gz('xue1xiao4', 'xué xiào');
eq(wrongTone.issues.map((i) => i.kind), ['tone'], 'reports the tone issue');
eq(wrongTone.issues[0].index, 0, 'reports which syllable');

const wrongLetter = gz('she2xiao4', 'xué xiào');
eq(wrongLetter.issues.map((i) => i.kind), ['base'], 'reports the letter issue');

// 你好 nǐ hǎo
ok(gz('ni3hao3', 'nǐ hǎo').correct, 'ni3hao3');
ok(gz('nǐhǎo', 'nǐ hǎo').correct, 'nǐhǎo unspaced');
ok(gz('ni3hao3ma5', 'nǐ hǎo').correct === false, 'extra syllable rejected');

// neutral tone: 朋友 péng you
ok(gz('peng2you', 'péng you').correct, 'neutral omitted');
ok(gz('peng2you5', 'péng you').correct, 'neutral as 5');
ok(gz('peng2yǒu', 'péng you').correct === false, 'wrong tone on neutral rejected');
ok(gz('peng2 you', 'péng you').correct, 'spaced with neutral');

// 我们 wǒ men
ok(gz('wo3men', 'wǒ men').correct, 'wo3men');
ok(gz('wǒmen', 'wǒ men').correct, 'wǒmen');

// ü handling: 绿色 lǜ sè
ok(gz('lv4se4', 'lǜ sè').correct, 'lv4se4 (lenient)');
ok(gz('lü4sè', 'lǜ sè').correct, 'lü4sè');
ok(gz('lu4se4', 'lǜ sè').correct, 'lu4 accepted when lenient');
ok(gz('lu4se4', 'lǜ sè', { strictU: true }).correct === false, 'lu4 rejected when strict');
ok(gz('lv4se4', 'lǜ sè', { strictU: true }).correct, 'lv4 accepted when strict');

// sandhi: 一个 yí gè (stored with sandhi) should also accept yī gè
ok(gz('yi1ge4', 'yí gè').correct, 'yi1ge4 accepted for yí gè (sandhi)');
ok(gz('yi2ge4', 'yí gè').correct, 'yi2ge4 accepted');
ok(gz('yi4ge4', 'yí gè').correct, 'yi4ge4 accepted');
ok(gz('yi3ge4', 'yí gè').correct === false, 'yi3ge4 rejected');
// 不客气 bú kè qi
ok(gz('bu4ke4qi', 'bú kè qi').correct, 'bu4 accepted for bú (sandhi)');
ok(gz('bu2ke4qi', 'bú kè qi').correct, 'bu2 accepted');

// alternatives: 长 zhǎng / cháng
ok(gz('zhang3', 'zhǎng', { alternatives: 'cháng' }).correct, 'primary reading');
ok(gz('chang2', 'zhǎng', { alternatives: 'cháng' }).correct, 'alternative reading accepted');
ok(gz('chang3', 'zhǎng', { alternatives: 'cháng' }).correct === false, 'wrong tone still rejected');

// 了 le / liǎo
ok(gz('le', 'le', { alternatives: 'liǎo|liào' }).correct, 'neutral le');
ok(gz('liao3', 'le', { alternatives: 'liǎo|liào' }).correct, 'liǎo alternative');

// tone marks typed on the wrong vowel are still read correctly
ok(gz('xúe xiào', 'xué xiào').correct, 'misplaced mark still decodes');

// blank / junk
ok(gz('', 'xué xiào').correct === false, 'empty answer wrong');
ok(gz('   ', 'xué xiào').correct === false, 'whitespace answer wrong');
ok(gz('hello', 'xué xiào').correct === false, 'latin junk wrong');
ok(gz('xue2xiao4', 'xué xiào').noTonesTyped === undefined, 'tones present');
ok(gz('xuexiao', 'xué xiào').noTonesTyped === true, 'flags missing tones');

// 谢谢 xiè xie (second syllable neutral)
ok(gz('xie4xie', 'xiè xie').correct, 'xie4xie with neutral second');
ok(gz('xie4xie5', 'xiè xie').correct, 'xie4xie5');

// 出租车 chū zū chē
ok(gz('chu1zu1che1', 'chū zū chē').correct, '3 syllables');
ok(gz('chūzūchē', 'chū zū chē').correct, '3 syllables unspaced');

// 图书馆 tú shū guǎn
ok(gz('tu2shu1guan3', 'tú shū guǎn').correct, 'tu2shu1guan3');
ok(gz('túshūguǎn', 'tú shū guǎn').correct, 'túshūguǎn unspaced');

// 公共汽车 gōng gòng qì chē (4 syllables)
ok(gz('gong1gong4qi4che1', 'gōng gòng qì chē').correct, '4 syllables, numbers');
ok(gz('gōnggòngqìchē', 'gōng gòng qì chē').correct, '4 syllables, marks unspaced');

// alt spellings the learner might try
ok(gz('xue2 xiao4 ', 'xué xiào').correct, 'trailing space tolerated');
ok(gz("xue2'xiao4", 'xué xiào').correct, 'apostrophe separator tolerated');
ok(gz('xue2-xiao4', 'xué xiào').correct, 'hyphen separator tolerated');

/* ------------------------------------------------------------- report --- */

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exit(1);
}
console.log('pinyin engine: all good');
