import * as state from '../../modules/state.js';
import * as dom from '../../modules/dom.js';
import * as storage from '../../modules/storage.js';
import * as ui from '../../modules/ui.js';
import * as api from '../../modules/api.js';
import * as audio from '../../modules/audio.js';

// =================================
// Vocabulary Feature
// =================================

/**
 * 初始化单词本功能，绑定所有相关的事件监听器。
 */
export function initVocabulary() {
    dom.addVocabBookBtn.addEventListener('click', () => openModalForNewBook());
    dom.vocabBookList.addEventListener('click', handleVocabBookSelection);
    dom.editVocabBookBtn.addEventListener('click', () => openModalForEditBook());
    dom.deleteVocabBookBtn.addEventListener('click', deleteActiveVocabBook);
    dom.importVocabBookBtn.addEventListener('click', openModalForImportBook);
    dom.exportVocabBookBtn.addEventListener('click', exportActiveVocabBook);
    dom.mergeVocabBooksBtn.addEventListener('click', openModalForMergeBooks);

    // 單詞列表高亮
    dom.wordList.addEventListener('mouseover', (e) => {
        const wordId = e.target.dataset.wordId;
        if (wordId) {
            const elements = dom.wordList.querySelectorAll(`[data-word-id="${wordId}"]`);
            elements.forEach(el => el.classList.add('highlight'));
        }
    });

    dom.wordList.addEventListener('mouseout', (e) => {
        const wordId = e.target.dataset.wordId;
        if (wordId) {
            const elements = dom.wordList.querySelectorAll(`[data-word-id="${wordId}"]`);
            elements.forEach(el => el.classList.remove('highlight'));
        }
    });

    // 初次加載時渲染視圖
    renderVocabBookList();
    updateActiveBookView();
}

function renderVocabBookList() {
    dom.vocabBookList.innerHTML = '';
    if (state.vocabularyBooks.length === 0) {
        dom.vocabBookList.innerHTML = '<li class="word-item-placeholder">還沒有單詞本</li>';
        return;
    }
    state.vocabularyBooks.forEach(book => {
        const li = document.createElement('li');
        li.className = 'vocab-book-item';
        li.dataset.bookId = book.id;
        if (book.id === state.activeBookId) {
            li.classList.add('active');
        }
        li.innerHTML = `<span>${book.name}</span> <span class="word-count">${book.words.length}</span>`;
        dom.vocabBookList.appendChild(li);
    });
}

function handleVocabBookSelection(e) {
    const target = e.target.closest('.vocab-book-item');
    if (target) {
        const bookId = target.dataset.bookId;
        if (state.activeBookId !== bookId) {
            state.setActiveBookId(bookId);
            storage.saveAppState();
            renderVocabBookList();
            updateActiveBookView();
        }
    }
}

function updateActiveBookView() {
    const activeBook = state.vocabularyBooks.find(b => b.id === state.activeBookId);
    if (activeBook) {
        dom.currentBookName.textContent = activeBook.name;
        dom.editVocabBookBtn.disabled = false;
        dom.deleteVocabBookBtn.disabled = false;
        dom.exportVocabBookBtn.disabled = false;
        renderWordList();
    } else {
        dom.currentBookName.textContent = '請選擇一個單詞本';
        dom.editVocabBookBtn.disabled = true;
        dom.deleteVocabBookBtn.disabled = true;
        dom.exportVocabBookBtn.disabled = true;
        dom.wordList.innerHTML = '<li class="word-item-placeholder">請從左側選擇或創建一個單詞本</li>';
    }
}

function openModalForNewBook() {
    dom.modalTitle.textContent = '新增單詞本';
    dom.modalBody.innerHTML = `
        <div class="input-group">
            <label for="modal-book-name">單詞本名稱</label>
            <input type="text" id="modal-book-name" placeholder="例如：雅思核心詞彙">
        </div>
        <div class="input-group">
            <label for="modal-vocab-content">批量新增單詞 (每行一個)</label>
            <textarea id="modal-vocab-content" placeholder="可只輸入英文單詞，如:\napple\nbanana\ncherry\n系統將自動補全音標和釋義。"></textarea>
            <div id="modal-ai-progress" class="import-progress"></div>
        </div>
        <div class="modal-actions">
            <button class="cancel-btn">取消</button>
            <button class="save-btn">創建</button>
        </div>
    `;
    dom.appModal.querySelector('.save-btn').onclick = () => saveBookWithAICompletion();
    dom.appModal.querySelector('.cancel-btn').onclick = ui.closeModal;
    ui.openModal();
}

