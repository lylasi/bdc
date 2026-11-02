import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { buildPrompt, getPromptVersion } from '../../../../modules/prompts/index.js';
import { IPA_NOTATION_RULE } from '../../../../modules/phonetics-data.js';
import { createSseParser } from '../../../../modules/ai-protocols/common.js';

const artifactDir = dirname(fileURLToPath(import.meta.url));
const language = { locale: 'zh-CN' };
const userPrompt = (id, params, variant) => [{ role: 'user', content: buildPrompt(id, params, { ...language, variant }) }];
const tutor = buildPrompt('assistant.articleTutor', {}, language);

export function makeCases() {
    const common = { maxTokens: 8192, json: true, responseFormat: true };
    return [
        {
            ...common, id: 'word-bank', category: 'word', sourcePrompt: 'dictionary.wordAnalysis', responseFormat: false,
            messages: userPrompt('dictionary.wordAnalysis', { word: 'bank', notation: IPA_NOTATION_RULE }),
            requiredFields: ['phonetic', 'pos', 'meaning'],
            rubric: ['1: JSON 與必需欄位完整', '1: 常用義為銀行，可另列河岸', '1: 包含名詞詞性', '1: 音標包含正確的 bæŋk', '1: 簡潔、不添加虛構來源或無關內容']
        },
        {
            ...common, id: 'word-sanction', category: 'word', sourcePrompt: 'article.wordTooltip',
            messages: userPrompt('article.wordTooltip', { word: 'sanction', sentence: 'The board refused to sanction the project because the safety review was incomplete.' }, 'standard'),
            requiredFields: ['word', 'sentence', 'analysis.phonetic', 'analysis.pos', 'analysis.meaning', 'analysis.role'],
            rubric: ['1: JSON 與必需欄位完整', '2: 句中 sanction 是批准／認可，不是制裁', '1: 動詞詞性及音標合理', '1: 指出 to sanction 的不定式／refused 的補足關係，沒有誤判主被動']
        },
        {
            ...common, id: 'translation-library', category: 'translation', sourcePrompt: 'article.paragraphTranslation',
            messages: userPrompt('article.paragraphTranslation', { paragraph: 'When the town library extended its opening hours last autumn, staff expected most visitors to arrive after work. Instead, the busiest period was early morning, when students came to study before school. The library has since added six desks near the windows, but it has kept the quiet reading room unchanged. Visitors do not need to book a seat, although groups of more than four people must reserve a meeting room. The new timetable will remain in place until March, when the council will review attendance figures.' }, 'standard'),
            requiredFields: ['chinese_translation'],
            rubric: ['1: 嚴格 JSON 及非空譯文', '1: 保留預期下班後但實際早上最忙的轉折', '1: 保留加六張桌、安靜閱覽室不變', '1: 個人不需預約，超過四人的團體須預約會議室', '1: 保留截至三月及議會檢視入館數字，無捏造']
        },
        {
            ...common, id: 'translation-study', category: 'translation', sourcePrompt: 'article.paragraphTranslation',
            messages: userPrompt('article.paragraphTranslation', { paragraph: '**River Study**\n\nNot all of the 120 volunteers completed the course. Of the 80 who did, 60 reported better sleep, compared with 30 of the 60 people in a separate comparison group. The researchers described the difference as promising but did not claim that the course caused it: participants had chosen their own group, and sleep was measured only by self-report. A reduction of 10 percentage points should not be confused with a reduction of 10 percent. The team will publish its methods next month, provided that the independent review has been completed.' }, 'standard'),
            requiredFields: ['chinese_translation'],
            rubric: ['1: 嚴格 JSON、保留標題的 **粗體** 標記（標題文字可翻譯）', '1: 並非全部120人完成；80完成者60改善；另一組60人30改善', '1: 沒有聲稱因果，保留自選分組與自我報告限制', '1: 區分10個百分點與10%', '1: 下月公布以完成獨立審查為條件，而非確定已完成']
        },
        {
            ...common, id: 'syntax-inversion', category: 'syntax', sourcePrompt: 'article.sentenceAnalysis',
            messages: userPrompt('article.sentenceAnalysis', { sentence: 'Not until the final report had been checked twice did the committee agree to publish it.', context: 'The committee was responsible for deciding when the report could be released.', keyPointRule: 'Return 1-3 brief key points. If structured analysis is unreliable, return an empty array.' }, 'structured'),
            requiredFields: ['sentence', 'translation', 'phrase_alignment', 'chunks', 'key_points'],
            rubric: ['1: JSON、譯文、結構陣列完整', '1: 直到報告被檢查兩次後才同意公布', '1: 正確辨認 Not until 置首引發主句部分倒裝', '1: did 的還原為 committee agreed，非 until 從句倒裝', '1: had been checked 是先於同意的過去完成被動，it 指報告']
        },
        {
            ...common, id: 'syntax-mixed-conditional', category: 'syntax', sourcePrompt: 'article.sentenceAnalysis',
            messages: userPrompt('article.sentenceAnalysis', { sentence: 'Had Maya not missed the train, she would be attending the interview now.', context: 'Maya missed the only train that could get her to the interview on time.', keyPointRule: 'Return 1-3 brief key points. If structured analysis is unreliable, return an empty array.' }, 'structured'),
            requiredFields: ['sentence', 'translation', 'phrase_alignment', 'chunks', 'key_points'],
            rubric: ['1: JSON、譯文、結構陣列完整', '1: 還原 If Maya had not missed the train', '1: 過去反事實：實際錯過火車', '1: 現在結果：現在未能出席面試，不是僅過去事件', '1: 正確稱為過去條件＋現在結果的混合條件句，解釋 would be attending']
        },
        {
            ...common, id: 'assistant-basic', category: 'assistant', sourcePrompt: 'assistant.articleTutor', json: false, responseFormat: false,
            messages: [{ role: 'system', content: tutor }, { role: 'user', content: '文章原文：Emma has been to Paris three times, but she is at home now. Her brother has gone to Paris and will not return until Friday.\n\n请结合原文，用不超过250个中文字解释 has been to 与 has gone to 的区别，说明两个人现在的情况，并各给一个简短英文例句。不要扩展到其他时态。' }],
            rubric: ['1: been to 表示到訪經驗、通常已返回', '1: Emma 現在在家且去過三次', '1: gone to 表示已前往、尚未返回；兄弟週五前未回', '1: 兩個英文例句與解釋吻合', '1: 清晰簡潔、不擴展其他時態，不把 gone to 解釋為已經返回']
        },
        {
            ...common, id: 'assistant-critical', category: 'assistant', sourcePrompt: 'assistant.articleTutor', json: false, responseFormat: false,
            messages: [{ role: 'system', content: tutor }, { role: 'user', content: '文章原文：Students chose whether to join an optional reading course. Before the course, 60 of the 100 participants passed a comprehension test; afterwards, 72 passed. In a separate comparison group of 100 students, the number passing rose from 70 to 77. The groups were not randomly assigned, and no other differences between them were measured.\n\n有人总结：“课程使通过率提高了12%，因此每100名学生必定会多12人通过；扣除对照组后，课程的因果效果就是5%。”\n\n请用不超过350个中文字核对这句话。区分百分比与百分点，算出两组各自的变化及变化之差，并说明这些数据能否证明因果关系。不要编造研究信息。' }],
            rubric: ['1: 60%→72% 是12個百分點；相對增幅20%', '1: 對照70%→77% 是7個百分點', '1: 變化之差5個百分點，不是直接當作5%相對增幅', '1: 自選分組／非隨機／混雜，不能把差值當已證明因果', '1: 不保證每100人必多12人，不捏造資料，給出準確易懂更正']
        }
    ].map((item) => ({ ...item, promptVersion: getPromptVersion(item.sourcePrompt), promptHash: createHash('sha256').update(JSON.stringify(item.messages)).digest('hex') }));
}

