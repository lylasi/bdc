import { createHash } from 'node:crypto';
import { makeCases as previousCases } from '../20261102121456495/benchmark.mjs';
import { buildPrompt, getPromptVersion } from '../../../../modules/prompts/index.js';

const locale = { locale: 'zh-CN' };
const userPrompt = (id, params, variant) => [{ role: 'user', content: buildPrompt(id, params, { ...locale, variant }) }];
export function makeCases() {
    const common = { maxTokens: 8192, json: true, responseFormat: true };
    const extra = [
        {
            ...common, id: 'word-idiom', category: 'word', sourcePrompt: 'article.phraseAnalysis',
            messages: userPrompt('article.phraseAnalysis', { selection: 'kicks the bucket', sentence: 'Leo says he wants to travel the world before he kicks the bucket.', context: 'Leo is alive and is casually describing his future travel plans.' }, 'standard'),
            requiredFields: ['selection', 'sentence', 'analysis.phonetic', 'analysis.meaning', 'analysis.usage', 'analysis.examples'], arrayFields: ['analysis.examples'],
            rubric: ['1: JSON與必要欄位完整、例句陣列可用', '1: 辨認慣用語為死亡／死去，不是字面踢桶', '1: 說明口語／非正式語氣，避免當作正式哀悼措辭', '1: 不聲稱Leo已經死亡，保留未來計劃的語境', '1: 例句及中文對應正確、音標合理，不編造詞源或來源']
        },
        {
            ...common, id: 'translation-long-policy', category: 'translation', sourcePrompt: 'article.paragraphTranslation',
            messages: userPrompt('article.paragraphTranslation', { paragraph: '**Riverside pilot**\n\nAt Monday\'s meeting, the council agreed to fund a six-month transport pilot, not a permanent service. The plan has not yet started. If the independent safety review is completed before 15 December, the first buses will run in January; otherwise, the launch will be delayed. Dr. Maya Chen said that approval of the funding should not be confused with approval to begin carrying passengers. No date for a permanent service has been agreed.\n\nApplicants under 18 cannot join the passenger panel. People aged 18 or over may apply, but applications received after Friday will not be considered unless the delay was caused by the council\'s own website. Successful applicants will be notified within seven working days, excluding weekends and public holidays. They will receive a travel pass, but they will not be paid for attending meetings.\n\nThe pilot follows a small, voluntary survey. In one neighbourhood, the share of respondents willing to use the bus rose from 40% to 50%. That is an increase of 10 percentage points, or a relative increase of 25%; it is not a 10% relative increase. Not all respondents had previously used public transport. Because the survey was voluntary and the two neighbourhoods differed in income and distance from the station, the council did not claim that cheaper fares caused the change.\n\nThe published budget includes drivers and routine maintenance but excludes major repairs. Any proposal to increase the budget must return to the council for a separate vote. Fewer than five residents complained about the proposed timetable, which does not mean that every other resident supported it: most residents did not respond. The council will publish the full figures rather than only the positive comments.\n\nThe final report must distinguish observed changes from predicted benefits. Even if passenger numbers rise, that alone will not establish whether the service reduced car journeys. A permanent service will be considered only after the pilot has ended and the external assessment has been published.' }, 'standard'),
            requiredFields: ['chinese_translation'],
            rubric: ['1: 嚴格JSON、全文完整且保留標題粗體與段落；Maya Chen人名不改寫', '1: 區分六個月試辦／永久服務、撥款／載客批准，保留安全審查與日期條件', '1: 年齡18以下不合資格、18及以上可申請；週五後例外僅因議會網站；七個工作天不含週末假日；無會議薪酬', '1: 保留40%到50%、10個百分點、相對25%、自願調查及不能推論因果', '1: 保留不含大修、追加預算另投票、少於五人不代表其他全支持、永久化須試辦結束及外評公布']
        },
        {
            ...common, id: 'syntax-ambiguous', category: 'syntax', sourcePrompt: 'article.sentenceAnalysis',
            messages: userPrompt('article.sentenceAnalysis', { sentence: 'I saw the man with the telescope.', context: 'Both the observer and the man may have had access to a telescope. No further information identifies who was using or carrying it.', keyPointRule: 'Return 1-3 brief key points. Explain genuine ambiguity when context does not resolve it.' }, 'structured'),
            requiredFields: ['sentence', 'translation', 'phrase_alignment', 'chunks', 'key_points'],
            rubric: ['1: JSON、譯文及結構陣列完整', '1: 明確承認with the telescope有兩種合理附著／解讀', '1: 修飾saw時可指我用望遠鏡看見男人', '1: 修飾man時可指拿著／帶著望遠鏡的男人', '1: 依現有上下文不能確定唯一解讀，不聲稱必然只有一方使用']
        },
        {
            ...common, id: 'assistant-multiturn', category: 'assistant', sourcePrompt: 'assistant.articleTutor', json: false, responseFormat: false,
            messages: [
                { role: 'system', content: buildPrompt('assistant.articleTutor', {}, locale) },
                { role: 'user', content: '文章原文：At Green School, 80 students chose an optional reading club and another 80 did not join. In the club group, the number passing the same comprehension test rose from 40 to 50. In the comparison group, it rose from 48 to 52. Students were not randomly assigned, and other differences between them were not measured.\n先确认两组人数和通过人数，先不要判断因果。' },
                { role: 'assistant', content: '两组各80人。阅读组通过人数40→50，对照组48→52。' },
                { role: 'user', content: '现在纠正这个总结：“课程让每100人必定多12.5人通过，净因果收益就是7.5%。”请沿用前面每组80人的数据。先用一句不超过35词的英文概括，再用恰好三条中文说明，每条尽量不超过50字。说明两组通过率各自的百分点变化、相对增幅、变化之差，以及因果推断的限制，不要编造新数据。' }
            ],
            rubric: ['1: 閱讀組50%到62.5%，增加12.5個百分點、相對增幅25%', '1: 對照組60%到65%，增加5個百分點、相對增幅約8.33%，變化之差7.5個百分點', '1: 非隨機、自選或混雜使因果未被證明，不保證每100人必多12.5人', '1: 先一句不超過35詞英文，再恰好三條中文，表達簡潔', '1: 保留兩組各80人的多輪上下文，不改成實際各100人、不捏造樣本或研究結論']
        }
    ];
    return [...previousCases(), ...extra.map((item) => ({ ...item, promptVersion: getPromptVersion(item.sourcePrompt), promptHash: createHash('sha256').update(JSON.stringify(item.messages)).digest('hex') }))];
}

export const representativeCases = ['word-sanction', 'translation-library', 'syntax-inversion', 'assistant-critical'];
