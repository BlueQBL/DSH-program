import { computed, createSSRApp, mergeProps, nextTick, onBeforeUnmount, onMounted, reactive, ref, unref, useSSRContext, watch } from "vue";
import { renderToString, ssrIncludeBooleanAttr, ssrInterpolate, ssrLooseContain, ssrRenderAttr, ssrRenderAttrs, ssrRenderClass, ssrRenderComponent, ssrRenderList, ssrRenderStyle } from "vue/server-renderer";
//#region src/game/roles.js
/**
* 角色定义 · 9 人标准局
* 3 狼人 / 预言家 / 女巫 / 猎人 / 3 平民
*
* 本文件只描述"角色是什么"，不含任何流程逻辑。
*/
var ROLE = {
	WOLF: "wolf",
	SEER: "seer",
	WITCH: "witch",
	HUNTER: "hunter",
	VILLAGER: "villager"
};
var TEAM = {
	WOLF: "wolf",
	GOOD: "good"
};
/** 9 人局牌堆 */
var DECK_9 = [
	ROLE.WOLF,
	ROLE.WOLF,
	ROLE.WOLF,
	ROLE.SEER,
	ROLE.WITCH,
	ROLE.HUNTER,
	ROLE.VILLAGER,
	ROLE.VILLAGER,
	ROLE.VILLAGER
];
var GOD_ROLES = [
	ROLE.SEER,
	ROLE.WITCH,
	ROLE.HUNTER
];
var ROLE_META = {
	[ROLE.WOLF]: {
		id: ROLE.WOLF,
		name: "狼人",
		team: TEAM.WOLF,
		tone: "blood",
		sigil: "狼",
		tagline: "夜里睁眼，与同伴共刀一人",
		brief: "白天伪装成好人，夜里和同伴一起猎杀。你可以悍跳预言家，也可以藏到最后一轮。",
		win: "杀光三名神职，或杀光三名平民，即屠边获胜。",
		nightHint: "与同伴商定今晚要杀的人。"
	},
	[ROLE.SEER]: {
		id: ROLE.SEER,
		name: "预言家",
		team: TEAM.GOOD,
		tone: "moon",
		sigil: "验",
		tagline: "夜里查验一人，是狼是好人",
		brief: "你是好人唯一的眼睛。第一晚就要开始验人，白天适时起跳报验人结果。",
		win: "放逐或杀死全部三只狼人。",
		nightHint: "选择一名玩家查验身份。"
	},
	[ROLE.WITCH]: {
		id: ROLE.WITCH,
		name: "女巫",
		team: TEAM.GOOD,
		tone: "moss",
		sigil: "药",
		tagline: "一瓶解药，一瓶毒药，各只能用一次",
		brief: "你知道每晚谁被狼刀。解药可救回一人，毒药可毒杀一人，同夜不可双药齐发。",
		win: "放逐或杀死全部三只狼人。",
		nightHint: "决定今晚是否用药。"
	},
	[ROLE.HUNTER]: {
		id: ROLE.HUNTER,
		name: "猎人",
		team: TEAM.GOOD,
		tone: "brass",
		sigil: "枪",
		tagline: "出局时可开枪带走一人",
		brief: "你掌握着最后一击。被投票放逐或被狼刀时可开枪，但被女巫毒死则无法开枪。",
		win: "放逐或杀死全部三只狼人。",
		nightHint: "你没有夜间技能，闭眼等待天亮。"
	},
	[ROLE.VILLAGER]: {
		id: ROLE.VILLAGER,
		name: "平民",
		team: TEAM.GOOD,
		tone: "candle",
		sigil: "民",
		tagline: "没有技能，只有一双眼睛",
		brief: "你没有夜晚技能，全部筹码就是白天的推理与投票。听发言，盘逻辑，别被人带偏。",
		win: "放逐或杀死全部三只狼人。",
		nightHint: "你没有夜间技能，闭眼等待天亮。"
	}
};
/**
* 九位村民。每人一句性格底色，用来让 AI 的发言口吻彼此区分。
* tone 决定了发言模板的语气池。
*/
var PERSONAS = [
	{
		name: "老陈",
		epithet: "沉默的看门人",
		tone: "steady",
		hue: 28
	},
	{
		name: "阿蛮",
		epithet: "急了就拍桌",
		tone: "brash",
		hue: 358
	},
	{
		name: "小满",
		epithet: "记账一样记发言",
		tone: "careful",
		hue: 152
	},
	{
		name: "铁柱",
		epithet: "话少，票不软",
		tone: "blunt",
		hue: 22
	},
	{
		name: "白露",
		epithet: "眼神很冷",
		tone: "cold",
		hue: 205
	},
	{
		name: "阿七",
		epithet: "从不把话说死",
		tone: "sly",
		hue: 275
	},
	{
		name: "长庚",
		epithet: "话里带旧理",
		tone: "elder",
		hue: 42
	},
	{
		name: "青禾",
		epithet: "温和，但记仇",
		tone: "gentle",
		hue: 168
	},
	{
		name: "半仙",
		epithet: "信命也信逻辑",
		tone: "mystic",
		hue: 320
	}
];
//#endregion
//#region src/game/setup.js
/**
* 开局：发牌、建席位、初始化面板
*/
var uid = 0;
function createRng(seed) {
	let s = seed >>> 0 || Date.now() >>> 0;
	return function rng() {
		s ^= s << 13;
		s >>>= 0;
		s ^= s >> 17;
		s ^= s << 5;
		s >>>= 0;
		return s / 4294967296;
	};
}
function shuffle(list, rng) {
	const a = list.slice();
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}
/**
* @param {object} opts
*  - humanRole: ROLE.* | 'random'
*  - rng: ()=>number
*/
function createMatch({ humanRole = "random", rng = Math.random } = {}) {
	const roles = shuffle(DECK_9, rng).slice();
	if (humanRole && humanRole !== "random") {
		const at = roles.indexOf(humanRole);
		if (at >= 0) [roles[0], roles[at]] = [roles[at], roles[0]];
	}
	const personas = shuffle(PERSONAS, rng);
	const players = Array.from({ length: 9 }, (_, i) => {
		const isHuman = i === 0;
		const persona = isHuman ? {
			name: "你",
			epithet: "坐在正下方",
			tone: "steady",
			hue: 190
		} : personas[i - 1];
		return {
			id: i,
			seat: i,
			name: persona.name,
			persona,
			hue: persona.hue,
			role: roles[i],
			team: ROLE_META[roles[i]].team,
			alive: true,
			isHuman,
			deathDay: null,
			deathReason: null,
			deathNote: "",
			checks: [],
			antidote: true,
			poison: true,
			claimsMade: 0,
			spokeToday: false,
			votedToday: false,
			swayed: 0
		};
	});
	return {
		id: `m${++uid}`,
		seed: Math.floor(rng() * 1e9),
		rng,
		day: 1,
		phase: "lobby",
		phaseLabel: "等待开局",
		nightStep: null,
		nightKill: null,
		poisonTarget: null,
		players,
		humanId: 0,
		log: [],
		claims: [],
		speeches: [],
		voteHistory: [],
		deaths: [],
		supported: {},
		attacked: {},
		influence: {},
		publicClaimsRole: {},
		wolfPush: null,
		winner: null,
		winReason: "",
		revealAll: false,
		startedAt: Date.now(),
		endedAt: null,
		turn: null,
		awaiting: null,
		currentSpeech: null,
		lastTally: null,
		audit: []
	};
}
function logEntry(state, kind, text, extra = {}) {
	const entry = {
		id: state.log.length + 1,
		day: state.day,
		phase: state.phase,
		kind,
		text,
		...extra
	};
	state.log.push(entry);
	return entry;
}
function checkWin(state) {
	const alive = state.players.filter((p) => p.alive);
	const aliveWolves = alive.filter((p) => p.role === ROLE.WOLF);
	const aliveGods = alive.filter((p) => GOD_ROLES.includes(p.role));
	const aliveVillagers = alive.filter((p) => p.role === ROLE.VILLAGER);
	if (aliveWolves.length === 0) return {
		winner: TEAM.GOOD,
		reason: "三只狼全部出局，村子活下来了。"
	};
	if (aliveGods.length === 0) return {
		winner: TEAM.WOLF,
		reason: "神职全部出局——狼人屠神成功。"
	};
	if (aliveVillagers.length === 0) return {
		winner: TEAM.WOLF,
		reason: "平民全部出局——狼人屠民成功。"
	};
	if (aliveWolves.length >= alive.length - aliveWolves.length) return {
		winner: TEAM.WOLF,
		reason: "狼人数量已不少于好人，投票再也拦不住他们了。"
	};
	return null;
}
/** 死亡结算（唯一入口，负责记日志与胜负） */
function killPlayer(state, playerId, reason, note = "") {
	const p = state.players.find((x) => x.id === playerId);
	if (!p || !p.alive) return null;
	p.alive = false;
	p.deathDay = state.day;
	p.deathReason = reason;
	p.deathNote = note;
	state.deaths.push({
		playerId,
		day: state.day,
		reason,
		note
	});
	return p;
}
//#endregion
//#region src/game/speech.js
/**
* 发言生成
*
* 目标：让机器人说的话"内容是真的"——每一句都引用本局真实发生过的事
* （谁跳了预言家、谁验了谁、谁上票给了谁、谁死了），而不是随机套话。
* 句式随人格（PERSONAS.tone）与局势变化，避免全场一个腔调。
*/
var seatLabel = (p) => p ? `${p.seat + 1}号` : "某位";
var fullLabel = (p) => p ? `${p.seat + 1}号${p.name}` : "某位";
function listLabels(players) {
	return players.map(seatLabel).join("、");
}
var TONE = {
	steady: {
		open: [
			"我说一下。",
			"我按顺序讲。",
			"先听我把话讲完。",
			"我这里有一条线，讲给大家听。"
		],
		close: [
			"就这些。",
			"我说完了。",
			"剩下的你们自己盘。",
			"我票已经定了。"
		],
		hedge: [
			"我不敢把话说死",
			"我保留一点余地",
			"这话可能不好听"
		]
	},
	brash: {
		open: [
			"我直接说了！",
			"别绕圈子，我讲重点。",
			"今天我把话讲难听点。",
			"我先开团。"
		],
		close: [
			"不服就来投我。",
			"我就这个态度。",
			"出他，错了算我的。",
			"别磨叽，上票。"
		],
		hedge: [
			"我不管别的",
			"我懒得听解释",
			"反正我认定了"
		]
	},
	careful: {
		open: [
			"我把发言记了一下。",
			"我按时间线捋一遍。",
			"我这边有几条记录。",
			"我不急，先说观察到的东西。"
		],
		close: [
			"我的票先放这儿。",
			"以上是我的复盘。",
			"我说得慢，但都是真的。",
			"大家核对一下时间线。"
		],
		hedge: [
			"我倾向于",
			"从记录上看",
			"我不能百分百确定"
		]
	},
	blunt: {
		open: [
			"话不多。",
			"我说三句。",
			"我讲结论。",
			"不铺垫了。"
		],
		close: [
			"就这样。",
			"票给他。",
			"完事。"
		],
		hedge: [
			"差不离",
			"大概率",
			"我心里有数"
		]
	},
	cold: {
		open: [
			"我只讲逻辑。",
			"情绪没有意义，听推论。",
			"我不评价人，只评价行为。",
			"让我把话说完。"
		],
		close: [
			"逻辑到此。",
			"结论你们自己下。",
			"我说完了。"
		],
		hedge: [
			"概率上",
			"按现有信息",
			"除非我漏了什么"
		]
	},
	sly: {
		open: [
			"我不急着站边。",
			"先说个有意思的地方。",
			"我给大家留个钩子。",
			"我话不说满。"
		],
		close: [
			"票我先捏着。",
			"看后面谁露马脚。",
			"我先到这。"
		],
		hedge: [
			"有意思的是",
			"我不好说，但",
			"你们注意到没有"
		]
	},
	elder: {
		open: [
			"老理儿是这样。",
			"我讲个老规矩。",
			"这局我看了很久了。",
			"我年纪大，话慢。"
		],
		close: [
			"话尽于此。",
			"听不听在你们。",
			"我这一票不轻。"
		],
		hedge: [
			"照常理讲",
			"以我这点经验",
			"我不敢托大"
		]
	},
	gentle: {
		open: [
			"我轻声说两句。",
			"我不太会吵架，但我有想法。",
			"我说得慢，别打断我。",
			"我把我知道的讲出来。"
		],
		close: [
			"我说完了，谢谢。",
			"希望大家投得准。",
			"以上。"
		],
		hedge: [
			"我可能想错了",
			"我个人感觉",
			"我有点犹豫"
		]
	},
	mystic: {
		open: [
			"我先看个气口。",
			"这局的味道不太对。",
			"我掐了一下，讲给你们。",
			"我不说玄的，我说实的——但实里也有玄。"
		],
		close: [
			"信不信由你。",
			"天意如此，票在我手。",
			"我说完了。"
		],
		hedge: [
			"我算不准",
			"这局气场乱",
			"我半信半疑"
		]
	}
};
function tone$1(p) {
	return TONE[p?.persona?.tone] || TONE.steady;
}
var pick$1 = (rng, arr) => arr[Math.floor(rng() * arr.length)];
function aliveOf$1(state) {
	return state.players.filter((p) => p.alive);
}
function claimersOf(state, role) {
	return state.claims.filter((c) => c.role === role);
}
/** 某人最后一轮把票投给了谁 */
function lastVoteOf(state, playerId) {
	for (let i = state.voteHistory.length - 1; i >= 0; i--) {
		const v = state.voteHistory[i].votes[playerId];
		if (v !== void 0 && v !== null) return v;
	}
	return null;
}
function byId$1(state, id) {
	return state.players.find((p) => p.id === id) || null;
}
/** 谁在上一轮上票给了"我" */
function whoVotedAgainst(state, id) {
	const last = state.voteHistory[state.voteHistory.length - 1];
	if (!last) return [];
	return Object.entries(last.votes).filter(([, t]) => t === id).map(([voter]) => byId$1(state, Number(voter))).filter(Boolean);
}
/**
* @param {object} state   全局面板（只读使用）
* @param {object} me      发言者
* @param {object} intent  { kind, ... } 发言意图
* @param {function} rng
* @returns {string}
*/
function compose(state, me, intent, rng = Math.random) {
	const t = tone$1(me);
	const parts = [];
	if (rng() < .72) parts.push(pick$1(rng, t.open));
	switch (intent.kind) {
		case "claim-seer":
			parts.push(claimSeer(state, me, intent, rng));
			break;
		case "report-check":
			parts.push(reportCheck(state, me, intent, rng));
			break;
		case "counter-claim":
			parts.push(counterClaim(state, me, intent, rng));
			break;
		case "defend-self":
			parts.push(defendSelf(state, me, intent, rng));
			break;
		case "accuse":
			parts.push(accuse(state, me, intent, rng));
			break;
		case "support":
			parts.push(support(state, me, intent, rng));
			break;
		case "villager-read":
			parts.push(villagerRead(state, me, intent, rng));
			break;
		case "wolf-cover":
			parts.push(wolfCover(state, me, intent, rng));
			break;
		case "last-words":
			parts.push(lastWords$1(state, me, intent, rng));
			break;
		default: parts.push(villagerRead(state, me, intent, rng));
	}
	if (intent.voteTarget && intent.kind !== "last-words" && rng() < .8) parts.push(pick$1(rng, [
		`我的票投${seatLabel(intent.voteTarget)}。`,
		`先上${seatLabel(intent.voteTarget)}一票。`,
		`票给${seatLabel(intent.voteTarget)}，不动摇。`,
		`这轮我跟${seatLabel(intent.voteTarget)}。`
	]));
	if (rng() < .62) parts.push(pick$1(rng, t.close));
	return parts.filter(Boolean).join("");
}
function claimSeer(state, me, intent, rng) {
	const checks = intent.checks || [];
	const head = pick$1(rng, [
		"我是预言家。",
		"我跳预言家。",
		"预言家在这儿，别找错人。",
		"我不藏了，我是预言家。"
	]);
	if (!checks.length) return `${head}今晚的验人我会报出来。`;
	const lines = checks.map((c) => {
		const target = byId$1(state, c.targetId);
		const verdict = c.result === ROLE.WOLF ? "查杀" : "金水";
		return `第${c.day}晚验的${seatLabel(target)}，${verdict}`;
	});
	const tail = checks.some((c) => c.result === ROLE.WOLF) ? pick$1(rng, [
		"。查杀优先，今天先把他送出去。",
		"。有查杀先出查杀，这是死规矩。",
		"。狼已经露头了，别再散票。"
	]) : pick$1(rng, [
		"。后面我还会继续验，你们跟我的票。",
		"。金水就先记着，我明晚会接着验。",
		"。我这条线是干净的，信我的跟我走。"
	]);
	return `${head}${lines.join("，")}${tail}`;
}
function reportCheck(state, me, intent, rng) {
	const c = intent.check;
	if (!c) return "我今晚验的人手上有结果，一会儿报。";
	const target = byId$1(state, c.targetId);
	const wolf = c.result === ROLE.WOLF;
	return `${pick$1(rng, [
		`我接着报验人。`,
		`预言家的第二条信息。`,
		`昨晚的结果出来了。`
	])}${wolf ? `${seatLabel(target)}是查杀。` : `${seatLabel(target)}是金水。`}${wolf ? pick$1(rng, [
		"他必须今天走。",
		"谁保他，谁就有问题。",
		"这只狼藏得挺深，但我验到了。"
	]) : pick$1(rng, [
		"这个人可以放心。",
		"他是干净的，别浪费票。",
		"谁咬他，我就盯谁。"
	])}`;
}
function counterClaim(state, me, intent, rng) {
	const rival = intent.rival;
	const lines = (intent.checks || []).map((c) => {
		return `我验的是${seatLabel(byId$1(state, c.targetId))}，${c.result === ROLE.WOLF ? "查杀" : "金水"}`;
	});
	return pick$1(rng, [
		`我是真预言家。${seatLabel(rival)}是悍跳的狼，${lines.join("，")}。好人别跟他走。`,
		`${seatLabel(rival)}跳预言家，那我必须出来。我才是真的，${lines.join("，")}。`,
		`对跳了。我是真预言家，${seatLabel(rival)}是狼。${lines.join("，")}。今天先出他。`
	]);
}
function defendSelf(state, me, intent, rng) {
	const accuser = intent.accuser;
	const vs = whoVotedAgainst(state, me.id);
	const bits = [];
	if (accuser) bits.push(pick$1(rng, [
		`${seatLabel(accuser)}给我扣了个查杀，理由站不住。`,
		`${seatLabel(accuser)}咬我，可他自己一句话都没验清。`,
		`${seatLabel(accuser)}今天突然冲我来，太急了。`
	]));
	if (vs.length) bits.push(`${listLabels(vs)}上的票，我记着。`);
	bits.push(pick$1(rng, [
		"我是好人，出我等于白送一只狼。",
		"你们今天把我推出去，明天狼就多一刀。",
		"我没什么可辩的，我本来就干净。",
		"狼最喜欢看好人自己咬自己。"
	]));
	return bits.join("");
}
function accuse(state, me, intent, rng) {
	const target = intent.target;
	const reasons = [];
	const lastVote = lastVoteOf(state, target.id);
	if (lastVote !== null && lastVote !== me.id) {
		const lp = byId$1(state, lastVote);
		reasons.push(pick$1(rng, [`他上一轮把票挂在${seatLabel(lp)}身上，那票很脏。`, `他给${seatLabel(lp)}上票的时机太怪。`]));
	}
	if (state.speeches.filter((s) => s.playerId === target.id).length <= 1) reasons.push("他发言一直在划水，不表态、不担责。");
	const defs = state.supported[target.id] || [];
	if (defs.length) {
		const d = byId$1(state, defs[defs.length - 1]);
		if (d && d.alive) reasons.push(pick$1(rng, [`他一直在保${seatLabel(d)}，两个人像一伙的。`, `他替${seatLabel(d)}说话，这不像好人干的事。`]));
	}
	if (!reasons.length) reasons.push(pick$1(rng, [
		"他整场没有给过任何有效信息。",
		"他的每句话都在两边讨好。",
		"我找不到他做过一件对好人有帮助的事。"
	]));
	return pick$1(rng, [
		`我怀疑${seatLabel(target)}。`,
		`今天我的目标是${seatLabel(target)}。`,
		`我把焦点放在${seatLabel(target)}身上。`
	]) + reasons.slice(0, 2).join("");
}
function support(state, me, intent, rng) {
	const target = intent.target;
	return pick$1(rng, [
		`我站${seatLabel(target)}，他的逻辑是通的。`,
		`我认${seatLabel(target)}是好人，我跟他票。`,
		`${seatLabel(target)}发言干净，我愿意压他。`
	]);
}
function villagerRead(state, me, intent, rng) {
	aliveOf$1(state).filter((p) => p.id !== me.id);
	const claimers = claimersOf(state, ROLE.SEER);
	const bits = [];
	if (claimers.length >= 2) {
		const names = claimers.map((c) => seatLabel(byId$1(state, c.playerId))).join("和");
		bits.push(pick$1(rng, [`${names}对跳预言家，里面至少有一只狼。`, `两个预言家里必有一狼，今天必须处理一个。`]));
	} else if (claimers.length === 1) {
		const c = byId$1(state, claimers[0].playerId);
		bits.push(pick$1(rng, [`场上只有${seatLabel(c)}跳预言家，暂时没对跳。`, `${seatLabel(c)}是唯一预言家，我暂且听他的。`]));
	}
	const deaths = state.deaths.filter((d) => d.day >= state.day - 1);
	if (deaths.length) bits.push(`昨晚倒了${listLabels(deaths.map((d) => byId$1(state, d.playerId)))}，这刀有讲究。`);
	if (!bits.length) bits.push(pick$1(rng, [`现在信息太少，我只能从发言里挑刺。`, `第一轮没什么实锤，我先听你们说。`]));
	const suspect = intent.target;
	if (suspect) bits.push(pick$1(rng, [`${seatLabel(suspect)}让我最不舒服。`, `${seatLabel(suspect)}的发言我过不去。`]));
	return bits.join("");
}
function wolfCover(state, me, intent, rng) {
	const target = intent.target;
	return pick$1(rng, [
		`我是平民，我谈感受。${target ? seatLabel(target) + "今天很急，我觉得有问题。" : "场上有人一直在带节奏。"}`,
		`我不跳任何身份，我说逻辑。${target ? seatLabel(target) + "的投票很不干净。" : "我盯着几个不说话的人。"}`,
		`以我的位置，我只能盘票型。${target ? seatLabel(target) + "那票说不通。" : "有人在保人。"}`
	]);
}
function lastWords$1(state, me, intent, rng) {
	const meta = ROLE_META[me.role];
	if (me.role === ROLE.WOLF) return pick$1(rng, [
		"我是平民，你们出错了，狼还在场上。",
		"行，我走了。但我提醒一句，你们今天票型很散，狼在笑。",
		"我不是狼。你们回头看看是谁把我推上去的。"
	]);
	if (me.role === ROLE.SEER && intent.checks?.length) return `我是真预言家。把验人留给你们：${intent.checks.map((c) => `${seatLabel(byId$1(state, c.targetId))}${c.result === ROLE.WOLF ? "查杀" : "金水"}`).join("，")}。好人别走错路。`;
	return pick$1(rng, [
		`我是${meta.name}，你们今天送错了人。好好看看票型。`,
		"我走了。剩下的局，别被带偏。",
		"记住我说的话，明天你们会想起来的。"
	]);
}
//#endregion
//#region src/game/ai.js
/**
* 机器人决策
*
* 设计原则：机器人不"作弊"。每个决策只看它身份允许它知道的东西：
*   · 狼人知道同伴是谁
*   · 预言家知道自己验过谁
*   · 其余人只能看公开信息：谁跳了身份、谁验了谁、谁给谁上票、谁死了
* 怀疑度模型（computeSuspicion）是好人阵营所有推理的共同底座，
* 它从真实的狼人杀经验法则出发，而不是随机数。
*/
var wolvesOf = (state) => state.players.filter((p) => p.role === ROLE.WOLF);
var aliveOf = (state) => state.players.filter((p) => p.alive);
var aliveWolves = (state) => wolvesOf(state).filter((p) => p.alive);
var byId = (state, id) => state.players.find((p) => p.id === id) || null;
var clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
/**
* 从 viewer 的视角给每个存活玩家打怀疑分。
* 分数越高越像狼。
*/
function computeSuspicion(state, viewer, rng = Math.random) {
	const score = {};
	for (const p of state.players) score[p.id] = 0;
	const iAmWolf = viewer.role === ROLE.WOLF;
	const iAmSeer = viewer.role === ROLE.SEER;
	const myTeam = iAmWolf ? wolvesOf(state).map((p) => p.id) : [];
	const trusted = /* @__PURE__ */ new Set([viewer.id]);
	const known = /* @__PURE__ */ new Set();
	if (iAmWolf) myTeam.forEach((id) => trusted.add(id));
	if (iAmSeer) for (const c of viewer.checks || []) if (c.result === ROLE.WOLF) known.add(c.targetId);
	else trusted.add(c.targetId);
	for (const id of known) score[id] += 12;
	const claims = state.claims.filter((c) => c.role === ROLE.SEER);
	/**
	* 信任块：如果场上有一个明显更可信的预言家，好人会结成票块——
	* 信他的金水，出他的查杀。这是好人阵营唯一能对抗"三狼同票"的东西，
	* 也是真实牌局里村庄的运作方式。
	*/
	if (!iAmWolf) {
		const ranked = claims.map((c) => ({
			c,
			cred: claimCredibility(state, c)
		})).sort((a, b) => b.cred - a.cred);
		const best = ranked[0];
		const runnerUp = ranked[1];
		if (best) {
			const mine = best.c.playerId === viewer.id;
			const margin = runnerUp ? best.cred - runnerUp.cred : 99;
			if (!iAmSeer && best.cred > 0 && margin >= .25) {
				/**
				* 结块不是无条件的。真实牌局里永远有一两个人不认这个预言家，
				* 村庄的纪律性是"大致一致"，不是"全体一致"。
				* 这一条 dissent 是狼人唯一的翻盘空间，也是好人偶尔翻车的原因。
				*/
				const belief = clamp(.6 + best.cred * .12, .6, .94);
				if (rng() < belief) for (const chk of best.c.checks) if (chk.result === ROLE.WOLF) score[chk.targetId] += 8;
				else {
					trusted.add(chk.targetId);
					score[chk.targetId] -= 3;
				}
			} else if (mine && runnerUp && claimCredibility(state, runnerUp.c) < .4) score[runnerUp.c.playerId] += 6;
		}
	}
	if (claims.length >= 2) {
		const ranked = claims.map((c) => ({
			c,
			cred: claimCredibility(state, c)
		})).sort((a, b) => b.cred - a.cred);
		ranked.forEach((r, i) => {
			const penalty = i === 0 ? -2.5 : i === ranked.length - 1 ? 7 : 3.5;
			score[r.c.playerId] += iAmSeer && r.c.playerId !== viewer.id ? 12 : penalty;
		});
		const best = ranked[0].c.playerId;
		for (const vh of state.voteHistory) for (const [voter, target] of Object.entries(vh.votes)) if (target === best && Number(voter) !== best && !trusted.has(Number(voter))) score[Number(voter)] += 2.2;
	} else if (claims.length === 1) {
		const c = claims[0];
		const claimer = byId(state, c.playerId);
		if (iAmSeer && c.playerId !== viewer.id) score[c.playerId] += 14;
		else if (claimer && claimer.alive) {
			const nightsOut = state.day - c.day;
			if (nightsOut >= 2) score[c.playerId] += clamp(nightsOut - 1, 0, 3) * 1.4;
			for (const chk of c.checks) if (chk.result === ROLE.GOOD && !byId(state, chk.targetId)?.alive) score[c.playerId] -= 1.8;
		}
		if (!iAmSeer) {
			for (const chk of c.checks) if (chk.result === ROLE.WOLF) score[chk.targetId] += 5;
		}
	}
	for (const vh of state.voteHistory) {
		const recency = 1 / (1 + Math.max(0, state.day - vh.day - 1) * .5);
		for (const [voter, target] of Object.entries(vh.votes)) {
			const v = Number(voter), t = Number(target);
			if (t == null || v === t) continue;
			if (trusted.has(t) && !trusted.has(v)) score[v] += 1.6 * recency;
			if (known.has(t) && !trusted.has(v)) score[v] += 1.2 * recency;
			if (known.has(t) && trusted.has(v)) score[v] -= 1.5 * recency;
		}
		const entries = Object.entries(vh.votes);
		for (const [a, ta] of entries) for (const [b, tb] of entries) if (a !== b && ta != null && ta === tb && score[Number(a)] > 4) score[Number(b)] += .5 * recency;
	}
	const accusedToday = {};
	for (const s of state.speeches) {
		if (s.day !== state.day || s.targetId == null) continue;
		if (s.kind !== "accuse" && s.kind !== "wolf-cover") continue;
		const weight = 1 + Math.min(1.4, (state.influence[s.playerId] || 0) * .25);
		accusedToday[s.targetId] = (accusedToday[s.targetId] || 0) + weight;
	}
	for (const [id, w] of Object.entries(accusedToday)) {
		if (trusted.has(Number(id))) continue;
		score[Number(id)] += Math.min(4.2, w * .85);
	}
	for (const p of state.players) {
		if (!p.alive || p.id === viewer.id) continue;
		const mine = state.speeches.filter((s) => s.playerId === p.id);
		if (state.day >= 2 && mine.length <= 1) score[p.id] += .9;
		if ((state.supported[p.id] || []).some((d) => score[d] > 5)) score[p.id] += 1.1;
		if ((state.attacked[p.id] || []).some((d) => trusted.has(d))) score[p.id] += 1.3;
	}
	if (iAmWolf) {
		const realSeer = state.claims.find((c) => c.role === ROLE.SEER && !myTeam.includes(c.playerId));
		if (realSeer) score[realSeer.playerId] += 20;
		for (const id of trusted) score[id] = -99;
	}
	for (const p of state.players) {
		if (p.id === viewer.id) continue;
		score[p.id] += (rng() - .5) * 1.6;
	}
	return score;
}
/**
* 一个预言家声明的可信度（0 分以下 = 很可疑）。
*
* 这里只用公开信息，所以同一时刻全场算出来的分数是一致的——
* 这正是村庄能收敛到同一个答案的原因。最关键的一条经验法则是：
* 真预言家验的是"可疑的人"，悍跳狼咬的往往是"村里的好人"。
*/
function claimCredibility(state, claim) {
	let cred = 1;
	const claimer = byId(state, claim.playerId);
	if (!claimer) return cred;
	const nightsOut = state.day - claim.day;
	if (claimer.alive && nightsOut >= 2) cred -= clamp(nightsOut - 1, 0, 3) * 1.5;
	if (!claimer.alive && claimer.deathReason === "wolf") cred += 1.5;
	for (const chk of claim.checks) {
		const t = byId(state, chk.targetId);
		if (!t) continue;
		if (chk.result === ROLE.GOOD && !t.alive && t.deathReason === "wolf") cred += 1.8;
		if (chk.result === ROLE.WOLF && !t.alive && t.deathReason === "vote") cred += 1.2;
		if (chk.result === ROLE.WOLF) cred -= Math.min(2.8, (state.influence[chk.targetId] || 0) * .5);
		else cred += .35;
	}
	if (claim.checks.length === 0) cred -= 1;
	return cred;
}
/** 狼队今晚刀谁 */
function wolfKillTarget(state, rng = Math.random) {
	const pack = aliveWolves(state);
	const packIds = pack.map((p) => p.id);
	const candidates = aliveOf(state).filter((p) => !packIds.includes(p.id));
	if (!candidates.length) return null;
	const scored = candidates.map((p) => {
		let s = rng() * 2;
		if (state.claims.find((c) => c.playerId === p.id && c.role === ROLE.SEER)) s += 24;
		if (state.claims.some((c) => c.playerId !== p.id && c.checks.some((k) => k.targetId === p.id && k.result === ROLE.WOLF))) s -= 4;
		s += state.speeches.filter((sp) => sp.playerId === p.id).length * .8;
		s += (state.influence[p.id] || 0) * 1.2;
		if (state.publicClaimsRole[p.id] && GOD_ROLES.includes(state.publicClaimsRole[p.id])) s += 3;
		if ((state.attacked[p.id] || []).some((t) => packIds.includes(t))) s += 4.5;
		s -= p.id === pack[0].id ? 0 : 0;
		return {
			p,
			s
		};
	});
	scored.sort((a, b) => b.s - a.s);
	return scored[0].p.id;
}
/** 预言家今晚验谁 */
function seerCheckTarget(state, me, rng = Math.random) {
	const checked = new Set((me.checks || []).map((c) => c.targetId));
	const pool = aliveOf(state).filter((p) => p.id !== me.id && !checked.has(p.id));
	if (!pool.length) return null;
	const susp = computeSuspicion(state, me, rng);
	const scored = pool.map((p) => {
		let s = susp[p.id] + rng() * 2;
		if (state.claims.find((c) => c.playerId === p.id && c.role === ROLE.SEER)) s += 10;
		return {
			p,
			s
		};
	});
	scored.sort((a, b) => b.s - a.s);
	return scored[rng() < .78 ? 0 : Math.min(scored.length - 1, 1 + Math.floor(rng() * 2))].p.id;
}
/** 女巫的用药决策 */
function witchDecision(state, me, rng = Math.random) {
	const victimId = state.nightKill;
	const victim = victimId != null ? byId(state, victimId) : null;
	const out = {
		save: false,
		poison: null,
		reason: ""
	};
	const firstNight = state.day === 1;
	if (me.antidote && victim) {
		let want = 0;
		if (victim.id === me.id) {
			want = firstNight ? .95 : 0;
			out.reason = "self";
		} else {
			if (state.claims.find((c) => c.playerId === victim.id && c.role === ROLE.SEER)) {
				want = .9;
				out.reason = "seer";
			} else if (firstNight) {
				want = .35;
				out.reason = "first";
			} else {
				want = .45;
				out.reason = "value";
			}
			if (firstNight && rng() < .55) want -= .5;
		}
		out.save = rng() < want;
	}
	if (me.poison && !out.save) {
		const susp = computeSuspicion(state, me, rng);
		const alive = aliveOf(state).filter((p) => p.id !== me.id);
		const target = alive.sort((a, b) => susp[b.id] - susp[a.id])[0];
		if (target) {
			const top = susp[target.id];
			const second = alive[1] ? susp[alive[1].id] : -99;
			const confident = state.claims.some((c) => c.role === ROLE.SEER && c.checks.some((k) => k.result === ROLE.WOLF && k.targetId === target.id)) || top - second > 1.2 || top > 8;
			if (!firstNight && confident && rng() < .68) {
				out.poison = target.id;
				out.reason = "poison";
			}
		}
	}
	return out;
}
/** 猎人开枪目标 */
function hunterTarget(state, me, rng = Math.random) {
	const susp = computeSuspicion(state, me, rng);
	const alive = aliveOf(state).filter((p) => p.id !== me.id);
	if (!alive.length) return null;
	alive.sort((a, b) => susp[b.id] - susp[a.id]);
	if (susp[alive[0].id] < 2 && rng() < .5) return null;
	return alive[0].id;
}
/**
* 预言家（自称者）今天要不要起跳 / 报验人
* @returns {null | {check}}
*/
function seerAnnouncement(state, me, rng = Math.random) {
	const checks = me.checks || [];
	if (!checks.length) return null;
	const myChecks = state.claims.find((c) => c.playerId === me.id)?.checks?.length || 0;
	const pending = checks.slice(myChecks);
	if (!pending.length) return null;
	const rivals = state.claims.filter((c) => c.role === ROLE.SEER && c.playerId !== me.id);
	const hasWolf = pending.some((c) => c.result === ROLE.WOLF);
	if (myChecks > 0) return { check: pending[pending.length - 1] };
	if (rivals.length) return {
		check: pending[pending.length - 1],
		counter: rivals[0].playerId
	};
	if (hasWolf) return { check: pending[pending.length - 1] };
	if (state.day === 1) return rng() < .9 ? { check: pending[pending.length - 1] } : null;
	return { check: pending[pending.length - 1] };
}
/**
* 狼人是否悍跳预言家
* @returns {null | {targetId, result}}
*/
function wolfFakeClaim(state, me, rng = Math.random) {
	const pack = aliveWolves(state);
	if (state.claims.some((c) => c.role === ROLE.SEER && pack.some((w) => w.id === c.playerId))) return null;
	const rivals = state.claims.filter((c) => c.role === ROLE.SEER);
	if (state.claims.some((c) => c.playerId === me.id)) return null;
	const base = rivals.length ? .8 : state.day === 1 ? .5 : .25;
	const naturalLeader = pack.slice().sort((a, b) => {
		const ta = a.persona.tone === "brash" || a.persona.tone === "sly" ? 1 : 0;
		return (b.persona.tone === "brash" || b.persona.tone === "sly" ? 1 : 0) - ta;
	})[0];
	if (naturalLeader && naturalLeader.id !== me.id && rng() < .6) return null;
	if (rng() > base) return null;
	const meIds = pack.map((p) => p.id);
	const pool = aliveOf(state).filter((p) => !meIds.includes(p.id));
	if (!pool.length) return null;
	const realSeer = rivals.find((c) => !meIds.includes(c.playerId));
	if (realSeer && rng() < .65) return {
		targetId: realSeer.playerId,
		result: ROLE.WOLF
	};
	const mates = pack.filter((w) => w.id !== me.id);
	if (mates.length && rng() < .35) return {
		targetId: mates[Math.floor(rng() * mates.length)].id,
		result: ROLE.GOOD
	};
	pool.sort((a, b) => (state.influence[a.id] || 0) - (state.influence[b.id] || 0));
	const weak = pool.slice(0, Math.max(1, Math.ceil(pool.length / 2)));
	return {
		targetId: weak[Math.floor(rng() * weak.length)].id,
		result: ROLE.WOLF
	};
}
/**
* 悍跳狼第二天起的续跳：继续编造验人结果，维持预言家人设。
* @returns {null | {check}}
*/
function wolfFollowUpClaim(state, me, rng = Math.random) {
	const myClaim = state.claims.find((c) => c.playerId === me.id && c.role === ROLE.SEER);
	if (!myClaim) return null;
	if (myClaim.day === state.day) return null;
	if (state.day - myClaim.day > 3) return null;
	if (rng() < .18) return null;
	const packIds = aliveWolves(state).map((p) => p.id);
	const told = new Set(myClaim.checks.map((c) => c.targetId));
	const pool = aliveOf(state).filter((p) => p.id !== me.id && !told.has(p.id));
	if (!pool.length) return null;
	const mates = pool.filter((p) => packIds.includes(p.id));
	if (mates.length && rng() < .3) return { check: {
		targetId: mates[Math.floor(rng() * mates.length)].id,
		result: ROLE.GOOD,
		day: state.day - 1,
		fake: true
	} };
	const outsiders = pool.filter((p) => !packIds.includes(p.id));
	const good = outsiders.filter((p) => !state.claims.some((c) => c.playerId === p.id && c.role === ROLE.SEER));
	const target = (good.length ? good : outsiders)[0];
	const result = good.length && rng() < .7 ? ROLE.GOOD : ROLE.WOLF;
	return { check: {
		targetId: target.id,
		result,
		day: state.day - 1,
		fake: true
	} };
}
/**
* 生成一次白天的发言意图
*/
function decideSpeech(state, me, rng = Math.random) {
	if (me.role === ROLE.SEER) {
		const already = state.claims.some((c) => c.playerId === me.id);
		const ann = seerAnnouncement(state, me, rng);
		if (ann) return ann.counter ? {
			kind: "counter-claim",
			rival: byId(state, ann.counter),
			checks: me.checks
		} : {
			kind: already ? "report-check" : "claim-seer",
			check: ann.check,
			checks: me.checks
		};
	}
	if (me.role === ROLE.WOLF) {
		const followUp = wolfFollowUpClaim(state, me, rng);
		if (followUp) return {
			kind: "report-check",
			check: followUp.check,
			checks: [followUp.check],
			fake: true
		};
		const fake = wolfFakeClaim(state, me, rng);
		if (fake) return {
			kind: "claim-seer",
			checks: [{
				targetId: fake.targetId,
				result: fake.result,
				day: state.day - 1,
				fake: true
			}],
			fake: true
		};
		const susp = computeSuspicion(state, me, rng);
		const alive = aliveOf(state).filter((p) => p.id !== me.id && p.role !== ROLE.WOLF);
		alive.sort((a, b) => susp[b.id] - susp[a.id]);
		const push = alive[0];
		return {
			kind: rng() < .55 ? "accuse" : "wolf-cover",
			target: push,
			voteTarget: push
		};
	}
	const accuser = state.claims.find((c) => c.role === ROLE.SEER && c.checks.some((k) => k.targetId === me.id && k.result === ROLE.WOLF));
	if (accuser && byId(state, accuser.playerId)?.alive) return {
		kind: "defend-self",
		accuser: byId(state, accuser.playerId)
	};
	const susp = computeSuspicion(state, me, rng);
	const alive = aliveOf(state).filter((p) => p.id !== me.id);
	alive.sort((a, b) => susp[b.id] - susp[a.id]);
	const top = alive[0];
	const claims = state.claims.filter((c) => c.role === ROLE.SEER);
	if (claims.length) {
		const best = byId(state, claims.map((c) => ({
			c,
			cred: claimCredibility(state, c)
		})).sort((a, b) => b.cred - a.cred)[0].c.playerId);
		if (best && best.alive && susp[best.id] < 2 && rng() < .4) return {
			kind: "support",
			target: best,
			voteTarget: top
		};
	}
	return {
		kind: top && susp[top.id] > 3 ? "accuse" : "villager-read",
		target: top,
		voteTarget: top
	};
}
/** 白天投票 */
function decideVote(state, me, rng = Math.random) {
	const alive = aliveOf(state).filter((p) => p.id !== me.id);
	if (!alive.length) return null;
	if (me.role === ROLE.WOLF) {
		const packIds = aliveWolves(state).map((p) => p.id);
		const pool = alive.filter((p) => !packIds.includes(p.id));
		if (!pool.length) return null;
		if (state.wolfPush && pool.some((p) => p.id === state.wolfPush) && rng() > .2) return state.wolfPush;
		const susp = computeSuspicion(state, me, rng);
		pool.sort((a, b) => susp[b.id] - susp[a.id]);
		return pool[0].id;
	}
	const susp = computeSuspicion(state, me, rng);
	if (me.role !== ROLE.SEER) {
		const claims = state.claims.filter((c) => c.role === ROLE.SEER);
		if (claims.length) {
			const ranked = claims.map((c) => ({
				c,
				cred: claimCredibility(state, c)
			})).sort((a, b) => b.cred - a.cred);
			const best = ranked[0];
			const margin = ranked[1] ? best.cred - ranked[1].cred : 99;
			if (best.cred > 0 && margin >= .25) {
				const kill = best.c.checks.find((k) => k.result === ROLE.WOLF && alive.some((p) => p.id === k.targetId));
				if (kill && rng() < .74) return kill.targetId;
			}
		}
	}
	const sorted = alive.slice().sort((a, b) => susp[b.id] - susp[a.id]);
	if (state.day === 1 && rng() < .2 && sorted.length > 1) return sorted[1].id;
	return sorted[0].id;
}
/** 狼队今天集中票给谁 */
function chooseWolfPush(state, rng = Math.random) {
	const pack = aliveWolves(state);
	const packIds = pack.map((p) => p.id);
	const pool = aliveOf(state).filter((p) => !packIds.includes(p.id));
	if (!pool.length || !pack.length) return null;
	const fake = state.claims.find((c) => c.role === ROLE.SEER && packIds.includes(c.playerId));
	const realSeer = state.claims.find((c) => c.role === ROLE.SEER && !packIds.includes(c.playerId));
	if (fake && realSeer && byId(state, realSeer.playerId)?.alive) return realSeer.playerId;
	const susp = computeSuspicion(state, pack[0], rng);
	pool.sort((a, b) => (susp[b.id] || 0) - (susp[a.id] || 0) || (state.influence[b.id] || 0) - (state.influence[a.id] || 0));
	return pool[0].id;
}
//#endregion
//#region src/game/director.js
/**
* 导演：一局狼人杀的完整流程
*
* 用 async/await 写成一条线性剧本，人类玩家的操作通过 host.ask() 挂起等待。
* 每一个 await 都是一个"节拍"，host.wait 负责节奏与倍速，host.ask 负责交互。
*/
var BEAT = {
	nightFall: 2200,
	step: 1300,
	reveal: 1900,
	speak: 700,
	between: 700,
	vote: 800,
	dawn: 1700,
	result: 2200,
	over: 900
};
var Aborted = class extends Error {};
var aliveList = (state) => state.players.filter((p) => p.alive);
var aliveOthers = (state, id) => aliveList(state).filter((p) => p.id !== id);
var P = (state, id) => state.players.find((p) => p.id === id);
var mark = (p) => p.isHuman ? "你" : `${p.seat + 1}号${p.name}`;
function recordSpeech(state, p, text, intent) {
	state.speeches.push({
		id: state.speeches.length + 1,
		playerId: p.id,
		day: state.day,
		text,
		kind: intent.kind,
		targetId: intent.target?.id ?? null
	});
	p.spokeToday = true;
	state.influence[p.id] = (state.influence[p.id] || 0) + .7;
	if (intent.target) (state.attacked[p.id] ||= []).push(intent.target.id);
	if (intent.kind === "support" && intent.target) {
		(state.supported[p.id] ||= []).push(intent.target.id);
		state.influence[intent.target.id] = (state.influence[intent.target.id] || 0) + .9;
	}
	if (intent.kind === "accuse" && intent.target) state.influence[intent.target.id] = (state.influence[intent.target.id] || 0) - .3;
}
/** 把预言家声明登记到公开面板 */
function publishSeerClaim(state, p, checks, fake = false) {
	let claim = state.claims.find((c) => c.playerId === p.id && c.role === ROLE.SEER);
	if (!claim) {
		claim = {
			playerId: p.id,
			role: ROLE.SEER,
			day: state.day,
			checks: [],
			fake
		};
		state.claims.push(claim);
	}
	claim.checks = checks.map((c) => ({
		...c,
		fake
	}));
	claim.day = Math.min(claim.day, state.day);
	state.publicClaimsRole[p.id] = ROLE.SEER;
	p.claimsMade = (p.claimsMade || 0) + 1;
	state.influence[p.id] = (state.influence[p.id] || 0) + 1.6;
}
async function runGame(state, host) {
	try {
		logEntry(state, "system", `第 ${state.day} 天。9 人标准局：3 狼人、预言家、女巫、猎人、3 平民。`);
		while (!state.winner) {
			if (state.day > 40) {
				state.winner = TEAM.GOOD;
				state.winReason = "对局超过了天数上限，判定好人获胜。";
				state.phase = "over";
				state.phaseLabel = "好人胜利";
				state.revealAll = true;
				break;
			}
			await night(state, host);
			if (await finishIfOver(state, host)) return;
			await dawn(state, host);
			if (await finishIfOver(state, host)) return;
			await dayPhase(state, host);
			if (await finishIfOver(state, host)) return;
			state.day += 1;
			resetDaily(state);
		}
	} catch (err) {
		if (err instanceof Aborted) return;
		throw err;
	}
}
function resetDaily(state) {
	state.players.forEach((p) => {
		p.spokeToday = false;
		p.votedToday = false;
	});
	state.wolfPush = null;
}
async function finishIfOver(state, host) {
	const result = checkWin(state);
	if (!result) return false;
	state.winner = result.winner;
	state.winReason = result.reason;
	state.phase = "over";
	state.phaseLabel = result.winner === TEAM.WOLF ? "狼人胜利" : "好人胜利";
	state.endedAt = Date.now();
	state.revealAll = true;
	state.awaiting = null;
	state.turn = null;
	logEntry(state, "system", `${result.reason}`, { highlight: true });
	host.sfx?.(result.winner === TEAM.WOLF ? "wolf-win" : "good-win");
	await host.wait(BEAT.over);
	return true;
}
async function night(state, host) {
	state.phase = "night";
	state.phaseLabel = `第 ${state.day} 夜 · 天黑请闭眼`;
	state.nightKill = null;
	state.poisonTarget = null;
	state.turn = null;
	logEntry(state, "phase", `天黑请闭眼。`);
	host.sfx?.("night");
	await host.wait(BEAT.nightFall);
	state.nightStep = "wolf";
	state.phaseLabel = "狼人行动";
	logEntry(state, "night", "狼人睁眼，互相确认身份，商量今晚要杀的人。");
	const wolves = aliveWolves(state);
	const humanWolf = wolves.find((w) => w.isHuman);
	const nonWolfPool = aliveList(state).filter((p) => p.role !== ROLE.WOLF).map((p) => p.id);
	let killId = null;
	if (humanWolf && nonWolfPool.length) {
		const mates = wolves.filter((w) => !w.isHuman);
		const suggestion = wolfKillTarget(state, state.rng);
		killId = (await host.ask({
			kind: "pick-one",
			role: ROLE.WOLF,
			title: "今晚猎杀谁？",
			hint: mates.length ? `同伴：${mates.map((m) => mark(m)).join("、")}` : "你是唯一的狼。",
			suggestion: suggestion != null ? `${seatLabel(P(state, suggestion))}（同伴倾向）` : "",
			candidates: nonWolfPool,
			allowSkip: false
		})).playerId;
		state.turn = humanWolf.id;
		logEntry(state, "night", `狼队商定：今晚击杀 ${seatLabel(P(state, killId))}。`, {
			secret: true,
			actorId: humanWolf.id
		});
		await host.wait(BEAT.step);
	} else if (wolves.length) {
		killId = wolfKillTarget(state, state.rng);
		state.turn = wolves[0].id;
		await host.wait(BEAT.step);
	} else await host.wait(BEAT.step);
	state.nightKill = killId;
	state.turn = null;
	state.nightStep = "seer";
	state.phaseLabel = "预言家行动";
	const seer = aliveList(state).find((p) => p.role === ROLE.SEER);
	if (seer) {
		logEntry(state, "night", "预言家睁眼，选择一人查验。");
		const checked = new Set((seer.checks || []).map((c) => c.targetId));
		const pool = aliveOthers(state, seer.id).filter((p) => !checked.has(p.id)).map((p) => p.id);
		let checkId = null;
		if (pool.length) {
			if (seer.isHuman) {
				state.turn = seer.id;
				checkId = (await host.ask({
					kind: "pick-one",
					role: ROLE.SEER,
					title: "今晚查验谁？",
					hint: checked.size ? `已验过：${[...checked].map((i) => seatLabel(P(state, i))).join("、")}` : "这是你的第一次查验。",
					candidates: pool,
					allowSkip: false
				})).playerId;
			} else checkId = seerCheckTarget(state, seer, state.rng);
			if (checkId != null) {
				const target = P(state, checkId);
				const result = target.role === ROLE.WOLF ? ROLE.WOLF : ROLE.GOOD;
				seer.checks.push({
					targetId: checkId,
					result,
					day: state.day
				});
				if (seer.isHuman) await host.reveal({
					tone: result === ROLE.WOLF ? "blood" : "moss",
					title: `${seatLabel(target)} · ${result === ROLE.WOLF ? "狼人" : "好人"}`,
					subtitle: result === ROLE.WOLF ? "查杀" : "金水"
				});
			}
		}
		state.turn = null;
		await host.wait(BEAT.step);
	} else await host.wait(BEAT.step / 2);
	state.nightStep = "witch";
	state.phaseLabel = "女巫行动";
	const witch = aliveList(state).find((p) => p.role === ROLE.WITCH);
	if (witch) {
		logEntry(state, "night", "女巫睁眼。");
		const victim = killId != null ? P(state, killId) : null;
		const canSelfSave = state.day === 1;
		let save = false;
		let poison = null;
		if (witch.isHuman) {
			state.turn = witch.id;
			const canSave = witch.antidote && !!victim && (victim.id !== witch.id || canSelfSave);
			const canPoison = witch.poison;
			if (!victim && !canPoison) logEntry(state, "night", "今晚无人倒牌，你手上的药还在。", {
				secret: true,
				actorId: witch.id
			});
			else {
				const ans = await host.ask({
					kind: "witch",
					role: ROLE.WITCH,
					title: "今晚，你要用药吗？",
					hint: victim ? `今晚倒牌的是 ${seatLabel(victim)}${victim.id === witch.id ? "（你自己）" : ""}。` : "今晚没人被刀。",
					antidote: witch.antidote,
					poison: witch.poison,
					canSave,
					canPoison,
					saveBlockedReason: !witch.antidote ? "解药已经用掉了" : victim && victim.id === witch.id && !canSelfSave ? "女巫从第二夜起不能自救" : "",
					candidates: canPoison ? aliveOthers(state, witch.id).map((p) => p.id) : []
				});
				save = !!ans.save;
				poison = ans.poison ?? null;
			}
			state.turn = null;
		} else {
			const d = witchDecision(state, witch, state.rng);
			save = d.save;
			poison = d.poison;
		}
		let savedId = null;
		let poisonedId = null;
		if (save && witch.antidote && victim) {
			witch.antidote = false;
			state.nightKill = null;
			savedId = victim.id;
			logEntry(state, "night", `女巫用了解药，${seatLabel(victim)}活了下来。`, {
				secret: true,
				actorId: witch.id
			});
			if (witch.isHuman) await host.reveal({
				tone: "moss",
				title: "解药已用",
				subtitle: `${seatLabel(victim)} 被救回`
			});
		}
		if (poison != null && witch.poison) {
			witch.poison = false;
			state.poisonTarget = poison;
			poisonedId = poison;
			logEntry(state, "night", `女巫用了毒药，目标是 ${seatLabel(P(state, poison))}。`, {
				secret: true,
				actorId: witch.id
			});
			if (witch.isHuman) await host.reveal({
				tone: "blood",
				title: "毒药已用",
				subtitle: `${seatLabel(P(state, poison))} 中毒`
			});
		}
		state.audit.push({
			day: state.day,
			kind: "witch",
			witchId: witch.id,
			savedId,
			poisonedId,
			usedAntidote: savedId != null,
			usedPoison: poisonedId != null
		});
		await host.wait(BEAT.step);
	} else await host.wait(BEAT.step / 2);
	state.nightStep = null;
}
async function dawn(state, host) {
	state.phase = "dawn";
	state.phaseLabel = `第 ${state.day} 天 · 天亮了`;
	host.sfx?.("dawn");
	logEntry(state, "phase", "天亮了。");
	await host.wait(BEAT.dawn);
	const dead = [];
	if (state.nightKill != null) {
		const p = killPlayer(state, state.nightKill, "wolf", "夜间被狼人击杀");
		if (p) dead.push({
			player: p,
			reason: "wolf"
		});
	}
	if (state.poisonTarget != null) {
		const p = killPlayer(state, state.poisonTarget, "poison", "被女巫毒杀");
		if (p) dead.push({
			player: p,
			reason: "poison"
		});
	}
	if (!dead.length) {
		state.phaseLabel = "平安夜";
		logEntry(state, "dawn", "昨晚是平安夜，没有人出局。", { highlight: true });
	} else {
		for (const d of dead) logEntry(state, "death", `${fullLabel(d.player)} 倒牌了。`, {
			playerId: d.player.id,
			highlight: true
		});
		if (dead.length === 1) state.phaseLabel = `昨晚，${seatLabel(dead[0].player)} 倒牌`;
		else state.phaseLabel = `昨晚倒了 ${dead.map((d) => seatLabel(d.player)).join("、")}`;
	}
	host.sfx?.(dead.length ? "death" : "calm");
	await host.wait(BEAT.reveal);
	for (const d of dead) if (d.player.role === ROLE.HUNTER && d.reason !== "poison") {
		await hunterShot(state, host, d.player);
		if (state.winner) return;
	}
	for (const d of dead) if (state.day === 1) await lastWords(state, host, d.player);
}
async function hunterShot(state, host, hunter) {
	state.phaseLabel = "猎人开枪";
	state.currentSpeech = null;
	logEntry(state, "system", `${mark(hunter)} 是猎人，枪口还能响一次。`, { highlight: true });
	host.sfx?.("gun");
	await host.wait(BEAT.reveal);
	const pool = aliveList(state).filter((p) => p.id !== hunter.id).map((p) => p.id);
	if (!pool.length) return;
	let targetId = null;
	if (hunter.isHuman) {
		state.turn = hunter.id;
		targetId = (await host.ask({
			kind: "pick-one",
			role: ROLE.HUNTER,
			title: "开枪带走谁？",
			hint: "你可以压枪，把机会留给下一轮——但你已经出局了。",
			candidates: pool,
			allowSkip: true,
			skipLabel: "不开枪"
		})).playerId;
		state.turn = null;
	} else targetId = hunterTarget(state, hunter, state.rng);
	if (targetId != null) {
		const t = killPlayer(state, targetId, "hunter", "被猎人开枪带走");
		logEntry(state, "death", `砰——${fullLabel(t)} 被猎人带走了。`, {
			playerId: t.id,
			highlight: true
		});
		host.sfx?.("death");
		await host.wait(BEAT.reveal);
	} else {
		logEntry(state, "system", "猎人压枪，没有开火。");
		await host.wait(BEAT.step);
	}
	state.audit.push({
		day: state.day,
		kind: "hunter",
		shooterId: hunter.id,
		targetId,
		reason: hunter.deathReason
	});
}
async function lastWords(state, host, who) {
	let text;
	if (who.isHuman) text = (await host.ask({
		kind: "speak",
		role: who.role,
		title: "你的遗言",
		hint: "说给活着的人听。",
		targets: aliveList(state).filter((p) => p.id !== who.id).map((p) => p.id),
		kinds: speakKinds(who.role),
		lastWords: true
	})).text || compose(state, who, { kind: "last-words" }, state.rng);
	else text = compose(state, who, {
		kind: "last-words",
		checks: who.role === ROLE.SEER ? who.checks : null
	}, state.rng);
	recordSpeech(state, who, text, { kind: "last-words" });
	state.currentSpeech = {
		playerId: who.id,
		text,
		kind: "last-words",
		day: state.day,
		seq: Date.now()
	};
	logEntry(state, "speech", `${mark(who)}：${text}`, {
		playerId: who.id,
		speech: true
	});
	await host.wait(BEAT.speak + text.length * 26);
	state.currentSpeech = null;
}
async function dayPhase(state, host) {
	state.phase = "day";
	state.phaseLabel = `第 ${state.day} 天 · 发言`;
	logEntry(state, "phase", "白天，开始发言。");
	await host.wait(BEAT.step);
	state.wolfPush = chooseWolfPush(state, state.rng);
	const lastDeath = state.deaths[state.deaths.length - 1];
	const startSeat = lastDeath ? (lastDeath.playerId + 1) % 9 : 0;
	const order = [];
	for (let i = 0; i < 9; i++) {
		const p = state.players[(startSeat + i) % 9];
		if (p.alive) order.push(p);
	}
	for (const p of order) {
		await speak(state, host, p);
		if (state.winner) return;
	}
	await votePhase(state, host);
}
async function speak(state, host, p) {
	state.turn = p.id;
	state.phaseLabel = `第 ${state.day} 天 · ${mark(p)} 发言`;
	let text, intent;
	if (p.isHuman) {
		const ans = await host.ask({
			kind: "speak",
			role: p.role,
			title: "轮到你发言",
			hint: "挑一个立场，机器人才听得懂；也可以自己写一段话。",
			targets: aliveList(state).filter((x) => x.id !== p.id).map((x) => x.id),
			kinds: speakKinds(p.role, state, p),
			allowSkip: true
		});
		intent = ans.intent;
		text = ans.text;
	} else {
		intent = decideSpeech(state, p, state.rng);
		text = compose(state, p, intent, state.rng);
	}
	if (intent.kind === "claim-seer" || intent.kind === "counter-claim" || intent.kind === "report-check") {
		if (p.role === ROLE.SEER) publishSeerClaim(state, p, p.checks.length ? p.checks : intent.checks || [], false);
		else {
			const merged = [...state.claims.find((c) => c.playerId === p.id)?.checks || [], ...intent.checks || []];
			publishSeerClaim(state, p, merged.length ? merged : intent.checks || [], true);
		}
	}
	recordSpeech(state, p, text, intent);
	state.currentSpeech = {
		playerId: p.id,
		text,
		kind: intent.kind,
		day: state.day,
		seq: Date.now()
	};
	logEntry(state, "speech", `${mark(p)}：${text}`, {
		playerId: p.id,
		speech: true
	});
	host.sfx?.("speak");
	const dwell = Math.max(BEAT.speak, Math.min(5200, 420 + text.length * 34));
	await host.wait(dwell);
	state.turn = null;
}
async function votePhase(state, host) {
	state.phase = "vote";
	state.phaseLabel = `第 ${state.day} 天 · 投票放逐`;
	state.currentSpeech = null;
	logEntry(state, "phase", "发言结束，开始投票。");
	host.sfx?.("vote");
	await host.wait(BEAT.vote);
	const voters = aliveList(state);
	const votes = {};
	const order = [];
	const lastDeath = state.deaths[state.deaths.length - 1];
	const startSeat = lastDeath ? (lastDeath.playerId + 1) % 9 : 0;
	for (let i = 0; i < 9; i++) {
		const p = state.players[(startSeat + i) % 9];
		if (p.alive) order.push(p);
	}
	for (const p of order) {
		state.turn = p.id;
		let targetId = null;
		if (p.isHuman) {
			const pool = voters.filter((x) => x.id !== p.id).map((x) => x.id);
			targetId = (await host.ask({
				kind: "vote",
				role: p.role,
				title: "你要投谁？",
				hint: `场上还有 ${voters.length} 人。多数票出局，平票则本轮不放逐。`,
				candidates: pool,
				allowSkip: true,
				skipLabel: "弃票"
			})).playerId;
		} else targetId = decideVote(state, p, state.rng);
		votes[p.id] = targetId;
		p.votedToday = true;
		const label = targetId == null ? "弃票" : `→ ${seatLabel(P(state, targetId))}`;
		logEntry(state, "vote", `${mark(p)} 投票 ${label}`, {
			playerId: p.id,
			targetId
		});
		await host.wait(Math.max(160, BEAT.vote * .42));
	}
	state.turn = null;
	const tally = {};
	for (const [, t] of Object.entries(votes)) {
		if (t == null) continue;
		tally[t] = (tally[t] || 0) + 1;
	}
	const entries = Object.entries(tally).map(([id, n]) => ({
		id: Number(id),
		n
	}));
	entries.sort((a, b) => b.n - a.n);
	const top = entries[0];
	const tie = entries.length > 1 && entries[1].n === top?.n;
	state.lastTally = entries.map((e) => ({
		playerId: e.id,
		count: e.n
	}));
	state.voteHistory.push({
		day: state.day,
		votes: { ...votes },
		exiledId: null
	});
	if (!top || tie) {
		state.phaseLabel = "平票 · 无人出局";
		logEntry(state, "result", tie ? "票型平了，本轮没有人被放逐。" : "全场弃票，本轮没有人被放逐。", { highlight: true });
		host.sfx?.("calm");
		await host.wait(BEAT.result);
		return;
	}
	const exiled = P(state, top.id);
	state.voteHistory[state.voteHistory.length - 1].exiledId = exiled.id;
	exile(state, exiled, `${top.n} 票`, "vote");
	state.phaseLabel = `${seatLabel(exiled)} 被放逐`;
	logEntry(state, "result", `${fullLabel(exiled)} 以 ${top.n} 票被放逐出村。`, {
		playerId: exiled.id,
		highlight: true
	});
	host.sfx?.("exile");
	await host.wait(BEAT.result);
	if (exiled.role === ROLE.HUNTER) await hunterShot(state, host, exiled);
	else await lastWords(state, host, exiled);
	if (exiled.role === ROLE.WOLF) logEntry(state, "system", "（狼人出局，好人阵营向前一步。）");
}
/** 统一放逐入口，便于扩展 */
function exile(state, player, note, reason) {
	killPlayer(state, player.id, reason, `被投票放逐（${note}）`);
}
function speakKinds(role, state = null, me = null) {
	const base = [
		{
			id: "villager-read",
			name: "盘逻辑",
			blurb: "讲讲你的观察，不指名道姓"
		},
		{
			id: "accuse",
			name: "指认",
			blurb: "点名一个人，说出理由",
			needsTarget: true
		},
		{
			id: "support",
			name: "站边",
			blurb: "表态信谁，跟他的票",
			needsTarget: true
		},
		{
			id: "defend-self",
			name: "辩解",
			blurb: "回应别人对你的怀疑"
		}
	];
	const seerish = [{
		id: "claim-seer",
		name: "跳预言家",
		blurb: "公布身份与验人结果",
		risky: true
	}];
	if (role === ROLE.WOLF) return [
		...seerish,
		...base,
		{
			id: "wolf-cover",
			name: "伪装",
			blurb: "装作平民，把水搅浑",
			needsTarget: true
		}
	];
	if (role === ROLE.SEER) return [{
		id: "claim-seer",
		name: "亮身份 + 报验人",
		blurb: "把你的验人结果全部公布"
	}, ...base];
	return [...base, {
		id: "claim-seer",
		name: "跳预言家",
		blurb: "假装预言家（风险极高）",
		risky: true
	}];
}
//#endregion
//#region src/game/autopilot.js
/**
* 托管：用同一套 AI 逻辑替人类席位作答。
*
* 两个地方共用它——
*   1. 观战模式：你不动手，看看这八个人自己会打成什么样；
*   2. 无头模拟器：一秒跑一千局，用来验证流程和平衡。
*
* 因为共用同一份代码，观战时看到的行为就是统计里那个行为，
* 不存在"演示版"和"真实版"两套 AI。
*/
/**
* @param {object} state  全局面板
* @param {object} req    导演发来的提问（kind / candidates / canSave / targets …）
* @param {function} rng
*/
function answerAsHuman(state, req, rng = Math.random) {
	const me = state.players[state.humanId];
	if (!me) return { playerId: null };
	switch (req.kind) {
		case "pick-one":
			if (req.role === ROLE.HUNTER) return { playerId: hunterTarget(state, me, rng) };
			if (req.role === ROLE.WOLF) return { playerId: wolfKillTarget(state, rng) };
			if (req.role === ROLE.SEER) return { playerId: seerCheckTarget(state, me, rng) ?? req.candidates?.[0] ?? null };
			return { playerId: req.candidates?.[Math.floor(rng() * (req.candidates?.length || 1))] ?? null };
		case "witch": {
			const d = witchDecision(state, me, rng);
			if (d.save && req.canSave) return {
				save: true,
				poison: null
			};
			if (d.poison != null && req.canPoison) return {
				save: false,
				poison: d.poison
			};
			return {
				save: false,
				poison: null
			};
		}
		case "vote": return { playerId: decideVote(state, me, rng) };
		case "speak": {
			const intent = decideSpeech(state, me, rng);
			return {
				intent,
				text: compose(state, me, intent, rng)
			};
		}
		default: return { playerId: null };
	}
}
//#endregion
//#region src/game/audio.js
/**
* 音效：全部用 WebAudio 现场合成，不依赖任何音频文件。
* 狼人杀需要的是"钟、木、枪、夜风"这类材质声，合成比采样更贴。
*/
var ctx = null;
var master = null;
function ensure() {
	if (typeof window === "undefined") return null;
	if (!ctx) {
		const AC = window.AudioContext || window.webkitAudioContext;
		if (!AC) return null;
		ctx = new AC();
		master = ctx.createGain();
		master.gain.value = .5;
		master.connect(ctx.destination);
	}
	if (ctx.state === "suspended") ctx.resume();
	return ctx;
}
/** 一段噪声缓冲，用于风声与枪声 */
function noiseBuffer(seconds = 1) {
	const n = Math.floor(ctx.sampleRate * seconds);
	const buf = ctx.createBuffer(1, n, ctx.sampleRate);
	const d = buf.getChannelData(0);
	let last = 0;
	for (let i = 0; i < n; i++) {
		const white = Math.random() * 2 - 1;
		last = (last + .02 * white) / 1.02;
		d[i] = last * 3.2;
	}
	return buf;
}
function tone({ freq, type = "sine", at = 0, dur = .4, gain = .2, glide = null }) {
	const o = ctx.createOscillator();
	const g = ctx.createGain();
	o.type = type;
	o.frequency.setValueAtTime(freq, ctx.currentTime + at);
	if (glide) o.frequency.exponentialRampToValueAtTime(glide, ctx.currentTime + at + dur);
	g.gain.setValueAtTime(1e-4, ctx.currentTime + at);
	g.gain.exponentialRampToValueAtTime(gain, ctx.currentTime + at + .02);
	g.gain.exponentialRampToValueAtTime(1e-4, ctx.currentTime + at + dur);
	o.connect(g);
	g.connect(master);
	o.start(ctx.currentTime + at);
	o.stop(ctx.currentTime + at + dur + .05);
}
function noise({ at = 0, dur = 1, gain = .15, filter = 800, q = .7, type = "lowpass" }) {
	const src = ctx.createBufferSource();
	src.buffer = noiseBuffer(Math.max(.4, dur + .2));
	const f = ctx.createBiquadFilter();
	f.type = type;
	f.frequency.value = filter;
	f.Q.value = q;
	const g = ctx.createGain();
	g.gain.setValueAtTime(1e-4, ctx.currentTime + at);
	g.gain.exponentialRampToValueAtTime(gain, ctx.currentTime + at + .03);
	g.gain.exponentialRampToValueAtTime(1e-4, ctx.currentTime + at + dur);
	src.connect(f);
	f.connect(g);
	g.connect(master);
	src.start(ctx.currentTime + at);
	src.stop(ctx.currentTime + at + dur + .1);
}
var RECIPES = {
	night: () => {
		noise({
			dur: 2.4,
			gain: .1,
			filter: 420
		});
		tone({
			freq: 78,
			type: "sine",
			dur: 2.6,
			gain: .1,
			glide: 55
		});
	},
	dawn: () => {
		tone({
			freq: 392,
			type: "triangle",
			dur: 1.6,
			gain: .1
		});
		tone({
			freq: 587.3,
			type: "triangle",
			at: .22,
			dur: 1.8,
			gain: .07
		});
	},
	death: () => {
		tone({
			freq: 110,
			type: "sine",
			dur: 1.1,
			gain: .22,
			glide: 62
		});
		noise({
			dur: .5,
			gain: .08,
			filter: 300
		});
	},
	calm: () => {
		tone({
			freq: 523.25,
			type: "sine",
			dur: .9,
			gain: .06
		});
	},
	gun: () => {
		noise({
			dur: .34,
			gain: .5,
			filter: 2400,
			type: "highpass"
		});
		tone({
			freq: 90,
			type: "square",
			dur: .22,
			gain: .2,
			glide: 45
		});
	},
	exile: () => {
		tone({
			freq: 196,
			type: "sawtooth",
			dur: .7,
			gain: .12,
			glide: 130
		});
		noise({
			dur: .7,
			gain: .09,
			filter: 600
		});
	},
	vote: () => {
		tone({
			freq: 660,
			type: "square",
			dur: .09,
			gain: .05
		});
	},
	speak: () => {
		tone({
			freq: 880,
			type: "sine",
			dur: .05,
			gain: .03
		});
	},
	"wolf-win": () => {
		tone({
			freq: 146.8,
			type: "sawtooth",
			dur: 2.4,
			gain: .16,
			glide: 92
		});
		noise({
			dur: 2.4,
			gain: .1,
			filter: 500
		});
	},
	"good-win": () => {
		[
			523.25,
			659.25,
			783.99,
			1046.5
		].forEach((f, i) => tone({
			freq: f,
			type: "triangle",
			at: i * .13,
			dur: 1.4,
			gain: .1
		}));
	},
	select: () => {
		tone({
			freq: 1320,
			type: "sine",
			dur: .06,
			gain: .035
		});
	},
	reject: () => {
		tone({
			freq: 220,
			type: "square",
			dur: .16,
			gain: .07,
			glide: 160
		});
	}
};
var muted$1 = false;
function setMuted(v) {
	muted$1 = v;
}
function play(name) {
	if (muted$1) return;
	if (!ensure()) return;
	const recipe = RECIPES[name];
	if (!recipe) return;
	try {
		recipe();
	} catch {}
}
function unlock() {
	ensure();
}
//#endregion
//#region src/composables/useGame.js
/**
* 全局唯一的对局仓库。
* 界面只读 game 这个响应式对象，所有动作通过下面的方法发起。
*/
var game = ref(null);
var screen = ref("lobby");
var pending = ref(null);
var reveal = ref(null);
var paused = ref(false);
var speed = ref(1);
var muted = ref(false);
var options = reactive({
	humanRole: "random",
	voteTimer: true,
	spectate: false
});
var token = {
	aborted: false,
	askReject: null
};
var running = false;
var askSeq = 0;
var revealSeq = 0;
function wait(ms) {
	return new Promise((resolve, reject) => {
		let acc = 0;
		let last = performance.now();
		let raf = 0;
		const step = () => {
			if (token.aborted) {
				cancelAnimationFrame(raf);
				return reject(new Aborted());
			}
			const now = performance.now();
			if (!paused.value) acc += (now - last) * speed.value;
			last = now;
			if (acc >= ms) return resolve();
			raf = requestAnimationFrame(step);
		};
		raf = requestAnimationFrame(step);
	});
}
function ask(request) {
	return new Promise((resolve, reject) => {
		token.askReject = reject;
		const req = {
			...request,
			id: ++askSeq,
			auto: options.spectate,
			timeLimit: request.timeLimit ?? (!options.spectate && request.kind === "vote" && options.voteTimer ? 45e3 : 0),
			submit: (answer) => {
				if (pending.value !== req) return;
				token.askReject = null;
				pending.value = null;
				resolve(answer ?? { playerId: null });
			}
		};
		pending.value = req;
		if (options.spectate) {
			const mine = token;
			setTimeout(() => {
				if (mine.aborted || pending.value !== req) return;
				req.submit(answerAsHuman(game.value, req, game.value?.rng || Math.random));
			}, 850 / Math.max(.4, speed.value));
		}
	});
}
function showReveal(card) {
	return new Promise((resolve) => {
		const id = ++revealSeq;
		reveal.value = {
			...card,
			id
		};
		const hold = card.hold ?? 1750;
		setTimeout(() => {
			if (reveal.value && reveal.value.id === id) reveal.value = null;
			resolve();
		}, hold / Math.max(.4, speed.value));
	});
}
var host = {
	wait,
	ask,
	reveal: showReveal,
	sfx: (name) => {
		if (!muted.value) play(name);
	}
};
async function startGame() {
	abort();
	unlock();
	const rng = createRng(Math.random() * 1e9 | 0);
	game.value = createMatch({
		humanRole: options.humanRole,
		rng
	});
	screen.value = "playing";
	pending.value = null;
	reveal.value = null;
	paused.value = false;
	running = true;
	try {
		await runGame(game.value, host);
	} catch (err) {
		if (!(err instanceof Aborted)) {
			console.error("[狼人杀] 流程异常：", err);
			throw err;
		}
	} finally {
		if (running && game.value && !game.value.winner) {}
		running = false;
		if (game.value?.winner) screen.value = "over";
	}
}
function abort() {
	token.aborted = true;
	token.askReject?.(new Aborted());
	token.askReject = null;
	token = {
		aborted: false,
		askReject: null
	};
	pending.value = null;
	reveal.value = null;
}
function restart() {
	startGame();
}
function toLobby() {
	abort();
	running = false;
	screen.value = "lobby";
	game.value = null;
}
function pick(playerId) {
	if (!pending.value) return;
	if (!muted.value) play("select");
	pending.value.submit({ playerId });
}
function skip() {
	if (!pending.value) return;
	if (!muted.value) play("reject");
	pending.value.submit({ playerId: null });
}
function submitWitch({ save = false, poison = null }) {
	if (!pending.value) return;
	pending.value.submit({
		save,
		poison
	});
}
/** 人类玩家的发言：把界面选择翻译成导演能懂的 intent */
function submitSpeech({ kind, targetId = null, verdict = "wolf", text = "" }) {
	const t = pending.value;
	if (!t) return;
	const g = game.value;
	const me = g.players[g.humanId];
	const target = targetId != null ? g.players.find((p) => p.id === targetId) : null;
	const intent = {
		kind,
		target,
		voteTarget: target
	};
	if (kind === "claim-seer") intent.checks = me.role === ROLE.SEER ? me.checks.slice() : target ? [{
		targetId: target.id,
		result: verdict,
		day: g.day - 1,
		fake: true
	}] : [];
	if (kind === "report-check" && me.role === ROLE.SEER) intent.checks = me.checks.slice();
	const spoken = text.trim() ? text.trim() : compose(g, me, intent, g.rng);
	t.submit({
		intent,
		text: spoken
	});
}
function submitVote(playerId) {
	if (!pending.value) return;
	if (!muted.value) play(playerId == null ? "reject" : "select");
	pending.value.submit({ playerId });
}
var me = computed(() => {
	if (!game.value) return null;
	return game.value.players[game.value.humanId];
});
var myRoleMeta = computed(() => me.value ? ROLE_META[me.value.role] : null);
var alivePlayers = computed(() => game.value ? game.value.players.filter((p) => p.alive) : []);
var aliveCount = computed(() => alivePlayers.value.length);
var wolvesAlive = computed(() => alivePlayers.value.filter((p) => p.role === ROLE.WOLF).length);
var myTeammates = computed(() => {
	if (!game.value || !me.value || me.value.role !== ROLE.WOLF) return [];
	return game.value.players.filter((p) => p.role === ROLE.WOLF && p.id !== me.value.id);
});
/** 天幕色调：夜 / 拂晓 / 白昼 / 终局 */
var skyTone = computed(() => {
	const g = game.value;
	if (!g) return "dusk";
	if (g.phase === "over") return g.winner === TEAM.WOLF ? "blood" : "dawn";
	if (g.phase === "night") return g.nightStep === "witch" ? "deep" : "night";
	if (g.phase === "dawn") return "dawn";
	return "day";
});
var canAct = computed(() => !!pending.value);
var humanTurnActive = computed(() => canAct.value);
function useGame() {
	return {
		game,
		screen,
		pending,
		reveal,
		paused,
		speed,
		muted,
		options,
		me,
		myRoleMeta,
		alivePlayers,
		aliveCount,
		wolvesAlive,
		myTeammates,
		skyTone,
		canAct,
		humanTurnActive,
		startGame,
		restart,
		toLobby,
		pick,
		skip,
		submitWitch,
		submitSpeech,
		submitVote,
		speakKinds,
		seatLabel,
		ROLE,
		ROLE_META,
		TEAM,
		toggleMute,
		togglePause
	};
}
function toggleMute() {
	muted.value = !muted.value;
	setMuted(muted.value);
	if (!muted.value) {
		unlock();
		play("select");
	}
}
function togglePause() {
	paused.value = !paused.value;
}
//#endregion
//#region \0plugin-vue:export-helper
var _plugin_vue_export_helper_default = (sfc, props) => {
	const target = sfc.__vccOpts || sfc;
	for (const [key, val] of props) target[key] = val;
	return target;
};
//#endregion
//#region src/components/SkyCanopy.vue
var _sfc_main$10 = {
	__name: "SkyCanopy",
	__ssrInlineRender: true,
	setup(__props) {
		/**
		* 天幕
		*
		* 这是整页的签名元素，也是唯一的"装饰性"投入：
		* 一片真实绘制的夜空压在村庄屋脊之上。
		* 它同时是三个东西——
		*   1. 阶段指示器：天色的冷暖告诉你现在是夜、是拂晓还是白天；
		*   2. 人口计：村里每一扇亮着的窗，就是还活着的一名玩家；
		*   3. 情绪发生器：狼人睁眼时天最黑，天亮时屋脊后透出一线暖光。
		*/
		const { game, skyTone } = useGame();
		const canvas = ref(null);
		const wrap = ref(null);
		const lit = computed(() => game.value ? game.value.players.filter((p) => p.alive).length : 9);
		const total = computed(() => game.value ? game.value.players.length : 9);
		const nightIndex = computed(() => {
			const g = game.value;
			if (!g) return 1;
			if (g.phase === "night") return g.day;
			return Math.max(1, g.day - 1);
		});
		const SKY = {
			dusk: {
				top: [
					14,
					20,
					36
				],
				mid: [
					26,
					28,
					45
				],
				bot: [
					62,
					44,
					44
				],
				star: .45,
				moon: .85,
				glow: null
			},
			night: {
				top: [
					4,
					8,
					16
				],
				mid: [
					8,
					14,
					26
				],
				bot: [
					18,
					27,
					40
				],
				star: 1,
				moon: 1,
				glow: null
			},
			deep: {
				top: [
					2,
					5,
					11
				],
				mid: [
					4,
					9,
					18
				],
				bot: [
					11,
					18,
					30
				],
				star: 1.25,
				moon: 1.1,
				glow: null
			},
			dawn: {
				top: [
					18,
					25,
					48
				],
				mid: [
					58,
					50,
					66
				],
				bot: [
					168,
					108,
					74
				],
				star: .3,
				moon: .4,
				glow: [
					235,
					154,
					92
				]
			},
			day: {
				top: [
					40,
					62,
					90
				],
				mid: [
					76,
					105,
					132
				],
				bot: [
					176,
					152,
					108
				],
				star: 0,
				moon: 0,
				glow: [
					246,
					208,
					148
				]
			},
			blood: {
				top: [
					10,
					6,
					10
				],
				mid: [
					32,
					10,
					14
				],
				bot: [
					86,
					22,
					22
				],
				star: .7,
				moon: .5,
				glow: [
					192,
					64,
					58
				]
			}
		};
		function makeHouses(seed) {
			let s = seed >>> 0 || 1;
			const rnd = () => {
				s ^= s << 13;
				s >>>= 0;
				s ^= s >> 17;
				s ^= s << 5;
				s >>>= 0;
				return s / 4294967296;
			};
			const houses = [];
			let x = -40;
			let i = 0;
			while (x < 1500) {
				const w = 54 + rnd() * 62;
				const h = 30 + rnd() * 34;
				houses.push({
					id: i++,
					x,
					w,
					h,
					peak: rnd() < .75,
					chimney: rnd() < .35,
					tree: 0
				});
				x += w + 4 + rnd() * 12;
				if (rnd() < .22) {
					houses.push({
						id: i++,
						x,
						w: 16,
						h: 44,
						tree: 1,
						peak: false
					});
					x += 22;
				}
			}
			houses.push({
				id: i++,
				x: 470,
				w: 26,
				h: 74,
				peak: true,
				chimney: false,
				tree: 0,
				steeple: true
			});
			return houses;
		}
		/** 挑出 9 座"有窗"的房子，尽量均匀分布 */
		function pickWindowHouses(houses, count) {
			const sorted = houses.filter((h) => !h.tree).sort((a, b) => a.x - b.x);
			const picks = [];
			for (let i = 0; i < count; i++) {
				const idx = Math.round((i + .5) * (sorted.length / count));
				picks.push(sorted[Math.min(sorted.length - 1, idx)]);
			}
			return picks;
		}
		let ctx = null;
		let dpr = 1;
		let W = 0, H = 0;
		let raf = 0;
		let houses = [];
		let windowHouses = [];
		let stars = [];
		let t0 = performance.now();
		let lastFrame = 0;
		let reduced = false;
		let ro = null;
		function onResize() {
			resize();
		}
		function resize() {
			const el = wrap.value;
			const cv = canvas.value;
			if (!el || !cv) return;
			const rect = el.getBoundingClientRect();
			dpr = Math.min(2, window.devicePixelRatio || 1);
			W = Math.max(320, Math.round(rect.width));
			H = Math.max(96, Math.round(rect.height));
			cv.width = Math.round(W * dpr);
			cv.height = Math.round(H * dpr);
			cv.style.width = W + "px";
			cv.style.height = H + "px";
			ctx = cv.getContext("2d");
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			houses = makeHouses(20240917);
			windowHouses = pickWindowHouses(houses, 9);
			stars = Array.from({ length: 86 }, (_, i) => {
				const r = (i * 9301 + 49297) % 233280 / 233280;
				const r2 = (i * 4523 + 12345) % 199999 / 199999;
				const r3 = (i * 7919 + 104729) % 31337 / 31337;
				return {
					x: r * W,
					y: r2 * H * .72,
					r: .5 + r3 * 1.15,
					a: .28 + r3 * .7,
					ph: r3 * 6.28,
					sp: .06 + r2 * .22
				};
			});
		}
		const lerp = (a, b, t) => a + (b - a) * t;
		const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
		function draw(now) {
			if (!ctx) return;
			const time = (now - t0) / 1e3;
			const p = SKY[skyTone.value] || SKY.night;
			const g = ctx.createLinearGradient(0, 0, 0, H);
			g.addColorStop(0, rgb(p.top));
			g.addColorStop(.55, rgb(p.mid));
			g.addColorStop(1, rgb(p.bot));
			ctx.fillStyle = g;
			ctx.fillRect(0, 0, W, H);
			if (p.glow) {
				const glow = ctx.createRadialGradient(W * .62, H * 1.05, 0, W * .62, H * 1.05, H * 1.5);
				glow.addColorStop(0, rgb(p.glow, skyTone.value === "day" ? .5 : .42));
				glow.addColorStop(.45, rgb(p.glow, .12));
				glow.addColorStop(1, rgb(p.glow, 0));
				ctx.fillStyle = glow;
				ctx.fillRect(0, 0, W, H);
			}
			if (p.star > 0 && !reduced) for (const s of stars) {
				const tw = .72 + .28 * Math.sin(time * 1.5 + s.ph);
				const a = s.a * p.star * tw;
				if (a <= .02) continue;
				const x = (s.x + time * s.sp * 8) % W;
				ctx.fillStyle = `rgba(226,236,252,${a})`;
				ctx.beginPath();
				ctx.arc(x, s.y, s.r, 0, 6.2832);
				ctx.fill();
			}
			else if (p.star > 0) for (const s of stars) {
				ctx.fillStyle = `rgba(226,236,252,${s.a * p.star})`;
				ctx.beginPath();
				ctx.arc(s.x, s.y, s.r, 0, 6.2832);
				ctx.fill();
			}
			if (p.moon > .05) {
				const progress = nightProgress();
				const mx = lerp(W * .16, W * .84, progress);
				const my = H * .42 - Math.sin(progress * Math.PI) * H * .26;
				const r = Math.max(13, Math.min(24, H * .13));
				const halo = ctx.createRadialGradient(mx, my, 0, mx, my, r * 7);
				halo.addColorStop(0, `rgba(198,216,244,${.26 * p.moon})`);
				halo.addColorStop(.35, `rgba(150,178,214,${.09 * p.moon})`);
				halo.addColorStop(1, "rgba(150,178,214,0)");
				ctx.fillStyle = halo;
				ctx.beginPath();
				ctx.arc(mx, my, r * 7, 0, 6.2832);
				ctx.fill();
				ctx.save();
				ctx.globalAlpha = p.moon;
				ctx.fillStyle = "#e8eefb";
				ctx.beginPath();
				ctx.arc(mx, my, r, 0, 6.2832);
				ctx.fill();
				const phase = (nightIndex.value - 1) % 4 / 4;
				ctx.globalCompositeOperation = "destination-out";
				ctx.beginPath();
				ctx.arc(mx - r * (.25 + phase * 1.15), my - r * .12, r * .94, 0, 6.2832);
				ctx.fill();
				ctx.restore();
			}
			if (skyTone.value === "day") {
				const sx = W * .78, sy = H * .3;
				const halo = ctx.createRadialGradient(sx, sy, 0, sx, sy, H * 1.1);
				halo.addColorStop(0, "rgba(255,238,198,0.55)");
				halo.addColorStop(.25, "rgba(246,208,148,0.18)");
				halo.addColorStop(1, "rgba(246,208,148,0)");
				ctx.fillStyle = halo;
				ctx.beginPath();
				ctx.arc(sx, sy, H * 1.1, 0, 6.2832);
				ctx.fill();
			}
			const base = H + 6;
			const s = Math.max(.5, Math.min(1.35, W / 1360));
			ctx.save();
			ctx.translate(W / 2 - 750 * s, 0);
			ctx.scale(s, s);
			ctx.fillStyle = "rgba(6,10,16,0.85)";
			for (const h of houses) {
				if (h.tree) continue;
				const y = base - h.h * .62;
				ctx.fillRect(h.x + 6, y + 8, h.w, h.h);
				if (h.peak) {
					ctx.beginPath();
					ctx.moveTo(h.x + 2, y + 8);
					ctx.lineTo(h.x + 6 + h.w / 2, y - h.h * .2);
					ctx.lineTo(h.x + 10 + h.w, y + 8);
					ctx.closePath();
					ctx.fill();
				}
			}
			ctx.fillStyle = "#04070c";
			for (const h of houses) {
				const y = base - h.h;
				if (h.tree) {
					ctx.beginPath();
					ctx.moveTo(h.x + h.w / 2, y - 14);
					ctx.lineTo(h.x + h.w, y + h.h * .4);
					ctx.lineTo(h.x, y + h.h * .4);
					ctx.closePath();
					ctx.fill();
					ctx.fillRect(h.x + h.w / 2 - 1.5, y + h.h * .3, 3, h.h * .7);
					continue;
				}
				ctx.fillRect(h.x + 8, y + 6, h.w, h.h);
				if (h.peak) {
					ctx.beginPath();
					ctx.moveTo(h.x + 3, y + 7);
					ctx.lineTo(h.x + 8 + h.w / 2, y - h.h * .22);
					ctx.lineTo(h.x + 13 + h.w, y + 7);
					ctx.closePath();
					ctx.fill();
				}
				if (h.steeple) {
					ctx.beginPath();
					ctx.moveTo(h.x + 8 + h.w / 2, y - 34);
					ctx.lineTo(h.x + 13 + h.w, y + 8);
					ctx.lineTo(h.x + 3, y + 8);
					ctx.closePath();
					ctx.fill();
				}
				if (h.chimney) ctx.fillRect(h.x + 8 + h.w * .72, y - 2, 7, 14);
			}
			const players = game.value?.players || [];
			for (let i = 0; i < 9; i++) {
				const h = windowHouses[i];
				if (!h) continue;
				const alive = players[i] ? players[i].alive : true;
				const isHuman = players[i]?.isHuman;
				const y = base - h.h + 16;
				const wx = h.x + 8 + h.w / 2 - 3.5;
				const ww = 7, wh = 9;
				if (alive) {
					const flick = reduced ? 1 : .86 + .14 * Math.sin(time * 3.1 + i * 1.7);
					ctx.save();
					ctx.shadowColor = "rgba(242,217,121,0.85)";
					ctx.shadowBlur = 12 * flick;
					ctx.fillStyle = `rgba(246,222,140,${.94 * flick})`;
					ctx.fillRect(wx, y, ww, wh);
					ctx.restore();
					ctx.fillStyle = "rgba(4,7,12,0.75)";
					ctx.fillRect(wx + ww / 2 - .5, y, 1, wh);
					ctx.fillRect(wx, y + wh / 2 - .5, ww, 1);
					if (isHuman) {
						ctx.strokeStyle = "rgba(242,217,121,0.9)";
						ctx.lineWidth = 1.2;
						ctx.strokeRect(wx - 2.5, y - 2.5, 12, 14);
					}
				} else {
					ctx.fillStyle = "rgba(18,26,38,0.9)";
					ctx.fillRect(wx, y, ww, wh);
					ctx.strokeStyle = "rgba(120,140,170,0.14)";
					ctx.lineWidth = .8;
					ctx.strokeRect(wx + .4, y + .4, 6.2, 8.2);
				}
			}
			ctx.restore();
			const seam = ctx.createLinearGradient(0, H - 26, 0, H);
			seam.addColorStop(0, "rgba(6,10,16,0)");
			seam.addColorStop(1, "rgba(3,6,10,0.96)");
			ctx.fillStyle = seam;
			ctx.fillRect(0, H - 26, W, 26);
		}
		/** 夜空进度：狼人 → 预言家 → 女巫 → 天亮 */
		function nightProgress() {
			const g = game.value;
			if (!g) return .5;
			if (g.phase === "night") return {
				wolf: .22,
				seer: .46,
				witch: .7
			}[g.nightStep] ?? .5;
			if (g.phase === "dawn") return .93;
			if (g.phase === "over") return .5;
			return .86;
		}
		function loop(now) {
			raf = requestAnimationFrame(loop);
			if (now - lastFrame < 33) return;
			lastFrame = now;
			draw(now);
		}
		onMounted(() => {
			reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
			resize();
			ro = new ResizeObserver(resize);
			ro.observe(wrap.value);
			window.addEventListener("resize", onResize);
			if (reduced) draw(performance.now());
			else raf = requestAnimationFrame(loop);
		});
		onBeforeUnmount(() => {
			cancelAnimationFrame(raf);
			ro?.disconnect();
			window.removeEventListener("resize", onResize);
		});
		return (_ctx, _push, _parent, _attrs) => {
			_push(`<div${ssrRenderAttrs(mergeProps({
				ref_key: "wrap",
				ref: wrap,
				class: "canopy"
			}, _attrs))} data-v-3539068c><canvas class="sky" aria-hidden="true" data-v-3539068c></canvas><div class="readout" data-v-3539068c><div class="eyebrow" data-v-3539068c>`);
			if (unref(game)) _push(`<span data-v-3539068c>第 ${ssrInterpolate(unref(game).day)} ${ssrInterpolate(unref(game).phase === "night" ? "夜" : "天")}</span>`);
			else _push(`<span data-v-3539068c>九人标准局</span>`);
			_push(`</div><h1 class="phase" data-v-3539068c>${ssrInterpolate(unref(game) ? unref(game).phaseLabel : "狼人杀")}</h1></div><div class="census"${ssrRenderAttr("title", `村里还亮着 ${lit.value} 扇窗`)} data-v-3539068c><span class="num census-n" data-v-3539068c>${ssrInterpolate(lit.value)}</span><span class="census-d" data-v-3539068c>/ ${ssrInterpolate(total.value)} 人</span><span class="census-label" data-v-3539068c>屋里还有灯</span></div></div>`);
		};
	}
};
var _sfc_setup$10 = _sfc_main$10.setup;
_sfc_main$10.setup = (props, ctx) => {
	const ssrContext = useSSRContext();
	(ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("src/components/SkyCanopy.vue");
	return _sfc_setup$10 ? _sfc_setup$10(props, ctx) : void 0;
};
var SkyCanopy_default = /*#__PURE__*/ _plugin_vue_export_helper_default(_sfc_main$10, [["__scopeId", "data-v-3539068c"]]);
//#endregion
//#region src/components/SeatCard.vue
var _sfc_main$9 = {
	__name: "SeatCard",
	__ssrInlineRender: true,
	props: {
		player: {
			type: Object,
			required: true
		},
		x: {
			type: Number,
			required: true
		},
		y: {
			type: Number,
			required: true
		},
		speaker: Boolean,
		votable: Boolean,
		selectable: Boolean,
		dimmed: Boolean
	},
	emits: ["pick"],
	setup(__props, { emit: __emit }) {
		/**
		* 一张席位牌。
		* 木牌 + 火漆印的形制：活着的时候是暖色，出局之后整块木头褪成灰。
		*/
		const props = __props;
		const { game, me, pending } = useGame();
		const p = computed(() => props.player);
		const seerClaim = computed(() => game.value?.claims.find((c) => c.playerId === p.value.id && c.role === ROLE.SEER) || null);
		const checkMark = computed(() => {
			const g = game.value;
			if (!g) return null;
			for (const c of g.claims) for (const chk of c.checks) if (chk.targetId === p.value.id) return {
				result: chk.result,
				by: c.playerId
			};
			return null;
		});
		const isTeammate = computed(() => p.value.role === ROLE.WOLF && me.value?.role === ROLE.WOLF && p.value.id !== me.value.id);
		const votesAgainst = computed(() => {
			const g = game.value;
			if (!g || g.phase !== "vote") return 0;
			return g.log.filter((e) => e.kind === "vote" && e.day === g.day && e.targetId === p.value.id).length;
		});
		const myVoteHere = computed(() => {
			const g = game.value;
			if (!g || g.phase !== "vote") return false;
			return g.log.some((e) => e.kind === "vote" && e.day === g.day && e.playerId === g.humanId && e.targetId === p.value.id);
		});
		const canClick = computed(() => props.selectable && !props.dimmed && p.value.alive);
		const sealPath = computed(() => {
			const seed = p.value.hue * 13.7 + p.value.seat * 41;
			const pts = [];
			const n = 18;
			for (let i = 0; i < n; i++) {
				const a = i / n * Math.PI * 2;
				const r = 21 * (1 + (Math.sin(seed + i * 2.399) * .035 + Math.cos(seed * 1.7 + i) * .02));
				pts.push(`${(22 + Math.cos(a) * r).toFixed(2)},${(22 + Math.sin(a) * r).toFixed(2)}`);
			}
			return `M${pts.join("L")}Z`;
		});
		const avatarStyle = computed(() => ({
			"--h": p.value.hue,
			background: p.value.alive ? `radial-gradient(circle at 34% 28%, hsl(${p.value.hue} 30% 30%), hsl(${p.value.hue} 26% 15%))` : "radial-gradient(circle at 34% 28%, #1b2029, #0d1117)"
		}));
		return (_ctx, _push, _parent, _attrs) => {
			_push(`<div${ssrRenderAttrs(mergeProps({
				class: ["seat", {
					dead: !p.value.alive,
					human: p.value.isHuman,
					speaker: __props.speaker,
					votable: __props.votable,
					selectable: canClick.value,
					dimmed: __props.dimmed,
					teammate: isTeammate.value
				}],
				style: { transform: `translate(-50%, -50%) translate(${__props.x}px, ${__props.y}px)` }
			}, _attrs))} data-v-a5b848f2><button class="card cut-sm"${ssrIncludeBooleanAttr(!canClick.value) ? " disabled" : ""}${ssrRenderAttr("aria-label", `${p.value.seat + 1}号${p.value.name}${p.value.alive ? "" : "（已出局）"}`)} data-v-a5b848f2><span class="no num" data-v-a5b848f2>${ssrInterpolate(p.value.seat + 1)}</span><span class="avatar" style="${ssrRenderStyle(avatarStyle.value)}" data-v-a5b848f2><svg class="ring" viewBox="0 0 44 44" aria-hidden="true" data-v-a5b848f2><path${ssrRenderAttr("d", sealPath.value)} class="${ssrRenderClass(p.value.alive ? "stroke-alive" : "stroke-dead")}" data-v-a5b848f2></path></svg><span class="initial" data-v-a5b848f2>${ssrInterpolate(p.value.name.slice(0, 1))}</span></span><span class="who" data-v-a5b848f2><span class="name" data-v-a5b848f2>${ssrInterpolate(p.value.isHuman ? "你" : p.value.name)}</span><span class="epithet" data-v-a5b848f2>${ssrInterpolate(p.value.persona.epithet)}</span></span><span class="marks" data-v-a5b848f2>`);
			if (isTeammate.value) _push(`<span class="tag tag-blood" data-v-a5b848f2>同伴</span>`);
			else _push(`<!---->`);
			if (seerClaim.value) _push(`<span class="tag tag-brass" data-v-a5b848f2>预言家</span>`);
			else _push(`<!---->`);
			if (checkMark.value && checkMark.value.result === unref(ROLE).WOLF) _push(`<span class="tag tag-blood" data-v-a5b848f2>查杀</span>`);
			else if (checkMark.value) _push(`<span class="tag tag-moss" data-v-a5b848f2>金水</span>`);
			else _push(`<!---->`);
			_push(`</span>`);
			if (votesAgainst.value) _push(`<span class="votes num" data-v-a5b848f2>${ssrInterpolate(votesAgainst.value)}</span>`);
			else _push(`<!---->`);
			if (myVoteHere.value) _push(`<span class="myvote" data-v-a5b848f2>你的票</span>`);
			else _push(`<!---->`);
			_push(`</button>`);
			if (!p.value.alive) _push(`<span class="seal" aria-hidden="true" data-v-a5b848f2><span class="seal-text" data-v-a5b848f2>${ssrInterpolate(p.value.deathReason === "vote" ? "放逐" : "殁")}</span></span>`);
			else _push(`<!---->`);
			if (__props.speaker) _push(`<div class="speaking" aria-hidden="true" data-v-a5b848f2><i data-v-a5b848f2></i><i data-v-a5b848f2></i><i data-v-a5b848f2></i></div>`);
			else _push(`<!---->`);
			_push(`</div>`);
		};
	}
};
var _sfc_setup$9 = _sfc_main$9.setup;
_sfc_main$9.setup = (props, ctx) => {
	const ssrContext = useSSRContext();
	(ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("src/components/SeatCard.vue");
	return _sfc_setup$9 ? _sfc_setup$9(props, ctx) : void 0;
};
var SeatCard_default = /*#__PURE__*/ _plugin_vue_export_helper_default(_sfc_main$9, [["__scopeId", "data-v-a5b848f2"]]);
//#endregion
//#region src/composables/useTypewriter.js
/**
* 逐字显现。速度自适应：长句更快，短句从容。
* 尊重 prefers-reduced-motion —— 那种情况下直接全量显示。
*/
function useTypewriter(source, { base = 34, min = 14, max = 62 } = {}) {
	const shown = ref("");
	const done = ref(false);
	let timer = null;
	const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
	function stop() {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	}
	function run(text) {
		stop();
		if (!text) {
			shown.value = "";
			done.value = true;
			return;
		}
		if (reduced) {
			shown.value = text;
			done.value = true;
			return;
		}
		const step = Math.max(min, Math.min(max, Math.round(1400 / Math.max(6, text.length))));
		let i = 0;
		shown.value = "";
		done.value = false;
		timer = setInterval(() => {
			i += 1;
			shown.value = text.slice(0, i);
			if (i >= text.length) {
				stop();
				done.value = true;
			}
		}, step);
	}
	watch(source, (t) => run(t), { immediate: true });
	onBeforeUnmount(stop);
	return {
		shown,
		done
	};
}
//#endregion
//#region src/components/TableHub.vue
var _sfc_main$8 = {
	__name: "TableHub",
	__ssrInlineRender: true,
	setup(__props) {
		/**
		* 桌心。
		* 发言时这里是字幕，等待时这里是局势提示。
		*/
		const { game, pending, me, aliveCount } = useGame();
		const speakerId = computed(() => game.value?.currentSpeech?.playerId ?? null);
		const rawText = computed(() => game.value?.currentSpeech?.text ?? "");
		const { shown, done } = useTypewriter(rawText);
		const speaker = computed(() => {
			const g = game.value;
			if (!g || speakerId.value == null) return null;
			return g.players.find((p) => p.id === speakerId.value);
		});
		const quiet = computed(() => !rawText.value);
		/** 安静的时候，说一句应景的话 */
		const hint = computed(() => {
			const g = game.value;
			if (!g) return {
				text: "",
				note: ""
			};
			if (g.phase === "over") return {
				text: g.winReason,
				note: "本局结束"
			};
			if (g.phase === "night") {
				if (g.nightStep === "wolf") return me.value?.role === ROLE.WOLF ? {
					text: "同伴在等你定刀口。",
					note: "狼人行动"
				} : {
					text: "狼人正在睁眼，商量今晚要杀谁。",
					note: "狼人行动"
				};
				if (g.nightStep === "seer") return me.value?.role === ROLE.SEER ? {
					text: "挑一个你最想看清的人。",
					note: "预言家行动"
				} : {
					text: "预言家正在查验一个人。",
					note: "预言家行动"
				};
				if (g.nightStep === "witch") return {
					text: "女巫手上还有药。",
					note: "女巫行动"
				};
				return {
					text: "所有人闭眼。村子安静得能听见风。",
					note: `第 ${g.day} 夜`
				};
			}
			if (g.phase === "dawn") return {
				text: "天亮了。先看看昨晚谁没能起来。",
				note: "天亮"
			};
			if (g.phase === "day") return {
				text: "按顺序发言。听清楚谁在保谁，谁在推谁。",
				note: "白天发言"
			};
			if (g.phase === "vote") return {
				text: "投票放逐。多数票出局，平票则谁也不走。",
				note: "投票"
			};
			return {
				text: "",
				note: ""
			};
		});
		const tally = computed(() => {
			const g = game.value;
			if (!g || g.phase !== "vote" || !g.lastTally) return [];
			return g.lastTally.map((t) => ({
				...t,
				player: g.players.find((p) => p.id === t.playerId)
			}));
		});
		return (_ctx, _push, _parent, _attrs) => {
			_push(`<div${ssrRenderAttrs(mergeProps({ class: "hub" }, _attrs))} data-v-ee00eabc>`);
			if (!quiet.value) {
				_push(`<div class="speech" data-v-ee00eabc><div class="line" data-v-ee00eabc><span class="dot" style="${ssrRenderStyle({ background: `hsl(${speaker.value?.hue} 45% 55%)` })}" data-v-ee00eabc></span><span class="who" data-v-ee00eabc>${ssrInterpolate(speaker.value?.isHuman ? "你" : `${speaker.value?.seat + 1}号${speaker.value?.name}`)}</span><span class="role-note" data-v-ee00eabc>${ssrInterpolate(speaker.value?.isHuman ? "" : speaker.value?.persona?.epithet)}</span></div><p class="text" data-v-ee00eabc>${ssrInterpolate(unref(shown))}`);
				if (!unref(done)) _push(`<span class="caret" data-v-ee00eabc></span>`);
				else _push(`<!---->`);
				_push(`</p></div>`);
			} else {
				_push(`<div class="hint" data-v-ee00eabc><div class="eyebrow hint-note" data-v-ee00eabc>${ssrInterpolate(hint.value.note)}</div><p class="hint-text" data-v-ee00eabc>${ssrInterpolate(hint.value.text)}</p>`);
				if (tally.value.length) {
					_push(`<div class="tally" data-v-ee00eabc><!--[-->`);
					ssrRenderList(tally.value, (t) => {
						_push(`<span class="tally-item" data-v-ee00eabc><span class="num" data-v-ee00eabc>${ssrInterpolate(t.player?.seat + 1)}</span><span class="num tally-n" data-v-ee00eabc>${ssrInterpolate(t.count)}</span></span>`);
					});
					_push(`<!--]--></div>`);
				} else if (unref(pending)) _push(`<div class="waiting" data-v-ee00eabc><i data-v-ee00eabc></i><i data-v-ee00eabc></i><i data-v-ee00eabc></i><span data-v-ee00eabc>等你决定</span></div>`);
				else _push(`<!---->`);
				_push(`</div>`);
			}
			_push(`</div>`);
		};
	}
};
var _sfc_setup$8 = _sfc_main$8.setup;
_sfc_main$8.setup = (props, ctx) => {
	const ssrContext = useSSRContext();
	(ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("src/components/TableHub.vue");
	return _sfc_setup$8 ? _sfc_setup$8(props, ctx) : void 0;
};
var TableHub_default = /*#__PURE__*/ _plugin_vue_export_helper_default(_sfc_main$8, [["__scopeId", "data-v-ee00eabc"]]);
//#endregion
//#region src/components/SeatRing.vue
var CARD_W = 104;
var CARD_H = 118;
var _sfc_main$7 = {
	__name: "SeatRing",
	__ssrInlineRender: true,
	setup(__props) {
		/**
		* 圆桌。九个席位按等角分布在椭圆上，人类固定在正下方。
		* 投票时，票会画成弧线从投票人飞向他投的人——一局狼人杀的票型，
		* 天生就是一张图，没必要用表格去表达。
		*/
		const { game, pending, pick, me } = useGame();
		const el = ref(null);
		const box = ref({
			w: 1100,
			h: 520
		});
		let ro = null;
		let raf = 0;
		function measure() {
			if (!el.value) return;
			const r = el.value.getBoundingClientRect();
			box.value = {
				w: Math.max(360, r.width),
				h: Math.max(280, r.height)
			};
		}
		const layout = computed(() => {
			const { w, h } = box.value;
			const rx = Math.max(120, Math.min(w * .5 - CARD_W * .72, 368));
			const ry = Math.max(84, Math.min(h * .5 - CARD_H * .72, 166));
			const cx = w / 2;
			const cy = h / 2;
			return {
				rx,
				ry,
				cx,
				cy,
				seats: (game.value?.players || []).map((p, i) => {
					const a = (90 + i * 40) * Math.PI / 180;
					return {
						p,
						x: cx + rx * Math.cos(a),
						y: cy + ry * Math.sin(a),
						angle: a
					};
				})
			};
		});
		const candidates = computed(() => {
			const c = pending.value?.candidates;
			return c ? new Set(c) : null;
		});
		function selectable(id) {
			const g = game.value;
			if (!(g?.players.find((x) => x.id === id))?.alive) return false;
			if (!pending.value) return false;
			if (pending.value.kind === "vote") return id !== g.humanId;
			return candidates.value ? candidates.value.has(id) : false;
		}
		function dimmed(id) {
			if (!pending.value) return false;
			if (pending.value.kind === "vote") return id === game.value.humanId;
			return !candidates.value?.has(id) || !game.value.players.find((x) => x.id === id)?.alive;
		}
		const arrows = computed(() => {
			const g = game.value;
			if (!g || g.phase !== "vote") return [];
			const pos = Object.fromEntries(layout.value.seats.map((s) => [s.p.id, s]));
			const out = [];
			let i = 0;
			for (const e of g.log) {
				if (e.kind !== "vote" || e.day !== g.day || e.targetId == null) continue;
				const a = pos[e.playerId];
				const b = pos[e.targetId];
				if (!a || !b || e.playerId === e.targetId) continue;
				const dx = b.x - a.x;
				const dy = b.y - a.y;
				const d = Math.hypot(dx, dy) || 1;
				const off = 56;
				const sx = a.x + dx / d * off;
				const sy = a.y + dy / d * off;
				const ex = b.x - dx / d * 50;
				const ey = b.y - dy / d * 50;
				const nx = -dy / d;
				const ny = dx / d;
				const bow = d * .13;
				const qx = (sx + ex) / 2 + nx * bow;
				const qy = (sy + ey) / 2 + ny * bow;
				out.push({
					key: `${e.playerId}-${e.targetId}-${i++}`,
					d: `M${sx.toFixed(1)},${sy.toFixed(1)} Q${qx.toFixed(1)},${qy.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`
				});
			}
			return out;
		});
		const tableStyle = computed(() => {
			const { rx, ry } = layout.value;
			return {
				width: `${(rx + CARD_W * .62) * 2}px`,
				height: `${(ry + CARD_H * .6) * 2}px`
			};
		});
		onMounted(() => {
			measure();
			ro = new ResizeObserver(measure);
			ro.observe(el.value);
			window.addEventListener("resize", measure);
		});
		onBeforeUnmount(() => {
			ro?.disconnect();
			cancelAnimationFrame(raf);
			window.removeEventListener("resize", measure);
		});
		return (_ctx, _push, _parent, _attrs) => {
			_push(`<div${ssrRenderAttrs(mergeProps({
				ref_key: "el",
				ref: el,
				class: "ring"
			}, _attrs))} data-v-cb2c952e><div class="table" style="${ssrRenderStyle(tableStyle.value)}" aria-hidden="true" data-v-cb2c952e><div class="table-inner" data-v-cb2c952e></div><div class="table-rim" data-v-cb2c952e></div></div><svg class="arrows"${ssrRenderAttr("viewBox", `0 0 ${box.value.w} ${box.value.h}`)} preserveAspectRatio="none" aria-hidden="true" data-v-cb2c952e><defs data-v-cb2c952e><marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse" data-v-cb2c952e><path d="M0,1 L9,5 L0,9 z" fill="rgba(212,69,60,0.85)" data-v-cb2c952e></path></marker></defs><!--[-->`);
			ssrRenderList(arrows.value, (a) => {
				_push(`<path${ssrRenderAttr("d", a.d)} class="arrow" pathLength="1" marker-end="url(#ah)" data-v-cb2c952e></path>`);
			});
			_push(`<!--]--></svg><!--[-->`);
			ssrRenderList(layout.value.seats, (s) => {
				_push(ssrRenderComponent(SeatCard_default, {
					key: s.p.id,
					player: s.p,
					x: s.x,
					y: s.y,
					speaker: unref(game)?.turn === s.p.id,
					votable: unref(game)?.phase === "vote" && s.p.alive,
					selectable: selectable(s.p.id),
					dimmed: dimmed(s.p.id),
					onPick: unref(pick)
				}, null, _parent));
			});
			_push(`<!--]-->`);
			_push(ssrRenderComponent(TableHub_default, null, null, _parent));
			_push(`</div>`);
		};
	}
};
var _sfc_setup$7 = _sfc_main$7.setup;
_sfc_main$7.setup = (props, ctx) => {
	const ssrContext = useSSRContext();
	(ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("src/components/SeatRing.vue");
	return _sfc_setup$7 ? _sfc_setup$7(props, ctx) : void 0;
};
var SeatRing_default = /*#__PURE__*/ _plugin_vue_export_helper_default(_sfc_main$7, [["__scopeId", "data-v-cb2c952e"]]);
//#endregion
//#region src/components/RoleCard.vue
var _sfc_main$6 = {
	__name: "RoleCard",
	__ssrInlineRender: true,
	setup(__props) {
		/**
		* 我的手牌。
		* 是一张实物：木纹底、火漆印、可以翻面看牌背（牌背写着你的私密情报）。
		*/
		const { game, me, myRoleMeta, myTeammates } = useGame();
		const flipped = ref(false);
		const meta = computed(() => myRoleMeta.value);
		const tone = computed(() => {
			return {
				blood: {
					a: "#d4453c",
					b: "rgba(155,34,38,0.5)"
				},
				moss: {
					a: "#86ba95",
					b: "rgba(79,122,91,0.5)"
				},
				moon: {
					a: "#cfdff4",
					b: "rgba(143,168,200,0.5)"
				},
				brass: {
					a: "#f2d979",
					b: "rgba(201,162,39,0.5)"
				},
				candle: {
					a: "#efe6d2",
					b: "rgba(194,181,155,0.45)"
				}
			}[meta.value?.tone] || {
				a: "#f2d979",
				b: "rgba(201,162,39,0.5)"
			};
		});
		const checks = computed(() => (me.value?.checks || []).slice().reverse());
		const teammates = computed(() => myTeammates.value);
		const isDead = computed(() => me.value && !me.value.alive);
		return (_ctx, _push, _parent, _attrs) => {
			if (meta.value) {
				_push(`<div${ssrRenderAttrs(mergeProps({ class: ["hand", {
					flipped: flipped.value,
					dead: isDead.value
				}] }, _attrs))} data-v-3a1f845f><button class="flip"${ssrRenderAttr("aria-pressed", flipped.value)}${ssrRenderAttr("aria-label", flipped.value ? "看牌面" : "看牌背")} data-v-3a1f845f><span class="inner" data-v-3a1f845f><span class="face front cut-sm" style="${ssrRenderStyle({
					"--accent": tone.value.a,
					"--accent-dim": tone.value.b
				})}" data-v-3a1f845f><span class="corner tl num" data-v-3a1f845f>${ssrInterpolate(unref(me).seat + 1)}</span><span class="corner br num" data-v-3a1f845f>${ssrInterpolate(unref(me).seat + 1)}</span><span class="sigil" data-v-3a1f845f><svg viewBox="0 0 68 68" aria-hidden="true" data-v-3a1f845f><circle cx="34" cy="34" r="30" data-v-3a1f845f></circle></svg><span class="sigil-ch" data-v-3a1f845f>${ssrInterpolate(meta.value.sigil)}</span></span><span class="role-name" data-v-3a1f845f>${ssrInterpolate(meta.value.name)}</span><span class="${ssrRenderClass([meta.value.team === unref(TEAM).WOLF ? "is-wolf" : "is-good", "team"])}" data-v-3a1f845f>${ssrInterpolate(meta.value.team === unref(TEAM).WOLF ? "狼人阵营" : "好人阵营")}</span></span><span class="face back cut-sm" data-v-3a1f845f><span class="back-title" data-v-3a1f845f>${ssrInterpolate(meta.value.name)} · 须知</span><span class="back-line" data-v-3a1f845f>${ssrInterpolate(meta.value.brief)}</span><span class="back-win" data-v-3a1f845f>胜利条件：${ssrInterpolate(meta.value.win)}</span>`);
				if (teammates.value.length) _push(`<span class="intel" data-v-3a1f845f><span class="intel-label" data-v-3a1f845f>同伴</span><span class="intel-value" data-v-3a1f845f>${ssrInterpolate(teammates.value.map((t) => `${t.seat + 1}号${t.name}${t.alive ? "" : "（已出局）"}`).join("、"))}</span></span>`);
				else _push(`<!---->`);
				if (checks.value.length) {
					_push(`<span class="intel" data-v-3a1f845f><span class="intel-label" data-v-3a1f845f>已验</span><span class="intel-value" data-v-3a1f845f><!--[-->`);
					ssrRenderList(checks.value, (c) => {
						_push(`<span class="verdict" data-v-3a1f845f><span class="num" data-v-3a1f845f>${ssrInterpolate(unref(game).players.find((p) => p.id === c.targetId)?.seat + 1)}</span><em class="${ssrRenderClass(c.result === unref(ROLE).WOLF ? "w" : "g")}" data-v-3a1f845f>${ssrInterpolate(c.result === unref(ROLE).WOLF ? "狼" : "好")}</em></span>`);
					});
					_push(`<!--]--></span></span>`);
				} else _push(`<!---->`);
				if (unref(me).role === unref(ROLE).WITCH) _push(`<span class="intel" data-v-3a1f845f><span class="intel-label" data-v-3a1f845f>药</span><span class="intel-value potions" data-v-3a1f845f><em class="${ssrRenderClass(unref(me).antidote ? "on" : "off")}" data-v-3a1f845f>解药${ssrInterpolate(unref(me).antidote ? "在" : "已用")}</em><em class="${ssrRenderClass(unref(me).poison ? "on" : "off")}" data-v-3a1f845f>毒药${ssrInterpolate(unref(me).poison ? "在" : "已用")}</em></span></span>`);
				else _push(`<!---->`);
				_push(`</span></span></button><span class="flip-hint" data-v-3a1f845f>翻面</span>`);
				if (isDead.value) _push(`<span class="dead-seal" data-v-3a1f845f><span data-v-3a1f845f>你已出局</span></span>`);
				else _push(`<!---->`);
				_push(`</div>`);
			} else _push(`<!---->`);
		};
	}
};
var _sfc_setup$6 = _sfc_main$6.setup;
_sfc_main$6.setup = (props, ctx) => {
	const ssrContext = useSSRContext();
	(ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("src/components/RoleCard.vue");
	return _sfc_setup$6 ? _sfc_setup$6(props, ctx) : void 0;
};
var RoleCard_default = /*#__PURE__*/ _plugin_vue_export_helper_default(_sfc_main$6, [["__scopeId", "data-v-3a1f845f"]]);
//#endregion
//#region src/components/ActionDock.vue
var _sfc_main$5 = {
	__name: "ActionDock",
	__ssrInlineRender: true,
	setup(__props) {
		/**
		* 行动坞。
		* 左边是我的手牌（永远看得见自己的身份），右边是当下唯一要做的那件事。
		* 这里的原则是：任何时刻，屏幕上只出现一个明确的问题。
		*/
		const { game, me, pending, paused, speed, muted, pick, skip, submitWitch, submitSpeech, submitVote, toggleMute, togglePause, restart } = useGame();
		const P = (id) => game.value?.players.find((p) => p.id === id);
		const shortLabel = (id) => {
			const p = P(id);
			return p ? `${p.seat + 1}号` : "—";
		};
		const kind = ref(null);
		const targetId = ref(null);
		const verdict = ref(ROLE.WOLF);
		const text = ref("");
		watch(pending, () => {
			kind.value = null;
			targetId.value = null;
			verdict.value = ROLE.WOLF;
			text.value = "";
		});
		const kinds = computed(() => pending.value?.kinds || []);
		const curKind = computed(() => kinds.value.find((k) => k.id === kind.value) || null);
		const needsTarget = computed(() => {
			if (!curKind.value) return false;
			if (kind.value === "claim-seer") return me.value?.role !== ROLE.SEER;
			return !!curKind.value.needsTarget;
		});
		const canSpeak = computed(() => {
			if (!kind.value) return false;
			if (needsTarget.value && targetId.value == null) return false;
			return true;
		});
		const remain = ref(0);
		let tick = null;
		watch(() => [pending.value?.id, pending.value?.timeLimit], () => {
			clearInterval(tick);
			const lim = pending.value?.timeLimit || 0;
			remain.value = lim ? Math.ceil(lim / 1e3) : 0;
			if (!lim) return;
			const deadline = Date.now() + lim;
			tick = setInterval(() => {
				const left = Math.max(0, deadline - Date.now());
				remain.value = Math.ceil(left / 1e3);
				if (left <= 0) {
					clearInterval(tick);
					if (pending.value?.kind === "vote") submitVote(null);
				}
			}, 250);
		}, { immediate: true });
		onBeforeUnmount(() => clearInterval(tick));
		const witchPoison = ref(null);
		watch(pending, () => {
			witchPoison.value = null;
		});
		const headTitle = computed(() => {
			const g = game.value;
			if (!g) return "准备";
			const p = pending.value;
			if (!p) {
				if (g.phase === "over") return "本局结束";
				if (g.phase === "night") return "夜里";
				return "白天";
			}
			return {
				"pick-one": "选择目标",
				vote: "投票放逐",
				witch: "女巫用药",
				speak: "发言"
			}[p.kind] || "行动";
		});
		const idleText = computed(() => {
			const g = game.value;
			if (!g) return "";
			if (g.phase === "over") return `本局由${g.winner === "wolf" ? "狼人" : "好人"}阵营获胜。`;
			if (g.turn != null) {
				const t = P(g.turn);
				if (t && !t.isHuman) return `等 ${t.seat + 1}号${t.name} 说完。`;
			}
			if (g.phase === "night") return "所有人闭着眼。";
			if (g.phase === "vote") return "正在收票。";
			return "稍等片刻。";
		});
		const speedOptions = [
			{
				v: .6,
				name: "慢"
			},
			{
				v: 1,
				name: "正常"
			},
			{
				v: 2.2,
				name: "快"
			}
		];
		return (_ctx, _push, _parent, _attrs) => {
			_push(`<div${ssrRenderAttrs(mergeProps({ class: "dock" }, _attrs))} data-v-20dd53ef>`);
			_push(ssrRenderComponent(RoleCard_default, null, null, _parent));
			_push(`<section class="action panel" data-v-20dd53ef><header class="panel-head" data-v-20dd53ef><span class="panel-title" data-v-20dd53ef>${ssrInterpolate(headTitle.value)}</span><span class="controls" data-v-20dd53ef><span class="speeds" data-v-20dd53ef><!--[-->`);
			ssrRenderList(speedOptions, (s) => {
				_push(`<button class="${ssrRenderClass([{ on: unref(speed) === s.v }, "speed"])}"${ssrRenderAttr("title", `节奏：${s.name}`)} data-v-20dd53ef>${ssrInterpolate(s.name)}</button>`);
			});
			_push(`<!--]--></span><button class="ic"${ssrRenderAttr("title", unref(paused) ? "继续" : "暂停")} data-v-20dd53ef>${ssrInterpolate(unref(paused) ? "▶" : "❚❚")}</button><button class="ic"${ssrRenderAttr("title", unref(muted) ? "打开音效" : "静音")} data-v-20dd53ef>${ssrInterpolate(unref(muted) ? "♪̸" : "♪")}</button><button class="ic" title="重开一局" data-v-20dd53ef>↺</button></span></header><div class="body" data-v-20dd53ef>`);
			if (unref(pending) && unref(pending).auto) {
				_push(`<div class="auto" data-v-20dd53ef><div class="auto-head" data-v-20dd53ef><span class="auto-tag" data-v-20dd53ef>AI 托管</span><span class="auto-who" data-v-20dd53ef>${ssrInterpolate(unref(me)?.isHuman ? "你的席位" : "")}正在决定</span></div><p class="auto-title" data-v-20dd53ef>${ssrInterpolate(unref(pending).title)}</p>`);
				if (unref(pending).hint) _push(`<p class="auto-hint" data-v-20dd53ef>${ssrInterpolate(unref(pending).hint)}</p>`);
				else _push(`<!---->`);
				_push(`<p class="auto-note" data-v-20dd53ef> 观战模式下，你的席位交给同一套 AI`);
				if (unref(pending).candidates?.length) _push(`<!--[-->，候选 ${ssrInterpolate(unref(pending).candidates.length)} 人<!--]-->`);
				else _push(`<!---->`);
				_push(`。 想看它怎么想，就把纪要拉到最下面。 </p></div>`);
			} else if (!unref(pending)) _push(`<div class="idle" data-v-20dd53ef><div class="idle-line" data-v-20dd53ef><span class="pulse" data-v-20dd53ef></span><span data-v-20dd53ef>${ssrInterpolate(idleText.value)}</span></div></div>`);
			else if (unref(pending).kind === "pick-one") {
				_push(`<!--[--><div class="ask" data-v-20dd53ef><h3 class="ask-title" data-v-20dd53ef>${ssrInterpolate(unref(pending).title)}</h3>`);
				if (unref(pending).hint) _push(`<p class="ask-hint" data-v-20dd53ef>${ssrInterpolate(unref(pending).hint)}</p>`);
				else _push(`<!---->`);
				if (unref(pending).suggestion) _push(`<p class="ask-sug" data-v-20dd53ef>参考：${ssrInterpolate(unref(pending).suggestion)}</p>`);
				else _push(`<!---->`);
				_push(`</div><div class="choices" data-v-20dd53ef><!--[-->`);
				ssrRenderList(unref(pending).candidates, (id) => {
					_push(`<button class="choice" data-v-20dd53ef><span class="choice-seat num" data-v-20dd53ef>${ssrInterpolate(P(id)?.seat + 1)}</span><span class="choice-name" data-v-20dd53ef>${ssrInterpolate(P(id)?.isHuman ? "你" : P(id)?.name)}</span><span class="choice-ep" data-v-20dd53ef>${ssrInterpolate(P(id)?.persona?.epithet)}</span></button>`);
				});
				_push(`<!--]--></div><div class="foot" data-v-20dd53ef><span class="tip" data-v-20dd53ef>也可以直接点桌上的席位牌</span>`);
				if (unref(pending).allowSkip) _push(`<button class="btn btn-ghost btn-sm" data-v-20dd53ef>${ssrInterpolate(unref(pending).skipLabel || "跳过")}</button>`);
				else _push(`<!---->`);
				_push(`</div><!--]-->`);
			} else if (unref(pending).kind === "vote") {
				_push(`<!--[--><div class="ask" data-v-20dd53ef><h3 class="ask-title" data-v-20dd53ef>${ssrInterpolate(unref(pending).title)}</h3><p class="ask-hint" data-v-20dd53ef>${ssrInterpolate(unref(pending).hint)}</p>`);
				if (remain.value) _push(`<div class="${ssrRenderClass([{ urgent: remain.value <= 10 }, "countdown"])}" data-v-20dd53ef><span class="num" data-v-20dd53ef>${ssrInterpolate(remain.value)}</span><span class="cd-label" data-v-20dd53ef>秒后自动弃票</span></div>`);
				else _push(`<!---->`);
				_push(`</div><div class="choices" data-v-20dd53ef><!--[-->`);
				ssrRenderList(unref(pending).candidates, (id) => {
					_push(`<button class="choice vote" data-v-20dd53ef><span class="choice-seat num" data-v-20dd53ef>${ssrInterpolate(P(id)?.seat + 1)}</span><span class="choice-name" data-v-20dd53ef>${ssrInterpolate(P(id)?.name)}</span></button>`);
				});
				_push(`<!--]--></div><div class="foot" data-v-20dd53ef><span class="tip" data-v-20dd53ef>多数票出局；平票则本轮无人出局</span><button class="btn btn-ghost btn-sm" data-v-20dd53ef>弃票</button></div><!--]-->`);
			} else if (unref(pending).kind === "witch") {
				_push(`<!--[--><div class="ask" data-v-20dd53ef><h3 class="ask-title" data-v-20dd53ef>${ssrInterpolate(unref(pending).title)}</h3><p class="ask-hint" data-v-20dd53ef>${ssrInterpolate(unref(pending).hint)}</p></div><div class="chem" data-v-20dd53ef><div class="chem-row" data-v-20dd53ef><span class="chem-name" data-v-20dd53ef>解药</span><span class="${ssrRenderClass([unref(pending).antidote ? "ok" : "used", "chem-state"])}" data-v-20dd53ef>${ssrInterpolate(unref(pending).antidote ? "尚在" : "已用尽")}</span><button class="${ssrRenderClass([{ "btn-primary": unref(pending).canSave && witchPoison.value == null }, "btn btn-sm"])}"${ssrIncludeBooleanAttr(!unref(pending).canSave || witchPoison.value != null) ? " disabled" : ""} data-v-20dd53ef>救回 ${ssrInterpolate(shortLabel(unref(game).nightKill))}</button>`);
				if (unref(pending).saveBlockedReason) _push(`<span class="chem-note" data-v-20dd53ef>${ssrInterpolate(unref(pending).saveBlockedReason)}</span>`);
				else _push(`<!---->`);
				_push(`</div><div class="chem-row" data-v-20dd53ef><span class="chem-name" data-v-20dd53ef>毒药</span><span class="${ssrRenderClass([unref(pending).poison ? "ok" : "used", "chem-state"])}" data-v-20dd53ef>${ssrInterpolate(unref(pending).poison ? "尚在" : "已用尽")}</span><button class="${ssrRenderClass([{ "btn-danger": witchPoison.value != null }, "btn btn-sm"])}"${ssrIncludeBooleanAttr(!unref(pending).canPoison) ? " disabled" : ""} data-v-20dd53ef>${ssrInterpolate(witchPoison.value == null ? "下毒" : "取消")}</button><span class="chem-note" data-v-20dd53ef>与解药不可同夜齐发</span></div></div>`);
				if (witchPoison.value != null) {
					_push(`<div class="choices tight" data-v-20dd53ef><!--[-->`);
					ssrRenderList(unref(pending).candidates, (id) => {
						_push(`<button class="${ssrRenderClass([{ on: witchPoison.value === id }, "choice"])}" data-v-20dd53ef><span class="choice-seat num" data-v-20dd53ef>${ssrInterpolate(P(id)?.seat + 1)}</span><span class="choice-name" data-v-20dd53ef>${ssrInterpolate(P(id)?.name)}</span></button>`);
					});
					_push(`<!--]--></div>`);
				} else _push(`<!---->`);
				_push(`<div class="foot" data-v-20dd53ef><button class="btn btn-ghost btn-sm" data-v-20dd53ef>今晚不用药</button><button class="btn btn-primary btn-sm"${ssrIncludeBooleanAttr(witchPoison.value == null || witchPoison.value < 0) ? " disabled" : ""} data-v-20dd53ef>确认毒杀</button></div><!--]-->`);
			} else if (unref(pending).kind === "speak") {
				_push(`<!--[--><div class="ask" data-v-20dd53ef><h3 class="ask-title" data-v-20dd53ef>${ssrInterpolate(unref(pending).title)}</h3><p class="ask-hint" data-v-20dd53ef>${ssrInterpolate(unref(pending).hint)}</p></div><div class="kinds" data-v-20dd53ef><!--[-->`);
				ssrRenderList(kinds.value, (k) => {
					_push(`<button class="${ssrRenderClass([{
						on: kind.value === k.id,
						risky: k.risky
					}, "kind"])}" data-v-20dd53ef><span class="kind-name" data-v-20dd53ef>${ssrInterpolate(k.name)}</span><span class="kind-blurb" data-v-20dd53ef>${ssrInterpolate(k.blurb)}</span></button>`);
				});
				_push(`<!--]--></div>`);
				if (needsTarget.value) {
					_push(`<div class="sub" data-v-20dd53ef><span class="sub-label" data-v-20dd53ef>${ssrInterpolate(kind.value === "claim-seer" ? "你要报谁" : "对谁")}</span><div class="choices tight" data-v-20dd53ef><!--[-->`);
					ssrRenderList(unref(pending).targets, (id) => {
						_push(`<button class="${ssrRenderClass([{ on: targetId.value === id }, "choice sm"])}" data-v-20dd53ef><span class="choice-seat num" data-v-20dd53ef>${ssrInterpolate(P(id)?.seat + 1)}</span><span class="choice-name" data-v-20dd53ef>${ssrInterpolate(P(id)?.name)}</span></button>`);
					});
					_push(`<!--]--></div>`);
					if (kind.value === "claim-seer" && unref(me).role !== unref(ROLE).SEER) _push(`<div class="sub" data-v-20dd53ef><span class="sub-label" data-v-20dd53ef>报他什么</span><div class="verdicts" data-v-20dd53ef><button class="${ssrRenderClass([{ on: verdict.value === unref(ROLE).WOLF }, "vbtn"])}" data-v-20dd53ef>查杀</button><button class="${ssrRenderClass([{ on: verdict.value === "good" }, "vbtn good"])}" data-v-20dd53ef>金水</button></div></div>`);
					else _push(`<!---->`);
					_push(`</div>`);
				} else _push(`<!---->`);
				_push(`<div class="free" data-v-20dd53ef><textarea class="free-box" rows="2" maxlength="140"${ssrRenderAttr("placeholder", unref(pending).lastWords ? "留一句话给活着的人（可留空）" : "也可以自己写一段话，留空则由系统按你的立场组织语言")} data-v-20dd53ef>${ssrInterpolate(text.value)}</textarea><span class="free-count num" data-v-20dd53ef>${ssrInterpolate(text.value.length)}/140</span></div><div class="foot" data-v-20dd53ef>`);
				if (unref(pending).allowSkip && !unref(pending).lastWords) _push(`<button class="btn btn-ghost btn-sm" data-v-20dd53ef> 过麦 </button>`);
				else _push(`<!---->`);
				_push(`<button class="btn btn-primary btn-sm"${ssrIncludeBooleanAttr(!unref(pending).lastWords && !canSpeak.value) ? " disabled" : ""} data-v-20dd53ef>${ssrInterpolate(unref(pending).lastWords ? "留下遗言" : "说出口")}</button></div><!--]-->`);
			} else _push(`<!---->`);
			_push(`</div></section></div>`);
		};
	}
};
var _sfc_setup$5 = _sfc_main$5.setup;
_sfc_main$5.setup = (props, ctx) => {
	const ssrContext = useSSRContext();
	(ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("src/components/ActionDock.vue");
	return _sfc_setup$5 ? _sfc_setup$5(props, ctx) : void 0;
};
var ActionDock_default = /*#__PURE__*/ _plugin_vue_export_helper_default(_sfc_main$5, [["__scopeId", "data-v-20dd53ef"]]);
//#endregion
//#region src/components/LogRail.vue
var _sfc_main$4 = {
	__name: "LogRail",
	__ssrInlineRender: true,
	setup(__props) {
		/**
		* 纪要。
		* 一整局狼人杀本质上就是一份不断生长的卷宗：谁说了什么、谁投了谁、谁没起来。
		* 这里按时间顺序记录，并把"只有你能看见"的私密信息单独标出来。
		*/
		const { game, me } = useGame();
		const onlySpeech = ref(false);
		const scroller = ref(null);
		const entries = computed(() => {
			const g = game.value;
			if (!g) return [];
			const all = g.log;
			return onlySpeech.value ? all.filter((e) => e.kind === "speech") : all;
		});
		const claims = computed(() => {
			const g = game.value;
			if (!g) return [];
			return g.claims.map((c) => ({
				...c,
				player: g.players.find((p) => p.id === c.playerId)
			}));
		});
		const graves = computed(() => {
			const g = game.value;
			if (!g) return [];
			return g.players.filter((p) => !p.alive);
		});
		const toneOf = (p) => `hsl(${p?.hue ?? 200} 45% 58%)`;
		watch(() => entries.value.length, async () => {
			await nextTick();
			const el = scroller.value;
			if (el) el.scrollTop = el.scrollHeight;
		});
		return (_ctx, _push, _parent, _attrs) => {
			_push(`<aside${ssrRenderAttrs(mergeProps({ class: "rail panel" }, _attrs))} data-v-587877f5><header class="panel-head" data-v-587877f5><span class="panel-title" data-v-587877f5>纪要</span><span class="head-right" data-v-587877f5><button class="${ssrRenderClass([{ on: onlySpeech.value }, "chip"])}" data-v-587877f5>${ssrInterpolate(onlySpeech.value ? "只看发言" : "全部")}</button></span></header>`);
			if (claims.value.length || graves.value.length) {
				_push(`<div class="dossier" data-v-587877f5>`);
				if (claims.value.length) {
					_push(`<div class="row" data-v-587877f5><span class="row-label" data-v-587877f5>跳身份</span><span class="row-body" data-v-587877f5><!--[-->`);
					ssrRenderList(claims.value, (c) => {
						_push(`<button class="pill brass" data-v-587877f5><span class="num" data-v-587877f5>${ssrInterpolate(c.player.seat + 1)}</span>${ssrInterpolate(c.player.name)}·预言家 </button>`);
					});
					_push(`<!--]--></span></div>`);
				} else _push(`<!---->`);
				if (graves.value.length) {
					_push(`<div class="row" data-v-587877f5><span class="row-label" data-v-587877f5>已出局</span><span class="row-body" data-v-587877f5><!--[-->`);
					ssrRenderList(graves.value, (p) => {
						_push(`<span class="pill blood" data-v-587877f5><span class="num" data-v-587877f5>${ssrInterpolate(p.seat + 1)}</span>${ssrInterpolate(p.name)}</span>`);
					});
					_push(`<!--]--></span></div>`);
				} else _push(`<!---->`);
				_push(`</div>`);
			} else _push(`<!---->`);
			_push(`<div class="stream" data-v-587877f5><!--[-->`);
			ssrRenderList(entries.value, (e) => {
				_push(`<!--[-->`);
				if (e.kind === "phase") _push(`<div class="phase-line" data-v-587877f5><span class="phase-rule" data-v-587877f5></span><span class="phase-text" data-v-587877f5>${ssrInterpolate(e.text)}</span><span class="phase-rule" data-v-587877f5></span></div>`);
				else if (e.kind === "speech") _push(`<div${ssrRenderAttr("data-p", e.playerId)} class="${ssrRenderClass([{ mine: e.playerId === unref(game).humanId }, "ev speech"])}" data-v-587877f5><span class="ev-dot" style="${ssrRenderStyle({ background: toneOf(unref(game).players.find((p) => p.id === e.playerId)) })}" data-v-587877f5></span><div class="ev-body" data-v-587877f5><span class="ev-who" data-v-587877f5>${ssrInterpolate(unref(game).players.find((p) => p.id === e.playerId)?.isHuman ? "你" : `${unref(game).players.find((p) => p.id === e.playerId)?.seat + 1}号${unref(game).players.find((p) => p.id === e.playerId)?.name}`)}</span><span class="ev-text" data-v-587877f5>${ssrInterpolate(e.text)}</span></div></div>`);
				else if (e.kind === "vote") _push(`<div class="ev vote"${ssrRenderAttr("data-p", e.targetId ?? void 0)} data-v-587877f5><span class="vote-tag" data-v-587877f5>票</span><span class="vote-text" data-v-587877f5>${ssrInterpolate(unref(game).players.find((p) => p.id === e.playerId)?.isHuman ? "你" : `${unref(game).players.find((p) => p.id === e.playerId)?.seat + 1}号`)} <em data-v-587877f5>→</em> ${ssrInterpolate(e.targetId == null ? "弃票" : `${unref(game).players.find((p) => p.id === e.targetId)?.seat + 1}号${unref(game).players.find((p) => p.id === e.targetId)?.name}`)}</span></div>`);
				else if (e.kind === "death") _push(`<div class="ev death"${ssrRenderAttr("data-p", e.playerId)} data-v-587877f5><span class="death-mark" data-v-587877f5>✝</span><span class="death-text" data-v-587877f5>${ssrInterpolate(e.text)}</span></div>`);
				else if (e.kind === "result") _push(`<div class="ev result" data-v-587877f5><span class="result-text" data-v-587877f5>${ssrInterpolate(e.text)}</span></div>`);
				else if (e.kind === "night") {
					_push(`<div class="${ssrRenderClass([{ secret: e.secret }, "ev night"])}" data-v-587877f5>`);
					if (e.secret) _push(`<span class="tag tag-brass" data-v-587877f5>密</span>`);
					else _push(`<!---->`);
					_push(`<span class="night-text" data-v-587877f5>${ssrInterpolate(e.text)}</span></div>`);
				} else if (e.kind === "dawn") _push(`<div class="ev dawn" data-v-587877f5><span class="dawn-text" data-v-587877f5>${ssrInterpolate(e.text)}</span></div>`);
				else _push(`<div class="ev system" data-v-587877f5><span class="system-text" data-v-587877f5>${ssrInterpolate(e.text)}</span></div>`);
				_push(`<!--]-->`);
			});
			_push(`<!--]-->`);
			if (!entries.value.length) _push(`<div class="empty" data-v-587877f5><p data-v-587877f5>牌还没发。</p><p class="empty-sub" data-v-587877f5>开一局，这里会长出一整晚的证词。</p></div>`);
			else _push(`<!---->`);
			_push(`</div></aside>`);
		};
	}
};
var _sfc_setup$4 = _sfc_main$4.setup;
_sfc_main$4.setup = (props, ctx) => {
	const ssrContext = useSSRContext();
	(ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("src/components/LogRail.vue");
	return _sfc_setup$4 ? _sfc_setup$4(props, ctx) : void 0;
};
var LogRail_default = /*#__PURE__*/ _plugin_vue_export_helper_default(_sfc_main$4, [["__scopeId", "data-v-587877f5"]]);
//#endregion
//#region src/components/RevealOverlay.vue
var _sfc_main$3 = {
	__name: "RevealOverlay",
	__ssrInlineRender: true,
	setup(__props) {
		/**
		* 揭示卡：验人结果、用药结果这类"只有你知道"的瞬间，
		* 值得用一整块屏幕单独说一次。
		*/
		const { reveal } = useGame();
		const TONE = {
			blood: {
				a: "#d4453c",
				sigil: "狼"
			},
			moss: {
				a: "#86ba95",
				sigil: "善"
			},
			moon: {
				a: "#cfdff4",
				sigil: "验"
			},
			brass: {
				a: "#f2d979",
				sigil: "灯"
			}
		};
		return (_ctx, _push, _parent, _attrs) => {
			if (unref(reveal)) _push(`<div${ssrRenderAttrs(mergeProps({
				class: "veil",
				role: "status",
				"aria-live": "assertive"
			}, _attrs))} data-v-de1f0c16><div class="card cut" style="${ssrRenderStyle({ "--a": (TONE[unref(reveal).tone] || TONE.brass).a })}" data-v-de1f0c16><span class="sigil" data-v-de1f0c16>${ssrInterpolate((TONE[unref(reveal).tone] || TONE.brass).sigil)}</span><span class="subtitle" data-v-de1f0c16>${ssrInterpolate(unref(reveal).subtitle)}</span><span class="title" data-v-de1f0c16>${ssrInterpolate(unref(reveal).title)}</span><span class="hint" data-v-de1f0c16>只有你能看见这一行</span></div></div>`);
			else _push(`<!---->`);
		};
	}
};
var _sfc_setup$3 = _sfc_main$3.setup;
_sfc_main$3.setup = (props, ctx) => {
	const ssrContext = useSSRContext();
	(ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("src/components/RevealOverlay.vue");
	return _sfc_setup$3 ? _sfc_setup$3(props, ctx) : void 0;
};
var RevealOverlay_default = /*#__PURE__*/ _plugin_vue_export_helper_default(_sfc_main$3, [["__scopeId", "data-v-de1f0c16"]]);
//#endregion
//#region src/components/LobbyScreen.vue
var _sfc_main$2 = {
	__name: "LobbyScreen",
	__ssrInlineRender: true,
	setup(__props) {
		/**
		* 开局页。
		* 不介绍"这是什么游戏"——来的人都知道。
		* 只回答一个问题：你今晚想坐哪个位置。
		*/
		const { options, startGame, muted, toggleMute } = useGame();
		const CHOICES = [
			{
				id: "random",
				name: "随机",
				sigil: "？",
				blurb: "把命运交出去",
				tone: "candle"
			},
			{
				id: ROLE.WOLF,
				name: "狼人",
				sigil: "狼",
				blurb: "伪装、猎杀、悍跳",
				tone: "blood",
				count: 3
			},
			{
				id: ROLE.SEER,
				name: "预言家",
				sigil: "验",
				blurb: "好人唯一的眼睛",
				tone: "moon",
				count: 1
			},
			{
				id: ROLE.WITCH,
				name: "女巫",
				sigil: "药",
				blurb: "一瓶救人，一瓶杀人",
				tone: "moss",
				count: 1
			},
			{
				id: ROLE.HUNTER,
				name: "猎人",
				sigil: "枪",
				blurb: "倒下时还能带走一个",
				tone: "brass",
				count: 1
			},
			{
				id: ROLE.VILLAGER,
				name: "平民",
				sigil: "民",
				blurb: "没有牌，只有脑子",
				tone: "candle",
				count: 3
			}
		];
		const ACCENT = {
			blood: "#d4453c",
			moss: "#86ba95",
			moon: "#cfdff4",
			brass: "#f2d979",
			candle: "#c2b59b"
		};
		const chosen = computed(() => CHOICES.find((c) => c.id === options.humanRole) || CHOICES[0]);
		const FLOW = [
			{
				t: "入夜",
				d: "狼人睁眼选刀口；预言家查验一人；女巫决定是否用药。"
			},
			{
				t: "天亮",
				d: "公布昨夜倒牌的人。若是猎人出局，可以开枪带走一人。"
			},
			{
				t: "发言",
				d: "从出局者的下一位开始，依次陈述、跳身份、指认。"
			},
			{
				t: "投票",
				d: "全场投票，多数票放逐；平票则本轮无人出局。"
			}
		];
		const NOTES = [
			"女巫首夜可以自救，从第二夜起不能自救。",
			"解药与毒药不可在同一夜同时使用。",
			"猎人被投票放逐或被狼刀死可开枪；被女巫毒死不能开枪。",
			"本局不翻牌，出局不公布身份，全靠发言与票型推理。"
		];
		return (_ctx, _push, _parent, _attrs) => {
			_push(`<div${ssrRenderAttrs(mergeProps({ class: "lobby" }, _attrs))} data-v-8b32e21a><div class="hero" data-v-8b32e21a><p class="eyebrow" data-v-8b32e21a>九人标准局 · 三狼 · 三神 · 三民</p><h1 class="big" data-v-8b32e21a>狼人杀</h1><p class="lede" data-v-8b32e21a> 九个人围着一张桌子。八个由机器扮演，各自记着自己的账、盘着自己的逻辑。 你坐在正下方，只有一票，和一整晚的判断。 </p></div><section class="pick" data-v-8b32e21a><div class="pick-head" data-v-8b32e21a><span class="panel-title" data-v-8b32e21a>你今晚坐哪个位置</span><span class="pick-note" data-v-8b32e21a>${ssrInterpolate(chosen.value.blurb)}</span></div><div class="cards" data-v-8b32e21a><!--[-->`);
			ssrRenderList(CHOICES, (c) => {
				_push(`<button class="${ssrRenderClass([{ on: unref(options).humanRole === c.id }, "rc"])}" style="${ssrRenderStyle({ "--a": ACCENT[c.tone] })}" data-v-8b32e21a><span class="rc-sigil" data-v-8b32e21a>${ssrInterpolate(c.sigil)}</span><span class="rc-name" data-v-8b32e21a>${ssrInterpolate(c.name)}</span><span class="rc-blurb" data-v-8b32e21a>${ssrInterpolate(c.blurb)}</span>`);
				if (c.count) _push(`<span class="rc-count num" data-v-8b32e21a>×${ssrInterpolate(c.count)}</span>`);
				else _push(`<!---->`);
				_push(`</button>`);
			});
			_push(`<!--]--></div><div class="launch" data-v-8b32e21a><button class="btn btn-primary btn-lg" data-v-8b32e21a>发牌，天黑请闭眼</button><button class="btn btn-lg" data-v-8b32e21a>观战一局</button><label class="opt" data-v-8b32e21a><input${ssrIncludeBooleanAttr(Array.isArray(unref(options).voteTimer) ? ssrLooseContain(unref(options).voteTimer, null) : unref(options).voteTimer) ? " checked" : ""} type="checkbox" data-v-8b32e21a><span data-v-8b32e21a>投票限时 45 秒</span></label><button class="btn btn-ghost btn-sm" data-v-8b32e21a> 音效：${ssrInterpolate(unref(muted) ? "关" : "开")}</button></div><p class="watch-note" data-v-8b32e21a> 观战＝你的席位交给同一套 AI，全程只看不动手。想核验机器人有没有作弊、打得像不像人，这是最直接的办法。 </p></section><section class="how" data-v-8b32e21a><div class="how-col" data-v-8b32e21a><h2 class="panel-title" data-v-8b32e21a>一局的流程</h2><ol class="flow" data-v-8b32e21a><!--[-->`);
			ssrRenderList(FLOW, (f, i) => {
				_push(`<li data-v-8b32e21a><span class="flow-n num" data-v-8b32e21a>${ssrInterpolate(i + 1)}</span><span class="flow-b" data-v-8b32e21a><strong data-v-8b32e21a>${ssrInterpolate(f.t)}</strong><em data-v-8b32e21a>${ssrInterpolate(f.d)}</em></span></li>`);
			});
			_push(`<!--]--></ol></div><div class="how-col" data-v-8b32e21a><h2 class="panel-title" data-v-8b32e21a>本局细则</h2><ul class="notes" data-v-8b32e21a><!--[-->`);
			ssrRenderList(NOTES, (n) => {
				_push(`<li data-v-8b32e21a>${ssrInterpolate(n)}</li>`);
			});
			_push(`<!--]--></ul><p class="win" data-v-8b32e21a><span data-v-8b32e21a>好人胜</span>：三只狼全部出局。<br data-v-8b32e21a><span data-v-8b32e21a>狼人胜</span>：杀光三名神职，或杀光三名平民。 </p></div></section></div>`);
		};
	}
};
var _sfc_setup$2 = _sfc_main$2.setup;
_sfc_main$2.setup = (props, ctx) => {
	const ssrContext = useSSRContext();
	(ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("src/components/LobbyScreen.vue");
	return _sfc_setup$2 ? _sfc_setup$2(props, ctx) : void 0;
};
var LobbyScreen_default = /*#__PURE__*/ _plugin_vue_export_helper_default(_sfc_main$2, [["__scopeId", "data-v-8b32e21a"]]);
//#endregion
//#region src/components/EndScreen.vue
var _sfc_main$1 = {
	__name: "EndScreen",
	__ssrInlineRender: true,
	setup(__props) {
		/**
		* 结局。
		* 摊牌：九个人的身份全部亮出来，让玩家回头对一遍自己这一晚的判断。
		*/
		const { game, restart, toLobby } = useGame();
		const dismissed = ref(false);
		watch(() => game.value?.id, () => {
			dismissed.value = false;
		});
		const won = computed(() => game.value?.winner);
		const headline = computed(() => won.value === TEAM.WOLF ? "狼人胜利" : "好人胜利");
		const sub = computed(() => {
			const g = game.value;
			if (!g) return "";
			return g.players[g.humanId].team === g.winner ? "你站在赢的那一边。" : "你站错了边，下一个村子会更小心。";
		});
		const REASON_LABEL = {
			wolf: "被狼人杀害",
			poison: "被女巫毒杀",
			vote: "被投票放逐",
			hunter: "被猎人带走"
		};
		const rows = computed(() => {
			const g = game.value;
			if (!g) return [];
			return g.players.map((p) => ({
				...p,
				meta: ROLE_META[p.role],
				ended: p.alive ? "存活" : `第 ${p.deathDay} 天 · ${REASON_LABEL[p.deathReason] || "出局"}`
			}));
		});
		const stats = computed(() => {
			const g = game.value;
			if (!g) return [];
			return [
				{
					label: "熬过的天数",
					value: g.day
				},
				{
					label: "公开发言",
					value: g.speeches.length
				},
				{
					label: "投票轮次",
					value: g.voteHistory.length || g.day
				}
			];
		});
		return (_ctx, _push, _parent, _attrs) => {
			if (!dismissed.value) {
				_push(`<div${ssrRenderAttrs(mergeProps({ class: "end" }, _attrs))} data-v-be5fe940><div class="${ssrRenderClass([won.value, "sheet cut"])}" data-v-be5fe940><span class="mark" data-v-be5fe940>${ssrInterpolate(won.value === unref(TEAM).WOLF ? "狼" : "灯")}</span><p class="eyebrow" data-v-be5fe940>第 ${ssrInterpolate(unref(game).day)} 天结束</p><h2 class="headline" data-v-be5fe940>${ssrInterpolate(headline.value)}</h2><p class="reason" data-v-be5fe940>${ssrInterpolate(unref(game).winReason)}</p><p class="sub" data-v-be5fe940>${ssrInterpolate(sub.value)}</p><div class="stats" data-v-be5fe940><!--[-->`);
				ssrRenderList(stats.value, (s) => {
					_push(`<div class="stat" data-v-be5fe940><span class="stat-v num" data-v-be5fe940>${ssrInterpolate(s.value)}</span><span class="stat-l" data-v-be5fe940>${ssrInterpolate(s.label)}</span></div>`);
				});
				_push(`<!--]--></div><div class="roster" data-v-be5fe940><div class="roster-head" data-v-be5fe940><span data-v-be5fe940>席位</span><span data-v-be5fe940>身份</span><span data-v-be5fe940>阵营</span><span data-v-be5fe940>结局</span></div><!--[-->`);
				ssrRenderList(rows.value, (r) => {
					_push(`<div class="${ssrRenderClass([{
						me: r.isHuman,
						dead: !r.alive,
						wolf: r.team === unref(TEAM).WOLF
					}, "roster-row"])}" data-v-be5fe940><span class="c-seat num" data-v-be5fe940>${ssrInterpolate(r.seat + 1)}</span><span class="c-name" data-v-be5fe940>${ssrInterpolate(r.isHuman ? "你" : r.name)} <em data-v-be5fe940>${ssrInterpolate(r.role === unref(ROLE).SEER && r.claimsMade ? "·曾跳预言家" : "")}</em></span><span class="c-role" data-v-be5fe940>${ssrInterpolate(r.meta.name)}</span><span class="c-end" data-v-be5fe940>${ssrInterpolate(r.ended)}</span></div>`);
				});
				_push(`<!--]--></div><div class="actions" data-v-be5fe940><button class="btn btn-primary" data-v-be5fe940>再来一局</button><button class="btn btn-ghost" data-v-be5fe940>查看纪要</button><button class="btn btn-ghost" data-v-be5fe940>换个身份</button></div></div></div>`);
			} else _push(`<!---->`);
		};
	}
};
var _sfc_setup$1 = _sfc_main$1.setup;
_sfc_main$1.setup = (props, ctx) => {
	const ssrContext = useSSRContext();
	(ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("src/components/EndScreen.vue");
	return _sfc_setup$1 ? _sfc_setup$1(props, ctx) : void 0;
};
var EndScreen_default = /*#__PURE__*/ _plugin_vue_export_helper_default(_sfc_main$1, [["__scopeId", "data-v-be5fe940"]]);
//#endregion
//#region src/App.vue
var _sfc_main = {
	__name: "App",
	__ssrInlineRender: true,
	setup(__props) {
		/**
		* 舞台。
		*
		* 版面就是一张桌子：
		*   上面  天幕   —— 天色 = 阶段，亮着的窗 = 活着的人
		*   中间  圆桌   —— 九个席位，票型画成弧线
		*   右下  纪要   —— 这一晚的卷宗
		*   下面  行动坞 —— 我的手牌 + 此刻唯一要做的那件事
		*/
		const { game, screen, skyTone } = useGame();
		watch(skyTone, (t) => {
			if (typeof document !== "undefined") document.documentElement.dataset.tone = t;
		}, { immediate: true });
		function onKey(e) {
			if (e.code === "Space" && e.target === document.body) e.preventDefault();
		}
		onMounted(() => {
			window.addEventListener("keydown", onKey);
			const unlock$1 = () => {
				unlock();
				window.removeEventListener("pointerdown", unlock$1);
			};
			window.addEventListener("pointerdown", unlock$1, { once: true });
		});
		const playing = computed(() => screen.value === "playing" || screen.value === "over");
		return (_ctx, _push, _parent, _attrs) => {
			_push(`<div${ssrRenderAttrs(mergeProps({ class: "app" }, _attrs))} data-v-bde6c058>`);
			_push(ssrRenderComponent(SkyCanopy_default, null, null, _parent));
			if (unref(screen) === "lobby") _push(ssrRenderComponent(LobbyScreen_default, null, null, _parent));
			else if (playing.value) {
				_push(`<div class="play" data-v-bde6c058><main class="stage" data-v-bde6c058>`);
				_push(ssrRenderComponent(SeatRing_default, null, null, _parent));
				_push(`</main>`);
				_push(ssrRenderComponent(ActionDock_default, { class: "dock" }, null, _parent));
				_push(ssrRenderComponent(LogRail_default, { class: "rail" }, null, _parent));
				_push(`</div>`);
			} else _push(`<!---->`);
			_push(ssrRenderComponent(RevealOverlay_default, null, null, _parent));
			if (unref(screen) === "over") _push(ssrRenderComponent(EndScreen_default, null, null, _parent));
			else _push(`<!---->`);
			_push(`</div>`);
		};
	}
};
var _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
	const ssrContext = useSSRContext();
	(ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("src/App.vue");
	return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
var App_default = /*#__PURE__*/ _plugin_vue_export_helper_default(_sfc_main, [["__scopeId", "data-v-bde6c058"]]);
//#endregion
//#region scripts/ssr-smoke.js
/**
* 渲染冒烟测试。
*
* 构建期只能保证模板编译通过；这里把界面真正渲染一遍（Vue 服务端渲染），
* 覆盖开局页、对局中（含各类待办面板）、结算页三条分支，
* 任何 setup() 里的取值错误都会当场抛出来。
*
*   npm run smoke
*/
var store = useGame();
var failures = [];
async function scenario(name, prepare) {
	prepare();
	const app = createSSRApp(App_default);
	app.config.warnHandler = (msg) => {
		failures.push(`[${name}] Vue 警告：${msg}`);
	};
	try {
		const html = await renderToString(app);
		if (!html || html.length < 200) throw new Error(`输出过短（${html?.length ?? 0} 字节）`);
		console.log(`  ✓ ${name.padEnd(16, "　")} ${String(html.length).padStart(6)} 字节`);
	} catch (err) {
		failures.push(`[${name}] 渲染失败：${err.message}\n${err.stack?.split("\n").slice(1, 5).join("\n")}`);
		console.log(`  ✗ ${name}`);
	}
}
/** 造一局进行到一半的真实对局 */
function midGame(humanRole = ROLE.SEER) {
	const g = createMatch({
		humanRole,
		rng: createRng(20240917)
	});
	g.phase = "day";
	g.day = 2;
	g.phaseLabel = "第 2 天 · 发言";
	g.turn = 3;
	const seer = g.players[g.humanId];
	seer.checks.push({
		targetId: 4,
		result: ROLE.WOLF,
		day: 1
	});
	seer.checks.push({
		targetId: 7,
		result: ROLE.GOOD,
		day: 2
	});
	g.claims.push({
		playerId: seer.id,
		role: ROLE.SEER,
		day: 1,
		checks: seer.checks.slice()
	});
	const wolf = g.players.find((p) => p.role === ROLE.WOLF && p.id !== seer.id);
	g.claims.push({
		playerId: wolf.id,
		role: ROLE.SEER,
		day: 1,
		fake: true,
		checks: [{
			targetId: seer.id,
			result: ROLE.WOLF,
			day: 1,
			fake: true
		}]
	});
	g.publicClaimsRole[seer.id] = ROLE.SEER;
	g.publicClaimsRole[wolf.id] = ROLE.SEER;
	g.players[5].alive = false;
	g.players[5].deathDay = 2;
	g.players[5].deathReason = "wolf";
	g.deaths.push({
		playerId: 5,
		day: 2,
		reason: "wolf"
	});
	g.speeches.push({
		id: 1,
		playerId: seer.id,
		day: 1,
		text: "我是预言家，昨晚验的5号，查杀。",
		kind: "claim-seer",
		targetId: 4
	});
	g.speeches.push({
		id: 2,
		playerId: wolf.id,
		day: 1,
		text: "我才是预言家，1号是悍跳的狼。",
		kind: "counter-claim",
		targetId: 0
	});
	g.speeches.push({
		id: 3,
		playerId: 8,
		day: 2,
		text: "我站1号预言家，今天先出5号。",
		kind: "support",
		targetId: seer.id
	});
	g.attacked[seer.id] = [4];
	g.attacked[wolf.id] = [0];
	g.supported[8] = [seer.id];
	g.influence[seer.id] = 3.2;
	g.influence[wolf.id] = 2.1;
	g.log.push({
		id: 1,
		day: 1,
		phase: "night",
		kind: "phase",
		text: "天黑请闭眼。"
	}, {
		id: 2,
		day: 1,
		phase: "night",
		kind: "night",
		text: "狼人睁眼。",
		secret: true
	}, {
		id: 3,
		day: 1,
		phase: "dawn",
		kind: "dawn",
		text: "昨晚是平安夜，没有人出局。"
	}, {
		id: 4,
		day: 1,
		phase: "day",
		kind: "speech",
		text: "1号：我是预言家，昨晚验的5号，查杀。",
		playerId: seer.id,
		speech: true
	}, {
		id: 5,
		day: 1,
		phase: "day",
		kind: "speech",
		text: "3号：我才是预言家。",
		playerId: wolf.id,
		speech: true
	}, {
		id: 6,
		day: 1,
		phase: "vote",
		kind: "vote",
		text: "2号 投票 → 5号",
		playerId: 1,
		targetId: 5
	}, {
		id: 7,
		day: 1,
		phase: "vote",
		kind: "vote",
		text: "4号 投票 → 1号",
		playerId: 3,
		targetId: 0
	}, {
		id: 8,
		day: 1,
		phase: "result",
		kind: "result",
		text: "5号白露 以 4 票被放逐出村。"
	}, {
		id: 9,
		day: 2,
		phase: "dawn",
		kind: "death",
		text: "6号阿七 倒牌了。",
		playerId: 5
	});
	g.lastTally = [{
		playerId: 4,
		count: 4
	}, {
		playerId: 0,
		count: 3
	}];
	return g;
}
console.log("渲染冒烟测试：");
await scenario("开局页", () => {
	store.screen.value = "lobby";
	store.game.value = null;
	store.pending.value = null;
});
await scenario("对局·空闲", () => {
	store.game.value = midGame();
	store.screen.value = "playing";
	store.pending.value = null;
});
await scenario("对局·正在发言", () => {
	store.game.value.currentSpeech = {
		playerId: 3,
		text: "我盘一下，两个预言家里必有一狼，今天必须处理一个。",
		kind: "accuse"
	};
});
await scenario("待办·选人", () => {
	store.game.value.currentSpeech = null;
	store.pending.value = {
		id: 1,
		kind: "pick-one",
		title: "今晚猎杀谁？",
		hint: "同伴：3号铁柱",
		suggestion: "5号（同伴倾向）",
		candidates: [
			1,
			2,
			3,
			4,
			6,
			7,
			8
		],
		allowSkip: false,
		submit() {}
	};
});
await scenario("待办·女巫", () => {
	store.game.value.nightKill = 2;
	store.game.value.phase = "night";
	store.pending.value = {
		id: 2,
		kind: "witch",
		title: "今晚，你要用药吗？",
		hint: "今晚倒牌的是 3号铁柱。",
		antidote: true,
		poison: true,
		canSave: true,
		canPoison: true,
		saveBlockedReason: "",
		candidates: [
			1,
			3,
			4,
			6,
			7,
			8
		],
		submit() {}
	};
});
await scenario("待办·投票", () => {
	store.game.value.phase = "vote";
	store.pending.value = {
		id: 3,
		kind: "vote",
		title: "你要投谁？",
		hint: "场上还有 8 人。",
		candidates: [
			1,
			2,
			3,
			4,
			6,
			7,
			8
		],
		allowSkip: true,
		skipLabel: "弃票",
		timeLimit: 45e3,
		submit() {}
	};
});
await scenario("待办·发言", () => {
	store.pending.value = {
		id: 4,
		kind: "speak",
		title: "轮到你发言",
		hint: "挑一个立场。",
		targets: [
			1,
			2,
			3,
			4,
			6,
			7,
			8
		],
		allowSkip: true,
		kinds: store.speakKinds(ROLE.SEER),
		submit() {}
	};
});
await scenario("观战·托管面板", () => {
	store.options.spectate = true;
	store.pending.value = {
		id: 5,
		kind: "vote",
		title: "你要投谁？",
		hint: "场上还有 8 人。",
		candidates: [
			1,
			2,
			3,
			4,
			6,
			7,
			8
		],
		allowSkip: true,
		auto: true,
		timeLimit: 0,
		submit() {}
	};
});
await scenario("揭示卡", () => {
	store.options.spectate = false;
	store.pending.value = null;
	store.reveal.value = {
		id: 9,
		tone: "blood",
		title: "4号白露 · 狼人",
		subtitle: "查杀"
	};
});
await scenario("结算页", () => {
	store.reveal.value = null;
	const g = store.game.value;
	g.winner = "good";
	g.winReason = "三只狼全部出局，村子活下来了。";
	g.phase = "over";
	g.phaseLabel = "好人胜利";
	g.revealAll = true;
	g.players[4].alive = false;
	g.players[4].deathDay = 2;
	g.players[4].deathReason = "vote";
	store.screen.value = "over";
});
console.log("");
if (failures.length) {
	console.log(`发现 ${failures.length} 个问题：`);
	for (const f of failures) console.log("  · " + f);
	process.exitCode = 1;
} else console.log("全部场景渲染通过，无 Vue 警告。");
//#endregion
export {};
