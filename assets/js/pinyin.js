/* ==========================================================================
   pinyin.js — the grading engine.

   Responsibilities
     * convert between tone marks (xué xiào), tone numbers (xue2xiao4) and plain (xuexiao)
     * segment unseparated user input (xuexiao) into real pinyin syllables
     * grade an answer, allowing the leniency settings, sandhi variants and
       alternate readings of single characters
   ========================================================================== */

/* ------------------------------------------------------------ syllable --- */

// Every standard Hanyu Pinyin syllable, written with the "u" spelling of ü
// (lü -> lu, lüe -> lue) because segmentation always works on normalised text.
const SYLLABLE_LIST = `
a ai an ang ao e ei en eng er o ou
ba bai ban bang bao bei ben beng bi bian biao bie bin bing bo bu
pa pai pan pang pao pei pen peng pi pian piao pie pin ping po pou pu
ma mai man mang mao me mei men meng mi mian miao mie min ming miu mo mou mu
fa fan fang fei fen feng fo fou fu
da dai dan dang dao de dei den deng di dia dian diao die ding diu dong dou du duan dui dun duo
ta tai tan tang tao te teng ti tian tiao tie ting tong tou tu tuan tui tun tuo
na nai nan nang nao ne nei nen neng ni nian niang niao nie nin ning niu nong nou nu nuan nuo nue
la lai lan lang lao le lei leng li lia lian liang liao lie lin ling liu lo long lou lu luan lun luo lue
ga gai gan gang gao ge gei gen geng gong gou gu gua guai guan guang gui gun guo
ka kai kan kang kao ke kei ken keng kong kou ku kua kuai kuan kuang kui kun kuo
ha hai han hang hao he hei hen heng hong hou hu hua huai huan huang hui hun huo
ji jia jian jiang jiao jie jin jing jiong jiu ju juan jue jun
qi qia qian qiang qiao qie qin qing qiong qiu qu quan que qun
xi xia xian xiang xiao xie xin xing xiong xiu xu xuan xue xun
zha zhai zhan zhang zhao zhe zhei zhen zheng zhi zhong zhou zhu zhua zhuai zhuan zhuang zhui zhun zhuo
cha chai chan chang chao che chen cheng chi chong chou chu chua chuai chuan chuang chui chun chuo
sha shai shan shang shao she shei shen sheng shi shou shu shua shuai shuan shuang shui shun shuo
ran rang rao re ren reng ri rong rou ru rua ruan rui run ruo
za zai zan zang zao ze zei zen zeng zi zong zou zu zuan zui zun zuo
ca cai can cang cao ce cen ceng ci cong cou cu cuan cui cun cuo
sa sai san sang sao se sen seng si song sou su suan sui sun suo
ya yan yang yao ye yi yin ying yo yong you yu yuan yue yun
wa wai wan wang wei wen weng wo wu
hm hng m n ng
`
  .trim()
  .split(/\s+/);

const SYLLABLES = new Set(SYLLABLE_LIST);
const MAX_SYLLABLE_LEN = 6;

// Letters that can appear in typed pinyin: ASCII plus the Latin Extended-A/B
// vowels that carry tone marks (ā á ǎ à … ǖ ǘ ǚ ǜ), which are NOT ASCII letters.
const PINYIN_CHUNK = /[a-z\u00c0-\u024f:]+[1-5]?/gi;
const HAS_TONE_DIGIT = /[1-5]/;

const TONE_TABLE = [
  { plain: 'a', tones: ['a', 'ā', 'á', 'ǎ', 'à'] },
  { plain: 'e', tones: ['e', 'ē', 'é', 'ě', 'è'] },
  { plain: 'i', tones: ['i', 'ī', 'í', 'ǐ', 'ì'] },
  { plain: 'o', tones: ['o', 'ō', 'ó', 'ǒ', 'ò'] },
  { plain: 'u', tones: ['u', 'ū', 'ú', 'ǔ', 'ù'] },
  { plain: 'ü', tones: ['ü', 'ǖ', 'ǘ', 'ǚ', 'ǜ'] },
];

const MARK_TO_TONE = new Map(); // 'ā' -> { plain: 'a', tone: 1 }
for (const row of TONE_TABLE) {
  row.tones.forEach((glyph, index) => {
    MARK_TO_TONE.set(glyph, { plain: row.plain, tone: index === 0 ? null : index });
  });
}

