// 对谈录 · 前端主程序
//
// 一条消息从输入到落盘的完整路径：
//   输入框 → store.pushUser（立刻落盘）
//          → store.pushAssistant（占位，状态 streaming）
//          → POST /api/chat，逐帧读 SSE
//          → 每帧 appendDelta（边写边落盘，刷新也能看到半截文字）
//          → store.finish（状态 done / error / interrupted）
//
// 渲染用的是「一帧一渲染」而不是每个 token 都动 DOM：
// SSE 的到达节奏不可控，用 requestAnimationFrame 合并，界面才稳。

import { renderMarkdown, escapeHtml, markdownToPlain } from './lib/markdown.js';
import { createStore } from './lib/store.js';

const els = {
  exchanges: document.getElementById('exchanges'),
  sheet: document.getElementById('sheet'),
  blank: document.getElementById('blank-sheet'),
  starters: document.getElementById('starters'),
  composer: document.getElementById('composer'),
  input: document.getElementById('composer-input'),
  send: document.getElementById('send-button'),
  stop: document.getElementById('stop-button'),
  hint: document.getElementById('composer-hint'),
  modeChip: document.getElementById('mode-chip'),
  modeLabel: document.getElementById('mode-label'),
  modelPicker: document.getElementById('model-picker'),
  modelSelect: document.getElementById('model-select'),
  pickerLoading: document.getElementById('picker-loading'),
  notice: document.getElementById('notice'),
  clear: document.getElementById('clear-button'),
  exportButton: document.getElementById('export-button'),
  confirmStrip: document.getElementById('confirm-strip'),
  confirmClear: document.getElementById('confirm-clear'),
  cancelClear: document.getElementById('cancel-clear'),
  reachBottom: document.getElementById('reach-bottom'),
  jumpBottom: document.getElementById('jump-bottom'),
  template: document.getElementById('exchange-template'),
};

const store = createStore();

const MODEL_PREF_KEY = 'duitanlu.model.v1';

/**
 * 读取用户在页面上选过的模型。
 *
 * 只在用户**主动选择**时写入 —— 服务端默认值不写进偏好，
 * 否则以后你改了服务端默认，页面还会拿旧值盖回去。
 */
function readModelPreference() {
  try {
    const saved = localStorage.getItem(MODEL_PREF_KEY);
    return saved && /^[A-Za-z0-9._:\/-]{1,80}$/.test(saved) ? saved : '';
  } catch {
    return '';
  }
}

function writeModelPreference(model) {
  try {
    if (model) localStorage.setItem(MODEL_PREF_KEY, model);
    else localStorage.removeItem(MODEL_PREF_KEY);
  } catch {
    /* 隐私模式下忽略 */
  }
}

/** 运行期状态（不落盘） */
const runtime = {
  config: { mode: 'unknown', model: null, hint: null },
  busy: false,          // 是否有请求在进行
  controller: null,     // 用于「停止生成」
  liveTurn: null,       // 当前正在流式写入的那条助手消息
  renderNode: null,     // 对应的 DOM 节点，避免整页重渲染
  lastPaint: '',
  frameHandle: null,
  pinned: true,         // 视图是否贴着底部
  serverDefaultModel: null, // 服务端默认模型（含启动探测结果）
  availableModels: [],      // 选择框里的可选模型
  /** 用户显式选过的模型；为空表示「跟随服务端默认」 */
  chosenModel: readModelPreference(),
};

/** 本次请求实际要用哪个模型 */
function effectiveModel() {
  return runtime.chosenModel || runtime.serverDefaultModel || '';
}

// ---------------------------------------------------------------- 小工具