function openModalForEditBook() {
    const book = state.vocabularyBooks.find(b => b.id === state.activeBookId);
    if (!book) return;

    dom.modalTitle.textContent = '編輯單詞本 - ' + book.name;
    const wordsText = book.words.map(w => {
        const phonetic = (w.phonetic || '').replace(/^\/+|\/+$/g, '');
        return `${w.word}#${w.meaning || ''}@/${phonetic}/`;
    }).join('\n');
    dom.modalBody.innerHTML = `
        <div class="input-group">
            <label for="modal-book-name">單詞本名稱</label>
            <input type="text" id="modal-book-name" value="${book.name}">
        </div>
        <div class="input-group">
            <label for="modal-vocab-content">單詞內容 (格式: 單詞#中文@音標)</label>
            <textarea id="modal-vocab-content">${wordsText}</textarea>
            <small class="form-hint">對於只有單詞的行，系統將嘗試自動補全音標和釋義。</small>
            <div id="modal-ai-progress" class="import-progress"></div>
        </div>
        <div class="modal-actions">
            <button class="cancel-btn">取消</button>
            <button class="save-btn">保存更改</button>
        </div>
    `;
    dom.appModal.querySelector('.save-btn').onclick = () => saveBookWithAICompletion(book.id);
    dom.appModal.querySelector('.cancel-btn').onclick = ui.closeModal;
    ui.openModal();
}

async function openModalForImportBook() {
    dom.modalTitle.textContent = '導入單詞本';
    dom.modalBody.innerHTML = `<p>正在加載預設單詞本...</p>`;
    ui.openModal();

    try {
        const defaultBooks = await fetchDefaultWordlists();
        if (defaultBooks.length === 0) {
            dom.modalBody.innerHTML = `<p>沒有找到可用的預設單詞本。</p>`;
            return;
        }

        const checkboxesHtml = defaultBooks.map(book => {
             const safeId = `import-checkbox-${book.path.replace(/[^a-zA-Z0-9]/g, '')}`;
             return `
                <div class="import-preset-item-wrapper">
                    <input type="checkbox" id="${safeId}" value="${book.path}" data-name="${book.name}" class="import-checkbox">
                    <label for="${safeId}" class="import-preset-item">${book.name}</label>
                </div>
            `;
        }).join('');
        const presetItemsHtml = `<div class="import-preset-list">${checkboxesHtml}</div>`;

        dom.modalBody.innerHTML = `
            <div class="import-container">
                <div class="import-section">
                    <h4 class="import-section-title">從預設列表選擇</h4>
                    <div id="modal-import-list">
                        ${presetItemsHtml}
                    </div>
                </div>
                <div class="import-section">
                    <h4 class="import-section-title">從URL導入</h4>
                    <div class="input-group">
                         <label for="modal-import-url">單詞本URL</label>
                         <input type="url" id="modal-import-url" placeholder="https://example.com/words.json">
                    </div>
                </div>
                <div class="import-section">
                    <h4 class="import-section-title">從文件導入</h4>
                    <div class="input-group">
                        <label for="modal-import-file">選擇JSON文件</label>
                        <input type="file" id="modal-import-file" accept=".json">
                    </div>
                </div>
            </div>
            <div id="modal-import-progress" class="import-progress"></div>
            <div class="modal-actions">
                <button class="cancel-btn">取消</button>
                <button class="save-btn">導入選中</button>
            </div>
        `;
        dom.appModal.querySelector('.save-btn').onclick = () => importSharedVocabBooks();
        dom.appModal.querySelector('.cancel-btn').onclick = ui.closeModal;

    } catch (error) {
        console.error('加載預設單詞本失敗:', error);
        dom.modalBody.innerHTML = `<p style="color: red;">加載失敗，請稍後再試。</p>`;
    }
}

