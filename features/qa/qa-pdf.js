// PDF導出功能
import { displayMessage } from '../../modules/ui.js';
import { loadQASet } from './qa-storage.js';
import { t, formatDateTime } from '../../modules/i18n.js';

console.log('qa-pdf.js 模組載入');

// ========================= 可調整區（PDF 版面配置） =========================
// 說明：以下常數為 PDF 生成時使用的主要版面與樣式配置。
// 之後若要調整間距、字體大小、顏色等，僅需改動此區即可。
// 實務參考：
// - 若手寫題（不含答案）覺得線與題幹距離太近/太遠 → 調整 spacing.answerLineGap
// - 若含答案版本想讓答案更靠近題目 → 調整 spacing.answerTextTopGap
// - 若兩行書寫時線距不夠 → 同樣調整 spacing.answerLineGap（兩條線與題幹距離同步）
// - 若題與題之間太擠 → 調整 spacing.answerTextBottomGap（含答案）或 spacing.answerBottomGap（手寫）
// - 邊界留白需增減 → 調整 margin.*
// - 標題/內文大小 → 調整 fontSize.*
// - 主色/文字色 → 調整 colors.*
// ========================================================================
// PDF生成配置
const PDF_CONFIG = {
  margin: {
    top: 20,
    right: 20,
    bottom: 20,
    left: 20
  },
  fontSize: {
    title: 16,
    subtitle: 14,
    normal: 12,
    small: 10
  },
  lineHeight: 1.2,
  spacing: {
    titleBottom: 6,
    instructionBottom: 8,
    questionSpacing: 6,
    // 答題線行距（兩條線之間的距離），同時也作為題目到第一條線的上方距離
    answerLineGap: 10,
    // 答題線上方預留空間（供書寫） - 與行距一致以保持對稱
    answerTopGap: 10,
    // 答題線後的下方間距（更緊湊）
    answerBottomGap: 3,
    // 含答案模式：題目 → 答案 的上方距離（更靠近題目）
    answerTextTopGap: 4,
    // 含答案模式：答案結束 → 下一題 的下方距離（留出間距）
    answerTextBottomGap: 8,
    // 題目之間的額外間距
    answerSpacing: 2
  },
  colors: {
    primary: '#0f766e',
    success: '#0f9e6b',
    warning: '#b96b00',
    error: '#d92d20',
    text: '#333941',
    lightGray: '#f3f2ee'
  }
};
// ======================= 可調整區（PDF 版面配置）結束 =======================

// 導出問答集為手寫默寫PDF
export async function exportQASetForHandwriting(qaSetId, options = {}) {
  try {
    console.log('開始生成手寫默寫PDF...');

    // 載入問答集數據
    const qaSet = await loadQASet(qaSetId);
    if (!qaSet) {
      throw new Error(t('qaPdf.loadSetFailed'));
    }

    // 檢查並載入jsPDF
    console.log('檢查jsPDF狀態:', typeof window.jsPDF);
    if (!resolveJsPDFConstructor()) {
      displayMessage(t('qaPdf.preparingEngine'), 'info');
      console.log('正在載入jsPDF...');
      await loadjsPDF();
    }

    let doc;
    const jsPDFConstructor = resolveJsPDFConstructor();

    if (jsPDFConstructor) {
      try {
        doc = new jsPDFConstructor();
        console.log('PDF文檔創建成功');
      } catch (error) {
        console.error('PDF文檔創建失敗:', error);
        throw new Error(t('qa.pdfCtorFailed', { message: error.message }));
      }
    } else {
      throw new Error(t('qaPdf.loadLibraryFailed'));
    }

    // 註冊中文字型（若可用 Base64）— 會在提供 Base64 時自動生效

    // 兼容掘金方法：若前端以 <script src="./SourceHanSansSC-Normal-Min-normal.js"></script>
    // 暴露 window.fontBase64/window.fontFamilyName，則此處會自動註冊。
    await registerChineseFont(doc, options.font || {});

    const {
      shuffleQuestions = false,
      includeAnswers = false,
      answerLines = 1,
      questionsPerPage = 8,
      currentQuestions = null
    } = options;

    // 若提供當前順序，優先使用（不再打亂）
    let questions = Array.isArray(currentQuestions) && currentQuestions.length
      ? [...currentQuestions]
      : [...qaSet.questions];

    // 僅在未提供當前順序時，依需求亂序
    if (!currentQuestions && shuffleQuestions) {
      questions = shuffleArray(questions);
    }

    let yPosition = PDF_CONFIG.margin.top;
    const pageHeight = doc.internal.pageSize.height;
    const contentWidth = doc.internal.pageSize.width - PDF_CONFIG.margin.left - PDF_CONFIG.margin.right;
    let questionCount = 0;

    // 添加標題
    yPosition = addHandwritingTitle(doc, qaSet.name, yPosition);
    yPosition += 4;

    // 添加說明
    yPosition = addHandwritingInstructions(doc, yPosition, includeAnswers);
    yPosition += 6;

    // 處理每個問題
    for (let i = 0; i < questions.length; i++) {
      const question = questions[i];

      // 精準估算當前題塊高度（避免被切頁）
      const questionText = `${i + 1}. ${question.question}`;
      const qLines = doc.splitTextToSize(questionText, contentWidth).length;
      const qHeight = qLines * getLineHeightMm(PDF_CONFIG.fontSize.normal);
      let blockHeight;
      if (includeAnswers) {
        const answerLabel = t('qaPdf.answer', { answer: question.answer });
        const aLines = doc.splitTextToSize(answerLabel, contentWidth).length;
        const aHeight = aLines * getLineHeightMm(PDF_CONFIG.fontSize.small);
        blockHeight = qHeight + PDF_CONFIG.spacing.answerTextTopGap + aHeight + PDF_CONFIG.spacing.answerTextBottomGap + PDF_CONFIG.spacing.answerSpacing;
      } else {
        const L = PDF_CONFIG.spacing.answerLineGap;
        blockHeight = qHeight + L + (answerLines * L) + PDF_CONFIG.spacing.answerBottomGap + PDF_CONFIG.spacing.answerSpacing;
      }

      // 檢查是否需要新頁面
      if (questionCount >= questionsPerPage || yPosition + blockHeight > pageHeight - 25) {
        doc.addPage();
        yPosition = PDF_CONFIG.margin.top;
        questionCount = 0;
      }

      // 添加問題
      yPosition = addHandwritingQuestion(doc, question, i + 1, yPosition, contentWidth, includeAnswers, answerLines);
      questionCount++;
    }

    // 添加頁腳
    addHandwritingFooter(doc);

    // 生成文件名
    const timestamp = new Date().toISOString().split('T')[0];
    const shuffleText = shuffleQuestions ? t('qaPdf.shuffled') : t('qaPdf.ordered');
    const answerText = includeAnswers ? t('qaPdf.withAnswers') : t('qaPdf.handwriting');
    const filename = `${qaSet.name}${shuffleText}${answerText}_${timestamp}.pdf`;

    // 保存PDF
    doc.save(filename);

    displayMessage(t('qaPdf.exportSuccess'), 'success');
    console.log(`手寫默寫PDF已保存: ${filename}`);

    return true;

  } catch (error) {
    console.error('手寫默寫PDF導出失敗:', error);
    displayMessage(t('qaPdf.exportFailed', { message: error.message }), 'error');
    return false;
  }
}