function formatClock(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function exchangeCount() {
  return store.messages.filter((m) => m.role === 'assistant').length;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 剪贴板 API 在非安全上下文不可用时的退路
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function flashHint(text, ms = 1600) {
  els.hint.textContent = text;
  clearTimeout(flashHint.timer);
  flashHint.timer = setTimeout(() => {
    els.hint.textContent = defaultHint();
  }, ms);
}

function defaultHint() {
  if (runtime.busy) return '正在生成…按 Esc 可以停下来';
  return 'Enter 发送 · Shift + Enter 换行';
}

// ---------------------------------------------------------------- 滚动

function distanceFromBottom() {
  return document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
}

function scrollToBottom(behavior = 'auto') {
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
}

function updatePinned() {
  const far = distanceFromBottom() > 120;
  runtime.pinned = !far;
  els.reachBottom.hidden = !far;
}

window.addEventListener('scroll', updatePinned, { passive: true });
window.addEventListener('resize', updatePinned);

els.jumpBottom.addEventListener('click', () => {
  scrollToBottom('smooth');
  runtime.pinned = true;
  els.reachBottom.hidden = true;
});

// ---------------------------------------------------------------- 渲染

function buildTurnNode(message, number) {
  const frag = els.template.content.cloneNode(true);
  const node = frag.querySelector('.exchange');
  node.dataset.id = message.id;

  frag.querySelector('[data-field="number"]').textContent = String(number).padStart(2, '0');
  frag.querySelector('[data-field="asked-at"]').textContent = formatClock(questionTime(message));

  const question = store.messages[store.messages.indexOf(message) - 1];
  frag.querySelector('[data-field="question"]').textContent = question ? question.content : '';

  const assistant = frag.querySelector('[data-field="answer-turn"]');
  assistant.dataset.status = message.status;
  node.__assistant = assistant;
  node.__answerBody = frag.querySelector('[data-field="answer"]');

  return { node, assistant, body: node.__answerBody };
}

/** 一条「答」归属的时间：用它前面那条提问的时间 */
function questionTime(assistantMessage) {
  const index = store.messages.indexOf(assistantMessage);
  const previous = store.messages[index - 1];
  return previous?.createdAt ?? assistantMessage.createdAt;
}

function paintTurn(node) {
  const assistant = node.__assistant;
  const body = node.__answerBody;
  const message = store.messages.find((m) => m.id === node.dataset.id);
  if (!message) return;

  const streaming = message.status === 'streaming';
  assistant.dataset.status = message.status;
  assistant.dataset.pending = streaming && !message.content ? 'true' : 'false';

  const html = renderMarkdown(message.content, { streaming });
  // 内容没变就不动 DOM，避免流式期间反复重排
  if (body.dataset.painted !== html) {
    body.innerHTML = html;
    body.dataset.painted = html;
  }

  const timing = node.querySelector('[data-field="answer-timing"]');
  if (message.finishedAt) {
    timing.textContent = formatDuration(message.finishedAt - message.createdAt);
  } else {
    timing.textContent = streaming ? '正在写' : '';
  }

  const status = node.querySelector('[data-field="answer-status"]');
  const tone = message.status === 'error' ? 'error' : 'info';
  status.dataset.tone = tone;
  status.hidden = !message.error && message.status !== 'interrupted';
  if (message.error) status.textContent = message.error;
  else if (message.status === 'interrupted') status.textContent = '已停止，写出的部分留在这里。可以让它重新生成。';

  const actions = node.querySelector('[data-field="answer-actions"]');
  const isLast = store.messages.at(-1)?.id === message.id;
  actions.dataset.visible = (!streaming && isLast && message.content) ? 'true' : 'false';
}

function render({ keepLive = false } = {}) {
  const assistants = store.messages.filter((m) => m.role === 'assistant');
  const isBlank = store.messages.length === 0;

  els.blank.hidden = !isBlank;
  els.clear.disabled = isBlank;
  els.exportButton.disabled = isBlank;

  if (keepLive && runtime.liveTurn && runtime.renderNode) {
    // 流式写入中：只增量重画这一条，其余不动（否则光标位置、滚动锚点都会跳）
    paintTurn(runtime.renderNode);
    return;
  }

  els.exchanges.replaceChildren();
  assistants.forEach((message, index) => {
    const { node } = buildTurnNode(message, index + 1);
    els.exchanges.appendChild(node);
    paintTurn(node);
  });

  if (runtime.liveTurn) {
    const live = els.exchanges.querySelector(`[data-id="${runtime.liveTurn.id}"]`);
    if (live) runtime.renderNode = live;
  }
}

function scheduleLivePaint() {
  if (runtime.frameHandle) return;
  runtime.frameHandle = requestAnimationFrame(() => {
    runtime.frameHandle = null;
    if (!runtime.renderNode) return;
    paintTurn(runtime.renderNode);
    if (runtime.pinned) scrollToBottom();
  });
}

function setBusy(busy) {
  runtime.busy = busy;
  els.input.disabled = busy;
  els.send.disabled = busy || !els.input.value.trim();
  els.send.textContent = busy ? '生成中' : '发送';
  els.stop.hidden = !busy;
  els.hint.textContent = defaultHint();
  updatePickerDisabled();
  updatePinned();
}

function updateSendState() {
  els.send.disabled = runtime.busy || !els.input.value.trim();
}

// ---------------------------------------------------------------- 输入框

function autoGrow() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 240)}px`;
}

els.input.addEventListener('input', () => {
  autoGrow();
  updateSendState();
});

els.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    els.composer.requestSubmit();
  }
  if (event.key === 'Escape' && runtime.busy) {
    event.preventDefault();
    stopGenerating();
  }
});

els.input.addEventListener('paste', () => {
  // 粘贴后再量一次高度
  requestAnimationFrame(autoGrow);
});

els.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  send();
});

els.stop.addEventListener('click', stopGenerating);

// 空页上的示例句：点一下填进输入框，用户还能改
els.starters.addEventListener('click', (event) => {
  const button = event.target.closest('.starter');
  if (!button) return;
  els.input.value = button.dataset.starter ?? '';
  autoGrow();
  updateSendState();
  els.input.focus();
});

// ---------------------------------------------------------------- 发送与流式读取

/**
 * 逐帧读取 SSE。
 * 用 fetch + ReadableStream 而不是 EventSource：需要 POST，且要能中途 abort。
 */
async function readEventStream(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw) continue;
        try {
          onEvent(JSON.parse(raw));
        } catch {
          /* 半截帧：丢掉，下一帧会补齐 */
        }
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
}

async function send(rawText) {
  const text = (rawText ?? els.input.value).trim();
  if (!text || runtime.busy) return;

  els.input.value = '';
  autoGrow();
  updateSendState();

  store.pushUser(text);
  const placeholder = store.pushAssistant();
  runtime.liveTurn = placeholder;
  runtime.renderNode = null;
  render();
  setBusy(true);
  if (runtime.pinned) scrollToBottom();

  // 只把「已完成的轮次 + 本条提问」发给服务端，不含刚建的空占位
  const history = store.messages
    .filter((m) => m.id !== placeholder.id)
    .map((m) => ({ role: m.role, content: m.content }));

  const controller = new AbortController();
  runtime.controller = controller;

  let sawDone = false;
  let doneReason = null;
  let streamError = null;
  let meta = null;
  let switchedNote = null;

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: history,
        sessionId: store.sessionId,
        // 页面选择框里的模型；服务端会校验并在不可用时自动换
        model: effectiveModel() || undefined,
      }),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      let detail = '';
      try {
        detail = (await response.json())?.error ?? '';
      } catch {
        /* 忽略 */
      }
      throw new Error(detail || `请求失败（HTTP ${response.status}）`);
    }

    await readEventStream(response, (event) => {
      switch (event.type) {
        case 'meta':
          meta = event;
          store.setMode(placeholder, event.mode);
          updateModeChip(event.mode, event.model);
          break;
        case 'model':
          // 服务端在第一段内容之前告知实际用的模型；与所选不同就是它替你换了
          store.setMode(placeholder, 'model');
          applyActiveModel(event.model, event.switchedFrom);
          break;
        case 'delta':
          if (typeof event.text === 'string' && event.text) {
            store.appendDelta(placeholder, event.text);
            scheduleLivePaint();
          }
          break;
        case 'error':
          streamError = event.message || '生成失败';
          break;
        case 'done':
          sawDone = true;
          doneReason = event.reason ?? 'stop';
          break;
        default:
          break;
      }
    });

    if (streamError) {
      store.finish(placeholder, placeholder.content ? 'interrupted' : 'error', streamError);
    } else if (doneReason === 'error') {
      // 服务端报告失败但没带 message（少见）：不能当成成功，否则错误被吞掉
      store.finish(
        placeholder,
        placeholder.content ? 'interrupted' : 'error',
        placeholder.content ? '生成中断，写出的部分保留在上方。' : '这一轮没有生成成功，可以重新生成。',
      );
    } else if (!placeholder.content) {
      store.finish(placeholder, 'error', '这轮没有收到任何内容，可以重新生成。');
    } else {
      store.finish(placeholder, 'done');
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      store.interrupt(placeholder);
    } else if (placeholder.content) {
      store.finish(placeholder, 'interrupted', `连接中断：${err.message}`);
    } else {
      store.finish(placeholder, 'error', `连不上服务端：${err.message}。确认 node server.mjs 还在运行。`);
    }
  } finally {
    runtime.controller = null;
    runtime.liveTurn = null;
    if (runtime.frameHandle) {
      cancelAnimationFrame(runtime.frameHandle);
      runtime.frameHandle = null;
    }
    render();
    setBusy(false);
    if (runtime.pinned) scrollToBottom();
    els.input.focus();
    if (switchedNote) {
      flashHint(`所选模型 ${switchedNote} 不可用，已自动改用 ${runtime.activeModel || '可用模型'}`, 4200);
    } else if (!sawDone && !streamError && meta === null) {
      // 一个帧都没收到：多半是服务端/网络问题，留个线索
      flashHint('这轮没有收到任何响应帧，检查服务端日志', 2600);
    }
  }
}

function stopGenerating() {
  runtime.controller?.abort();
}

/**
 * 重新生成：用同一条提问再问一次。
 *
 * 先把那条失败/中断的回答和它对应的提问一起摘掉，再把提问原样送回，
 * 这样列表里不会留下重复的提问 —— 一次提问永远对应一条回答。
 */
async function retryLast(message) {
  if (runtime.busy) return;
  const index = store.messages.indexOf(message);
  if (index < 1) return;
  const question = store.messages[index - 1];
  if (!question || question.role !== 'user') return;

  store.dropMessage(message);
  if (store.messages.at(-1)?.id === question.id) store.popLast();
  render();
  await send(question.content);
}

// ---------------------------------------------------------------- 模式提示

function updateModeChip(mode, model) {
  if (mode === 'model') {
    els.modeChip.dataset.mode = 'model';
    els.modeLabel.textContent = '真实模型';
  } else if (mode === 'mock') {
    els.modeChip.dataset.mode = 'mock';
    els.modeLabel.textContent = '离线回答';
  } else {
    els.modeChip.dataset.mode = 'unknown';
    els.modeLabel.textContent = '连接中…';
  }
  void model;
  updatePickerDisabled();
}

// ---------------------------------------------------------------- 模型选择

/**
 * 服务端回报本轮真正用的模型。
 *
 * 两种情况要区分开：
 *  · 用户选的模型被换掉了 → 把选择框同步过去，并提示，否则界面在说谎
 *  · 只是服务端探测结果 → 静默记录，不打扰
 */
function applyActiveModel(model, switchedFrom) {
  if (!model) return;

  const selectedBefore = els.modelSelect.value;
  if (selectedBefore === model) return;
  if (!runtime.availableModels.includes(model)) return;

  els.modelSelect.value = model;
  const lost = switchedFrom || selectedBefore;
  if (!lost || lost === model) return;

  // 用户选的那个被换掉了：界面必须跟着说实话，并停止让它继续生效
  switchedNote = lost;
  if (runtime.chosenModel === lost) {
    runtime.chosenModel = '';
    writeModelPreference('');
  }
}

/** 把可选项灌进选择框；当前生效的模型若不在列表里，临时补一项，免得显示空白 */
function populateModelPicker(models, current) {
  const options = [...models];
  if (current && !options.includes(current)) options.unshift(current);

  const selected = current && options.includes(current) ? current : options[0] ?? '';
  els.modelSelect.replaceChildren(
    ...options.map((id) => {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = id;
      if (id === selected) option.selected = true;
      return option;
    }),
  );
  els.modelPicker.hidden = options.length === 0;
}

function updatePickerDisabled() {
  // 生成过程中不许换模型：这一轮已经在用旧模型了，换了只会让人误以为生效了
  els.modelSelect.disabled = runtime.busy;
}

/** 页面加载时把可用模型列表拉回来 */
async function loadModelPicker() {
  if (runtime.config.mode !== 'model') {
    els.modelPicker.hidden = true;
    els.pickerLoading.hidden = true;
    return;
  }

  els.modelPicker.hidden = true;
  els.pickerLoading.hidden = false;
  try {
    const res = await fetch('/api/models');
    const data = await res.json();
    const models = Array.isArray(data.models) ? data.models : [];

    if (data.default) runtime.serverDefaultModel = data.default;
    runtime.availableModels = models;

    if (!models.length) {
      els.modelPicker.hidden = true;
      els.pickerLoading.hidden = true;
      if (data.note) flashHint(`模型列表不可用：${data.note}`, 4000);
      return;
    }

    // 用户选过的模型若已不在可用列表里，清掉偏好并回落到服务端默认
    if (runtime.chosenModel && !models.includes(runtime.chosenModel)) {
      flashHint(`之前选的 ${runtime.chosenModel} 已不可用，改回默认模型`, 4000);
      runtime.chosenModel = '';
      writeModelPreference('');
    }

    populateModelPicker(models, effectiveModel());
  } catch (err) {
    els.modelPicker.hidden = true;
    flashHint(`读取模型列表失败：${err.message}`, 4000);
  } finally {
    els.pickerLoading.hidden = true;
  }
}

els.modelSelect.addEventListener('change', () => {
  runtime.chosenModel = els.modelSelect.value;
  writeModelPreference(runtime.chosenModel);
  flashHint(`下一轮对话改用 ${runtime.chosenModel}`, 2600);
  els.input.focus();
});

function showNotice(config) {
  if (config.mode === 'mock') {
    els.notice.hidden = false;
    els.notice.innerHTML =
      '当前没有配置 API Key，正在使用<strong>本地离线回答</strong>：多轮记忆、逐字输出、刷新不丢都是真的，' +
      '只有「回答内容」是模板。接入真实模型：设置环境变量 <code>DEEPSEEK_API_KEY</code> 后重启服务。';
    return;
  }
  if (runtime.config.recovered) {
    els.notice.hidden = false;
    els.notice.textContent = '上次离开时有一轮还在生成，已经停下，写出的部分保留在上面。';
    return;
  }
  els.notice.hidden = true;
}

// ---------------------------------------------------------------- 清空与导出

els.clear.addEventListener('click', () => {
  if (store.messages.length === 0) return;
  els.confirmStrip.hidden = false;
  els.confirmClear.focus();
});

els.cancelClear.addEventListener('click', () => {
  els.confirmStrip.hidden = true;
  els.clear.focus();
});

els.confirmClear.addEventListener('click', () => {
  stopGenerating();
  store.clear();
  els.confirmStrip.hidden = true;
  render();
  setBusy(false);
  els.input.focus();
  scrollToBottom('smooth');
});

els.exportButton.addEventListener('click', () => {
  const lines = ['# 对谈录', ''];
  let index = 0;
  store.messages.forEach((message, i) => {
    if (message.role === 'user') {
      index += 1;
      lines.push(`## ${String(index).padStart(2, '0')}`, '', `**问**（${formatClock(message.createdAt)}）`, '', message.content, '');
    } else if (message.content) {
      lines.push(`**答**（${formatClock(message.createdAt)}）`, '', message.content, '');
    }
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  link.href = url;
  link.download = `对谈录-${stamp}.md`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  flashHint('已导出为 Markdown');
});

