// 语音输入（Web Speech API）
//
// 现实约束：SpeechRecognition 在各浏览器实现差异很大 ——
// Chrome / Edge 支持（走云端识别），Firefox 长期不支持，Safari 支持但行为不同。
// 所以这个模块的职责是「探测可用性 + 封装成统一接口 + 把不可用说清楚」，
// 而不是假设它一定存在。

const SpeechRecognitionCtor =
  typeof window !== 'undefined'
    ? window.SpeechRecognition || window.webkitSpeechRecognition || null
    : null;

/** 浏览器是否支持语音识别 */
export function isSpeechSupported() {
  return Boolean(SpeechRecognitionCtor);
}

/** 不支持时给用户的话 —— 要说清为什么，而不是只把按钮藏起来 */
export function unsupportedReason() {
  if (isSpeechSupported()) return '';
  return '这个浏览器不支持语音识别。Chrome 或 Edge 可以用；Firefox 暂不支持。';
}

/**
 * 创建一个语音输入会话。
 *
 * @param {{lang?:string, onInterim?:(text:string)=>void, onFinal?:(text:string)=>void,
 *          onError?:(message:string)=>void, onEnd?:()=>void}} handlers
 */
export function createSpeechInput({
  lang = 'zh-CN',
  onInterim = () => {},
  onFinal = () => {},
  onError = () => {},
  onEnd = () => {},
} = {}) {
  if (!SpeechRecognitionCtor) {
    return {
      supported: false,
      start() {
        onError(unsupportedReason());
      },
      stop() {},
      abort() {},
      get listening() {
        return false;
      },
    };
  }

  const recognition = new SpeechRecognitionCtor();
  recognition.lang = lang;
  recognition.continuous = true;      // 允许边说边停，不要说完一句就结束
  recognition.interimResults = true;  // 边说边显示，用户才知道识别到了什么
  recognition.maxAlternatives = 1;

  let listening = false;
  let finalText = '';

  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const text = result[0]?.transcript ?? '';
      if (result.isFinal) finalText += text;
      else interim += text;
    }
    if (interim) onInterim(finalText + interim);
    else if (finalText) onInterim(finalText);
  };

  recognition.onerror = (event) => {
    const code = event?.error || 'unknown';
    const messages = {
      'not-allowed': '麦克风权限被拒绝。在浏览器地址栏的权限设置里允许麦克风后重试。',
      'service-not-allowed': '浏览器禁用了语音识别服务，可能是网络或安全策略限制。',
      'no-speech': '没有听到声音，再试一次。',
      'audio-capture': '找不到麦克风设备，检查一下是否插好或被别的程序占用。',
      network: '语音识别服务连接失败，通常是网络问题。',
      aborted: '',
    };
    const message = messages[code] ?? `语音识别出错（${code}）`;
    if (message) onError(message);
  };

  recognition.onend = () => {
    listening = false;
    if (finalText.trim()) onFinal(finalText.trim());
    onEnd();
  };

  return {
    supported: true,
    start() {
      if (listening) return;
      finalText = '';
      try {
        recognition.start();
        listening = true;
      } catch (err) {
        // 连续快速点击时 start 会抛 InvalidStateError
        onError(`启动语音识别失败：${err.message}`);
      }
    },
    stop() {
      if (!listening) return;
      try {
        recognition.stop();
      } catch {
        /* 已经停了 */
      }
    },
    abort() {
      try {
        recognition.abort();
      } catch {
        /* 已经停了 */
      }
      listening = false;
    },
    get listening() {
      return listening;
    },
  };
}