export function makeBody({ model, mode, testCase }) {
    const body = { model, messages: testCase.messages, temperature: 0.2, max_tokens: testCase.maxTokens, stream: true, stream_options: { include_usage: true } };
    if (testCase.responseFormat) body.response_format = { type: 'json_object' };
    if (mode !== 'default') body.reasoning_effort = mode;
    return body;
}

function textOf(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map((part) => typeof part === 'string' ? part : part?.text || '').join('');
    return '';
}

function jsonInfo(answer, testCase) {
    if (!testCase.json) return { jsonValid: null, strictJsonValid: null, schemaValid: null };
    let parsed;
    let strictJsonValid = true;
    try { parsed = JSON.parse(answer); } catch (_) {
        strictJsonValid = false;
        try { parsed = JSON.parse(answer.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()); } catch (_) {
            return { jsonValid: false, strictJsonValid: false, schemaValid: false };
        }
    }
    const schemaValid = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (testCase.requiredFields || []).every((path) => {
        const value = path.split('.').reduce((obj, key) => obj?.[key], parsed);
        return Array.isArray(value) || (typeof value === 'string' && value.trim().length > 0);
    });
    return { jsonValid: true, strictJsonValid, schemaValid };
}

export async function runOne({ endpoint, model, mode, testCase, timeoutMs = 90000 }) {
    const started = performance.now();
    const elapsed = () => Math.round((performance.now() - started) * 10) / 10;
    const result = { startedAt: new Date().toISOString(), model, mode, caseId: testCase.id, category: testCase.category, promptHash: testCase.promptHash, requestedMaxTokens: testCase.maxTokens, headerMs: null, firstOutputMs: null, firstReasoningMs: null, firstAnswerMs: null, totalMs: null, reasoningChars: 0, answer: '', finishReason: '', done: false, usage: null, httpStatus: null, error: null, serverModels: [] };
    let reader;
    const ingest = (event) => {
        if (!event.data) return;
        if (event.data.trim() === '[DONE]') { result.done = true; return; }
        let json;
        try { json = JSON.parse(event.data); } catch (_) { result.error ||= 'invalid_sse_json'; return; }
        if (event.event === 'error' || json.error) result.error = String(json.error?.message || json.message || json.error || 'sse_error').slice(0, 800);
        if (json.model && !result.serverModels.includes(json.model)) result.serverModels.push(json.model);
        if (json.usage) result.usage = json.usage;
        const choice = json.choices?.[0];
        const delta = choice?.delta || choice?.message || {};
        const reasoning = textOf(delta.reasoning_content) || textOf(delta.reasoning);
        const answer = textOf(delta.content);
        if (reasoning.trim()) {
            result.firstReasoningMs ??= elapsed();
            result.firstOutputMs ??= elapsed();
        }
        result.reasoningChars += reasoning.length;
        if (answer.trim()) {
            result.firstAnswerMs ??= elapsed();
            result.firstOutputMs ??= elapsed();
        }
        result.answer += answer;
        if (choice?.finish_reason) result.finishReason = choice.finish_reason;
    };
    try {
        const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'User-Agent': 'BDC-Reasoning-Benchmark/1.0' }, body: JSON.stringify(makeBody({ model, mode, testCase })), signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
        result.headerMs = elapsed();
        result.httpStatus = response.status;
        if (!response.ok) {
            const detail = await response.text();
            result.error = `HTTP ${response.status}: ${detail.slice(0, 800)}`;
        } else if (!(response.headers.get('content-type') || '').includes('text/event-stream')) {
            ingest({ data: JSON.stringify(await response.json()) });
        } else {
            reader = response.body.getReader();
            const decoder = new TextDecoder();
            const parser = createSseParser();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                for (const event of parser.push(decoder.decode(value, { stream: true }))) ingest(event);
                if (result.done || result.error) break;
            }
            for (const event of parser.push(decoder.decode())) ingest(event);
            for (const event of parser.flush()) ingest(event);
        }
    } catch (error) {
        result.error = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : String(error?.message || error).slice(0, 800);
    } finally {
        result.totalMs = elapsed();
        try { await reader?.cancel(); } catch (_) {}
    }
    result.truncated = ['length', 'max_tokens', 'MAX_TOKENS'].includes(result.finishReason);
    if (result.truncated) result.error ||= 'truncated';
    if (!result.error && !result.done && !result.finishReason) result.error = 'incomplete_stream';
    if (!result.error && !result.answer.trim()) result.error = 'empty_answer';
    Object.assign(result, jsonInfo(result.answer, testCase));
    if (!result.error && testCase.json && !result.schemaValid) result.error = 'invalid_json_or_schema';
    result.ok = !result.error;
    return result;
}