// 添加手寫默寫標題
function addHandwritingTitle(doc, qaSetName, yPosition) {
  doc.setFontSize(PDF_CONFIG.fontSize.title);
  doc.setTextColor(PDF_CONFIG.colors.primary);

  // 使用中文標題，並進行UTF-8編碼處理
  const title = t('qaPdf.handwritingTitle', { name: qaSetName });

  // 方案B：將含中文的行以 Canvas 轉圖片嵌入，避免缺字
  addTextWithCJKImageFallback(doc, title, PDF_CONFIG.margin.left, yPosition, {
    fontSizePt: PDF_CONFIG.fontSize.title,
    color: PDF_CONFIG.colors.primary,
    weight: '600'
  });

  // 添加下劃線
  const textWidth = getApproxTextWidthMm(title, PDF_CONFIG.fontSize.title);
  doc.setLineWidth(0.5);
  doc.line(PDF_CONFIG.margin.left, yPosition + 2, PDF_CONFIG.margin.left + textWidth, yPosition + 2);

  return yPosition + PDF_CONFIG.spacing.titleBottom;
}

// 添加手寫默寫說明
function addHandwritingInstructions(doc, yPosition, includeAnswers) {
  doc.setFontSize(PDF_CONFIG.fontSize.small);
  doc.setTextColor(PDF_CONFIG.colors.text);

  const instructions = [
    t('qaPdf.identity'),
    '',
    includeAnswers ?
      t('qaPdf.instructionsWithAnswers') :
      t('qaPdf.instructions')
  ];

  instructions.forEach((instruction, index) => {
    if (!instruction) return;
    const y = yPosition + (index * 4);
    addTextWithCJKImageFallback(doc, instruction, PDF_CONFIG.margin.left, y, {
      fontSizePt: PDF_CONFIG.fontSize.small,
      color: PDF_CONFIG.colors.text
    });
  });

  return yPosition + PDF_CONFIG.spacing.instructionBottom;
}