// ---------------------------------------------------------------- 事件委托

els.exchanges.addEventListener('click', (event) => {
  const copyCode = event.target.closest('[data-copy-code]');
  if (copyCode) {
    const block = copyCode.closest('.code-block');
    const code = block?.querySelector('code')?.textContent ?? '';
    copyText(code).then((ok) => flashHint(ok ? '代码已复制' : '复制失败，请手动选择'));
    return;
  }

  const action = event.target.closest('[data-action]');
  if (!action) return;
  const node = action.closest('.exchange');
  const message = store.messages.find((m) => m.id === node?.dataset.id);
  if (!message) return;

  if (action.dataset.action === 'copy') {
    copyText(markdownToPlain(message.content)).then((ok) =>
      flashHint(ok ? '回答已复制' : '复制失败，请手动选择'),
    );
  } else if (action.dataset.action === 'retry') {
    retryLast(message);
  }
});

// ---------------------------------------------------------------- 跨标签页同步

window.addEventListener('storage', (event) => {
  if (event.key !== 'duitanlu.conversation.v1') return;
  if (runtime.busy) return; // 本页正在生成时不打断

  let snapshot = null;
  try {
    snapshot = JSON.parse(event.newValue ?? 'null');
  } catch {
    return;
  }
  if (!snapshot || !Array.isArray(snapshot.messages)) return;
  if (snapshot.sessionId !== store.sessionId) return;

  // 别的标签页改了对话：读回来跟随显示（写入方已经落盘，这里不再回写）
  store.adopt(snapshot.messages, { persist: false });
  runtime.liveTurn = null;
  runtime.renderNode = null;
  render();
  setBusy(false);
});

