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
  const view = {
    drawerOpen: false,
    historyMode: 'all',
    historyQ: '',
    starredOnly: false,
    records: [],
    modes: [],
    total: 0,
    openedId: '',
    model: '',          // 页面上选的模型；空表示用服务端探测出来的默认
    models: [],
  };

  const dom = {};

  /* ── 提示条 ─────────────────────────────────────────────── */
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
    Modes.MODES.forEach((mode) => {
      dom.modes.append(
        h(
          'button',
          {
            type: 'button',
            class: 'mode',
            'aria-current': String(mode.id === state.mode),
            title: mode.tagline,
            onclick: () => switchToMode(mode.id),
          },
          [h('span', { class: 'mode__mark', text: mode.mark }), h('span', { text: mode.name })]
        )
      );
    });
  }

  /**
   * 换板块：每个板块有自己的工作区（原稿、成稿、朱批），互不串台。
   * 切回用过的板块会把它自己那份装回来，而不是清空——来回对照着改稿是常态，
   * 每次清空会白丢一次工作；首次进入某个板块时它本来就是空的。
   */
  function switchToMode(modeId) {
    if (state.busy || modeId === state.mode) return;
    // 界面上的朱批视图也是这个板块的「活」：先放回 state 再存档，
    // 否则切走一趟回来，稿子和原稿都在、朱批却没了（留档里那份还在，但视图丢了）
    state = Object.assign({}, state, { polish });
    const moved = Core.switchWorkspace(state, modeId, workspaces);
    state = moved.state;
    workspaces = moved.workspaces;
    polish = state.polish || null;
    renderAll();
    persistUI();
    dom.material.focus();
    if (moved.restored && Core.hasWork(state)) {
      notice(`${Modes.getMode(state.mode).name} · 你上次在这里的稿子还在。想从头写就点「清空」。`, 'info');
    } else {
      notice('');
    }
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
    [0, 1].forEach((i) => {
      const text = Core.exampleOf(state.mode, i);
      host.append(
        h('button', {
          type: 'button',
          class: 'example',
          text,
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
          disabled: !version.text,
          onclick: () => onDraftAction(act.id, version),
        })
      )
    );
  }

  function renderDrafts() {
    clear(dom.drafts);
    dom.drafts.append(dom.draftsEmpty);
    renderEmptyState();
    if (state.versions.length) dom.drafts.classList.remove('drafts--empty');

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
        {
          onMeta(meta) {
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
        view.model
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
      renderHistory();
      const count = (data.modes || []).reduce((sum, m) => sum + m.count, 0);
      dom.historyCount.textContent = String(count);
      dom.drawerCount.textContent = `${count} 篇`;
    } catch (err) {
      view.records = [];
      renderHistory(err.message);
    }
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
              item.starred ? h('span', { class: 'record__badge', text: '星标' }) : null,
            ]),
          ]),
          h('div', { class: 'record__act' }, [
            h('button', {
              type: 'button',
              class: 'icon-btn',
              title: item.starred ? '取消星标' : '加星标',
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
      const result = await api.polish(text, { model: view.model });
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
    dom.openHistory = $('#open-history');
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
    dom.scrim.addEventListener('click', closeDrawer);

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
        if (view.drawerOpen) closeDrawer();
        else if (polish) {
          polish = null;
          renderPolish();
        }
      }
    });
  }

  async function boot() {
    cacheDom();
    api = await ApiMod.detect(window);

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
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