// 添加手寫默寫問題
function addHandwritingQuestion(doc, question, questionNumber, yPosition, contentWidth, includeAnswers, answerLines) {
  doc.setFontSize(PDF_CONFIG.fontSize.normal);
  doc.setTextColor(PDF_CONFIG.colors.text);

  // 問題編號和內容
  const questionText = `${questionNumber}. ${question.question}`;
  const questionLines = doc.splitTextToSize(questionText, contentWidth);
  doc.text(questionLines, PDF_CONFIG.margin.left, yPosition);
  // [版面點位] 題目與下方內容之間的間距：
  // - 含答案：answerTextTopGap（更靠題目）
  // - 手寫題：answerLineGap（與兩條線距離一致，保持對稱）
  const gapAfterQuestion = includeAnswers ? PDF_CONFIG.spacing.answerTextTopGap : PDF_CONFIG.spacing.answerLineGap;
  yPosition += questionLines.length * 5 + gapAfterQuestion;

  if (includeAnswers) {
    // 顯示答案
    const answerLabel = t('qaPdf.answer', { answer: question.answer });
    const answerX = PDF_CONFIG.margin.left; // 與題目左對齊
    const fontSize = PDF_CONFIG.fontSize.small;
    const lhMm = getLineHeightMm(fontSize);
    doc.setFontSize(fontSize);
    doc.setTextColor(PDF_CONFIG.colors.primary);
    // [版面點位] 答案段落：左對齊題幹，並自動換行（優先 jsPDF，退回 Canvas）
    const usedHeight = addWrappedTextSmart(doc, answerLabel, answerX, yPosition, contentWidth, {
      fontSizePt: fontSize,
      color: PDF_CONFIG.colors.primary
    });
    // [版面點位] 答案段落結束後與下一題的距離
    yPosition += (usedHeight > 0 ? usedHeight : lhMm) + PDF_CONFIG.spacing.answerTextBottomGap;
  } else {
    // 添加答題線，確保對齊和間距
    const lineSpacing = PDF_CONFIG.spacing.answerLineGap; // [版面點位] 兩條線間距（與題幹→第一條線一致）
    const lineStartX = PDF_CONFIG.margin.left + 5;
    const lineEndX = PDF_CONFIG.margin.left + contentWidth - 5;

    for (let i = 0; i < answerLines; i++) {
      doc.setLineWidth(0.3);
      doc.setDrawColor(120, 120, 120);
      const lineY = yPosition + (i * lineSpacing);
      doc.line(lineStartX, lineY, lineEndX, lineY);
    }
    // 緊湊處理：線條底部留較小空白
    yPosition += answerLines * lineSpacing + PDF_CONFIG.spacing.answerBottomGap;
  }

  return yPosition + PDF_CONFIG.spacing.answerSpacing;
}

// 添加手寫默寫頁腳
function addHandwritingFooter(doc) {
  const pageCount = doc.internal.getNumberOfPages();

  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(PDF_CONFIG.fontSize.small);
    doc.setTextColor(PDF_CONFIG.colors.text);

    const footerText = t('qaPdf.page', { current: i, total: pageCount });
    const footerX = doc.internal.pageSize.width / 2;
    const footerY = doc.internal.pageSize.height - 10;
    addTextWithCJKImageFallback(doc, footerText, footerX, footerY, {
      fontSizePt: PDF_CONFIG.fontSize.small,
      color: PDF_CONFIG.colors.text,
      align: 'center'
    });
  }
}

