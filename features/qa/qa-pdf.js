// PDF導出功能
import { displayMessage } from '../../modules/ui.js';
import { loadQASet } from './qa-storage.js';

console.log('qa-pdf.js 模組載入');

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
    answerSpacing: 4
  },
  colors: {
    primary: '#2563eb',
    success: '#16a34a',
    warning: '#d97706',
    error: '#dc2626',
    text: '#374151',
    lightGray: '#f3f4f6'
  }
};

// 導出問答集為手寫默寫PDF
export async function exportQASetForHandwriting(qaSetId, options = {}) {
  try {
    console.log('開始生成手寫默寫PDF...');

    // 載入問答集數據
    const qaSet = await loadQASet(qaSetId);
    if (!qaSet) {
      throw new Error('問答集載入失敗');
    }

    // 檢查並載入jsPDF
    console.log('檢查jsPDF狀態:', typeof window.jsPDF);
    if (typeof window.jsPDF === 'undefined') {
      console.log('正在載入jsPDF...');
      await loadjsPDF();
    }

    // 檢查jsPDF是否正確載入
    console.log('載入後jsPDF狀態:', window.jsPDF);

    let doc;
    let jsPDFConstructor = null;

    // 檢查多種可能的構造函數
    if (window.jsPDF && window.jsPDF.jsPDF) {
      jsPDFConstructor = window.jsPDF.jsPDF;
      console.log('使用 window.jsPDF.jsPDF 構造函數');
    } else if (window.jsPDF && typeof window.jsPDF === 'function') {
      jsPDFConstructor = window.jsPDF;
      console.log('使用 window.jsPDF 作為構造函數');
    } else if (typeof window.jspdf !== 'undefined') {
      jsPDFConstructor = window.jspdf;
      console.log('使用 window.jspdf 構造函數');
    } else if (typeof jsPDF !== 'undefined') {
      jsPDFConstructor = jsPDF;
      console.log('使用全域 jsPDF 構造函數');
    }

    if (jsPDFConstructor) {
      try {
        doc = new jsPDFConstructor();
        console.log('PDF文檔創建成功');
      } catch (error) {
        console.error('PDF文檔創建失敗:', error);
        throw new Error('jsPDF構造函數調用失敗: ' + error.message);
      }
    } else {
      throw new Error('jsPDF載入失敗，請檢查網路連接或嘗試刷新頁面');
    }

    const {
      shuffleQuestions = false,
      includeAnswers = false,
      answerLines = 1,
      questionsPerPage = 8
    } = options;

    let questions = [...qaSet.questions];

    // 如果需要亂序
    if (shuffleQuestions) {
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

      // 估算當前問題需要的空間（更緊湊）
      const estimatedHeight = includeAnswers ? 15 : (answerLines * 8 + 15);

      // 檢查是否需要新頁面（更寬鬆的分頁條件）
      if (questionCount >= questionsPerPage || yPosition + estimatedHeight > pageHeight - 25) {
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
    const shuffleText = shuffleQuestions ? '_亂序' : '_順序';
    const answerText = includeAnswers ? '_含答案' : '_手寫版';
    const filename = `${qaSet.name}${shuffleText}${answerText}_${timestamp}.pdf`;

    // 保存PDF
    doc.save(filename);

    displayMessage('手寫默寫PDF已成功導出！', 'success');
    console.log(`手寫默寫PDF已保存: ${filename}`);

    return true;

  } catch (error) {
    console.error('手寫默寫PDF導出失敗:', error);
    displayMessage('手寫默寫PDF導出失敗: ' + error.message, 'error');
    return false;
  }
}

// 添加手寫默寫標題
function addHandwritingTitle(doc, qaSetName, yPosition) {
  doc.setFontSize(PDF_CONFIG.fontSize.title);
  doc.setTextColor(PDF_CONFIG.colors.primary);

  // 使用中文標題，並進行UTF-8編碼處理
  const title = `${qaSetName} - 手寫默寫練習`;

  try {
    // 嘗試直接輸出中文
    doc.text(title, PDF_CONFIG.margin.left, yPosition);
  } catch (error) {
    // 如果中文失敗，則使用英文
    console.warn('中文字體不支持，使用英文標題');
    const fallbackTitle = `${qaSetName} - Handwriting Practice`;
    doc.text(fallbackTitle, PDF_CONFIG.margin.left, yPosition);
  }

  // 添加下劃線
  const textWidth = doc.getTextWidth(title);
  doc.setLineWidth(0.5);
  doc.line(PDF_CONFIG.margin.left, yPosition + 2, PDF_CONFIG.margin.left + textWidth, yPosition + 2);

  return yPosition + PDF_CONFIG.spacing.titleBottom;
}

// 添加手寫默寫說明
function addHandwritingInstructions(doc, yPosition, includeAnswers) {
  doc.setFontSize(PDF_CONFIG.fontSize.small);
  doc.setTextColor(PDF_CONFIG.colors.text);

  const instructions = [
    `日期: _______________    姓名: _______________    成績: _______________`,
    '',
    includeAnswers ?
      '說明: 請根據問題寫出答案，答案已提供在題目下方供參考。' :
      '說明: 請在下劃線上寫出完整的英文答案，注意大小寫和標點符號。'
  ];

  instructions.forEach((instruction, index) => {
    if (instruction) {
      try {
        doc.text(instruction, PDF_CONFIG.margin.left, yPosition + (index * 4));
      } catch (error) {
        // 如果中文失敗，使用英文替代
        const englishInstructions = [
          `Date: _______________    Name: _______________    Score: _______________`,
          '',
          includeAnswers ?
            'Instructions: Write answers based on the questions. Answers are provided below for reference.' :
            'Instructions: Write complete English answers on the lines below. Pay attention to spelling and punctuation.'
        ];
        doc.text(englishInstructions[index], PDF_CONFIG.margin.left, yPosition + (index * 4));
      }
    }
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
  yPosition += questionLines.length * 5 + 1; // 減少問題後的間距

  if (includeAnswers) {
    // 顯示答案
    doc.setFontSize(PDF_CONFIG.fontSize.small);
    doc.setTextColor(PDF_CONFIG.colors.primary);
    try {
      doc.text(`答案: ${question.answer}`, PDF_CONFIG.margin.left + 10, yPosition);
    } catch (error) {
      doc.text(`Answer: ${question.answer}`, PDF_CONFIG.margin.left + 10, yPosition);
    }
    yPosition += 5;
  } else {
    // 添加答題線，確保對齊和間距
    const lineSpacing = answerLines === 2 ? 8 : 6; // 減少線間距
    const lineStartX = PDF_CONFIG.margin.left + 5;
    const lineEndX = PDF_CONFIG.margin.left + contentWidth - 5;

    for (let i = 0; i < answerLines; i++) {
      doc.setLineWidth(0.3);
      doc.setDrawColor(120, 120, 120);
      const lineY = yPosition + (i * lineSpacing);
      doc.line(lineStartX, lineY, lineEndX, lineY);
    }
    yPosition += answerLines * lineSpacing + 2; // 減少線後間距
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

    try {
      const footerText = `第 ${i} 頁，共 ${pageCount} 頁`;
      const footerX = doc.internal.pageSize.width / 2;
      const footerY = doc.internal.pageSize.height - 10;
      doc.text(footerText, footerX, footerY, { align: 'center' });
    } catch (error) {
      const footerText = `Page ${i} of ${pageCount}`;
      const footerX = doc.internal.pageSize.width / 2;
      const footerY = doc.internal.pageSize.height - 10;
      doc.text(footerText, footerX, footerY, { align: 'center' });
    }
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
export async function exportTrainingResultToPDF(trainingResult, aiCheckingResult = null) {
  try {
    console.log('開始生成PDF報告...');

    // 檢查並載入jsPDF
    console.log('檢查jsPDF狀態:', typeof window.jsPDF);
    if (typeof window.jsPDF === 'undefined') {
      console.log('正在載入jsPDF...');
      await loadjsPDF();
    }

    // 檢查jsPDF是否正確載入
    console.log('載入後jsPDF狀態:', window.jsPDF);

    let doc;
    let jsPDFConstructor = null;

    // 檢查多種可能的構造函數
    if (window.jsPDF && window.jsPDF.jsPDF) {
      jsPDFConstructor = window.jsPDF.jsPDF;
      console.log('使用 window.jsPDF.jsPDF 構造函數');
    } else if (window.jsPDF && typeof window.jsPDF === 'function') {
      jsPDFConstructor = window.jsPDF;
      console.log('使用 window.jsPDF 作為構造函數');
    } else if (typeof window.jspdf !== 'undefined') {
      jsPDFConstructor = window.jspdf;
      console.log('使用 window.jspdf 構造函數');
    } else if (typeof jsPDF !== 'undefined') {
      jsPDFConstructor = jsPDF;
      console.log('使用全域 jsPDF 構造函數');
    }

    if (jsPDFConstructor) {
      try {
        doc = new jsPDFConstructor();
        console.log('PDF文檔創建成功');
      } catch (error) {
        console.error('PDF文檔創建失敗:', error);
        throw new Error('jsPDF構造函數調用失敗: ' + error.message);
      }
    } else {
      throw new Error('jsPDF載入失敗，請檢查網路連接或嘗試刷新頁面');
    }

    let yPosition = PDF_CONFIG.margin.top;
    const pageHeight = doc.internal.pageSize.height;
    const contentWidth = doc.internal.pageSize.width - PDF_CONFIG.margin.left - PDF_CONFIG.margin.right;

    // 添加標題
    yPosition = addTitle(doc, '問答訓練結果報告', yPosition);
    yPosition += 10;

    // 添加基本信息
    yPosition = addBasicInfo(doc, trainingResult, yPosition);
    yPosition += 10;

    // 添加訓練總結
    yPosition = addTrainingSummary(doc, trainingResult, aiCheckingResult, yPosition);
    yPosition += 15;

    // 添加詳細答案分析
    yPosition = await addDetailedAnswers(doc, trainingResult, aiCheckingResult, yPosition, pageHeight, contentWidth);

    // 添加頁腳
    addFooter(doc);

    // 生成文件名
    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `問答訓練報告_${trainingResult.qaSetName}_${timestamp}.pdf`;

    // 保存PDF
    doc.save(filename);

    displayMessage('PDF報告已成功導出！', 'success');
    console.log(`PDF已保存: ${filename}`);

    return true;

  } catch (error) {
    console.error('PDF導出失敗:', error);
    displayMessage('PDF導出失敗: ' + error.message, 'error');
    return false;
  }
}

// 動態載入jsPDF庫
async function loadjsPDF() {
  return new Promise((resolve, reject) => {
    if (typeof window.jsPDF !== 'undefined') {
      console.log('jsPDF已存在:', window.jsPDF);
      resolve();
      return;
    }

    console.log('開始載入jsPDF庫...');
    const script = document.createElement('script');

    // 使用支持中文的jsPDF版本
    script.src = 'https://unpkg.com/jspdf@latest/dist/jspdf.umd.min.js';

    script.onload = () => {
      console.log('jsPDF載入完成');
      console.log('window對象檢查:', Object.keys(window).filter(key => key.toLowerCase().includes('jspdf')));
      console.log('window.jsPDF:', window.jsPDF);
      console.log('window.jspdf:', window.jspdf);
      console.log('jsPDF類型:', typeof window.jsPDF);

      // 檢查多種可能的全局變量名稱
      let jsPDFConstructor = null;
      if (window.jsPDF) {
        jsPDFConstructor = window.jsPDF;
        console.log('使用window.jsPDF');
      } else if (window.jspdf) {
        jsPDFConstructor = window.jspdf;
        console.log('使用window.jspdf');
      } else if (typeof jsPDF !== 'undefined') {
        jsPDFConstructor = jsPDF;
        console.log('使用全域jsPDF');
      }

      if (jsPDFConstructor) {
        // 確保全局變量設置正確
        window.jsPDF = jsPDFConstructor;
        console.log('jsPDF對象存在');
        console.log('jsPDF屬性:', Object.keys(jsPDFConstructor));

        if (jsPDFConstructor.jsPDF) {
          console.log('發現構造函數:', jsPDFConstructor.jsPDF);
        } else if (typeof jsPDFConstructor === 'function') {
          console.log('jsPDF本身就是構造函數');
        }

        // 嘗試設置中文支持
        try {
          // 檢查是否有中文字體支持插件
          console.log('檢查中文字體支持...');
        } catch (error) {
          console.warn('中文字體支持檢查失敗，將使用回退方案');
        }
      } else {
        console.error('未找到jsPDF構造函數');
        reject(new Error('jsPDF載入失敗：未找到構造函數'));
        return;
      }

      resolve();
    };

    script.onerror = (error) => {
      console.error('jsPDF載入失敗:', error);
      reject(new Error('無法載入jsPDF庫'));
    };

    document.head.appendChild(script);
  });
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
    `問答集名稱: ${trainingResult.qaSetName}`,
    `訓練時間: ${formatDate(trainingResult.startTime)} - ${formatDate(trainingResult.endTime)}`,
    `訓練時長: ${formatDuration(trainingResult.duration)}`,
    `訓練模式: ${trainingResult.mode === 'random' ? '隨機模式' : '順序模式'}`,
    `題目總數: ${trainingResult.totalQuestions}`,
    `已回答: ${trainingResult.answeredQuestions}`
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
  doc.text('訓練總結', PDF_CONFIG.margin.left, yPosition);
  yPosition += 12;

  doc.setFontSize(PDF_CONFIG.fontSize.normal);
  doc.setTextColor(PDF_CONFIG.colors.text);

  if (aiCheckingResult && aiCheckingResult.summary) {
    const summary = aiCheckingResult.summary;
    doc.text(`AI評估準確率: ${summary.accuracy}%`, PDF_CONFIG.margin.left, yPosition);
    yPosition += 8;
    doc.text(`平均得分: ${summary.averageScore}/100`, PDF_CONFIG.margin.left, yPosition);
    yPosition += 8;

    if (summary.correctCount !== undefined) {
      doc.text(`完全正確: ${summary.correctCount}題`, PDF_CONFIG.margin.left, yPosition);
      yPosition += 8;
    }
  } else {
    const completionRate = Math.round((trainingResult.answeredQuestions / trainingResult.totalQuestions) * 100);
    doc.text(`完成率: ${completionRate}%`, PDF_CONFIG.margin.left, yPosition);
    yPosition += 8;
  }

  return yPosition;
}

// 添加詳細答案分析
async function addDetailedAnswers(doc, trainingResult, aiCheckingResult, yPosition, pageHeight, contentWidth) {
  doc.setFontSize(PDF_CONFIG.fontSize.subtitle);
  doc.setTextColor(PDF_CONFIG.colors.primary);
  doc.text('詳細答案分析', PDF_CONFIG.margin.left, yPosition);
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
    doc.text(`第 ${i + 1} 題`, PDF_CONFIG.margin.left, yPosition);
    yPosition += 10;

    // 問題內容
    doc.setTextColor(PDF_CONFIG.colors.text);
    yPosition = addWrappedText(doc, `問題: ${answer.question}`, PDF_CONFIG.margin.left, yPosition, contentWidth);
    yPosition += 5;

    // 標準答案
    yPosition = addWrappedText(doc, `標準答案: ${answer.correctAnswer}`, PDF_CONFIG.margin.left, yPosition, contentWidth);
    yPosition += 5;

    // 用戶答案
    const userAnswerText = answer.userAnswer || '(未回答)';
    yPosition = addWrappedText(doc, `您的答案: ${userAnswerText}`, PDF_CONFIG.margin.left, yPosition, contentWidth);
    yPosition += 5;

    // AI評分（如果有）
    if (aiResult) {
      doc.setTextColor(getScoreColor(aiResult.score));
      doc.text(`AI評分: ${aiResult.score}/100`, PDF_CONFIG.margin.left, yPosition);
      yPosition += 8;

      if (aiResult.feedback) {
        doc.setTextColor(PDF_CONFIG.colors.text);
        yPosition = addWrappedText(doc, `AI點評: ${aiResult.feedback}`, PDF_CONFIG.margin.left, yPosition, contentWidth);
        yPosition += 5;
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

// 添加頁腳
function addFooter(doc) {
  const pageCount = doc.internal.getNumberOfPages();

  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(PDF_CONFIG.fontSize.small);
    doc.setTextColor(PDF_CONFIG.colors.text);

    const footerText = `第 ${i} 頁，共 ${pageCount} 頁`;
    const footerX = doc.internal.pageSize.width / 2;
    const footerY = doc.internal.pageSize.height - 10;

    doc.text(footerText, footerX, footerY, { align: 'center' });

    // 添加生成時間
    const generateTime = `生成時間: ${formatDate(new Date())}`;
    doc.text(generateTime, PDF_CONFIG.margin.right, footerY, { align: 'right' });
  }
}

// 格式化日期
function formatDate(date) {
  return new Date(date).toLocaleString('zh-TW', {
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
  return `${minutes}分${seconds}秒`;
}