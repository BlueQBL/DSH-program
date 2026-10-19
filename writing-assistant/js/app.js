/*!
 * 三易 · 智能写作台 —— 界面装配（app.js）
 *
 * 只做三件事：把状态画到屏幕上、把用户动作变成状态变化、把动作结果告诉用户。
 * 所有文字都用 DOM 节点写入（不用 innerHTML 拼用户内容），避免稿子里的尖括号搞坏界面。
 */
(function () {
  'use strict';

  const Modes = window.WriterModes;
  const Core = window.WriterCore;
  const Polisher = window.WriterPolisher;
  const ApiMod = window.WriterApi;
  const AuthMod = window.WriterAuth;
  const AuthRules = window.WriterAuthRules;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /** 建节点的小工具：props 里 class/text/on* 有特殊含义 */
  function h(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach((key) => {
        const value = props[key];
        if (value == null || value === false) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
        else if (value === true) node.setAttribute(key, '');
        else node.setAttribute(key, String(value));
      });
    }
    (Array.isArray(children) ? children : children == null ? [] : [children]).forEach((child) => {
      if (child == null || child === false) return;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    });
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function debounce(fn, ms) {
    let timer = null;
    return function debounced() {
      const args = arguments;
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(null, args), ms);
    };
  }

  /* ── 全局状态 ───────────────────────────────────────────── */
  let api = null;
  let state = Core.createState();
  let workspaces = new Map();   // 每个板块一份工作区：换板块时互不串台
  let runCtrl = null;
  let polish = null;          // {source, label, before, edits, accepted:Set, stats, engine, note}
  const compareState = { open: false, a: 'input', b: '' };
  const view = {
    drawerOpen: false,
    historyMode: 'all',
    historyQ: '',
    starredOnly: false,
    records: [],
    modes: [],
    total: 0,
    localElsewhere: 0,  // 登录之后：没登录时写的那一桶还剩几篇（抽屉里会提一句）
    openedId: '',
    model: '',          // 页面上选的模型；空表示用服务端探测出来的默认
    models: [],
  };

  const dom = {};

  /* ── 提示条 ─────────────────────────────────────────────── */
  /**
   * 星标是什么，一句话说清：它不是置顶，而是「留档清理时不会被删掉」的标记，
   * 顺带可以用「只看星标」筛出来、导出时也只导这几篇。
   * 留档默认按时间倒序（最近写的在最前），刻意不做置顶——星标一多，时间序就废了。
   */
  const STAR_HINT = '不会被自动清理，可用「只看星标」筛出来';

  function toast(message, options) {
    const opt = options || {};
    const node = h('div', { class: 'toast', dataset: { level: opt.level || 'info' } }, [
      h('span', { text: message }),
      opt.action
        ? h('button', {
            class: 'toast__act',
            type: 'button',
            text: opt.action.label,
            onclick: () => {
              opt.action.run();
              node.remove();
            },
          })
        : null,
    ]);
    dom.toasts.append(node);
    setTimeout(() => {
      node.style.opacity = '0';
      setTimeout(() => node.remove(), 220);
    }, opt.ms || 4200);
  }

  function notice(text, level) {
    dom.notice.textContent = text || '';
    if (level) dom.notice.dataset.level = level;
    else delete dom.notice.dataset.level;
  }

  /* ── 画：模式 ───────────────────────────────────────────── */
  function renderModes() {
    clear(dom.modes);
    Modes.listGroups().forEach((group, gi) => {
      // 分组之间一道细线：十个板块不分组的会糊成一片
      if (gi > 0) dom.modes.append(h('span', { class: 'modes__sep', 'aria-hidden': 'true' }));
      group.modes.forEach((mode) => {
        dom.modes.append(
          h(
            'button',
            {
              type: 'button',
              class: 'mode',
              'aria-current': String(mode.id === state.mode),
              title: `${group.name} · ${mode.name}：${mode.tagline}`,
              onclick: () => switchToMode(mode.id),
            },
            [
              h('span', { class: 'mode__mark', text: mode.mark }),
              h('span', { text: mode.name }),
            ]
          )
        );
      });
    });
    revealCurrentMode();
  }

  /**
   * 把当前板块挪进可视范围。
   *
   * 为什么需要：导航是重建的，清空子节点时容器的横向滚动位置会被重置到最左边，
   * 于是点右边的板块之后，最左边高亮的还是「文章续写」——看起来就像没切换成功。
   * 窄屏退回横向滚动时这一条尤其要紧。
   */
  function revealCurrentMode() {
    const active = Array.from(dom.modes.children).find(
      (node) => node.classList && node.classList.contains('mode') && node.getAttribute('aria-current') === 'true'
    );
    if (!active || typeof active.scrollIntoView !== 'function') return;
    try {
      active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch {
      /* 老浏览器不认参数就算了，不影响功能 */
    }
  }

  /**
   * 换板块：每个板块有自己的工作区（原稿、成稿、朱批），互不串台。
   * 切回用过的板块会把它自己那份装回来，而不是清空——来回对照着改稿是常态，
   * 每次清空会白丢一次工作；首次进入某个板块时它本来就是空的。
   *
   * @param {string} modeId 目标板块
   * @param {string} [preset] 顺手放进去的素材（「接着写」「翻译这一稿」这类动作用）
   */
  function switchToMode(modeId, preset) {
    if (state.busy) return;
    // 已经在目标板块里：只把素材放进去（例如在翻译板块里对某一稿再点一次「翻译」）
    if (modeId === state.mode) {
      if (typeof preset === 'string') {
        state = Object.assign({}, state, { material: preset });
        renderAll();
        persistUI();
        notice('已把内容放进原稿，可以直接起稿。', 'info');
      }
      return;
    }
    // 界面上的朱批视图也是这个板块的「活」：先放回 state 再存档，
    // 否则切走一趟回来，稿子和原稿都在、朱批却没了（留档里那份还在，但视图丢了）
    state = Object.assign({}, state, { polish });
    const moved = Core.switchWorkspace(state, modeId, workspaces);
    state = moved.state;
    workspaces = moved.workspaces;
    if (typeof preset === 'string') state = Object.assign({}, state, { material: preset });
    polish = state.polish || null;
    renderAll();
    persistUI();
    if (typeof preset === 'string') notice(`已把内容放进「${Modes.getMode(state.mode).name}」的原稿，按起稿开始。`, 'info');
    else if (moved.restored && Core.hasWork(state)) {
      notice(`${Modes.getMode(state.mode).name} · 你上次在这里的稿子还在。想从头写就点「清空」。`, 'info');
    } else notice('');
    if (!preset) dom.material.focus();
  }

  /** 清空当前板块的工作区：原稿、成稿、朱批一起清，参数不动 */
  function clearWorkspace() {
    if (state.busy) return;
    if (!Core.hasWork(state) && !polish) {
      notice('这个板块本来就是空的。');
      return;
    }
    if (!window.confirm('清空当前板块的原稿与成稿？留档里的不受影响。')) return;
    state = Core.clearWork(state);
    workspaces.delete(state.mode);
    polish = null;
    renderAll();
    persistUI();
    notice('已清空，可以从头写。');
    dom.material.focus();
  }

  /* ── 自定义模板 ─────────────────────────────────────────── */
  /**
   * 模板库。
   *
   * 用户写的是「提示词」，但界面上要把它当成一个板块用：所以拿到列表后交给
   * Modes.setCustomTemplates() 注册成板块，之后起稿、多稿、朱批、留档、
   * 工作区隔离这些逻辑一行都不用改——它们只认「板块」。
   */
  const templates = { list: [], editing: '', open: false };

  async function loadTemplates() {
    try {
      const out = await api.templates.list();
      templates.list = out.templates || [];
    } catch (err) {
      templates.list = [];
      if (!templates.open) toast('模板库读不到：' + ((err && err.message) || ''), { level: 'error' });
    }
    Modes.setCustomTemplates(templates.list);
    dom.templateCount.textContent = String(templates.list.length);
    // 模板被删掉时，当前板块可能已经不存在了，退回续写
    if (!Modes.MODES.some((m) => m.id === state.mode)) {
      state = Core.switchWorkspace(state, 'continue', workspaces).state;
    }
    renderTemplates();
    renderModes();
    return templates.list;
  }

  function templateModeOf() {
    return Modes.customModeOf(state.mode);
  }

  /** 起稿时随请求带上的模板规格（服务端用它替代默认提示词） */
  function templatePayload() {
    const mode = templateModeOf();
    if (!mode) return null;
    return {
      id: mode.templateId,
      name: mode.name,
      system: mode.system,
      outputHint: mode.outputHint,
    };
  }

  function openTemplates() {
    templates.open = true;
    closeDrawer();
    dom.tplDrawer.hidden = false;
    dom.tplDrawer.removeAttribute('inert');
    dom.tplDrawer.setAttribute('aria-hidden', 'false');
    dom.scrim.hidden = false;
    loadTemplates().then(() => dom.tplName.focus());
  }

  function closeTemplates() {
    templates.open = false;
    dom.tplDrawer.hidden = true;
    dom.tplDrawer.setAttribute('inert', '');
    dom.tplDrawer.setAttribute('aria-hidden', 'true');
    if (!view.drawerOpen) dom.scrim.hidden = true;
  }

  function renderTemplates() {
    clear(dom.tplList);
    dom.tplCount.textContent = `${templates.list.length} 个`;
    if (!templates.list.length) {
      dom.tplList.append(
        h('p', {
          class: 'drawer__empty',
          text: '还没有自定义模板。在上面写一段提示词，比如「你是资深产品经理，只输出周报正文……」，保存后它会出现在顶部导航的「我的模板」里。',
        })
      );
      return;
    }
    templates.list.forEach((tpl) => {
      dom.tplList.append(
        h('article', { class: 'tpl' }, [
          h('span', { class: 'tpl__mark', text: tpl.mark }),
          h('div', { class: 'tpl__main' }, [
            h('span', { class: 'tpl__name', text: tpl.name }),
            h('p', { class: 'tpl__excerpt', text: tpl.system }),
            h('div', { class: 'tpl__meta' }, [
              h('span', { text: `${tpl.system.length} 字提示词` }),
              tpl.outputHint ? h('span', { text: '有输出要求' }) : null,
              h('span', { text: Core.formatTime(tpl.updatedAt) }),
            ]),
          ]),
          h('div', { class: 'tpl__act' }, [
            h('button', {
              type: 'button',
              class: 'btn btn--small btn--line',
              text: '用它写',
              onclick: () => useTemplate(tpl),
            }),
            h('button', {
              type: 'button',
              class: 'btn btn--small btn--line',
              text: '编辑',
              onclick: () => fillTemplateForm(tpl),
            }),
            h('button', {
              type: 'button',
              class: 'btn btn--small btn--line',
              text: '删除',
              onclick: () => removeTemplate(tpl),
            }),
          ]),
        ])
      );
    });
  }

  function fillTemplateForm(tpl) {
    templates.editing = tpl ? tpl.id : '';
    dom.tplFormTitle.textContent = tpl ? `编辑：${tpl.name}` : '新建模板';
    dom.tplName.value = tpl ? tpl.name : '';
    dom.tplMark.value = tpl ? tpl.mark : '';
    dom.tplTagline.value = tpl ? tpl.tagline : '';
    dom.tplSystem.value = tpl ? tpl.system : '';
    dom.tplOutput.value = tpl ? tpl.outputHint : '';
    dom.tplInputLabel.value = tpl ? tpl.inputLabel : '';
    dom.tplExample.value = tpl ? tpl.example : '';
    dom.tplFormNote.textContent = '';
    dom.tplCancel.hidden = !tpl;
    dom.tplName.focus();
  }

  async function saveTemplate(event) {
    if (event) event.preventDefault();
    const draft = {
      id: templates.editing || undefined,
      name: dom.tplName.value.trim(),
      mark: dom.tplMark.value.trim(),
      tagline: dom.tplTagline.value.trim(),
      system: dom.tplSystem.value.trim(),
      outputHint: dom.tplOutput.value.trim(),
      inputLabel: dom.tplInputLabel.value.trim(),
      example: dom.tplExample.value.trim(),
    };
    try {
      const saved = templates.editing
        ? await api.templates.update(templates.editing, draft)
        : await api.templates.create(draft);
      templates.editing = '';
      fillTemplateForm(null);
      await loadTemplates();
      toast(`已保存模板「${saved.name}」`);
      // 存完就带他去写：模板库是手段，写作台才是目的
      useTemplate(saved);
    } catch (err) {
      dom.tplFormNote.textContent = (err && err.message) || '保存失败';
    }
  }

  async function removeTemplate(tpl) {
    if (!window.confirm(`删除模板「${tpl.name}」？已经写过的稿子不受影响，但那个板块会消失。`)) return;
    try {
      await api.templates.remove(tpl.id);
      await loadTemplates();
      toast('已删除模板');
    } catch (err) {
      toast('删除失败：' + ((err && err.message) || ''), { level: 'error' });
    }
  }

  /** 切到某个模板板块并开始写 */
  function useTemplate(tpl) {
    const modeId = Modes.templateModeId(tpl.id);
    closeTemplates();
    if (modeId === state.mode) {
      dom.material.focus();
      return;
    }
    switchToMode(modeId);
    notice(`模板「${tpl.name}」：粘素材，按起稿。左侧参数（创意度、篇幅、一次几稿）照样能调。`, 'info');
  }

  /** 「给个例子」：省得对着空表单发呆 */
  function seedTemplateForm() {
    fillTemplateForm(null);
    dom.tplName.value = '产品周报';
    dom.tplMark.value = '周';
    dom.tplTagline.value = '每周给组里同步进展';
    dom.tplSystem.value =
      '你是资深产品经理，替团队写周报。只输出周报正文，分三块：本周进展、遇到的问题、下周计划。' +
      '每块用短句列举，不要写客套话，不要编造数据——数据只能来自我给的素材，缺的地方写「（待补）」。';
    dom.tplOutput.value = '每块不超过五条；遇到的问题要给出当前的处理办法';
    dom.tplInputLabel.value = '本周做了什么';
    dom.tplExample.value = '进展：上线了新版搜索，修了 3 个线上问题。\n风险：灰度期间接口偶发超时，还没定位到根因。';
    dom.tplFormNote.textContent = '这是例子，改成你自己的就行。';
  }

  /* ── 对比两稿 ───────────────────────────────────────────── */
  /** 可对比的对象：原稿、每一稿、润色稿 */
  function compareOptions() {
    const list = [{ value: 'input', label: '原稿' }];
    state.versions.forEach((v) => {
      if (v.text) list.push({ value: 'v' + v.index, label: `${Core.versionLabel(v.index)} · ${v.angleLabel || '常规'}` });
    });
    if (polish && polish.after) list.push({ value: 'polish', label: '润色稿' });
    return list;
  }

  function compareTextOf(ref) {
    if (ref === 'input') return state.material || '';
    if (ref === 'polish') return (polish && polish.after) || '';
    const index = Number(String(ref).replace('v', ''));
    const hit = state.versions.find((v) => v.index === index);
    return hit ? hit.text : '';
  }

  function openCompare() {
    const options = compareOptions();
    if (options.length < 2) {
      notice('至少要有两样东西（原稿、成稿或润色稿）才能对比。', 'warn');
      return;
    }
    compareState.open = true;
    // 默认：拿第一稿和最后一稿对比；只有一稿时拿原稿和它比
    const texts = options.map((o) => o.value);
    if (compareState.a === compareState.b) compareState.b = '';
    if (!texts.includes(compareState.a)) compareState.a = texts[0];
    if (!texts.includes(compareState.b)) compareState.b = texts[texts.length - 1] === compareState.a ? texts[0] : texts[texts.length - 1];
    renderCompare();
    dom.compare.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function renderCompare() {
    if (!compareState.open) {
      dom.compare.hidden = true;
      return;
    }
    const options = compareOptions();
    dom.compare.hidden = false;

    const fill = (select, current) => {
      clear(select);
      options.forEach((o) => select.append(h('option', { value: o.value, text: o.label, selected: o.value === current })));
      select.value = current;
    };
    fill(dom.compareA, compareState.a);
    fill(dom.compareB, compareState.b);

    const a = compareTextOf(compareState.a);
    const b = compareTextOf(compareState.b);
    const result = Polisher.compare(a, b);

    const labelOf = (value) => (options.find((o) => o.value === value) || { label: value }).label;
    dom.compareSummary.textContent = result.identical
      ? `${labelOf(compareState.a)} 与 ${labelOf(compareState.b)} 完全一样。`
      : `${result.edits.length} 处不同　·　相似度 ${(result.similarity * 100).toFixed(0)}%　·　` +
        `新增 ${result.addedChars} 字，删改 ${result.removedChars} 字（右稿相对左稿）`;

    // 正文：以左稿为底，右稿新增的用朱字标出，左稿被删的划掉——与朱批同一套标记
    const body = clear(dom.compareText);
    const edits = result.edits;
    const spans = Polisher.renderSpans(a, edits);
    spans.forEach((span) => {
      if (span.kind === 'same') {
        body.append(document.createTextNode(span.text));
        return;
      }
      const no = edits.findIndex((e) => e.id === span.editId);
      body.append(h('span', { class: span.kind === 'del' ? 'mark-del' : 'mark-ins', text: span.text }));
      if (span.editId && edits[no]) body.append(h('sup', { class: 'mark-no', text: String(no + 1) }));
    });
    if (!a && !b) body.append(document.createTextNode('两边都还没有内容。'));

    const changes = clear(dom.compareChanges);
    if (!edits.length) {
      changes.append(h('li', { class: 'annotation' }, [h('span', { class: 'annotation__reason', text: '两稿一模一样，没有差异。' })]));
    }
    edits.forEach((edit, i) => {
      changes.append(
        h('li', { class: 'annotation' }, [
          h('span', { class: 'annotation__no', text: String(i + 1) }),
          h('span', { class: 'annotation__type', text: (Polisher.TYPES[edit.type] || Polisher.TYPES.wording).label }),
          h('span', { class: 'annotation__change' }, [
            edit.before ? h('span', { class: 'annotation__from', text: clipForShow(edit.before) }) : null,
            h('span', { class: 'annotation__arrow', text: '→' }),
            h('span', { text: edit.after ? clipForShow(edit.after) : '（删去）' }),
          ]),
        ])
      );
    });
  }

  function clipForShow(text) {
    const s = String(text || '');
    return s.length > 60 ? s.slice(0, 60) + '…' : s;
  }

  /* ── 画：参数栏 ─────────────────────────────────────────── */
  function currentStop() {
    return Modes.creativityStop(state.params.creativity);
  }

  function renderPanel() {
    const mode = Modes.getMode(state.mode);

    /* 创意度 */
    const ticks = h(
      'div',
      { class: 'slider__ticks' },
      Modes.CREATIVITY.map((stop) =>
        h('button', {
          type: 'button',
          class: 'slider__tick',
          text: stop.label,
          title: stop.hint,
          'aria-current': String(currentStop().value === stop.value),
          onclick: () => update((s) => Core.setParam(s, { creativity: stop.value })),
        })
      )
    );

    const range = h('input', {
      type: 'range',
      min: String(Modes.CREATIVITY_MIN),
      max: String(Modes.CREATIVITY_MAX),
      step: '0.1',
      value: String(state.params.creativity),
      'aria-label': '创意度',
      oninput: (e) => update((s) => Core.setParam(s, { creativity: Number(e.target.value) })),
    });

    clear(dom.ctlCreativity).append(
      h('div', { class: 'panel__label' }, [
        h('span', { text: '创意度' }),
        h('span', { class: 'panel__value', text: Number(state.params.creativity).toFixed(1) }),
      ]),
      h('div', { class: 'slider' }, [range, ticks]),
      h('p', { class: 'panel__stop', text: `${currentStop().label} · ${currentStop().hint}` })
    );

    /* 篇幅 */
    const lengthChips = h(
      'div',
      { class: 'chips' },
      Modes.LENGTHS.map((preset) =>
        h('button', {
          type: 'button',
          class: 'chip',
          text: preset.label,
          title: preset.note,
          'aria-pressed': String(state.params.length === preset.id),
          onclick: () => update((s) => Core.setParam(s, { length: preset.id })),
        })
      )
    );

    const lengthBlock = [h('div', { class: 'panel__label' }, [h('span', { text: '输出长度' }), h('span', { class: 'panel__value', text: `约 ${Core.resolvedParams(state).chars} 字` })]), lengthChips];

    if (state.params.length === 'custom') {
      lengthBlock.push(
        h('div', { class: 'field-row', style: 'margin-top:10px' }, [
          h('input', {
            class: 'input',
            type: 'number',
            min: String(Modes.LIMITS.customCharsMin),
            max: String(Modes.LIMITS.customCharsMax),
            step: '50',
            value: String(state.params.customChars),
            'aria-label': '自定义字数',
            onchange: (e) => update((s) => Core.setParam(s, { customChars: Number(e.target.value) })),
          }),
          h('span', { class: 'field-row__unit', text: '字' }),
        ]),
        h(
          'div',
          { class: 'quick' },
          [200, 400, 600, 900, 1200].map((n) =>
            h('button', {
              type: 'button',
              class: 'quick__btn',
              text: String(n),
              onclick: () => update((s) => Core.setParam(s, { customChars: n })),
            })
          )
        )
      );
    }
    clear(dom.ctlLength).append(...lengthBlock);

    /* 版本数：最多到该模式的角度数 */
    const maxVersions = Modes.angleCount(state.mode);
    clear(dom.ctlVersions).append(
      h('div', { class: 'panel__label' }, [
        h('span', { text: '一次几稿' }),
        h('span', { class: 'panel__value', text: `${maxVersions} 个角度可选` }),
      ]),
      h(
        'div',
        { class: 'chips' },
        [1, 2, 3, 4].map((n) =>
          h('button', {
            type: 'button',
            class: 'chip chip--mark',
            text: Core.versionLabel(n - 1).replace('第', '').replace('稿', ''),
            title: n > maxVersions ? `${mode.name}只有 ${maxVersions} 个角度` : `生成 ${n} 份`,
            disabled: n > maxVersions,
            'aria-pressed': String(state.params.versions === n),
            onclick: () => update((s) => Core.setParam(s, { versions: n })),
          })
        )
      )
    );

    /* 语气 */
    clear(dom.ctlTone).append(
      h('div', { class: 'panel__label' }, [h('span', { text: '语气' })]),
      h(
        'div',
        { class: 'chips' },
        mode.tones.map((tone) =>
          h('button', {
            type: 'button',
            class: 'chip',
            text: tone.label,
            title: tone.brief,
            'aria-pressed': String(state.params.tone === tone.value),
            onclick: () => update((s) => Core.setParam(s, { tone: tone.value })),
          })
        )
      )
    );

    /* 模式专属字段 */
    const blocks = mode.fields.map((field) => {
      if (field.type === 'select') {
        return h('div', { class: 'field' }, [
          h('div', { class: 'panel__label' }, [h('span', { text: field.label })]),
          h(
            'div',
            { class: 'chips' },
            field.options.map((opt) =>
              h('button', {
                type: 'button',
                class: 'chip',
                text: opt.label,
                title: opt.brief,
                'aria-pressed': String(state.fields[field.id] === opt.value),
                onclick: () => update((s) => Core.setField(s, field.id, opt.value)),
              })
            )
          ),
        ]);
      }
      return h('div', { class: 'field' }, [
        h('label', { class: 'panel__label', for: 'field-' + field.id }, [h('span', { text: field.label })]),
        h('input', {
          class: 'input',
          id: 'field-' + field.id,
          type: 'text',
          maxlength: String(field.max || 200),
          placeholder: field.placeholder || '',
          value: state.fields[field.id] || '',
          oninput: (e) => update((s) => Core.setField(s, field.id, e.target.value), { light: true }),
        }),
      ]);
    });
    clear(dom.ctlFields).append(
      h('div', { class: 'panel__label' }, [h('span', { text: mode.name + '·专属' })]),
      ...(blocks.length ? blocks : [h('p', { class: 'field__note', text: '这种模式没有额外设置。' })])
    );

    dom.panelEngine.textContent = api && api.info && api.info.engine
      ? api.info.engine.note || ''
      : '';
  }

  /* ── 画：原稿与按钮 ─────────────────────────────────────── */
  function renderCompose() {
    const mode = Modes.getMode(state.mode);
    // 稿签上写出板块名：光看「原稿」两个字分不出自己在哪个板块，
    // 导航一旦被滚动/换行遮住，就会以为「怎么还是文章续写」
    if (dom.sheetTab) dom.sheetTab.textContent = `${mode.name} · 原稿`;
    dom.materialLabel.textContent = mode.input.label;
    dom.material.placeholder = mode.input.placeholder;
    dom.materialHint.textContent = mode.input.hint || '';
    if (dom.material.value !== state.material) dom.material.value = state.material;
    dom.materialCount.textContent = Core.formatChars(Core.charCount(state.material));
    autoGrow();

    const params = Core.resolvedParams(state);
    dom.paramSummary.textContent = `${mode.name} · ${Modes.describeParams(params).split(' · ').slice(1).join(' · ')} · ${params.versions} 稿`;

    const ready = Core.canGenerate(state);
    dom.generate.disabled = !state.busy && !ready;
    dom.generate.classList.toggle('btn--stop', state.busy);
    dom.generateInk.textContent = state.busy ? '停笔' : '起稿';
    dom.polishInput.disabled = state.busy || !String(state.material).trim();
    dom.generateKbd.textContent = state.busy ? '正在成稿' : 'Ctrl + Enter';
    // 成稿过程中不让换模型：换了会让这一批的几稿来自不同模型
    dom.modelSelect.disabled = state.busy || !view.models.length;

    renderExamples();
  }

  function autoGrow() {
    dom.material.style.height = 'auto';
    dom.material.style.height = Math.max(dom.material.scrollHeight, 168) + 'px';
  }

  function renderExamples() {
    const host = dom.draftsExamples;
    if (!host) return;
    clear(host);

    const custom = Modes.customModeOf(state.mode);
    // 作者没写示例时，示例是从提示词里推出来的「结构骨架」，要标出来——
    // 免得用户以为那是一段可以直接用的真实材料
    const derived = Boolean(custom) && !(custom.examples || []).length;

    const list = [];
    [0, 1].forEach((i) => {
      const text = Core.exampleOf(state.mode, i);
      if (text && list.indexOf(text) < 0) list.push(text);
    });

    if (!list.length) {
      host.append(
        h('p', {
          class: 'drafts__hint',
          text: custom ? '这个模板没写示例：把你的材料粘进原稿就行。' : '这个板块没准备示例：直接写你的材料。',
        })
      );
      return;
    }

    list.forEach((text) => {
      host.append(
        h('button', {
          type: 'button',
          class: 'example',
          text: derived ? '示例结构：' + text : text,
          title: derived ? '按你的提示词推出来的结构，点一下填进原稿、再改成自己的内容' : '点一下填进原稿',
          onclick: () => {
            state = Object.assign({}, state, { material: text });
            renderCompose();
            persistUI();
            dom.material.focus();
          },
        })
      );
    });
  }

  function renderEmptyState() {
    const empty = state.versions.length === 0;
    dom.draftsEmpty.hidden = !empty;
    dom.drafts.classList.toggle('drafts--empty', empty);
  }

  /* ── 画：成稿 ───────────────────────────────────────────── */
  function draftActions(version) {
    const acts = [
      { id: 'adopt', label: state.adopted === version.index ? '已采用' : '采用' },
      { id: 'polish', label: '一键优化' },
      { id: 'translate', label: '翻译', title: '把这一稿放进「多语言翻译」板块' },
      { id: 'extend', label: '接着写' },
      { id: 'copy', label: '复制' },
    ];
    return h(
      'div',
      { class: 'draft__tools' },
      acts.map((act) =>
        h('button', {
          type: 'button',
          class: 'draft__btn',
          dataset: { act: act.id },
          text: act.label,
          title: act.title || act.label,
          disabled: !version.text,
          onclick: () => onDraftAction(act.id, version),
        })
      )
    );
  }

  function renderDrafts() {
    clear(dom.drafts);
    dom.drafts.append(dom.draftsBar, dom.draftsEmpty);
    renderEmptyState();
    if (state.versions.length) dom.drafts.classList.remove('drafts--empty');

    // 一稿占满、两稿各一半、三稿三分之一、四稿四分之一 —— 列数跟着稿数走。
    // 写进 data-count 让 CSS 决定栏宽：稿少时稿纸更宽，正文不用挤在一列里断行。
    dom.drafts.dataset.count = String(state.versions.length);

    // 顶部工具行：有稿子就能对比；只有一稿时也能和原稿比
    const compareCount = compareOptions().length;
    dom.draftsBar.hidden = state.versions.length === 0;
    if (!dom.draftsBar.hidden) {
      const done = state.versions.filter((v) => v.text).length;
      dom.draftsBarLabel.textContent = `已出 ${done} 稿${state.adopted >= 0 ? ` · 采用${Core.versionLabel(state.adopted)}` : ''} · 可对比的对象 ${compareCount} 个`;
      dom.openCompare.disabled = compareCount < 2;
    }
    if (compareState.open) renderCompare();

    state.versions.forEach((version) => {
      const adopted = state.adopted === version.index;
      const tabText = `${Core.versionLabel(version.index)}${version.angleLabel ? ' · ' + version.angleLabel : ''}`;
      const card = h('div', { class: 'draft' + (adopted ? ' draft--adopted' : '') + (version.failed ? ' draft--failed' : '') }, [
        h('div', { class: 'sheet' }, [
          h('div', { class: 'sheet__tab', text: tabText }),
          h('div', { class: 'draft__body' }, [
            h('p', { class: 'draft__text', text: version.failed ? version.note : version.text }),
          ]),
          h('div', { class: 'draft__foot' }, [
            h('span', {
              class: 'draft__meta',
              text: version.failed
                ? '未成稿'
                : `${Core.formatChars(Core.charCount(version.text))}${version.engine ? ' · ' + engineLabel(version.engine) : ''}${meta.modelSuffix(version)}`,
            }),
            version.failed ? h('span', { class: 'draft__meta', text: '可重按一次起稿' }) : draftActions(version),
          ]),
        ]),
      ]);
      dom.drafts.append(card);
    });
  }

  function engineLabel(engine) {
    if (engine === 'live') return '模型';
    if (engine === 'live-partial') return '模型（部分）';
    return '离线';
  }

  /** 真实模型成稿时把模型名写在稿片上：以后翻留档也能看出是哪次生成的 */
  const meta = {
    modelSuffix(version) {
      const live = version.engine === 'live' || version.engine === 'live-partial';
      return live && state.engineModel ? ' · ' + state.engineModel : '';
    },
  };

  /* ── 画：朱批 ───────────────────────────────────────────── */
  function acceptedText() {
    if (!polish) return '';
    return Polisher.applyEdits(polish.before, polish.edits, polish.accepted);
  }

  function renderPolish() {
    if (!polish) {
      dom.polish.hidden = true;
      return;
    }
    dom.polish.hidden = false;
    dom.polishTarget.textContent = polish.label;

    const total = polish.edits.length;
    const taken = polish.accepted.size;
    dom.polishSummary.textContent = total
      ? `${total} 处朱批，已采纳 ${taken} 处　·　${polish.stats.list.map((s) => `${s.label} ${s.count}`).join('，')}${polish.note ? '　·　' + polish.note : ''}`
      : '这一段没挑出毛病，一个字没动。';

    /* 正文：把每条朱批按「采纳与否」画成当前的样子 */
    const body = clear(dom.polishText);
    const edits = polish.edits.slice().sort((a, b) => a.start - b.start);
    let cursor = 0;
    edits.forEach((edit, i) => {
      if (edit.start > cursor) body.append(document.createTextNode(polish.before.slice(cursor, edit.start)));
      const accepted = polish.accepted.has(edit.id);
      const no = h('sup', { class: 'mark-no', text: String(i + 1) });
      if (accepted) {
        if (edit.after) {
          body.append(h('span', { class: 'mark-ins', text: edit.after }), no);
        } else {
          body.append(h('span', { class: 'mark-del', text: edit.before }), no);
        }
      } else if (edit.before) {
        body.append(h('span', { class: 'mark-prop', text: edit.before }), no);
      } else {
        body.append(h('span', { class: 'mark-prop mark-prop--insert', title: '建议在此处插入' }), no);
      }
      cursor = Math.max(cursor, edit.end);
    });
    if (cursor < polish.before.length) body.append(document.createTextNode(polish.before.slice(cursor)));

    /* 批注清单 */
    const list = clear(dom.polishNotes);
    if (!total) {
      list.append(h('li', { class: 'annotation' }, [h('span', { class: 'annotation__reason', text: '没有需要改的地方。原稿已经挺干净了。' })]));
    }
    edits.forEach((edit, i) => {
      const accepted = polish.accepted.has(edit.id);
      list.append(
        h('li', { class: 'annotation', dataset: { accepted: String(accepted) } }, [
          h('span', { class: 'annotation__no', text: String(i + 1) }),
          h('span', { class: 'annotation__type', text: (Polisher.TYPES[edit.type] || Polisher.TYPES.wording).label }),
          h('span', { class: 'annotation__change' }, [
            edit.before ? h('span', { class: 'annotation__from', text: edit.before }) : null,
            h('span', { class: 'annotation__arrow', text: '→' }),
            h('span', { text: edit.after || '（删去）' }),
          ]),
          edit.reason ? h('span', { class: 'annotation__reason', text: edit.reason }) : null,
          h('span', { class: 'annotation__act' }, [
            h('button', {
              type: 'button',
              class: 'annotation__btn',
              dataset: { act: 'accept', edit: edit.id },
              text: accepted ? '已采纳' : '采纳',
            }),
            h('button', {
              type: 'button',
              class: 'annotation__btn',
              dataset: { act: 'revert', edit: edit.id },
              text: '还原',
            }),
          ]),
        ])
      );
    });
  }

  function toggleEdit(id, on) {
    if (!polish) return;
    if (on) polish.accepted.add(id);
    else polish.accepted.delete(id);
    renderPolish();
    syncPolishToRecord();
  }

  /** 朱批条目上的「采纳 / 还原」：按钮是每次重画的，所以用事件委托，不逐个挂闭包 */
  function onAnnotationClick(event) {
    const btn = event.target.closest('button[data-act]');
    if (!btn || !polish) return;
    const act = btn.dataset.act;
    const id = btn.dataset.edit;
    if (act === 'accept') toggleEdit(id, !polish.accepted.has(id));
    else if (act === 'revert') toggleEdit(id, false);
  }

  /** 采纳情况同步进留档：刷新后回来还是当时的样子 */
  const syncPolishToRecord = debounce(() => {
    if (!polish || !state.savedId) return;
    api.history
      .update(state.savedId, {
        polished: {
          source: polish.source,
          before: polish.before,
          after: acceptedText(),
          edits: polish.edits,
          accepted: Array.from(polish.accepted),
        },
      })
      .catch(() => {});
  }, 400);

  /* ── 状态更新 ───────────────────────────────────────────── */
  /** light=true 表示只更新输入框这类高频控件，不整块重画（避免光标跳走） */
  function update(mutator, options) {
    const before = state;
    state = mutator(state);
    if (state === before) return;
    if (options && options.light) {
      renderCompose();
      renderPanelValues();
      persistUI();
      return;
    }
    renderAll();
    persistUI();
  }

  /** 只改数值显示，不重建控件（拖动滑杆时用） */
  function renderPanelValues() {
    const value = $('.panel__value', dom.ctlCreativity);
    if (value) value.textContent = Number(state.params.creativity).toFixed(1);
    const stop = $('.panel__stop', dom.ctlCreativity);
    if (stop) stop.textContent = `${currentStop().label} · ${currentStop().hint}`;
    $$('.slider__tick', dom.ctlCreativity).forEach((btn) => {
      btn.setAttribute('aria-current', String(btn.textContent === currentStop().label));
    });
    const slider = $('input[type="range"]', dom.ctlCreativity);
    if (slider && Number(slider.value) !== Number(state.params.creativity)) slider.value = String(state.params.creativity);
  }

  function renderAll() {
    renderModes();
    renderCompose();
    renderPanel();
    renderDrafts();
    renderPolish();
  }

  function persistUI() {
    Core.saveUI(window.localStorage, {
      mode: state.mode,
      params: state.params,
      fields: state.fields,
      material: state.material,
      model: view.model,
    });
  }

  /* ── 起稿 ───────────────────────────────────────────────── */
  async function generate() {
    if (state.busy) {
      if (runCtrl) runCtrl.abort();
      return;
    }
    const text = String(state.material).trim();
    if (!text) {
      notice('先写点什么，或者点下面任意一条示例。', 'warn');
      dom.material.focus();
      return;
    }

    const params = Object.assign({ mode: state.mode, fields: state.fields }, state.params);
    notice('正在起稿……');
    runCtrl = new AbortController();
    state = Core.beginRun(state, []);
    state.busy = true;
    renderCompose();
    renderDrafts();

    const started = Date.now();
    try {
      await api.generate(
        params,
        { input: text },
        {          onMeta(meta) {
            state = Core.beginRun(state, meta.versions);
            state.engineModel = meta.model || '';
            if (meta.engineNote) api.info.engine.note = meta.engineNote;
            api.info.engine.live = meta.engine === 'live';
            api.info.engine.model = meta.model;
            renderEngine();
            renderDrafts();
            if (meta.modelNote) notice(meta.modelNote, 'warn');
            else notice(`正在起稿：${meta.versions.length} 个角度并行推进……`);
          },
          onDelta(index, piece) {
            state = Core.appendDelta(state, index, piece);
            patchDraft(index);
            renderCompose();
          },
          onVersionNote(payload) {
            notice(payload.message, 'warn');
          },
          onDone(done) {
            done.versions.forEach((v) => {
              state = Core.finishVersion(state, v.index, v);
            });
            state = Core.endRun(state, { engine: done.engine });
            const failed = (done.failed || []).length;
            notice(
              failed
                ? `成稿 ${done.versions.length} 份，${failed} 份没生成出来。`
                : `成稿 ${done.versions.length} 份，用时 ${(done.elapsedMs / 1000).toFixed(1)} 秒。`,
              failed ? 'warn' : ''
            );
          },
        },
        runCtrl.signal,
        view.model,
        templatePayload()
      );

      state = Core.endRun(state, {});
      renderAll();
      await saveRecord();
    } catch (err) {
      state = Object.assign({}, state, { busy: false });
      renderAll();
      if (err && err.name === 'AbortError') {
        notice('已停笔。已经写出来的部分留在稿纸上了。');
      } else {
        const message = (err && err.message) || '起稿失败';
        notice(message, 'warn');
        toast(message, { level: 'error' });
      }
    } finally {
      runCtrl = null;
      if (Date.now() - started > 0) renderCompose();
    }
  }

  /** 流式过程中只更新那一张稿片的正文，不整块重画（不然滚动位置和焦点都会跳） */
  function patchDraft(index) {
    const cards = $$('.draft', dom.drafts);
    const version = state.versions.find((v) => v.index === index);
    if (!version) return;
    const card = cards[state.versions.indexOf(version)];
    if (!card) return renderDrafts();
    const text = $('.draft__text', card);
    if (text) text.textContent = version.text;
    const meta = $('.draft__meta', card);
    if (meta) meta.textContent = Core.formatChars(Core.charCount(version.text));
    const body = $('.draft__body', card);
    if (body) body.scrollTop = body.scrollHeight;
  }

  /* ── 留档 ───────────────────────────────────────────────── */
  async function saveRecord() {
    try {
      const record = Core.toRecord(state);
      if (!record.versions.length) return;
      const saved = await api.history.create(record);
      state = Object.assign({}, state, { savedId: saved.id });
      view.openedId = saved.id;
      await refreshHistory();
      toast('已存进写作留档', {
        level: 'info',
        action: { label: '查看', run: openDrawer },
      });
    } catch (err) {
      toast('留档失败：' + ((err && err.message) || '未知原因'), { level: 'error' });
    }
  }

  async function refreshHistory() {
    try {
      const data = await api.history.list({
        mode: view.historyMode,
        q: view.historyQ,
        starred: view.starredOnly,
        limit: 100,
      });
      view.records = data.items || [];
      view.total = data.total || 0;
      view.modes = data.modes || [];
      view.localElsewhere = data.localElsewhere || 0;
      renderHistory();
      const count = (data.modes || []).reduce((sum, m) => sum + m.count, 0);
      dom.historyCount.textContent = String(count);
      dom.drawerCount.textContent = `${count} 篇`;
    } catch (err) {
      view.records = [];
      renderHistory(err.message);
    }
  }

  /**
   * 登录之后抽屉里那句「没登录时写的 N 篇还在」。
   * 为什么要有：留档按账号分开是登录的意义所在，但第一次登录的人只会看到
   * 「我的留档怎么空了」—— 说清它们在哪儿，再给一个显式的认领按钮。
   */
  function claimHint() {
    return h('p', { class: 'drawer__empty' }, [
      h('span', { text: `没登录时写的 ${view.localElsewhere} 篇还在「本地模式」那一桶里。` }),
      h('button', {
        type: 'button',
        class: 'link-btn',
        text: '认领到这个账号',
        title: '把它们记到这个账号名下（只动这一桶，不删不改别的）',
        onclick: async () => {
          try {
            const claimed = await api.history.claim();
            await refreshHistory();
            toast(claimed ? `认领了 ${claimed} 篇` : '没有可认领的稿子');
          } catch (err) {
            toast('认领失败：' + ((err && err.message) || ''), { level: 'error' });
          }
        },
      }),
    ]);
  }

  function renderHistory(errorText) {
    clear(dom.historyModes);
    const all = { id: 'all', name: '全部', mark: '全', count: (view.modes || []).reduce((s, m) => s + m.count, 0) };
    [all].concat(view.modes || []).forEach((mode) => {
      dom.historyModes.append(
        h('button', {
          type: 'button',
          class: 'chip',
          'aria-pressed': String(view.historyMode === mode.id),
          onclick: () => {
            view.historyMode = mode.id;
            refreshHistory();
          },
        }, [h('span', { text: mode.name }), h('span', { class: 'chip__num', text: String(mode.count || 0) })])
      );
    });

    const list = clear(dom.historyList);
    if (errorText) {
      list.append(h('p', { class: 'drawer__empty', text: '读不到留档：' + errorText }));
      return;
    }
    if (!view.records.length) {
      list.append(
        h('p', {
          class: 'drawer__empty',
          text: view.historyQ || view.starredOnly || view.historyMode !== 'all'
            ? '这个条件下没有稿子。'
            : '还没有留档。起一次稿，结果会自动存进来。',
        })
      );
      if (view.localElsewhere) list.append(claimHint());
      return;
    }

    view.records.forEach((item) => {
      list.append(
        h('article', {
          class: 'record',
          'aria-current': String(view.openedId === item.id),
          onclick: (e) => {
            if (e.target.closest('.record__act')) return;
            loadRecord(item.id);
          },
        }, [
          h('span', { class: 'record__mark', text: item.mark }),
          h('div', { class: 'record__main' }, [
            h('span', { class: 'record__title', text: item.title }),
            h('p', { class: 'record__excerpt', text: item.excerpt }),
            h('div', { class: 'record__meta' }, [
              h('span', { text: Core.formatTime(item.updatedAt) }),
              h('span', { text: `${item.versions} 稿 · ${Core.formatChars(item.chars)}` }),
              item.hasPolish ? h('span', { class: 'record__badge', text: '有朱批' }) : null,
              item.starred
                ? h('span', { class: 'record__badge', title: STAR_HINT, text: '星标' })
                : null,
            ]),
          ]),
          h('div', { class: 'record__act' }, [
            h('button', {
              type: 'button',
              class: 'icon-btn',
              title: item.starred ? `取消星标（${STAR_HINT}）` : `加星标（${STAR_HINT}）`,
              'aria-label': item.starred ? '取消星标' : '加星标',
              text: item.starred ? '★' : '☆',
              onclick: async () => {
                await api.history.update(item.id, { starred: !item.starred });
                await refreshHistory();
              },
            }),
            h('button', {
              type: 'button',
              class: 'icon-btn',
              title: '删除这篇',
              'aria-label': '删除这篇',
              text: '✕',
              onclick: async () => {
                if (!window.confirm(`删除「${item.title}」？删了就找不回来了。`)) return;
                await api.history.remove(item.id);
                if (view.openedId === item.id) view.openedId = '';
                await refreshHistory();
                toast('已删除');
              },
            }),
          ]),
        ])
      );
    });

    if (view.localElsewhere) list.append(claimHint());
  }

  async function loadRecord(id) {
    try {
      const record = await api.history.get(id);
      if (!record) {
        toast('这篇稿子已经不在了', { level: 'error' });
        await refreshHistory();
        return;
      }
      state = Core.fromRecord(record);
      polish = record.polished && record.polished.after
        ? {
            source: record.polished.source,
            label: record.polished.source.startsWith('version:')
              ? Core.versionLabel(Number(record.polished.source.split(':')[1]))
              : '原稿',
            before: record.polished.before,
            edits: record.polished.edits || [],
            accepted: new Set(record.polished.accepted || []),
            stats: Polisher.stats(record.polished.edits || []),
            engine: 'stored',
            note: '来自留档',
          }
        : null;
      // 载入的稿子归到它自己的板块：当前板块先存档，再把这份放进对应板块的工作区
      workspaces.set(state.mode, Core.snapshot(state));
      view.openedId = id;
      closeDrawer();
      renderAll();
      persistUI();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      toast('已载入：' + record.title);
    } catch (err) {
      toast('载入失败：' + ((err && err.message) || ''), { level: 'error' });
    }
  }

  function openDrawer() {
    view.drawerOpen = true;
    dom.drawer.hidden = false;
    dom.drawer.removeAttribute('inert');
    dom.drawer.setAttribute('aria-hidden', 'false');
    dom.scrim.hidden = false;
    refreshHistory();
    dom.historyQ.focus();
  }

  function closeDrawer() {
    view.drawerOpen = false;
    dom.drawer.hidden = true;
    // 只挪出屏幕还不够：键盘 Tab 依然能进到抽屉里的按钮，所以顺手让它 inert
    dom.drawer.setAttribute('inert', '');
    dom.drawer.setAttribute('aria-hidden', 'true');
    dom.scrim.hidden = true;
  }

  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /* ── 账号 ───────────────────────────────────────────────── */
  /**
   * 账号是**可选**的：不登录照样写、照样起稿、照样留档（存在「本地模式」那一桶）。
   * 登录只是把留档按人分开，顺带给你一个名字和头像。
   *
   * 表单的四张脸（login / register / name / password）共用同一个浮层：
   * 字段的显示与隐藏、按钮文字、提示语都从 authState.form 推出来。
   * 不另写四套界面 —— 那样最容易出现「改密码的框里还留着登录的校验」。
   */
  const AUTH_FORMS = {
    login: { title: '登录', submit: '登录', hint: '登录之后看到的是这个账号自己的留档' },
    register: {
      title: '注册',
      submit: '注册并登录',
      hint: '名字 2–20 个字，密码至少 8 位；不同账号的留档互不可见',
    },
    name: { title: '改名字', submit: '保存名字', hint: '名字只是显示用的，改它不用密码' },
    password: {
      title: '改密码',
      submit: '保存新密码',
      hint: '改完密码，别处开着的页面会立刻失效；这一台会继续用着',
    },
    recover: {
      title: '用恢复码重置密码',
      submit: '重置并登录',
      hint: '恢复码是注册时给你的那一串（12 位）。重置之后旧的作废，会给你一串新的',
    },
    'code-shown': { title: '记下这串恢复码', submit: '抄好了', hint: '' },
  };

  const authState = {
    user: null,
    registerOpen: true,
    form: 'login',
    note: '',
    busy: false,
    menuOpen: false,
    recent: [],
    avatarDraft: null,
  };

  /** 报头那一小块：没登录是「登录 / 注册」，登录了是头像 + 名字 */
  function renderAccount() {
    const user = authState.user;
    dom.accountSignin.hidden = Boolean(user);
    dom.accountSelf.hidden = !user;
    dom.accountMenu.hidden = !(authState.menuOpen && Boolean(user));
    dom.accountSelf.setAttribute('aria-expanded', String(authState.menuOpen && Boolean(user)));
    dom.accountNote.hidden = !authState.note;
    dom.accountNote.textContent = authState.note || '';
    dom.account.title = user ? `已登录：${user.name}` : '登录之后留档按账号分开；不登录也能用';
    if (user) {
      dom.accountName.textContent = user.name;
      AuthMod.paintAvatar(dom.accountAvatar, user);
      dom.accountMenuHead.textContent = `${user.name} · 留档只算这个账号的`;
    } else {
      dom.accountName.textContent = '';
      dom.accountMenuHead.textContent = '';
    }
  }

  /** 记住这个名字，下次点一下就能填上（只存名字，不存密码） */
  function rememberName(name) {
    authState.recent = AuthMod.writeRecentAccounts(
      AuthMod.rememberAccount(authState.recent, name),
      window.localStorage
    );
  }

  /**
   * 换主人 = 换了一桶留档。
   * 所以这里要清掉「当前打开的那篇」（savedId 指向的稿子已经不属于你了），
   * 再把抽屉里的列表重新拉一遍 —— 不清的话，采用哪一稿的同步会打到别人的 id 上。
   */
  function applyUser(user, message) {
    const beforeId = (authState.user && authState.user.id) || '';
    const nextId = (user && user.id) || '';
    authState.user = user || null;
    authState.note = '';
    if (nextId !== beforeId) {
      state = Object.assign({}, state, { savedId: '' });
      view.openedId = '';
      refreshHistory();
    }
    renderAccount();
    if (message) toast(message);
  }

  /** 票过期了（改过密码或到了 30 天）：说清楚，别装作还登着 */
  function handleAuthLost() {
    if (!authState.user) return;
    authState.user = null;
    authState.note = '登录已过期（改过密码或到了 30 天）。重新登录就能接着写 —— 留档一篇都没丢。';
    state = Object.assign({}, state, { savedId: '' });
    view.openedId = '';
    renderAccount();
    refreshHistory();
  }

  function showAuthError(text) {
    dom.authError.textContent = text || '';
    dom.authError.hidden = !text;
    if (text) dom.authOk.hidden = true;
  }

  function showAuthOk(text) {
    dom.authOk.textContent = text || '';
    dom.authOk.hidden = !text;
    if (text) dom.authError.hidden = true;
  }

  function renderRecentAccounts() {
    clear(dom.authRecent);
    if (authState.form === 'name' || authState.form === 'password') return;
    const list = AuthMod.matchRecentAccounts(authState.recent, dom.authName.value);
    list.forEach((item) => {
      dom.authRecent.append(
        h('button', {
          type: 'button',
          class: 'auth-recent__item',
          text: item.name,
          title: `用「${item.name}」登录`,
          onclick: () => {
            dom.authName.value = item.name;
            renderRecentAccounts();
            dom.authPassword.focus();
          },
        })
      );
    });
  }

  /** 四张脸共用这一个表单：只改「哪些字段露出来」和几句提示 */
  function renderAuthForm() {
    const form = authState.form;
    const copy = AUTH_FORMS[form] || AUTH_FORMS.login;
    const issued = form === 'code-shown';
    const changingPassword = form === 'password';
    const recovering = form === 'recover';
    const wantsName = form !== 'password' && !issued;
    const wantsPassword = form === 'login' || form === 'register' || changingPassword;
    const wantsNew = changingPassword || recovering;
    const wantsConfirm = form === 'register' || changingPassword || recovering;

    dom.authTitle.textContent = copy.title;
    dom.authSubmit.textContent = copy.submit;
    dom.authHint.textContent = copy.hint;

    dom.authTabs.hidden = !(authState.registerOpen && (form === 'login' || form === 'register'));
    dom.authTabLogin.setAttribute('aria-selected', String(form === 'login'));
    dom.authTabRegister.setAttribute('aria-selected', String(form === 'register'));

    dom.authNameField.hidden = !wantsName;
    dom.authNameLabel.textContent = form === 'name' ? '新名字' : '名字';

    dom.authPasswordField.hidden = !wantsPassword;
    dom.authPasswordLabel.textContent = changingPassword ? '原密码' : '密码';
    dom.authPassword.setAttribute('autocomplete', form === 'register' ? 'new-password' : 'current-password');

    dom.authCodeField.hidden = !recovering;

    dom.authNewField.hidden = !wantsNew;
    dom.authNewLabel.textContent = '新密码';

    dom.authConfirmField.hidden = !wantsConfirm;
    dom.authConfirmLabel.textContent = '再输一遍';

    // 恢复码那一屏：整张卡片只剩「这串码 + 复制」，别的都收起来
    dom.authCodeShown.hidden = !issued;
    if (issued) dom.authCodeValue.textContent = authState.issuedCode;
    dom.authRememberRow.hidden = changingPassword || recovering || issued;
    dom.authActions.hidden = issued;
    dom.authHint.hidden = issued;
    dom.authForgot.hidden = issued || recovering || form === 'name' || changingPassword;
    dom.authRecent.hidden = dom.authTabs.hidden || !authState.recent.length;
    renderRecentAccounts();
    showAuthError('');
    dom.authOk.hidden = true;
    if (issued) dom.authCodeCopy.focus();
  }

  function openAuth(form) {
    if (!api || api.kind !== 'server') {
      toast('登录要用本地服务：先运行 node server.js，再从 http://127.0.0.1:5260/ 打开', { level: 'warn' });
      return;
    }
    authState.form = AUTH_FORMS[form] ? form : 'login';
    authState.busy = false;
    authState.menuOpen = false;
    authState.recent = AuthMod.readRecentAccounts(window.localStorage);
    dom.authName.value = authState.user && authState.form === 'login' ? authState.user.name : '';
    dom.authPassword.value = '';
    dom.authConfirm.value = '';
    dom.authNew.value = '';
    dom.authCode.value = '';
    renderAccount();
    renderAuthForm();
    dom.authOverlay.hidden = false;
    dom.authOverlay.setAttribute('aria-hidden', 'false');
    if (authState.form === 'login' && authState.recent.length) dom.authPassword.focus();
    else dom.authName.focus();
  }

  function closeAuth() {
    dom.authOverlay.hidden = true;
    dom.authOverlay.setAttribute('aria-hidden', 'true');
  }

  async function submitAuth() {
    if (authState.busy) return;
    const form = authState.form;
    // 「恢复码那一屏」只有一个按钮：抄好了 → 关掉浮层
    if (form === 'code-shown') {
      closeAuth();
      return;
    }
    const name = dom.authName.value.trim();
    const password = dom.authPassword.value;
    const confirm = dom.authConfirm.value;
    const newPassword = dom.authNew.value;
    const code = dom.authCode.value;
    const checked = AuthMod.authFormError({
      mode: form,
      // 改密码时「名字」不是用户填的，是当前账号的（密码不能和名字一样这条要用到）
      name: form === 'password' ? (authState.user && authState.user.name) || '' : name,
      password,
      confirm,
      newPassword,
      code,
    });
    if (checked) {
      showAuthError(checked);
      return;
    }

    authState.busy = true;
    dom.authSubmit.disabled = true;
    showAuthError('');
    try {
      if (form === 'login') {
        const out = await api.auth.login({ name, password, remember: dom.authRemember.checked });
        rememberName(out.user.name);
        closeAuth();
        applyUser(out.user, `已登录：${out.user.name}`);
      } else if (form === 'register') {
        const out = await api.auth.register({ name, password, remember: dom.authRemember.checked });
        rememberName(out.user.name);
        applyUser(out.user);
        showIssuedCode(out.recoveryCode, `注册好了，欢迎 ${out.user.name}`);
      } else if (form === 'recover') {
        const out = await api.auth.recover({
          name,
          code,
          newPassword,
          remember: dom.authRemember.checked,
        });
        rememberName(out.user.name);
        applyUser(out.user);
        showIssuedCode(out.recoveryCode, `${out.user.name} 的密码重好了，也重新登录了`);
      } else if (form === 'name') {
        const before = (authState.user && authState.user.name) || '';
        const out = await api.auth.rename(name);
        authState.recent = AuthMod.writeRecentAccounts(
          AuthMod.renameRememberedAccount(authState.recent, before, out.user.name),
          window.localStorage
        );
        closeAuth();
        applyUser(out.user, out.unchanged ? '名字没变' : `名字已改成「${out.user.name}」`);
      } else {
        const out = await api.auth.changePassword({
          oldPassword: password,
          newPassword,
          remember: dom.authRemember.checked,
        });
        closeAuth();
        applyUser(out.user, '密码改好了，这台机器不用重新登录');
      }
    } catch (err) {
      showAuthError((err && err.message) || '没成功，稍后再试');
    } finally {
      authState.busy = false;
      dom.authSubmit.disabled = false;
    }
  }

  /**
   * 恢复码只出现这一次，所以注册 / 找回成功之后**不直接关浮层**，
   * 而是把这一串摆到用户面前，等他抄完点「抄好了」。
   */
  function showIssuedCode(code, message) {
    if (message) toast(message);
    if (!code) {
      closeAuth();
      return;
    }
    authState.issuedCode = code;
    authState.form = 'code-shown';
    renderAuthForm();
  }

  async function doLogout() {
    authState.menuOpen = false;
    const name = (authState.user && authState.user.name) || '';
    try {
      await api.auth.logout();
    } catch {
      // 票没作废也照样切回未登录：界面上绝不能装作还登着
    }
    applyUser(null, name ? `${name} 已退出登录` : '已退出登录');
    authState.note = '';
    renderAccount();
  }

  /** 进来先问一句「我是谁」——没登录也是正常状态（本地模式），不是错误 */
  async function loadAuth() {
    try {
      const out = await api.auth.me();
      authState.registerOpen = out.registerOpen !== false;
      // 本地模式（直接打开 index.html）没有账号服务，这件事点按钮时说一句就够了，
      // 不必在报头下面常驻一行说明
      authState.note = api.kind === 'server' ? out.authError || '' : '';
      authState.user = out.user || null;
      if (authState.user) rememberName(authState.user.name);
    } catch (err) {
      authState.note = '读不到登录状态：' + ((err && err.message) || '');
    }
    renderAccount();
  }

  /* 换头像 */
  function openAvatarPanel() {
    if (!authState.user) return;
    authState.menuOpen = false;
    renderAccount();
    authState.avatarDraft = AuthRules.normalizeAvatar(authState.user.avatar) || { kind: 'initial', color: null };
    dom.avatarError.hidden = true;
    dom.avatarUploadNote.textContent = 'png / jpg / webp，会先压到 128px 再传（一般十几 KB）';
    renderAvatarPanel();
    dom.avatarOverlay.hidden = false;
    dom.avatarOverlay.setAttribute('aria-hidden', 'false');
  }

  function closeAvatarPanel() {
    dom.avatarOverlay.hidden = true;
    dom.avatarOverlay.setAttribute('aria-hidden', 'true');
  }

  function renderAvatarPanel() {
    const user = authState.user || {};
    const draft = authState.avatarDraft || { kind: 'initial', color: null };
    dom.avatarPreviewName.textContent = user.name || '';
    AuthMod.paintAvatar(dom.avatarPreview, Object.assign({}, user, { avatar: draft }));

    const autoColor = AuthRules.avatarColorFor(AuthRules.nameKey(user.name || ''));
    const emojiOn = draft.kind === 'emoji' ? draft.emoji : '';
    clear(dom.avatarGrid);
    AuthRules.AVATAR_EMOJI.forEach((emoji) => {
      const on = emojiOn === emoji;
      dom.avatarGrid.append(
        h('button', {
          type: 'button',
          class: on ? 'avatar-choice avatar-choice--on' : 'avatar-choice',
          text: emoji,
          'aria-label': `用 ${emoji} 当头像`,
          'aria-pressed': String(on),
          onclick: () => {
            authState.avatarDraft = { kind: 'emoji', emoji };
            renderAvatarPanel();
          },
        })
      );
    });

    const currentColor = draft.kind === 'initial' ? draft.color || autoColor : '';
    clear(dom.avatarColors);
    AuthRules.AVATAR_COLORS.forEach((color) => {
      const on = currentColor === color;
      dom.avatarColors.append(
        h('button', {
          type: 'button',
          class: on ? 'avatar-swatch avatar-swatch--on' : 'avatar-swatch',
          style: `background:${color}`,
          'aria-label': `首字母头像用 ${color} 这个底色`,
          'aria-pressed': String(on),
          onclick: () => {
            authState.avatarDraft = { kind: 'initial', color };
            renderAvatarPanel();
          },
        })
      );
    });

    // 图片头像正在用时给它一个「用回文字头像」的出口，否则点过上传就没法回退了
    dom.avatarUpload.textContent = draft.kind === 'image' ? '换一张图…' : '上传我自己的图片…';
  }

  /** 选了文件 → 先压到 128px → 变成草稿头像（还没上传，点「保存」才发出去） */
  async function pickAvatarFile(event) {
    const file = event && event.target && event.target.files && event.target.files[0];
    if (!file) return;
    dom.avatarError.hidden = true;
    try {
      const compressed = await AuthMod.compressImage(file, {
        maxEdge: AuthMod.AVATAR_MAX_EDGE,
        targetChars: AuthMod.AVATAR_TARGET_CHARS,
      });
      const avatar = AuthMod.avatarFromUpload(compressed);
      if (!avatar) throw new Error('这张图压完还是不能用（太大或格式不对）');
      authState.avatarDraft = avatar;
      renderAvatarPanel();
      const kb = Math.max(1, Math.round(compressed.finalChars / 1024));
      dom.avatarUploadNote.textContent = `已选好这张图（压到 ${compressed.width}×${compressed.height}，约 ${kb} KB），点「保存」才生效`;
    } catch (err) {
      dom.avatarError.textContent = AuthMod.uploadErrorMessage(err);
      dom.avatarError.hidden = false;
    } finally {
      // 让「同一个文件再选一次」也能触发 change
      if (event && event.target) event.target.value = '';
    }
  }

  async function saveAvatar() {
    const draft = authState.avatarDraft || { kind: 'initial', color: null };
    dom.avatarSave.disabled = true;
    try {
      const out = await api.auth.setAvatar(draft);
      closeAvatarPanel();
      applyUser(out.user, '头像换好了');
    } catch (err) {
      dom.avatarError.textContent = (err && err.message) || '换头像失败';
      dom.avatarError.hidden = false;
    } finally {
      dom.avatarSave.disabled = false;
    }
  }

  /* ── 稿片上的动作 ───────────────────────────────────────── */
  function onDraftAction(act, version) {
    if (act === 'adopt') {
      state = Core.adopt(state, state.adopted === version.index ? -1 : version.index);
      renderDrafts();
      persistUI();
      syncRecord();
      toast(state.adopted === version.index ? `已采用${Core.versionLabel(version.index)}` : '已取消采用');
      return;
    }
    if (act === 'copy') {
      copyText(version.text, `已复制${Core.versionLabel(version.index)}`);
      return;
    }
    if (act === 'extend') {
      state = Core.asMaterial(state, version.text);
      polish = null;
      renderAll();
      persistUI();
      notice('已把这一稿放到原稿上，可以接着往下写。');
      dom.material.focus();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    if (act === 'polish') {
      runPolish({ source: 'version:' + version.index, label: Core.versionLabel(version.index), text: version.text });
      return;
    }
    if (act === 'translate') {
      // 翻译是个独立板块：把这一稿递过去，目标语言与角度在那边选
      switchToMode('translate', version.text);
      return;
    }
  }

  async function copyText(text, okMessage) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMessage);
    } catch {
      const area = h('textarea', { style: 'position:fixed;left:-9999px' });
      area.value = text;
      document.body.append(area);
      area.select();
      try {
        document.execCommand('copy');
        toast(okMessage);
      } catch {
        toast('复制失败，请手动选中', { level: 'error' });
      }
      area.remove();
    }
  }

  /** 采用了哪一稿要写回留档 */
  const syncRecord = debounce(async () => {
    if (!state.savedId) return;
    const record = Core.toRecord(state);
    try {
      await api.history.update(state.savedId, { adoptedIndex: record.adoptedIndex });
      refreshHistory();
    } catch {
      /* 同步失败不影响当前写作 */
    }
  }, 500);

  /* ── 一键优化 ───────────────────────────────────────────── */
  async function runPolish(target) {
    if (state.busy) return;
    const text = String(target.text || '').trim();
    if (!text) {
      notice('这一处还没有文字可以优化。', 'warn');
      return;
    }
    notice(`正在校对${target.label}……`);
    dom.polishInput.disabled = true;
    try {
      // 译文要按目标语言校对，而不是按中文的语法习惯；这一句提示让朱批更对症
      const isTranslate = Modes.getMode(state.mode).id === 'translate';
      const result = await api.polish(text, {
        model: view.model,
        focus: isTranslate ? '这是译文：重点核对目标语言的语法、搭配与地道程度，不要改成中文的表达习惯' : '',
      });
      const edits = result.edits || [];
      polish = {
        source: target.source,
        label: target.label,
        before: result.before || text,
        edits,
        accepted: new Set(edits.map((e) => e.id)), // 默认全部采纳，用户可以逐条撤销
        stats: result.stats || Polisher.stats(edits),
        engine: result.engine,
        note: result.note || '',
      };
      renderPolish();
      if (!edits.length) {
        notice(`${target.label}没挑出毛病，一个字没动。`, 'info');
      } else {
        notice(`${target.label}：${edits.length} 处朱批，默认全部采纳，可以逐条还原。`, 'info');
      }
      dom.polish.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      syncPolishToRecord();
    } catch (err) {
      const message = '校对失败：' + ((err && err.message) || '');
      notice(message, 'warn');
      toast(message, { level: 'error' });
    } finally {
      dom.polishInput.disabled = false;
    }
  }

  /** 把朱批结果落回原稿或那一稿 */
  function applyPolish() {
    if (!polish) return;
    const text = acceptedText();
    if (polish.source === 'input') {
      state = Object.assign({}, state, { material: text });
    } else {
      const index = Number(polish.source.split(':')[1]);
      state = Object.assign({}, state, {
        versions: state.versions.map((v) => (v.index === index ? Object.assign({}, v, { text, chars: text.length }) : v)),
      });
    }
    polish = null;
    renderAll();
    persistUI();
    syncRecord();
    toast('已采纳，文字已经更新');
  }

  function revertPolish() {
    if (!polish) return;
    polish.accepted = new Set();
    renderPolish();
    toast('已全部还原');
  }

  /* ── 启动 ───────────────────────────────────────────────── */
  function cacheDom() {
    dom.modes = $('#modes');
    dom.engine = $('#engine');
    dom.picker = $('#picker');
    dom.modelSelect = $('#model-select');
    dom.historyCount = $('#history-count');
    dom.templateCount = $('#template-count');
    dom.openTemplates = $('#open-templates');
    dom.tplDrawer = $('#tpl-drawer');
    dom.tplList = $('#tpl-list');
    dom.tplCount = $('#tpl-count');
    dom.tplForm = $('#tpl-form');
    dom.tplFormTitle = $('#tpl-form-title');
    dom.tplFormNote = $('#tpl-form-note');
    dom.tplName = $('#tpl-name');
    dom.tplMark = $('#tpl-mark');
    dom.tplTagline = $('#tpl-tagline');
    dom.tplSystem = $('#tpl-system');
    dom.tplOutput = $('#tpl-output');
    dom.tplInputLabel = $('#tpl-input-label');
    dom.tplExample = $('#tpl-example');
    dom.tplSave = $('#tpl-save');
    dom.tplCancel = $('#tpl-cancel');
    dom.tplSeed = $('#tpl-seed');
    dom.newTemplate = $('#new-template');
    dom.closeTemplates = $('#close-templates');
    dom.compare = $('#compare');
    dom.compareA = $('#compare-a');
    dom.compareB = $('#compare-b');
    dom.compareSummary = $('#compare-summary');
    dom.compareText = $('#compare-text');
    dom.compareChanges = $('#compare-changes');
    dom.compareSwap = $('#compare-swap');
    dom.compareCopy = $('#compare-copy');
    dom.compareClose = $('#compare-close');
    dom.draftsBar = $('#drafts-bar');
    dom.draftsBarLabel = $('#drafts-bar-label');
    dom.openCompare = $('#open-compare');
    dom.openHistory = $('#open-history');
    dom.sheetTab = $('#input-tab');
    dom.material = $('#material');
    dom.materialLabel = $('#material-label');
    dom.materialHint = $('#material-hint');
    dom.materialCount = $('#material-count');
    dom.paramSummary = $('#param-summary');
    dom.clearWork = $('#clear-work');
    dom.polishInput = $('#polish-input');
    dom.generate = $('#generate');
    dom.generateInk = $('.btn__ink', $('#generate'));
    dom.generateKbd = $('.btn__kbd', $('#generate'));
    dom.notice = $('#notice');
    dom.polish = $('#polish');
    dom.polishTarget = $('#polish-target');
    dom.polishSummary = $('#polish-summary');
    dom.polishText = $('#polish-text');
    dom.polishNotes = $('#polish-notes');
    dom.polishAcceptAll = $('#polish-accept-all');
    dom.polishRevertAll = $('#polish-revert-all');
    dom.polishCopy = $('#polish-copy');
    dom.polishClose = $('#polish-close');
    dom.drafts = $('#drafts');
    dom.draftsEmpty = $('#drafts-empty');
    dom.draftsExamples = $('#drafts-examples');
    dom.ctlCreativity = $('#ctl-creativity');
    dom.ctlLength = $('#ctl-length');
    dom.ctlVersions = $('#ctl-versions');
    dom.ctlTone = $('#ctl-tone');
    dom.ctlFields = $('#ctl-fields');
    dom.panelEngine = $('#panel-engine');
    dom.drawer = $('#drawer');
    dom.scrim = $('#scrim');
    dom.closeHistory = $('#close-history');
    dom.drawerCount = $('#drawer-count');
    dom.historyQ = $('#history-q');
    dom.historyStarred = $('#history-starred');
    dom.historyModes = $('#history-modes');
    dom.historyList = $('#history-list');
    dom.clearHistory = $('#clear-history');
    dom.toasts = $('#toasts');

    /* 账号 */
    dom.account = $('#account');
    dom.accountSignin = $('#account-signin');
    dom.accountSelf = $('#account-self');
    dom.accountAvatar = $('#account-avatar');
    dom.accountName = $('#account-name');
    dom.accountMenu = $('#account-menu');
    dom.accountMenuHead = $('#account-menu-head');
    dom.accountNote = $('#account-note');
    dom.accountAvatarEdit = $('#account-avatar-edit');
    dom.accountRename = $('#account-rename');
    dom.accountPassword = $('#account-password');
    dom.accountLogout = $('#account-logout');

    /* 登录 / 注册浮层 */
    dom.authOverlay = $('#auth-overlay');
    dom.authTitle = $('#auth-title');
    dom.authTabs = $('#auth-tabs');
    dom.authTabLogin = $('#auth-tab-login');
    dom.authTabRegister = $('#auth-tab-register');
    dom.authBody = $('#auth-body');
    dom.authNameField = $('#auth-name-field');
    dom.authNameLabel = $('#auth-name-label');
    dom.authName = $('#auth-name');
    dom.authRecent = $('#auth-recent');
    dom.authPasswordField = $('#auth-password-field');
    dom.authPasswordLabel = $('#auth-password-label');
    dom.authPassword = $('#auth-password');
    dom.authNewField = $('#auth-new-field');
    dom.authNewLabel = $('#auth-new-label');
    dom.authNew = $('#auth-new');
    dom.authConfirmField = $('#auth-confirm-field');
    dom.authConfirmLabel = $('#auth-confirm-label');
    dom.authConfirm = $('#auth-confirm');
    dom.authCodeField = $('#auth-code-field');
    dom.authCode = $('#auth-code');
    dom.authCodeShown = $('#auth-code-shown');
    dom.authCodeValue = $('#auth-code-value');
    dom.authCodeCopy = $('#auth-code-copy');
    dom.authCodeDone = $('#auth-code-done');
    dom.authRememberRow = $('#auth-remember-row');
    dom.authRemember = $('#auth-remember');
    dom.authError = $('#auth-error');
    dom.authOk = $('#auth-ok');
    dom.authHint = $('#auth-hint');
    dom.authActions = $('#auth-actions');
    dom.authForgot = $('#auth-forgot');
    dom.authForget = $('#auth-forget');
    dom.authSubmit = $('#auth-submit');
    dom.authCancel = $('#auth-cancel');
    dom.authClose = $('#auth-close');

    /* 换头像浮层 */
    dom.avatarOverlay = $('#avatar-overlay');
    dom.avatarPreview = $('#avatar-preview');
    dom.avatarPreviewName = $('#avatar-preview-name');
    dom.avatarGrid = $('#avatar-grid');
    dom.avatarColors = $('#avatar-colors');
    dom.avatarFile = $('#avatar-file');
    dom.avatarUpload = $('#avatar-upload');
    dom.avatarUploadNote = $('#avatar-upload-note');
    dom.avatarError = $('#avatar-error');
    dom.avatarSave = $('#avatar-save');
    dom.avatarCancel = $('#avatar-cancel');
    dom.avatarClose = $('#avatar-close');
  }

  function renderEngine() {
    const engine = api.info.engine || {};
    dom.engine.dataset.live = String(Boolean(engine.live));
    dom.engine.textContent = engine.live ? view.model || engine.model || '已接入模型' : '离线引擎';
    dom.engine.title = engine.note || '';
  }

  /* ── 模型选择 ───────────────────────────────────────────── */
  /**
   * 填模型下拉框。
   * 列表来自服务端的 /api/models（它在启动时已经探测过上游）；
   * 之前选的模型如果不在列表里（下架、换账号），说清楚并退回默认，不悄悄换。
   */
  function renderModels(info) {
    const list = (info && info.models) || [];
    view.models = list;
    const current = view.model || (info && info.current) || (info && info.default) || '';

    dom.picker.dataset.state = info && info.live ? 'live' : 'offline';
    dom.modelSelect.disabled = !info || !info.live || !list.length || state.busy;

    if (!info || !info.live) {
      dom.modelSelect.replaceChildren(h('option', { value: '', text: '离线引擎' }));
      dom.modelSelect.value = '';
      dom.picker.title = (info && info.note) || '没有配置 API Key，用内置离线引擎成稿';
      return;
    }

    if (!list.length) {
      // 拿不到列表也要能用：只放服务端当前这一个
      const only = info.current || info.default || '';
      dom.modelSelect.replaceChildren(h('option', { value: only, text: only || '默认模型' }));
      dom.modelSelect.value = only;
      dom.picker.title = info.note || '取不到模型列表，只能用默认模型';
      return;
    }

    const options = list.slice();
    if (current && !options.includes(current)) options.unshift(current);
    dom.modelSelect.replaceChildren(
      ...options.map((id) =>
        h('option', {
          value: id,
          text: id === info.current && !view.model ? `${id} · 已实测` : id,
          selected: id === current,
        })
      )
    );
    dom.modelSelect.value = current;
    dom.picker.title = `共 ${info.total} 个模型，其中可写字的 ${list.length} 个`;
  }

  async function loadModels() {
    try {
      const info = await api.models();
      if (view.model && info.live && info.models.length && !info.models.includes(view.model)) {
        toast(`之前选的 ${view.model} 已不可用，改回 ${info.current || info.default}`, { level: 'warn' });
        view.model = '';
        persistUI();
      }
      if (info.live && info.note) notice(info.note, 'warn');
      renderModels(info);
      renderEngine();
    } catch (err) {
      // 接口读不到不等于只能用离线引擎：如实标成「列表不可用」，模型名字段留空由服务端定
      renderModels({
        live: Boolean(api.info.engine && api.info.engine.live),
        models: [],
        current: (api.info.engine && api.info.engine.model) || '',
        note: '取不到模型列表：' + ((err && err.message) || ''),
      });
    }
  }

  function wireEvents() {
    dom.material.addEventListener('input', () => {
      state = Object.assign({}, state, { material: dom.material.value });
      dom.materialCount.textContent = Core.formatChars(Core.charCount(state.material));
      autoGrow();
      dom.polishInput.disabled = !state.material.trim();
      const ready = Core.canGenerate(state);
      dom.generate.disabled = !state.busy && !ready;
      persistUI();
    });

    dom.generate.addEventListener('click', generate);
    dom.clearWork.addEventListener('click', clearWorkspace);
    dom.polishInput.addEventListener('click', () => runPolish({ source: 'input', label: '原稿', text: state.material }));
    dom.polishNotes.addEventListener('click', onAnnotationClick);

    dom.polishAcceptAll.addEventListener('click', () => {
      if (!polish) return;
      polish.accepted = new Set(polish.edits.map((e) => e.id));
      renderPolish();
      applyPolish();
    });
    dom.polishRevertAll.addEventListener('click', revertPolish);
    dom.polishCopy.addEventListener('click', () => copyText(acceptedText(), '已复制润色稿'));
    dom.polishClose.addEventListener('click', () => {
      polish = null;
      renderPolish();
    });

    dom.openHistory.addEventListener('click', openDrawer);
    dom.closeHistory.addEventListener('click', closeDrawer);

    /* 账号 */
    dom.accountSignin.addEventListener('click', () => openAuth('login'));
    dom.accountSelf.addEventListener('click', () => {
      authState.menuOpen = !authState.menuOpen;
      renderAccount();
    });
    dom.accountAvatarEdit.addEventListener('click', openAvatarPanel);
    dom.accountRename.addEventListener('click', () => openAuth('name'));
    dom.accountPassword.addEventListener('click', () => openAuth('password'));
    dom.accountLogout.addEventListener('click', doLogout);

    dom.authTabLogin.addEventListener('click', () => openAuth('login'));
    dom.authTabRegister.addEventListener('click', () => openAuth('register'));
    dom.authForget.addEventListener('click', () => openAuth('recover'));
    dom.authSubmit.addEventListener('click', submitAuth);
    dom.authCancel.addEventListener('click', closeAuth);
    dom.authClose.addEventListener('click', closeAuth);
    dom.authCodeDone.addEventListener('click', closeAuth);
    dom.authCodeCopy.addEventListener('click', () => copyText(authState.issuedCode, '恢复码已复制'));
    dom.authName.addEventListener('input', renderRecentAccounts);
    [dom.authName, dom.authPassword, dom.authConfirm, dom.authNew, dom.authCode].forEach((field) => {
      field.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        submitAuth();
      });
    });

    dom.avatarSave.addEventListener('click', saveAvatar);
    dom.avatarCancel.addEventListener('click', closeAvatarPanel);
    dom.avatarClose.addEventListener('click', closeAvatarPanel);
    dom.avatarUpload.addEventListener('click', () => dom.avatarFile.click());
    dom.avatarFile.addEventListener('change', pickAvatarFile);

    dom.scrim.addEventListener('click', () => {
      closeDrawer();
      closeTemplates();
    });

    /* 模板库 */
    dom.openTemplates.addEventListener('click', openTemplates);
    dom.closeTemplates.addEventListener('click', closeTemplates);
    dom.newTemplate.addEventListener('click', () => fillTemplateForm(null));
    dom.tplCancel.addEventListener('click', () => fillTemplateForm(null));
    dom.tplSeed.addEventListener('click', seedTemplateForm);
    dom.tplForm.addEventListener('submit', saveTemplate);

    /* 对比两稿 */
    dom.openCompare.addEventListener('click', openCompare);
    dom.compareClose.addEventListener('click', () => {
      compareState.open = false;
      renderCompare();
    });
    dom.compareA.addEventListener('change', () => {
      compareState.a = dom.compareA.value;
      renderCompare();
    });
    dom.compareB.addEventListener('change', () => {
      compareState.b = dom.compareB.value;
      renderCompare();
    });
    dom.compareSwap.addEventListener('click', () => {
      const a = compareState.a;
      compareState.a = compareState.b;
      compareState.b = a;
      renderCompare();
    });
    dom.compareCopy.addEventListener('click', () => copyText(compareTextOf(compareState.b), '已复制右边这一稿'));

    dom.modelSelect.addEventListener('change', () => {
      view.model = dom.modelSelect.value;
      persistUI();
      renderEngine();
      renderModels({ live: true, models: view.models, current: view.model, total: view.models.length });
      notice(`这一稿开始用 ${view.model}。`, 'info');
    });

    dom.historyQ.addEventListener(
      'input',
      debounce(() => {
        view.historyQ = dom.historyQ.value.trim();
        refreshHistory();
      }, 200)
    );
    dom.historyStarred.addEventListener('change', () => {
      view.starredOnly = dom.historyStarred.checked;
      refreshHistory();
    });

    $$('[data-export]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const format = btn.dataset.export;
        try {
          const out = await api.history.exportAll(format, {
            mode: view.historyMode,
            q: view.historyQ,
            starred: view.starredOnly,
          });
          const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
          download(`三易留档-${stamp}.${out.ext}`, out.body, out.mime);
          toast('已导出 ' + out.ext.toUpperCase());
        } catch (err) {
          toast('导出失败：' + ((err && err.message) || ''), { level: 'error' });
        }
      });
    });

    dom.clearHistory.addEventListener('click', async () => {
      if (!window.confirm('清空全部留档？这一步不可撤销。')) return;
      try {
        const removed = await api.history.clear();
        view.openedId = '';
        await refreshHistory();
        toast(`已清空 ${removed} 篇`);
      } catch (err) {
        toast('清空失败：' + ((err && err.message) || ''), { level: 'error' });
      }
    });

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        generate();
        return;
      }
      if (e.key === 'Escape') {
        // 一层一层往回退：先关浮层，再关账号菜单，最后才是抽屉与朱批
        if (!dom.avatarOverlay.hidden) {
          closeAvatarPanel();
        } else if (!dom.authOverlay.hidden) {
          closeAuth();
        } else if (authState.menuOpen) {
          authState.menuOpen = false;
          renderAccount();
        } else if (view.drawerOpen) closeDrawer();
        else if (polish) {
          polish = null;
          renderPolish();
        }
      }
    });

    // 点别处把账号菜单收起来（菜单里的按钮自己会切状态，不用管）
    document.addEventListener('click', (event) => {
      if (!authState.menuOpen) return;
      const target = event.target;
      if (target && target.closest && target.closest('#account')) return;
      authState.menuOpen = false;
      renderAccount();
    });
  }

  async function boot() {
    cacheDom();
    api = await ApiMod.detect(window);
    // 票过期的唯一出口：任何一条账号请求回 401 都会走到 handleAuthLost
    ApiMod.onAuthLost(handleAuthLost);
    await loadAuth();

    // 顺序有讲究：先把模板注册成板块，再造状态 —— 否则上次停在自定义模板板块的话，
    // 那个板块 id 还没注册，状态会退回「文章续写」
    try {
      const out = await api.templates.list();
      templates.list = out.templates || [];
      Modes.setCustomTemplates(templates.list);
      dom.templateCount.textContent = String(templates.list.length);
      renderTemplates();
    } catch (err) {
      templates.list = [];
    }

    const saved = Core.loadUI(window.localStorage);
    state = Core.createState(saved.mode ? { mode: saved.mode } : {});
    if (saved.params) state.params = Object.assign(state.params, saved.params);
    if (saved.fields) state.fields = Object.assign(state.fields, saved.fields);
    if (typeof saved.material === 'string') state.material = saved.material;
    if (typeof saved.model === 'string') view.model = saved.model;
    state.params = Core.setParam(state, {}).params;

    renderEngine();
    renderAll();
    wireEvents();
    autoGrow();
    await loadModels();
    refreshHistory();

    if (!api.info.engine.live) {
      notice(
        '当前用离线引擎成稿，功能都是全的。设置 DEEPSEEK_API_KEY 或 OPENAI_API_KEY 后重启即可接入真实模型；' +
          '如果 Key 来自别家平台（中转、聚合），还要把 AI_BASE_URL 或 OPENAI_BASE_URL 设成那家的地址。',
        'info'
      );
      if (Modes.isCustomMode(state.mode) || state.mode === 'translate') {
        notice('这个板块需要真实模型：离线引擎不执行自定义提示词，也不会翻译。接上模型就好。', 'warn');
      }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