// 打亂數組順序
function shuffleArray(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// 導出問答訓練結果為PDF
export async function exportTrainingResultToPDF(trainingResult, aiCheckingResult = null, options = {}) {
  try {
    console.log('開始生成PDF報告...');

    // 檢查並載入jsPDF
    console.log('檢查jsPDF狀態:', typeof window.jsPDF);
    if (!resolveJsPDFConstructor()) {
      displayMessage(t('qaPdf.preparingEngine'), 'info');
      console.log('正在載入jsPDF...');
      await loadjsPDF();
    }

    let doc;
    const jsPDFConstructor = resolveJsPDFConstructor();

    if (jsPDFConstructor) {
      try {
        doc = new jsPDFConstructor();
        console.log('PDF文檔創建成功');
      } catch (error) {
        console.error('PDF文檔創建失敗:', error);
        throw new Error(t('qa.pdfCtorFailed', { message: error.message }));
      }
    } else {
      throw new Error(t('qaPdf.loadLibraryFailed'));
    }

    // 註冊中文字型（若前端已提供 Base64）
    await registerChineseFont(doc);

    let yPosition = PDF_CONFIG.margin.top;
    const pageHeight = doc.internal.pageSize.height;
    const contentWidth = doc.internal.pageSize.width - PDF_CONFIG.margin.left - PDF_CONFIG.margin.right;

    // 添加標題
    yPosition = addTitle(doc, t('qaPdf.reportTitle'), yPosition);
    yPosition += 10;

    // 添加基本信息
    yPosition = addBasicInfo(doc, trainingResult, yPosition);
    yPosition += 10;

    // 添加訓練總結
    yPosition = addTrainingSummary(doc, trainingResult, aiCheckingResult, yPosition);
    yPosition += 15;

    // 若有錯誤重點文字，插入「錯誤點彙總（精簡）」區塊
    if (options && options.errorText) {
      doc.setFontSize(PDF_CONFIG.fontSize.subtitle);
      doc.setTextColor(PDF_CONFIG.colors.primary);
      addTextWithCJKImageFallback(doc, t('qaPdf.errorSummary'), PDF_CONFIG.margin.left, yPosition, {
        fontSizePt: PDF_CONFIG.fontSize.subtitle,
        color: PDF_CONFIG.colors.primary,
        weight: '600'
      });
      yPosition += 10;
      doc.setFontSize(PDF_CONFIG.fontSize.normal);
      doc.setTextColor(PDF_CONFIG.colors.text);
      const block = doc.splitTextToSize(options.errorText, contentWidth);
      doc.text(block, PDF_CONFIG.margin.left, yPosition);
      yPosition += block.length * 6 + 10;
    }

    // 添加詳細答案分析
    yPosition = await addDetailedAnswers(doc, trainingResult, aiCheckingResult, yPosition, pageHeight, contentWidth);

    // 添加頁腳
    addFooter(doc);

    // 生成文件名
    const timestamp = new Date().toISOString().split('T')[0];
    const filename = t('qaPdf.reportFile', { name: trainingResult.qaSetName, date: timestamp });

    // 保存PDF
    doc.save(filename);

    displayMessage(t('qaPdf.reportSuccess'), 'success');
    console.log(`PDF已保存: ${filename}`);

    return true;

  } catch (error) {
    console.error('PDF導出失敗:', error);
    displayMessage(t('qaPdf.reportFailed', { message: error.message }), 'error');
    return false;
  }
}

// 動態載入jsPDF庫
// 來源依序嘗試：本地內嵌（離線可用、版本鎖定）→ 公開 CDN 備援
// 注意：整條 PDF 工具鏈（jsPDF + 中文字型）都只在需要導出時才抓，
//       首頁不載入，避免拖慢瀏覽體驗。
const JSPDF_SOURCES = [
  'modules/vendor/jspdf.umd.min.js',
  'https://unpkg.com/jspdf@4.2.1/dist/jspdf.umd.min.js',
  'https://registry.npmmirror.com/jspdf/4.2.1/files/dist/jspdf.umd.min.js'
];

// 已載入／載入中的來源，避免重複插入 <script>
const scriptPromises = new Map();

// 從各種可能的全域變數取出 jsPDF 建構函數（UMD 會掛在 window.jspdf.jsPDF）
function resolveJsPDFConstructor() {
  if (window.jsPDF && typeof window.jsPDF.jsPDF === 'function') return window.jsPDF.jsPDF;
  if (typeof window.jsPDF === 'function') return window.jsPDF;
  if (window.jspdf && typeof window.jspdf.jsPDF === 'function') return window.jspdf.jsPDF;
  if (typeof window.jspdf === 'function') return window.jspdf;
  if (typeof jsPDF !== 'undefined') return jsPDF;
  return null;
}

// 插入單一 <script> 並等待載入結果（同一來源只載入一次）
function loadScriptOnce(src) {
  if (!scriptPromises.has(src)) {
    scriptPromises.set(src, new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = () => {
        console.log('腳本載入完成:', src);
        resolve();
      };
      script.onerror = () => {
        scriptPromises.delete(src); // 允許之後重試同一來源（例如暫時離線）
        reject(new Error(`無法載入 ${src}`));
      };
      document.head.appendChild(script);
    }));
  }
  return scriptPromises.get(src);
}

async function loadjsPDF() {
  if (resolveJsPDFConstructor()) {
    console.log('jsPDF 已存在，略過載入');
    return;
  }

  const failures = [];
  for (const src of JSPDF_SOURCES) {
    try {
      await loadScriptOnce(src);
      const jsPDFConstructor = resolveJsPDFConstructor();
      if (!jsPDFConstructor) {
        throw new Error('腳本已載入但找不到 jsPDF 建構函數');
      }
      // 統一掛回 window.jsPDF，供其他模組沿用
      window.jsPDF = jsPDFConstructor;
      console.log('jsPDF 就緒，來源:', src);
      return;
    } catch (error) {
      failures.push(`${src} → ${error.message}`);
      console.warn('jsPDF 來源不可用，嘗試下一個:', src, error);
    }
  }

  console.error('jsPDF 所有來源皆載入失敗:', failures.join(' | '));
  throw new Error(t('qa.pdfLibLoadFailed'));
}

// ===== 中文字型按需載入 =====
// 字型資料（子集 0.3MB／完整 9MB／思源 mini 2.5MB）過去寫在 index.html，
// 每次開頁都要下載 12MB；現在只有真的要導出 PDF 時才抓，優先序如下：
//   1) Noto Sans TC 子集（最省，涵蓋常用字）
//   2) Noto Sans TC 完整版（子集缺字時）
//   3) 思源黑體 SC mini（保底，簡體最小集）
const CJK_FONT_SOURCES = [
  { kind: 'base64', path: 'modules/fonts/NotoSansTC-Subset.base64.txt', family: 'NotoSansTC-Subset', fileName: 'NotoSansTC-Subset.ttf' },
  { kind: 'base64', path: 'modules/fonts/NotoSansTC-Regular.base64.txt', family: 'NotoSansTC-Regular', fileName: 'NotoSansTC-Regular.ttf' },
  { kind: 'script', path: 'modules/fonts/SourceHanSansSC-Normal-Min-normal.js' }
];