async function fetchDefaultWordlists() {
    try {
        const response = await fetch('wordlists/manifest.json');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return await response.json();
    } catch (error) {
        console.error("獲取預設單詞本列表時出錯:", error);
        return [];
    }
}

async function importSharedVocabBooks() {
    const selectedCheckboxes = document.querySelectorAll('.import-checkbox:checked');
    const urlInput = document.getElementById('modal-import-url');
    const fileInput = document.getElementById('modal-import-file');
    const progressContainer = document.getElementById('modal-import-progress');

    const urlPath = urlInput.value.trim();
    const file = fileInput.files[0];

    let sources = Array.from(selectedCheckboxes).map(cb => ({ type: 'preset', value: cb.value, name: cb.dataset.name }));

    if (urlPath) {
        try {
            const url = new URL(urlPath);
            sources.push({ type: 'url', value: urlPath, name: url.pathname.split('/').pop() || 'URL單詞本' });
        } catch (_) {
            alert(`"${urlPath}" 不是一個有效的URL。`);
            return;
        }
    }

    if (file) {
        sources.push({ type: 'file', value: file, name: file.name });
    }

    if (sources.length === 0) {
        alert('請至少選擇一個預設單詞本、提供一個URL或選擇一個文件。');
        return;
    }

    const saveBtn = dom.appModal.querySelector('.save-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = '正在導入...';
    progressContainer.innerHTML = '';

    let successCount = 0;
    let finalMessage = '導入完成！\n\n';

    for (const source of sources) {
        try {
            progressContainer.innerHTML = `<p>正在處理: ${source.name}...</p>`;
            let bookData;

            if (source.type === 'preset' || source.type === 'url') {
                const response = await fetch(source.value);
                if (!response.ok) throw new Error(`無法加載: ${source.name}`);
                bookData = await response.json();
            } else {
                bookData = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => {
                        try { resolve(JSON.parse(reader.result)); } catch (e) { reject(new Error('文件格式無效')); }
                    };
                    reader.onerror = () => reject(new Error('讀取文件失敗'));
                    reader.readAsText(source.value);
                });
            }

            if (!bookData.name || !Array.isArray(bookData.words)) {
                throw new Error(`數據源 ${source.name} 格式不正確。`);
            }

            const existingBookIndex = state.vocabularyBooks.findIndex(b => b.name === bookData.name);
            if (existingBookIndex > -1) {
                if (!confirm(`單詞本 "${bookData.name}" 已存在。要覆蓋它嗎？`)) {
                    finalMessage += `已跳過: ${bookData.name}\n`;
                    continue;
                }
            }

            const wordsWithDetails = [];
            for (let i = 0; i < bookData.words.length; i++) {
                const line = bookData.words[i];
                progressContainer.innerHTML = `<p>正在解析: ${line} (${i + 1}/${bookData.words.length})</p>`;
                
                const parsedWord = parseWordsFromText(line)[0];
                if (!parsedWord) continue;

                if (!parsedWord.meaning || !parsedWord.phonetic) {
                    const analysis = await api.getWordAnalysis(parsedWord.word);
                    parsedWord.phonetic = parsedWord.phonetic || (analysis.phonetic || 'n/a').replace(/^\/|\/$/g, '');
                    parsedWord.meaning = parsedWord.meaning || analysis.meaning || '';
                }
                wordsWithDetails.push(parsedWord);
            }

            const newBook = { id: Date.now().toString(), name: bookData.name, words: wordsWithDetails };
            
            if (existingBookIndex > -1) {
                state.vocabularyBooks[existingBookIndex] = { ...state.vocabularyBooks[existingBookIndex], ...newBook };
                 finalMessage += `已覆蓋: ${bookData.name}\n`;
            } else {
                state.vocabularyBooks.push(newBook);
                 finalMessage += `已導入: ${bookData.name}\n`;
            }
            state.setActiveBookId(newBook.id);
            successCount++;

        } catch (error) {
            console.error(`導入 ${source.name} 失敗:`, error);
            finalMessage += `導入失敗: ${source.name} (${error.message})\n`;
        }
    }
    
    if (successCount > 0) {
        storage.saveVocabularyBooks();
        renderVocabBookList();
        updateActiveBookView();
    }
    
    alert(finalMessage);
    ui.closeModal();
}

