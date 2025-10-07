// 簡易 Markdown 轉 HTML（支援：標題、粗體、斜體、行內程式碼、連結、表格）
// 使用場景：OCR 結果預覽、簡單報表
// 注意：為安全僅做最小語法替換，且對文中 <>& 做轉義；不支援 HTML 直入。

export function markdownToHtml(md) {
  const esc = (s) => String(s).replace(/[&<>]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));
  const lines = String(md || '').split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 表格：第二行為分隔線
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i+1])) {
      const rows = [line];
      i++;
      while (i < lines.length && lines[i].includes('|')) { rows.push(lines[i]); i++; }
      out.push(tableMarkdownToHtml(rows.join('\n')));
      continue;
    }
    const m = line.match(/^(#{1,6})\s+(.*)/);
    if (m) { out.push(`<h${m[1].length}>${inlineMd(m[2])}</h${m[1].length}>`); i++; continue; }
    if (!line.trim()) { out.push(''); i++; continue; }
    out.push(`<p>${inlineMd(line)}</p>`);
    i++;
  }
  return out.join('\n');

  function inlineMd(s) {
    return esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }
  function tableMarkdownToHtml(t) {
    const rows = t.trim().split(/\r?\n/).filter(Boolean);
    if (rows.length < 2) return `<pre>${esc(t)}</pre>`;
    const header = splitRow(rows[0]);
    const body = rows.slice(2).map(splitRow);
    const ths = header.map(h => `<th>${inlineMd(h)}</th>`).join('');
    const trs = body.map(cols => `<tr>${cols.map(c => `<td>${inlineMd(c)}</td>`).join('')}</tr>`).join('');
    return `<table class="md-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
  }
  function splitRow(r) { return r.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(s => s.trim()); }
}