let cjkFontPromise = null;

// 取得目前已載入的字型 Base64（若外部已自行引入 loader，這裡會直接沿用）
function currentFontBase64() {
  return window.SourceHanSansTC?.base64 || window.fontBase64 || '';
}

async function ensureChineseFontData() {
  if (cjkFontPromise) return cjkFontPromise;

  cjkFontPromise = (async () => {
    if (currentFontBase64()) return currentFontBase64();

    for (const source of CJK_FONT_SOURCES) {
      try {
        if (source.kind === 'script') {
          await loadScriptOnce(source.path);
        } else {
          const resp = await fetch(source.path);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const text = await resp.text();
          if (!text || text.length < 1024) throw new Error('字型資料為空');
          window.SourceHanSansTC = window.SourceHanSansTC || {};
          window.SourceHanSansTC.base64 = text;
          window.SourceHanSansTC.name = source.family;
          window.SourceHanSansTC.fileName = source.fileName;
          window.fontBase64 = text;
          window.fontFamilyName = source.family;
          window.fontFileName = source.fileName;
        }

        const base64 = currentFontBase64();
        if (base64) {
          console.log('中文字型就緒，來源:', source.path);
          return base64;
        }
        throw new Error('載入後仍無字型資料');
      } catch (error) {
        console.warn('中文字型來源不可用，嘗試下一個:', source.path, error);
      }
    }

    console.warn('所有中文字型來源皆不可用，將以 Canvas 圖像方式輸出中文');
    return '';
  })();

  return cjkFontPromise;
}

// 提前暖機：使用者把游標移到導出按鈕上時就先抓好 jsPDF 與字型，
// 讓第一次導出不必等（仍然不會在開頁時下載任何 PDF 相關資源）。
export function prefetchPdfEngine() {
  loadjsPDF().catch(() => {});
  ensureChineseFontData().catch(() => {});
}

// 添加標題
function addTitle(doc, title, yPosition) {
  doc.setFontSize(PDF_CONFIG.fontSize.title);
  doc.setTextColor(PDF_CONFIG.colors.primary);
  doc.text(title, PDF_CONFIG.margin.left, yPosition);

  // 添加下劃線
  const textWidth = doc.getTextWidth(title);
  doc.setLineWidth(0.5);
  doc.line(PDF_CONFIG.margin.left, yPosition + 2, PDF_CONFIG.margin.left + textWidth, yPosition + 2);

  return yPosition + 15;
}

// 添加基本信息
function addBasicInfo(doc, trainingResult, yPosition) {
  doc.setFontSize(PDF_CONFIG.fontSize.normal);
  doc.setTextColor(PDF_CONFIG.colors.text);

  const basicInfo = [
    t('qaPdf.setName', { name: trainingResult.qaSetName }),
    t('qaPdf.trainingTime', { start: formatDate(trainingResult.startTime), end: formatDate(trainingResult.endTime) }),
    t('qaPdf.duration', { duration: formatDuration(trainingResult.duration) }),
    t('qaPdf.mode', { mode: trainingResult.mode === 'random' ? t('qaPdf.random') : t('qaPdf.sequential') }),
    t('qaPdf.total', { count: trainingResult.totalQuestions }),
    t('qaPdf.answered', { count: trainingResult.answeredQuestions })
  ];

  basicInfo.forEach((info, index) => {
    doc.text(info, PDF_CONFIG.margin.left, yPosition + (index * 8));
  });

  return yPosition + (basicInfo.length * 8);
}

