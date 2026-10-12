(() => {
  const dialog = document.getElementById('help-dialog');
  const title = document.getElementById('help-title');
  const body = document.getElementById('help-body');
  const content = {
    notation: ['牛津记音', ['本页音标采用牛津学习词典记音习惯；英美写法有差异时，随所选口音显示。', '点卡片按默认口音试听；点 UK / US 单独试听英音或美音，点例词小喇叭听整词。']],
    keyboard: ['快捷键', ['Tab：切换焦点；Enter / 空格：选中与播放。', 'R：重播；1 / 2：切换默认英音 / 美音。']],
    art: ['动作草图 · 图示说明', ['侧面图脸朝右；俯视图按上下方标记阅读。粉色是舌头，蓝色虚线箭头表示呼气出口方向，橙色标出接触或摩擦部位，紫色表示舌位滑动或动作阶段。', '鼻音 /m n ŋ/ 展示鼻咽通路；/l/ 的侧面图与俯视图是同一动作的不同视角。具体动作以当前音的标签为准。', '草图待语音专业审核，仅帮助理解大致动作，不按解剖比例，不对应当前录音者；鼻腔、喉部与三维结构未完整展示。']]
  };
  document.addEventListener('click', event => {
    const trigger = event.target.closest('[data-help]');
    if (!trigger || !content[trigger.dataset.help]) return;
    const [heading, paragraphs] = content[trigger.dataset.help];
    title.textContent = heading;
    body.replaceChildren(...paragraphs.map(text => {
      const paragraph = document.createElement('p');
      paragraph.textContent = text;
      return paragraph;
    }));
    dialog.showModal();
  });
  document.getElementById('help-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
})();