export function summarize(records) {
    const median = (values) => {
        const sorted = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
        if (!sorted.length) return null;
        const mid = Math.floor(sorted.length / 2);
        return (sorted[mid] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2;
    };
    const groups = new Map();
    for (const record of records) {
        const key = `${record.model}|${record.category}|${record.mode}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(record);
    }
    return [...groups].map(([key, rows]) => {
        const good = rows.filter((row) => row.ok);
        return { key, n: rows.length, successful: good.length, medianTotalMs: median(good.map((row) => row.totalMs)), medianFirstAnswerMs: median(good.map((row) => row.firstAnswerMs)), medianReasoningChars: median(good.map((row) => row.reasoningChars)), failures: rows.filter((row) => !row.ok).map((row) => ({ caseId: row.caseId, mode: row.mode, error: row.error })) };
    });
}

async function main() {
    const args = new Map();
    for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
    const endpoint = args.get('endpoint') || 'http://127.0.0.1:3425/v1/chat/completions';
    const models = (args.get('models') || 'workbuddy/deepseek-v4.1-flash').split(',');
    const modes = (args.get('modes') || 'none,high').split(',');
    const repeats = Number(args.get('repeats') || 2);
    const timeoutMs = Number(args.get('timeoutMs') || 90000);
    const label = args.get('label') || 'main';
    const out = args.get('out') || join(artifactDir, `${label}.jsonl`);
    const wanted = args.get('cases')?.split(',');
    const cases = makeCases().filter((item) => !wanted || wanted.includes(item.id));
    if (!cases.length) throw new Error('no cases selected');
    const previous = await readFile(out, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
    const records = previous.trim() ? previous.trim().split('\n').map((line) => JSON.parse(line)) : [];
    const key = (r) => [r.model, r.mode, r.caseId, r.repeat, r.promptHash].join('|');
    const completed = new Set(records.map(key));
    await writeFile(`${out}.manifest.json`, JSON.stringify({ label, endpoint, models, modes, repeats, timeoutMs, nodeVersion: process.version, createdAt: new Date().toISOString(), notes: 'Pinned routes; sequential, counterbalanced mode order; no client retries; reasoning text excluded; max_tokens=8192 for complete comparisons, above some BDC production limits.', cases }, null, 2) + '\n');
    for (const model of models) {
        let failures = 0;
        for (let repeat = 1; repeat <= repeats; repeat += 1) {
            for (let index = 0; index < cases.length; index += 1) {
                const testCase = cases[index];
                const order = (index + repeat) % 2 === 1 ? modes : [...modes].reverse();
                for (const mode of order) {
                    if (completed.has(key({ model, mode, caseId: testCase.id, repeat, promptHash: testCase.promptHash }))) continue;
                    console.log(JSON.stringify({ event: 'start', model, mode, caseId: testCase.id, repeat, time: new Date().toISOString() }));
                    const result = { ...await runOne({ endpoint, model, mode, testCase, timeoutMs }), label, repeat };
                    await appendFile(out, JSON.stringify(result) + '\n');
                    records.push(result);
                    console.log(JSON.stringify({ event: 'done', model, mode, caseId: testCase.id, repeat, ok: result.ok, totalSeconds: result.totalMs / 1000, answerSeconds: result.firstAnswerMs === null ? null : result.firstAnswerMs / 1000, reasoningChars: result.reasoningChars, finishReason: result.finishReason, usage: result.usage, error: result.error }));
                    if (result.ok) failures = 0;
                    else failures += 1;
                    if (failures >= 3) throw new Error('three consecutive failures; stop for diagnosis');
                }
            }
        }
    }
    await writeFile(`${out}.summary.json`, JSON.stringify(summarize(records), null, 2) + '\n');
    console.log(JSON.stringify({ event: 'complete', out, requests: records.length, successful: records.filter((r) => r.ok).length }));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