// 添加訓練總結
function addTrainingSummary(doc, trainingResult, aiCheckingResult, yPosition) {
  doc.setFontSize(PDF_CONFIG.fontSize.subtitle);
  doc.setTextColor(PDF_CONFIG.colors.primary);
  doc.text(t('qaPdf.summary'), PDF_CONFIG.margin.left, yPosition);
  yPosition += 12;

  doc.setFontSize(PDF_CONFIG.fontSize.normal);
  doc.setTextColor(PDF_CONFIG.colors.text);

  if (aiCheckingResult && aiCheckingResult.summary) {
    const s = aiCheckingResult.summary;
    const incorrect = s.incorrectCount != null ? s.incorrectCount : (Array.isArray(s.incorrectDetails) ? s.incorrectDetails.length : 0);
    const unanswered = s.unanswered != null ? s.unanswered : Math.max(0, (s.totalQuestions || trainingResult.totalQuestions || 0) - (s.totalAnswers || trainingResult.answeredQuestions || 0));
    const total = s.totalQuestions || trainingResult.totalQuestions;
    const answered = total - unanswered;
    doc.text(t('qaPdf.total', { count: total }), PDF_CONFIG.margin.left, yPosition); yPosition += 8;
    doc.text(t('qaPdf.answered', { count: answered }), PDF_CONFIG.margin.left, yPosition); yPosition += 8;
    doc.setTextColor(incorrect > 0 ? PDF_CONFIG.colors.error : PDF_CONFIG.colors.success);
    doc.text(t('qaPdf.incorrect', { count: incorrect }), PDF_CONFIG.margin.left, yPosition); yPosition += 8;
    doc.setTextColor(unanswered > 0 ? PDF_CONFIG.colors.warning : PDF_CONFIG.colors.success);
    doc.text(t('qaPdf.unanswered', { count: unanswered }), PDF_CONFIG.margin.left, yPosition); yPosition += 8;
    doc.setTextColor(PDF_CONFIG.colors.text);
  } else {
    const total = trainingResult.totalQuestions;
    const answered = trainingResult.answeredQuestions;
    const unanswered = Math.max(0, total - answered);
    doc.text(t('qaPdf.total', { count: total }), PDF_CONFIG.margin.left, yPosition); yPosition += 8;
    doc.text(t('qaPdf.answered', { count: answered }), PDF_CONFIG.margin.left, yPosition); yPosition += 8;
    doc.text(t('qaPdf.unanswered', { count: unanswered }), PDF_CONFIG.margin.left, yPosition); yPosition += 8;
  }

  return yPosition;
}

// 添加詳細答案分析
async function addDetailedAnswers(doc, trainingResult, aiCheckingResult, yPosition, pageHeight, contentWidth) {
  doc.setFontSize(PDF_CONFIG.fontSize.subtitle);
  doc.setTextColor(PDF_CONFIG.colors.primary);
  doc.text(t('qaPdf.details'), PDF_CONFIG.margin.left, yPosition);
  yPosition += 12;

  doc.setFontSize(PDF_CONFIG.fontSize.normal);

  for (let i = 0; i < trainingResult.answers.length; i++) {
    const answer = trainingResult.answers[i];
    const aiResult = aiCheckingResult?.checkedAnswers?.find(checked => checked.qid === answer.qid);

    // 檢查是否需要新頁面
    if (yPosition > pageHeight - 60) {
      doc.addPage();
      yPosition = PDF_CONFIG.margin.top;
    }

    // 問題標題
    doc.setTextColor(PDF_CONFIG.colors.primary);
    doc.text(t('qaPdf.questionNumber', { number: i + 1 }), PDF_CONFIG.margin.left, yPosition);
    yPosition += 10;

    // 問題內容
    doc.setTextColor(PDF_CONFIG.colors.text);
    yPosition = addWrappedText(doc, t('qaPdf.question', { text: answer.question }), PDF_CONFIG.margin.left, yPosition, contentWidth);
    yPosition += 5;

    // 標準答案
    yPosition = addWrappedText(doc, t('qaPdf.standardAnswer', { text: answer.correctAnswer }), PDF_CONFIG.margin.left, yPosition, contentWidth);
    yPosition += 5;

    // 用戶答案
    const userAnswerText = answer.userAnswer || t('qaPdf.noAnswer');
    yPosition = addWrappedText(doc, t('qaPdf.userAnswer', { text: userAnswerText }), PDF_CONFIG.margin.left, yPosition, contentWidth);
    yPosition += 5;

    // AI 判定（如果有）
    if (aiResult) {
      const ok = aiResult.isCorrect === true;
      doc.setTextColor(ok ? PDF_CONFIG.colors.success : PDF_CONFIG.colors.error);
      doc.text(t('qaPdf.verdict', { result: ok ? t('qaPdf.correct') : t('qaPdf.wrong') }), PDF_CONFIG.margin.left, yPosition);
      yPosition += 8;
      if (aiResult.teacherFeedback) {
        doc.setTextColor(PDF_CONFIG.colors.text);
        yPosition = addWrappedText(doc, t('qaPdf.feedback', { text: aiResult.teacherFeedback }), PDF_CONFIG.margin.left, yPosition, contentWidth);
        yPosition += 4;
      }
      // 簡列差異或改進
      const suggestions = aiResult.improvementSuggestions || aiResult.aiSuggestions || [];
      if (suggestions.length) {
        doc.setTextColor(PDF_CONFIG.colors.text);
        const line = t('qaPdf.suggestion', { text: suggestions.slice(0, 2).join('；') });
        yPosition = addWrappedText(doc, line, PDF_CONFIG.margin.left, yPosition, contentWidth);
        yPosition += 4;
      }
    }

    yPosition += 10; // 題目間隔
  }

  return yPosition;
}

// 添加自動換行文本
function addWrappedText(doc, text, x, y, maxWidth) {
  const lines = doc.splitTextToSize(text, maxWidth);
  doc.text(lines, x, y);
  return y + (lines.length * 6);
}

// 獲取分數對應的顏色
function getScoreColor(score) {
  if (score >= 80) return PDF_CONFIG.colors.success;
  if (score >= 60) return PDF_CONFIG.colors.warning;
  return PDF_CONFIG.colors.error;
}

