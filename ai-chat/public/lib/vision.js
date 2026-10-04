// 哪些模型能看图 —— 前端的单一来源
//
// 服务端有一份等价的判断（lib/error-mapping.mjs 里的 supportsVision）。
// 两份必须保持一致：前端用它给选择框加「可看图」标记，服务端用它决定是否放行图片。
// 之所以不共用一个文件：public/ 是浏览器模块（无构建），lib/ 是 Node 模块，两边
// 的加载方式不同。所以这里刻意把规则写得极简、一眼能比对。
//
// 关键事实：**DeepSeek 全系不支持图片**。用户在 DeepSeek 模型上贴图，
// 上游会直接拒绝 —— 界面必须提前说清楚，而不是让他发出去才收到报错。

const VISION_MODEL =
  /gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4-vision|gpt-5|gpt-6|claude-(3|opus|sonnet|haiku|fable)|gemini|grok-[2-9]|qwen-?vl|glm-4v|internvl|llava|pixtral|vision/i;

export function supportsVision(model) {
  if (!model || typeof model !== 'string') return false;
  return VISION_MODEL.test(model);
}

/** 从一批模型里挑出能看图的，用于「换一个能看图的模型」提示 */
export function visionModels(ids) {
  return (ids ?? []).filter((id) => typeof id === 'string' && supportsVision(id));
}
