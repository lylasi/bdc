const root = process.argv[2];
const cn = (await import(root + '/locales/zh-CN.js')).default;
const hk = (await import(root + '/locales/zh-HK.js')).default;
const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object') ? flat(v, p + k + '.') : [[p + k, v]]);
const fc = new Map(flat(cn)), fh = new Map(flat(hk));
const onlyCn = [...fc.keys()].filter(k => !fh.has(k));
const onlyHk = [...fh.keys()].filter(k => !fc.has(k));
console.log('keys CN', fc.size, 'HK', fh.size, 'onlyCN', onlyCn.length, 'onlyHK', onlyHk.length, JSON.stringify({ onlyCn, onlyHk }));
for (const k of ['article.englishSentenceOnly', 'article.sentenceNotReadable', 'article.readSelection', 'article.staleSentenceCard', 'article.sourceAlreadyChinese']) {
    console.log(k, '|CN:', JSON.stringify(fc.get(k)), '|HK:', JSON.stringify(fh.get(k)));
}