// 以向量文字為主，必要時回退到 Canvas 估算換行，回傳實際佔用高度（毫米）
function addWrappedTextSmart(doc, text, xMm, yMm, maxWidthMm, opts = {}) {
  const { fontSizePt = PDF_CONFIG.fontSize.normal, color = PDF_CONFIG.colors.text, weight = '400' } = opts;
  doc.setTextColor(color);
  doc.setFontSize(fontSizePt);
  const lineHeightMm = getLineHeightMm(fontSizePt);
  try {
    const lines = doc.splitTextToSize(text, maxWidthMm);
    doc.text(lines, xMm, yMm);
    return lines.length * lineHeightMm;
  } catch (_) {
    // 回退：使用 Canvas 計算換行
    const lines = splitTextByCanvas(text, fontSizePt, maxWidthMm, weight);
    let cursorY = yMm;
    for (const line of lines) {
      addTextWithCJKImageFallback(doc, line, xMm, cursorY, { fontSizePt, color, weight });
      cursorY += lineHeightMm;
    }
    return lines.length * lineHeightMm;
  }
}

function getLineHeightMm(fontSizePt) {
  const px = ptToPx(fontSizePt);
  return pxToMm(Math.round(px * 1.25));
}

function mmToPx(mm) { return Math.round(mm * (96 / 25.4)); }

// 使用 Canvas 度量計算多行斷行（支援中英文及長單字）
function splitTextByCanvas(text, fontSizePt, maxWidthMm, weight = '400') {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const fontPx = ptToPx(fontSizePt);
  const family = "'Noto Sans TC','Source Han Sans TC','PingFang TC','Microsoft JhengHei','Heiti TC',sans-serif";
  ctx.font = `${weight} ${fontPx}px ${family}`;

  const maxPx = mmToPx(maxWidthMm);
  const words = text.split(/(\s+)/); // 保留空白作為分隔
  const lines = [];
  let line = '';

  const width = s => ctx.measureText(s).width;
  const pushLine = () => { lines.push(line.trim()); line = ''; };

  for (let i = 0; i < words.length; i++) {
    const token = words[i];
    const tentative = line + token;
    if (width(tentative) <= maxPx) {
      line = tentative;
      continue;
    }
    // token 本身太長，對其內部做字符級斷行
    if (!line) {
      let tmp = '';
      for (const ch of token) {
        if (width(tmp + ch) <= maxPx) tmp += ch; else { lines.push(tmp); tmp = ch; }
      }
      line = tmp;
      continue;
    }
    // 先收斂當前行，再處理 token
    pushLine();
    i--; // 重新評估此 token
  }

  if (line.trim()) pushLine();
  return lines.length ? lines : [text];
}

// 添加頁腳
function addFooter(doc) {
  const pageCount = doc.internal.getNumberOfPages();

  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(PDF_CONFIG.fontSize.small);
    doc.setTextColor(PDF_CONFIG.colors.text);

    const footerText = t('qaPdf.page', { current: i, total: pageCount });
    const footerX = doc.internal.pageSize.width / 2;
    const footerY = doc.internal.pageSize.height - 10;

    addTextWithCJKImageFallback(doc, footerText, footerX, footerY, {
      fontSizePt: PDF_CONFIG.fontSize.small,
      color: PDF_CONFIG.colors.text,
      align: 'center'
    });

    // 添加生成時間
    const generateTime = t('qaPdf.generatedAt', { time: formatDate(new Date()) });
    addTextWithCJKImageFallback(doc, generateTime, PDF_CONFIG.margin.right, footerY, {
      fontSizePt: PDF_CONFIG.fontSize.small,
      color: PDF_CONFIG.colors.text,
      align: 'right'
    });
  }
}