// ---------------------------------------------------------------- 启动

async function boot() {
  render();
  setBusy(false);
  autoGrow();
  updateSendState();

  // 1) 问服务端现在是哪种模式
  try {
    const response = await fetch('/api/config');
    runtime.config = await response.json();
    runtime.config.recovered = store.recoveredInterrupted > 0;
    if (runtime.config.defaultModel) runtime.serverDefaultModel = runtime.config.defaultModel;
    if (runtime.config.model && runtime.config.mode === 'model') runtime.activeModel = runtime.config.model;
    updateModeChip(runtime.config.mode, runtime.config.model);
    els.notice.hidden = true;
    showNotice(runtime.config);
  } catch {
    updateModeChip('unknown', null);
    els.notice.hidden = false;
    els.notice.textContent = '读不到服务端配置，界面仍可用，但发送会失败——确认 node server.mjs 正在运行。';
  }

  // 2) 拉取可用模型，填进选择框（离线模式会直接跳过）
  await loadModelPicker();

  // 2) 本地为空时，尝试从服务端兜底副本恢复
  if (store.messages.length === 0) {
    try {
      const response = await fetch(`/api/history/${store.sessionId}`);
      const saved = await response.json();
      if (Array.isArray(saved?.turns) && saved.turns.length) {
        store.adopt(saved.turns);
        render();
        flashHint('本地没有记录，已从服务端兜底副本恢复这轮对话', 3000);
      }
    } catch {
      /* 兜底失败不影响使用 */
    }
  }

  render();
  updatePinned();
  els.input.focus();
}

boot();
