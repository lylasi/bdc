import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const root = new URL('../', import.meta.url);
const read = file => fs.readFileSync(new URL(file, root), 'utf8');
const data = await import('data:text/javascript;base64,' + Buffer.from(read('modules/phonetics-data.js')).toString('base64'));

test('unknown IPA is a reference, never relabeled by the selected voice', () => {
    const query = data.entryQuery({word:'read',phonetic:'/riːd/'},'us');
    assert.equal(query.get('ipa'), null);
    assert.equal(query.get('referenceIPA'), 'riːd');
    const known = data.entryQuery({word:'read',phonetic:'riːd',phoneticAccent:'uk'},'us');
    assert.equal(known.get('accent'),'uk');assert.equal(known.get('ipa'),'riːd');
    assert.equal(data.entryQuery({word:'read',phonetic:'error'}).has('ipa'),false);
});
test('AI output must identify exact word and accent, and preserves heteronyms', () => {
    const valid={word:'read',accent:'uk',readings:[{ipa:'riːd',meaning:'现在时'},{ipa:'red',meaning:'过去时'}]};
    assert.equal(data.validatePronunciations(valid,'read','uk').length,2);
    for (const ipa of ['ˈæp.əl','θɪŋk','ðɪs','ɡəʊ']) assert.equal(data.validIPA(ipa),true);
    assert.equal(data.validatePronunciations(valid,'read','us').length,0);
    assert.equal(data.validatePronunciations(valid,'reed','uk').length,0);
    for(const value of ['error','n/a','<script>', 'a'.repeat(161)]) {
        assert.equal(data.validatePronunciations({...valid,readings:[{ipa:value}]},'read','uk').length,0);
    }
    assert.equal(data.validatePronunciations('raw model text','read','uk').length,0);
});
test('accent voices never silently fall back from UK to US', () => {
    assert.equal(data.voiceForAccent({},'uk'),'en-GB-AbbiNeural');
    assert.equal(data.voiceForAccent({tts:{selectedVoices:{'en-GB':'en-GB-SoniaNeural'}}},'uk'),'en-GB-SoniaNeural');
    assert.throws(()=>data.voiceForAccent({tts:{selectedVoices:{'en-GB':'en-US-JennyNeural'}}},'uk'));
});
test('TTS reuses current BDC channel and selected voice with encoded text', () => {
    let settings={tts:{use:'local',baseUrlLocal:'http://lan.test:8888',baseUrlRemote:'https://remote.test'}};
    const context={TTS_CONFIG:{baseUrl:'https://fallback.test',voices:{english:'en-US-JennyNeural'}},
        loadGlobalSettings:()=>settings,loadGlobalSecrets:()=>({ttsApiKey:'test-key'}),state:{}};
    vm.createContext(context);
    const source=read('modules/audio.js').replace(/^import .*;\n/gm,'').replace(/^export /gm,'');
    vm.runInContext(source,context);
    let url=new URL(context.buildTTSUrl('tidy up',data.voiceForAccent(settings,'uk')));
    assert.equal(url.origin,'http://lan.test:8888');assert.equal(url.searchParams.get('v'),'en-GB-AbbiNeural');
    assert.equal(url.searchParams.get('t'),'tidy up');
    settings={...settings,tts:{...settings.tts,use:'remote'}};
    url=new URL(context.buildTTSUrl('apple',data.voiceForAccent(settings,'us')));
    assert.equal(url.origin,'https://remote.test');assert.equal(url.searchParams.get('v'),'en-US-JennyNeural');
});
test('setting defaults off, persists locally and survives unrelated updates', () => {
    const storage=new Map();
    const context={TTS_CONFIG:{},syncTouch(){},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)}};
    vm.createContext(context);
    vm.runInContext(read('modules/settings.js').replace(/^import .*;\n/gm,'').replace(/^export /gm,''),context);
    assert.equal(context.loadGlobalSettings().phonetics.enabled,false);
    context.saveGlobalSettings({phonetics:{enabled:true}});
    context.saveGlobalSettings({ai:{models:{wordAnalysis:'model'}}});
    assert.equal(context.loadGlobalSettings().phonetics.enabled,true);
    context.saveGlobalSettings({phonetics:{enabled:false}});
    assert.equal(context.loadGlobalSettings().phonetics.enabled,false);
});
test('new UI translation keys match in both locales', async () => {
    const dicts=await Promise.all(['zh-CN','zh-HK'].map(locale=>import('data:text/javascript;base64,'+Buffer.from(read(`locales/${locale}.js`)).toString('base64'))));
    assert.deepEqual(Object.keys(dicts[0].default.phonetics).sort(),Object.keys(dicts[1].default.phonetics).sort());
    for(const dict of dicts) for(const text of Object.values(dict.default.phonetics)) assert.ok(text.length);
});


test('shelter splits existing IPA offline and treats parenthesized r as optional', () => {
    const context = {window:{}};
    vm.createContext(context);
    vm.runInContext(read('phonetic-chart/data.js'), context);
    vm.runInContext(read('phonetic-chart/word-split.js'), context);
    for (const accent of ['uk','us']) {
        const tokens = data.practiceTokens('ˈʃeltə(r)', accent, 'shelter', context.window.WordSplit.tokenize);
        assert.deepEqual(Array.from(tokens.filter(t=>t.type==='sound'), t=>t.symbol), ['ʃ','e','l','t','ə','r']);
        assert.equal(tokens.at(-1).optional,true);
        const required=tokens.filter(t=>t.type==='sound' && !t.optional);
        assert.equal(required.length,5);
        assert.ok(required.every(t=>t.variant?.audio));
        assert.ok(tokens.every(t=>t.symbol!=='(' && t.symbol!==')'));
    }
});

test('phrases preserve complete IPA and reject non-English input', () => {
    for (const phrase of ['destroy buildings', 'tidy up the bedroom', "don't give up", 'a well-known place']) assert.equal(data.validWord(phrase), true);
    for (const phrase of ['', 'hello!', '<script>', '房子', 'a'.repeat(81)]) assert.equal(data.validWord(phrase), false);
    assert.equal(data.normalizePronunciationText('  Destroy   Buildings  '), 'destroy buildings');
    const ipa = 'dɪˈstrɔɪ ˈbɪldɪŋz';
    assert.equal(data.entryQuery({word:'destroy buildings',phonetic:ipa}).get('referenceIPA'), ipa);
    assert.equal(data.validatePronunciations({word:'destroy buildings',accent:'uk',readings:[{ipa}]},'destroy buildings','uk').length,1);
    const context = vm.createContext({window:{}});
    vm.runInContext(read('phonetic-chart/data.js'),context);
    vm.runInContext(read('phonetic-chart/word-split.js'),context);
    const tokens = data.practiceTokens(ipa,'uk','destroy buildings',context.window.WordSplit.tokenize);
    assert.ok(tokens.some(token => token.type === 'mark' && token.symbol === ' '));
    assert.ok(tokens.filter(token => token.type === 'sound').every(token => token.variant?.audio));
});