async function saveBookWithAICompletion(bookId = null) {
    const bookNameInput = document.getElementById('modal-book-name');
    const name = bookNameInput.value.trim();
    if (!name) {
        alert('單詞本名稱不能為空！');
        return;
    }

    const saveBtn = dom.appModal.querySelector('.save-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = '處理中...';

    let book;
    if (bookId) {
        book = state.vocabularyBooks.find(b => b.id === bookId);
        if (book) book.name = name;
    } else {
        book = {
            id: Date.now().toString(),
            name: name,
            words: []
        };
    }

    const wordsText = document.getElementById('modal-vocab-content').value.trim();
    await processWordsWithAI(book, wordsText);
    
    if (!bookId) {
        state.vocabularyBooks.push(book);
        state.setActiveBookId(book.id);
    }

    storage.saveVocabularyBooks();
    renderVocabBookList();
    updateActiveBookView();
    ui.closeModal();
}

async function processWordsWithAI(book, wordsText) {
    const progressContainer = document.getElementById('modal-ai-progress');
    const preliminaryWords = parseWordsFromText(wordsText);
    const finalWords = [];

    for (let i = 0; i < preliminaryWords.length; i++) {
        let wordObject = preliminaryWords[i];
        
        if (!wordObject.meaning.trim() || !wordObject.phonetic.trim()) {
            if(progressContainer) progressContainer.innerHTML = `<p>正在分析: ${wordObject.word} (${i + 1}/${preliminaryWords.length})</p>`;
            try {
                const analysis = await api.getWordAnalysis(wordObject.word);
                wordObject.phonetic = wordObject.phonetic || (analysis.phonetic || 'n/a').replace(/^\/|\/$/g, '');
                wordObject.meaning = wordObject.meaning || analysis.meaning || '分析失敗';
            } catch (e) {
                console.error(`Error analyzing word "${wordObject.word}":`, e);
                wordObject.meaning = wordObject.meaning || '分析失敗';
                wordObject.phonetic = wordObject.phonetic || 'n/a';
            }
        }
        finalWords.push(wordObject);
    }
    
    book.words = finalWords;
    if(progressContainer) progressContainer.innerHTML = `<p style="color: green;">處理完成！</p>`;
}

function deleteActiveVocabBook() {
    const book = state.vocabularyBooks.find(b => b.id === state.activeBookId);
    if (book && confirm(`確定要永久刪除單詞本 "${book.name}" 嗎？此操作無法撤銷。`)) {
        const bookIndex = state.vocabularyBooks.findIndex(b => b.id === state.activeBookId);
        if (bookIndex > -1) {
            state.vocabularyBooks.splice(bookIndex, 1);
        }
        state.setActiveBookId(state.vocabularyBooks.length > 0 ? state.vocabularyBooks[0].id : null);
        storage.saveVocabularyBooks();
        storage.saveAppState();
        renderVocabBookList();
        updateActiveBookView();
    }
}

function parseWordsFromText(text) {
    const lines = text.split('\n');
    return lines.map((line, index) => {
        if (!line.trim()) return null;
        let word = '', meaning = '', phonetic = '';
        const atIndex = line.indexOf('@');
        const hashIndex = line.indexOf('#');

        if (atIndex !== -1 && hashIndex !== -1) {
            if (hashIndex < atIndex) {
                word = line.substring(0, hashIndex).trim();
                meaning = line.substring(hashIndex + 1, atIndex).trim();
                phonetic = line.substring(atIndex + 1).trim();
            } else {
                word = line.substring(0, atIndex).trim();
                phonetic = line.substring(atIndex + 1, hashIndex).trim();
                meaning = line.substring(hashIndex + 1).trim();
            }
        } else if (hashIndex !== -1) {
            word = line.substring(0, hashIndex).trim();
            meaning = line.substring(hashIndex + 1).trim();
        } else if (atIndex !== -1) {
            word = line.substring(0, atIndex).trim();
            phonetic = line.substring(atIndex + 1).trim();
        } else {
            word = line.trim();
        }

        if (!word) return null;

        return {
            id: `${Date.now()}-${index}-${Math.random()}`,
            word,
            meaning,
            phonetic: phonetic.replace(/^\/|\/$/g, ''),
            examples: [],
        };
    }).filter(w => w !== null);
}

function exportActiveVocabBook() {
    const activeBook = state.vocabularyBooks.find(b => b.id === state.activeBookId);
    if (!activeBook) {
        alert('沒有激活的單詞本可以導出。');
        return;
    }

    const bookData = {
        name: activeBook.name,
        words: activeBook.words.map(w => {
            if (w.meaning && w.phonetic) {
                return `${w.word}#${w.meaning}@${w.phonetic}`;
            } else if (w.meaning) {
                return `${w.word}#${w.meaning}`;
            } else if (w.phonetic) {
                return `${w.word}@${w.phonetic}`;
            }
            return w.word;
        })
    };

    const content = JSON.stringify(bookData, null, 2);
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeBook.name.replace(/[\\/:\*\?"<>\|]/g, '_')}.json`;
    document.body.appendChild(a);
    a.click();
    
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    alert(`單詞本 "${activeBook.name}" 已導出。`);
}

function openModalForMergeBooks() {
    if (state.vocabularyBooks.length < 2) {
        alert('至少需要兩個單詞本才能進行合併。');
        return;
    }

    dom.modalTitle.textContent = '合併單詞本';
    dom.modalBody.innerHTML = `
        <div class="merge-layout">
            <div class="merge-selection-panel">
                <h4>選擇要合併的單詞本 (至少2個)</h4>
                <div id="merge-book-list" class="import-preset-list">
                    ${state.vocabularyBooks.map(book => `
                        <div class="import-preset-item-wrapper" data-book-id="${book.id}">
                            <div class="import-preset-item">${book.name} (${book.words.length}個單詞)</div>
                        </div>
                    `).join('')}
                </div>
            </div>
            <div class="merge-preview-panel">
                <h4>合併預覽</h4>
                <div class="input-group">
                    <label for="modal-merge-book-name">新單詞本名稱</label>
                    <input type="text" id="modal-merge-book-name" placeholder="例如：我的合輯">
                </div>
                <div id="merge-preview-details">
                    <p><strong>已選單詞本:</strong> <span id="merge-selected-count">0</span></p>
                    <ul id="merge-selected-list"></ul>
                    <p><strong>去重後總詞數:</strong> <span id="merge-total-words">0</span></p>
                </div>
                <small class="form-hint">重複的單詞將會被自動去除。</small>
            </div>
        </div>
        <div class="modal-actions">
            <button class="cancel-btn">取消</button>
            <button id="confirm-merge-btn" class="save-btn" disabled>合併</button>
        </div>
    `;

    const mergeBookList = dom.modalBody.querySelector('#merge-book-list');
    const newBookNameInput = dom.modalBody.querySelector('#modal-merge-book-name');
    
    mergeBookList.addEventListener('click', (e) => {
        const item = e.target.closest('.import-preset-item-wrapper');
        if (item) {
            item.classList.toggle('selected');
            updateMergePreview();
        }
    });

    newBookNameInput.addEventListener('input', () => updateMergePreview());

    dom.modalBody.querySelector('#confirm-merge-btn').onclick = () => mergeSelectedBooks();
    dom.modalBody.querySelector('.cancel-btn').onclick = ui.closeModal;
    
    ui.openModal();
    updateMergePreview();
}

function updateMergePreview() {
    const selectedItems = document.querySelectorAll('.import-preset-item-wrapper.selected');
    const newBookName = document.getElementById('modal-merge-book-name').value.trim();
    const selectedCountSpan = document.getElementById('merge-selected-count');
    const selectedListUl = document.getElementById('merge-selected-list');
    const totalWordsSpan = document.getElementById('merge-total-words');
    const confirmBtn = document.getElementById('confirm-merge-btn');

    selectedListUl.innerHTML = '';
    const mergedWords = new Set();
    let selectedBooks = [];

    selectedItems.forEach(item => {
        const bookId = item.dataset.bookId;
        const book = state.vocabularyBooks.find(b => b.id === bookId);
        if (book) {
            selectedBooks.push(book.name);
            book.words.forEach(word => mergedWords.add(word.word.toLowerCase()));
        }
    });

    selectedCountSpan.textContent = selectedItems.length;
    selectedListUl.innerHTML = selectedBooks.map(name => `<li>${name}</li>`).join('');
    totalWordsSpan.textContent = mergedWords.size;

    confirmBtn.disabled = !(selectedItems.length >= 2 && newBookName);
}

function mergeSelectedBooks() {
    const selectedItems = document.querySelectorAll('.import-preset-item-wrapper.selected');
    const newBookName = document.getElementById('modal-merge-book-name').value.trim();

    if (selectedItems.length < 2 || !newBookName) {
        return;
    }
    if (state.vocabularyBooks.some(b => b.name === newBookName)) {
        alert(`已存在名為 "${newBookName}" 的單詞本，請使用其他名稱。`);
        return;
    }

    const mergedWords = [];
    const seenWords = new Set();
    
    selectedItems.forEach(item => {
        const bookId = item.dataset.bookId;
        const book = state.vocabularyBooks.find(b => b.id === bookId);
        if (book) {
            book.words.forEach(word => {
                const wordIdentifier = word.word.toLowerCase();
                if (!seenWords.has(wordIdentifier)) {
                    mergedWords.push(word);
                    seenWords.add(wordIdentifier);
                }
            });
        }
    });

    const newBook = {
        id: Date.now().toString(),
        name: newBookName,
        words: mergedWords
    };

    state.vocabularyBooks.push(newBook);
    state.setActiveBookId(newBook.id);

    storage.saveVocabularyBooks();
    storage.saveAppState();
    renderVocabBookList();
    updateActiveBookView();
    ui.closeModal();
    alert(`成功合併 ${selectedItems.length} 個單詞本為 "${newBookName}"！`);
}

function renderWordList() {
    dom.wordList.innerHTML = '';
    const activeBook = state.vocabularyBooks.find(b => b.id === state.activeBookId);

    if (!activeBook || activeBook.words.length === 0) {
        dom.wordList.innerHTML = '<li class="word-item-placeholder">這個單詞本是空的，點擊右上角鉛筆按鈕添加單詞。</li>';
        return;
    }

    activeBook.words.forEach(word => {
        const li = document.createElement('li');
        li.className = 'word-item';
        li.innerHTML = `
            <div class="word-text">
                <strong data-word-id="${word.id}">${word.word}</strong>
                <span class="phonetic">/${word.phonetic}/</span>
                ${word.meaning ? `<span class="meaning" data-word-id="${word.id}">${word.meaning}</span>` : ''}
            </div>
            <div class="word-actions">
                <button class="play-btn" title="播放"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-play-circle" viewBox="0 0 16 16"><path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/><path d="M6.271 5.055a.5.5 0 0 1 .52.038l3.5 2.5a.5.5 0 0 1 0 .814l-3.5 2.5A.5.5 0 0 1 6 10.5v-5a.5.5 0 0 1 .271-.445z"/></svg></button>
            </div>
        `;

        const playBtn = li.querySelector('.play-btn');
        playBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            playWordAndMeaning(word);
        });
        
        dom.wordList.appendChild(li);
    });
}

function playWordAndMeaning(word) {
    audio.stopCurrentAudio();

    const wordElement = dom.wordList.querySelector(`strong[data-word-id="${word.id}"]`);
    const meaningElement = dom.wordList.querySelector(`span.meaning[data-word-id="${word.id}"]`);

    dom.wordList.querySelectorAll('.highlight').forEach(el => el.classList.remove('highlight'));

    audio.speakText(word.word, 'en-US', 0,
        () => {
            if (wordElement) wordElement.classList.add('highlight');
        },
        () => {
            if (wordElement) wordElement.classList.remove('highlight');
            
            if (word.meaning) {
                setTimeout(() => {
                    audio.speakText(word.meaning, 'zh-TW', 0,
                        () => {
                            if (meaningElement) meaningElement.classList.add('highlight');
                        },
                        () => {
                            if (meaningElement) meaningElement.classList.remove('highlight');
                        }
                    );
                }, 500);
            }
        }
    );
}