export const NEUTRAL_TONE = 5;

/* -------------------------------------------------------- normalisation --- */

/** ü -> 'u' (lenient) or 'v' (strict), v/u: -> ü first. */
export function normalizeBase(base, strictU = false) {
  const unified = base.toLowerCase().replace(/u:/g, 'ü').replace(/v/g, 'ü');
  return strictU ? unified.replace(/ü/g, 'v') : unified.replace(/ü/g, 'u');
}

/** Split a stored pinyin string ("xué xiào") into syllable objects. */
export function splitSyllables(pinyin) {
  return String(pinyin || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(decodeSyllable);
}

/**
 * 'xué' -> { raw:'xué', base:'xue', tone:2, letter:'xue' }
 * 'xue2' -> { raw:'xue2', base:'xue', tone:2 }
 * 'men'  -> { raw:'men', base:'men', tone:null }  (no mark and no digit = neutral)
 */
export function decodeSyllable(token) {
  const raw = String(token).trim();
  let working = raw.toLowerCase().replace(/u:/g, 'ü');
  let tone = null;

  // a trailing tone digit (1-5) wins
  const digitMatch = working.match(/^([a-zü]+)([1-5])$/);
  if (digitMatch) {
    working = digitMatch[1];
    tone = Number(digitMatch[2]);
  }

  let base = '';
  for (const ch of working) {
    const mapped = MARK_TO_TONE.get(ch);
    if (mapped) {
      base += mapped.plain;
      if (mapped.tone != null && tone == null) tone = mapped.tone;
    } else if (ch === 'ü') {
      base += 'ü';
    } else if (/[a-z]/.test(ch)) {
      base += ch;
    }
    // anything else (apostrophes, hyphens) is ignored
  }

  return {
    raw,
    base,
    tone: tone === NEUTRAL_TONE ? null : tone, // 5 and "no mark" are the same thing
    letter: normalizeBase(base, false),
    display: encodeSyllable(base, tone === NEUTRAL_TONE ? null : tone),
  };
}

/** { base:'xue', tone:2 } -> 'xué' (tone marks, the display form). */
export function encodeSyllable(base, tone) {
  const plain = String(base).toLowerCase().replace(/u:/g, 'ü').replace(/v/g, 'ü');
  if (!tone || tone === NEUTRAL_TONE) return plain;

  let target = -1;
  if (plain.includes('a')) target = plain.indexOf('a');
  else if (plain.includes('o')) target = plain.indexOf('o');
  else if (plain.includes('e')) target = plain.indexOf('e');
  else if (plain.includes('iu')) target = plain.indexOf('iu') + 1;
  else if (plain.includes('ui')) target = plain.indexOf('ui') + 1;
  else {
    for (let i = plain.length - 1; i >= 0; i -= 1) {
      if ('iuü'.includes(plain[i])) { target = i; break; }
    }
  }
  if (target < 0) return plain;

  const letter = plain[target];
  const row = TONE_TABLE.find((r) => r.plain === letter);
  if (!row) return plain;
  const glyph = row.tones[tone] || letter;
  return plain.slice(0, target) + glyph + plain.slice(target + 1);
}

/**
 * Decode a stored OR typed pinyin string into syllable objects.
 * Tolerates tone marks, tone numbers, separators and unseparated input
 * ("xué xiào", "xue2xiao4", "xuéxiào", "xuexiao").
 */
function decodeAll(pinyin) {
  const text = String(pinyin || '').trim();
  if (!text) return [];
  return parseInput(text).syllables.map((syllable) => ({
    base: syllable.base,
    tone: syllable.tone,
    letter: syllable.letter,
    display: encodeSyllable(syllable.base, syllable.tone),
  }));
}

/** 'xue2xiao4' | 'xuéxiào' -> 'xué xiào' */
export function toToneMarks(pinyin) {
  return decodeAll(pinyin).map((syllable) => syllable.display).join(' ');
}

/** 'xué xiào' -> 'xue2xiao4' */
export function toToneNumbers(pinyin) {
  return decodeAll(pinyin)
    .map((syllable) => syllable.base.replace(/ü/g, 'v') + (syllable.tone || NEUTRAL_TONE))
    .join('');
}

/** 'xué xiào' -> 'xuexiao' */
export function toPlain(pinyin) {
  return decodeAll(pinyin).map((syllable) => syllable.letter).join('');
}

/* --------------------------------------------------------- segmentation --- */

/**
 * Split a run of letters ("xuexiao") into real pinyin syllables.
 * Dynamic programming: fewest syllables, preferring the longest first match.
 * Returns null when no full segmentation exists.
 */
export function segmentLetters(letters) {
  const s = normalizeBase(String(letters || ''), false).replace(/[^a-z]/g, '');
  if (!s) return null;

  const best = new Array(s.length + 1).fill(null);
  best[0] = [];
  for (let i = 0; i < s.length; i += 1) {
    if (!best[i]) continue;
    for (let len = Math.min(MAX_SYLLABLE_LEN, s.length - i); len >= 1; len -= 1) {
      const chunk = s.slice(i, i + len);
      if (!SYLLABLES.has(chunk)) continue;
      const candidate = [...best[i], chunk];
      if (!best[i + len] || candidate.length < best[i + len].length) {
        best[i + len] = candidate;
      }
    }
  }
  return best[s.length];
}

/**
 * Parse whatever the learner typed into syllables aligned left-to-right.
 * Returns { syllables: [{base, tone}], hadSeparators, toneCount, letters }
 */
export function parseInput(input) {
  const raw = String(input || '').trim();
  const result = { syllables: [], hadSeparators: false, toneCount: 0, letters: '', raw };

  if (!raw) return result;

  let tokens;
  if (/[\s'’·-]/.test(raw)) {
    result.hadSeparators = true;
    tokens = raw.split(/[\s'’·-]+/).filter(Boolean);
  } else if (HAS_TONE_DIGIT.test(raw)) {
    tokens = raw.match(PINYIN_CHUNK) || [];
  } else {
    tokens = null; // letters only: segment below
  }

  if (tokens) {
    result.syllables = tokens.map(decodeSyllable).filter((s) => s.base);
  } else {
    const decoded = decodeSyllable(raw);
    const parts = segmentLetters(decoded.letter) || [decoded.letter];
    // distribute the single tone we may have found onto its syllable later;
    // with no separators and no digits only one mark can exist per syllable,
    // so re-scan the raw text mark by mark.
    result.syllables = distributeTones(raw, parts);
  }

  result.toneCount = result.syllables.filter((s) => s.tone != null).length;
  result.letters = result.syllables.map((s) => s.letter).join('');
  return result;
}

/**
 * Assign tone marks found in `raw` to the syllables produced by segmenting it.
 * "xuéxiào" + ['xue','xiao'] -> [{base:'xue',tone:2},{base:'xiao',tone:4}]
 */
function distributeTones(raw, parts) {
  const marks = [];
  for (const ch of String(raw).toLowerCase()) {
    const mapped = MARK_TO_TONE.get(ch);
    if (mapped && mapped.tone != null) marks.push(mapped.tone);
  }
  const digits = String(raw).match(/[1-5]/g) || [];
  const tones = [...marks, ...digits.map(Number)];

  const out = [];
  parts.forEach((part, index) => {
    // the syllable owns the next unused tone, walking left to right
    const tone = index < tones.length && tones[index] !== NEUTRAL_TONE ? tones[index] : null;
    out.push({ base: part, tone, letter: normalizeBase(part, false) });
  });
  return out;
}

/* ------------------------------------------------------------- grading --- */

/** 一 and 不 change tone by sandhi; treat the citation and sandhi tones as equal. */
function tonesEquivalent(base, userTone, expectedTone) {
  const a = userTone == null ? NEUTRAL_TONE : userTone;
  const b = expectedTone == null ? NEUTRAL_TONE : expectedTone;
  if (a === b) return true;
  const letter = base.replace(/ü/g, 'v');
  if (letter === 'yi') {
    // yī / yí / yì are all the same word 一
    return [1, 2, 4].includes(a) && [1, 2, 4].includes(b);
  }
  if (letter === 'bu') {
    // bù / bú
    return [2, 4].includes(a) && [2, 4].includes(b);
  }
  return false;
}

/**
 * Grade one candidate answer.
 * Returns { correct, issues:[{index, kind, expected, got}], expected, got }
 *   kind: 'base' | 'tone' | 'missing-tones' | 'extra'
 */
export function gradeCandidate(userSyllables, correctSyllables, options = {}) {
  const { requireTones = true, strictU = false } = options;
  const issues = [];
  const expected = correctSyllables.map((s) => ({
    base: normalizeBase(s.base, strictU),
    tone: s.tone,
    display: encodeSyllable(s.base, s.tone),
  }));
  const got = userSyllables.map((s) => ({
    base: normalizeBase(s.base, strictU),
    tone: s.tone,
    display: encodeSyllable(s.base, s.tone),
  }));
  const expectedDisplay = correctSyllables.map((s) => encodeSyllable(s.base, s.tone)).join(' ');

  if (got.length === 0) {
    return {
      correct: false,
      issues: [{ index: 0, kind: 'base', expected: expectedDisplay }],
      expected,
      got,
    };
  }

  if (expected.length !== got.length) {
    // Tolerate a syllable-count mismatch only when the letter streams agree,
    // otherwise the learner typed a genuinely different number of syllables.
    const joinBases = (list) => list.map((s) => s.base).join('');
    if (joinBases(expected) !== joinBases(got)) {
      return {
        correct: false,
        issues: [{ index: 0, kind: expected.length > got.length ? 'base' : 'extra', expected: expectedDisplay }],
        expected,
        got,
      };
    }
  }

  const length = Math.max(expected.length, got.length);
  for (let i = 0; i < length; i += 1) {
    const e = expected[i];
    const g = got[i];
    if (!e || !g) continue;
    if (e.base !== g.base) {
      issues.push({ index: i, kind: 'base', expected: e.display, got: g.display });
      continue;
    }
    if (!requireTones) continue;
    if (!tonesEquivalent(e.base, g.tone, e.tone)) {
      issues.push({
        index: i,
        kind: g.tone == null ? 'missing-tones' : 'tone',
        expected: e.display,
        got: g.display,
      });
    }
  }

  return { correct: issues.length === 0, issues, expected, got };
}

/**
 * Grade a full answer against the stored reading plus accepted alternatives.
 * Returns { correct, expected (display string), issues, parsed, noTonesTyped }
 */
export function checkAnswer(input, pinyin, options = {}) {
  const { alternatives = '', requireTones = true, strictU = false } = options;
  const parsed = parseInput(input);
  // alternatives are stored pipe separated: "liǎo|liào"
  const variants = [pinyin, ...String(alternatives).split('|')]
    .map((v) => String(v).trim())
    .filter(Boolean);

  const expectedDisplay = splitSyllables(pinyin)
    .map((s) => encodeSyllable(s.base, s.tone))
    .join(' ');

  if (parsed.syllables.length === 0) {
    return { correct: false, expected: expectedDisplay, issues: [{ index: 0, kind: 'base' }], parsed };
  }

  let best = null;
  for (const variant of variants) {
    // Do not pre-normalise: gradeCandidate applies the strictU policy exactly once,
    // otherwise the ü of "lǜ" is flattened to u before strict mode can see it.
    const correctSyllables = splitSyllables(variant).map((s) => ({ base: s.base, tone: s.tone }));
    const graded = gradeCandidate(parsed.syllables, correctSyllables, { requireTones, strictU });
    if (graded.correct) {
      return { correct: true, expected: expectedDisplay, issues: [], parsed, matchedVariant: variant };
    }
    if (!best || graded.issues.length < best.issues.length) best = { ...graded, matchedVariant: variant };
  }

  const noTonesTyped = parsed.toneCount === 0 && requireTones;
  return {
    correct: false,
    expected: expectedDisplay,
    issues: best?.issues || [],
    parsed,
    noTonesTyped,
    matchedVariant: best?.matchedVariant,
  };
}

/** Human-readable hint for the first problem in a graded answer. */
export function describeIssue(issue, expectedSyllables) {
  if (!issue) return '';
  const target = expectedSyllables?.[issue.index];
  const which = `syllable ${issue.index + 1}`;
  switch (issue.kind) {
    case 'tone':
      return `Tone is wrong on ${which}${target ? ` (${target.display})` : ''}.`;
    case 'missing-tones':
      return `Tone missing on ${which}${target ? ` (${target.display})` : ''}.`;
    case 'extra':
      return 'Too many syllables.';
    default:
      return target ? `${which} should be “${target.display}”.` : `${which} is wrong.`;
  }
}
