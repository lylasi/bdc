// Simple validators for AI JSON responses

export function isString(x) { return typeof x === 'string' && x.length >= 0; }
export function isArray(x) { return Array.isArray(x); }
export function isObject(x) { return x && typeof x === 'object' && !Array.isArray(x); }

export function validateWordAlignment(arr) {
  if (!isArray(arr)) return false;
  for (const it of arr) {
    if (!isObject(it)) return false;
    if (!isString(it.en) || !isString(it.zh)) return false;
  }
  return true;
}

export function validateDetailedAnalysis(arr) {
  if (!isArray(arr)) return false;
  for (const it of arr) {
    if (!isObject(it)) return false;
    if (!isString(it.word) || !isString(it.sentence)) return false;
    if (!isObject(it.analysis)) return false;
    const a = it.analysis;
    if (!('phonetic' in a && 'pos' in a && 'meaning' in a && 'role' in a)) return false;
    if (!isString(a.phonetic) || !isString(a.pos) || !isString(a.meaning) || !isString(a.role)) return false;
  }
  return true;
}

export function validateArticleAnalysis(obj, level = 'standard') {
  if (!isObject(obj)) return false;
  if (!isString(obj.chinese_translation)) return false;
  // word_alignment 可選；存在時需結構正確
  if (obj.word_alignment != null && !validateWordAlignment(obj.word_alignment)) return false;
  // 自 2025-10 起：允許所有等級採用最小輸出（僅翻譯）。
  // 若提供 detailed_analysis，需通過結構校驗；未提供亦視為合法。
  if (obj.detailed_analysis != null) {
    return validateDetailedAnalysis(obj.detailed_analysis);
  }
  return true;
}

export function validateWordInSentence(obj) {
  if (!isObject(obj)) return false;
  if (!isString(obj.word) || !isString(obj.sentence)) return false;
  if (!isObject(obj.analysis)) return false;
  const a = obj.analysis;
  return isString(a.phonetic) && isString(a.pos) && isString(a.meaning) && isString(a.role);
}

// Sentence-level analysis schema
export function validateSentenceAnalysis(obj) {
  if (!isObject(obj)) return false;
  if (!isString(obj.sentence) || !isString(obj.translation)) return false;
  if (obj.phrase_alignment && !validateWordAlignment(obj.phrase_alignment)) return false;
  if (obj.chunks) {
    if (!isArray(obj.chunks)) return false;
    for (const c of obj.chunks) {
      if (!isObject(c)) return false;
      if (!isString(c.text)) return false;
      if (!isString(c.role)) return false;
      if (c.note != null && !isString(c.note)) return false;
    }
  }
  if (obj.key_points) {
    if (!isArray(obj.key_points)) return false;
    for (const k of obj.key_points) if (!isString(k)) return false;
  }
  return true;
}

// Selection/phrase analysis schema
export function validateSelectionAnalysis(obj) {
  if (!isObject(obj)) return false;
  if (!isString(obj.selection) || !isString(obj.sentence)) return false;
  if (!isObject(obj.analysis)) return false;
  const a = obj.analysis;
  if (!isString(a.meaning)) return false;
  if (a.usage && !isString(a.usage)) return false;
  if (a.examples) {
    if (!isArray(a.examples)) return false;
    for (const ex of a.examples) {
      if (!isObject(ex)) return false;
      if (!isString(ex.en) || !isString(ex.zh)) return false;
    }
  }
  return true;
}