// 格式化日期
function formatDate(date) {
  return formatDateTime(date, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// 格式化時長
function formatDuration(duration) {
  const minutes = Math.floor(duration / 60000);
  const seconds = Math.floor((duration % 60000) / 1000);
  return t('qaPdf.durationShort', { minutes, seconds });
}

// 嘗試從多種來源註冊中文字型（思源黑體等）
// 支援：
// 1) options.font.base64 / options.font.fontBase64 / options.font.fileName / options.font.fontFamily；
// 2) window.fontBase64 與（可選）window.fontFamilyName / window.fontFileName；
// 3) window.SourceHanSansSC = { base64, name, fileName } 結構；
async function registerChineseFont(doc, opts = {}) {
  // 避免重複註冊
  if (doc.__cjkFontReady) return true;

  const options = opts || {};
  const fromWindow = typeof window !== 'undefined' ? window : {};

  // 顯式傳入的優先；否則按需抓取預設字型（子集 → 完整 → 思源 mini）
  const explicitBase64 = options.base64 || options.fontBase64;
  if (!explicitBase64) {
    await ensureChineseFontData();
  }

  // 來源優先序：顯式傳入 > Noto TC > 思源 TC > 思源 SC > 其他全域
  let fontBase64 = explicitBase64 || fromWindow.SourceHanSansTC?.base64 || fromWindow.SourceHanSans?.base64;
  let fontFamily = options.fontFamily || fromWindow.SourceHanSansTC?.name || fromWindow.SourceHanSans?.name || fromWindow.fontFamilyName;
  let fileName = options.fileName || fromWindow.SourceHanSansTC?.fileName || fromWindow.SourceHanSans?.fileName || fromWindow.fontFileName;
  // 若仍無，才回退到通用 window.fontBase64；但若其為 SC mini，改嘗試抓 Noto 再回退
  const isSCMini = (fromWindow.fontFamilyName || '').toLowerCase().includes('sourcehansanssc') || (fromWindow.fontFileName || '').toLowerCase().includes('sc-') || (fromWindow.fontFamilyName || '').toLowerCase().includes('min');
  if (!fontBase64 && !isSCMini && fromWindow.fontBase64) {
    fontBase64 = fromWindow.fontBase64;
    fontFamily = fontFamily || fromWindow.fontFamilyName || 'CJK-Fallback';
    fileName = fileName || fromWindow.fontFileName || `${fontFamily}.ttf`;
  }

  const finalBase64 = fontBase64 || fromWindow.fontBase64;
  if (!finalBase64 || typeof doc.addFileToVFS !== 'function' || typeof doc.addFont !== 'function') {
    console.warn('未提供中文字型 Base64 或 addFont API 不可用；跳過字型註冊。');
    return false;
  }

  try {
    doc.addFileToVFS(fileName, finalBase64);
    doc.addFont(fileName, fontFamily, 'normal');
    doc.setFont(fontFamily, 'normal');
    doc.__cjkFontReady = true;
    console.log(`已註冊中文字型: ${fontFamily}`);
    return true;
  } catch (err) {
    console.warn('註冊中文字型失敗：', err);
    return false;
  }
}

// ===== 方案B的通用工具：以 Canvas 轉圖像輸出含中文的行 =====

// 判斷文字是否包含 CJK（中日韓）或全形標點
function hasCJK(text) {
  return /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uFF00-\uFFEF]/.test(text);
}

// 點數轉像素（假設瀏覽器 96DPI；1pt = 1/72 inch）
function ptToPx(pt) {
  return Math.round(pt * (96 / 72));
}

// 像素轉毫米（96DPI；1in=25.4mm）
function pxToMm(px) {
  return px * 25.4 / 96;
}

// 估算文字寬度（毫米），供畫下劃線等用途
function getApproxTextWidthMm(text, fontSizePt) {
  const px = ptToPx(fontSizePt);
  // 寬度估算：字符數 * 0.6 倍字號（對於拉丁字準確；中文稍寬，我們加上係數 0.9）
  const approxPx = Math.max(1, Math.ceil(text.length * px * 0.6 * (hasCJK(text) ? 0.9 : 1)));
  return pxToMm(approxPx);
}

// 在 PDF 上輸出文字；若偵測到 CJK 即改以圖片輸出，避免 PDF 字型缺字
function addTextWithCJKImageFallback(doc, text, xMm, yMm, opts = {}) {
  const { fontSizePt = 12, color = '#000000', weight = '400', align = 'left' } = opts;

  // 若無 CJK 或已註冊中文字型，優先輸出向量文字
  const options = align ? { align } : undefined;
  if (!hasCJK(text) || doc.__cjkFontReady) {
    try { doc.text(text, xMm, yMm, options); return; } catch (_) { /* fallback to image */ }
  }

  // 以 Canvas 畫成位圖再嵌入
  const fontPx = ptToPx(fontSizePt);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  // 優先使用常見繁體字體家族
  const family = "'Noto Sans TC','Source Han Sans TC','PingFang TC','Microsoft JhengHei','Heiti TC',sans-serif";
  ctx.font = `${weight} ${fontPx}px ${family}`;
  const metrics = ctx.measureText(text);
  const ascent = Math.ceil(metrics.actualBoundingBoxAscent || fontPx * 0.8);
  const descent = Math.ceil(metrics.actualBoundingBoxDescent || fontPx * 0.2);
  const textWidth = Math.ceil(metrics.width) + 2;
  const textHeight = ascent + descent + 2;

  canvas.width = textWidth;
  canvas.height = textHeight;
  const ctx2 = canvas.getContext('2d');
  ctx2.font = `${weight} ${fontPx}px ${family}`;
  ctx2.textBaseline = 'top';
  ctx2.fillStyle = color;
  ctx2.fillText(text, 1, 1);

  const dataUrl = canvas.toDataURL('image/png');
  const wMm = pxToMm(textWidth);
  const hMm = pxToMm(textHeight);

  let x = xMm;
  if (align === 'center') x = xMm - wMm / 2;
  else if (align === 'right') x = xMm - wMm;

  // yMm 在此視為頂部對齊
  doc.addImage(dataUrl, 'PNG', x, yMm - 1, wMm, hMm);
}
