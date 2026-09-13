<script setup>
/**
 * 开局页。
 * 不介绍"这是什么游戏"——来的人都知道。
 * 只回答一个问题：你今晚想坐哪个位置。
 */

import { computed } from 'vue'
import { useGame } from '../composables/useGame.js'
import { ROLE, ROLE_META, DECK_9, TEAM } from '../game/roles.js'

const { options, startGame, muted, toggleMute } = useGame()

const CHOICES = [
  { id: 'random', name: '随机', sigil: '？', blurb: '把命运交出去', tone: 'candle' },
  { id: ROLE.WOLF, name: '狼人', sigil: '狼', blurb: '伪装、猎杀、悍跳', tone: 'blood', count: 3 },
  { id: ROLE.SEER, name: '预言家', sigil: '验', blurb: '好人唯一的眼睛', tone: 'moon', count: 1 },
  { id: ROLE.WITCH, name: '女巫', sigil: '药', blurb: '一瓶救人，一瓶杀人', tone: 'moss', count: 1 },
  { id: ROLE.HUNTER, name: '猎人', sigil: '枪', blurb: '倒下时还能带走一个', tone: 'brass', count: 1 },
  { id: ROLE.VILLAGER, name: '平民', sigil: '民', blurb: '没有牌，只有脑子', tone: 'candle', count: 3 },
]

const ACCENT = {
  blood: '#d4453c', moss: '#86ba95', moon: '#cfdff4', brass: '#f2d979', candle: '#c2b59b',
}

const chosen = computed(() => CHOICES.find((c) => c.id === options.humanRole) || CHOICES[0])

function startPlay() {
  options.spectate = false
  startGame()
}

function startWatch() {
  options.spectate = true
  options.humanRole = 'random'
  startGame()
}

const FLOW = [
  { t: '入夜', d: '狼人睁眼选刀口；预言家查验一人；女巫决定是否用药。' },
  { t: '天亮', d: '公布昨夜倒牌的人。若是猎人出局，可以开枪带走一人。' },
  { t: '发言', d: '从出局者的下一位开始，依次陈述、跳身份、指认。' },
  { t: '投票', d: '全场投票，多数票放逐；平票则本轮无人出局。' },
]

const NOTES = [
  '女巫首夜可以自救，从第二夜起不能自救。',
  '解药与毒药不可在同一夜同时使用。',
  '猎人被投票放逐或被狼刀死可开枪；被女巫毒死不能开枪。',
  '本局不翻牌，出局不公布身份，全靠发言与票型推理。',
]
</script>

<template>
  <div class="lobby">
    <div class="hero">
      <p class="eyebrow">九人标准局 · 三狼 · 三神 · 三民</p>
      <h1 class="big">狼人杀</h1>
      <p class="lede">
        九个人围着一张桌子。八个由机器扮演，各自记着自己的账、盘着自己的逻辑。
        你坐在正下方，只有一票，和一整晚的判断。
      </p>
    </div>

    <section class="pick">
      <div class="pick-head">
        <span class="panel-title">你今晚坐哪个位置</span>
        <span class="pick-note">{{ chosen.blurb }}</span>
      </div>

      <div class="cards">
        <button
          v-for="c in CHOICES"
          :key="c.id"
          class="rc"
          :class="{ on: options.humanRole === c.id }"
          :style="{ '--a': ACCENT[c.tone] }"
          @click="options.humanRole = c.id"
        >
          <span class="rc-sigil">{{ c.sigil }}</span>
          <span class="rc-name">{{ c.name }}</span>
          <span class="rc-blurb">{{ c.blurb }}</span>
          <span v-if="c.count" class="rc-count num">×{{ c.count }}</span>
        </button>
      </div>

      <div class="launch">
        <button class="btn btn-primary btn-lg" @click="startPlay">发牌，天黑请闭眼</button>
        <button class="btn btn-lg" @click="startWatch">观战一局</button>

        <label class="opt">
          <input v-model="options.voteTimer" type="checkbox" />
          <span>投票限时 45 秒</span>
        </label>

        <button class="btn btn-ghost btn-sm" @click="toggleMute">
          音效：{{ muted ? '关' : '开' }}
        </button>
      </div>
      <p class="watch-note">
        观战＝你的席位交给同一套 AI，全程只看不动手。想核验机器人有没有作弊、打得像不像人，这是最直接的办法。
      </p>
    </section>

    <section class="how">
      <div class="how-col">
        <h2 class="panel-title">一局的流程</h2>
        <ol class="flow">
          <li v-for="(f, i) in FLOW" :key="f.t">
            <span class="flow-n num">{{ i + 1 }}</span>
            <span class="flow-b">
              <strong>{{ f.t }}</strong>
              <em>{{ f.d }}</em>
            </span>
          </li>
        </ol>
      </div>

      <div class="how-col">
        <h2 class="panel-title">本局细则</h2>
        <ul class="notes">
          <li v-for="n in NOTES" :key="n">{{ n }}</li>
        </ul>
        <p class="win">
          <span>好人胜</span>：三只狼全部出局。<br />
          <span>狼人胜</span>：杀光三名神职，或杀光三名平民。
        </p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.lobby {
  height: 100%;
  overflow-y: auto;
  padding: clamp(22px, 4vh, 44px) clamp(18px, 5vw, 72px) 56px;
  display: flex;
  flex-direction: column;
  gap: clamp(24px, 4vh, 46px);
  max-width: 1180px;
  margin: 0 auto;
}

/* ─── 主标题 ─── */

.hero { display: flex; flex-direction: column; gap: 6px; }

.eyebrow { margin: 0; color: rgba(201, 162, 39, 0.8); }

.big {
  margin: 0;
  font-family: var(--font-brush);
  font-size: clamp(56px, 11vw, 112px);
  font-weight: 400;
  line-height: 0.98;
  letter-spacing: 0.12em;
  color: var(--paper);
  text-shadow: 0 4px 40px rgba(0, 0, 0, 0.9), 0 0 90px rgba(201, 162, 39, 0.09);
}

.lede {
  margin: 10px 0 0;
  max-width: 62ch;
  font-size: 14px;
  line-height: 1.95;
  color: var(--paper-2);
}

/* ─── 选身份 ─── */

.pick { display: flex; flex-direction: column; gap: 12px; }

.pick-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.pick-note { font-size: 11.5px; color: var(--brass); }

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
  gap: 10px;
}

.rc {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 15px 14px 13px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: linear-gradient(180deg, rgba(30, 26, 20, 0.6), rgba(10, 15, 21, 0.85));
  text-align: left;
  transition: border-color 0.2s var(--ease), background 0.2s var(--ease),
              transform 0.22s var(--ease-out), box-shadow 0.22s var(--ease);
}

.rc:hover {
  transform: translateY(-3px);
  border-color: color-mix(in srgb, var(--a) 55%, transparent);
}

.rc.on {
  border-color: var(--a);
  background:
    radial-gradient(120% 100% at 50% 0%, color-mix(in srgb, var(--a) 15%, transparent), transparent 60%),
    linear-gradient(180deg, rgba(34, 30, 22, 0.7), rgba(10, 15, 21, 0.9));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--a) 35%, transparent),
              0 8px 30px color-mix(in srgb, var(--a) 16%, transparent);
}

.rc-sigil {
  font-family: var(--font-brush);
  font-size: 30px;
  line-height: 1;
  color: var(--a);
}

.rc-name {
  font-family: var(--font-serif);
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.16em;
  color: var(--paper);
}

.rc-blurb { font-size: 10.5px; line-height: 1.5; color: var(--paper-3); }

.rc-count {
  position: absolute;
  top: 10px;
  right: 11px;
  font-size: 10px;
  color: var(--paper-4);
}

/* ─── 开始 ─── */

.launch {
  display: flex;
  align-items: center;
  gap: var(--gap-4);
  flex-wrap: wrap;
  margin-top: 6px;
}

.opt {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--paper-3);
  cursor: pointer;
}

.opt input { accent-color: var(--brass); width: 14px; height: 14px; }

.watch-note {
  margin: 10px 0 0;
  max-width: 66ch;
  font-size: 11px;
  line-height: 1.75;
  color: var(--paper-4);
}

/* ─── 规则 ─── */

.how {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: clamp(20px, 4vw, 56px);
  padding-top: 22px;
  border-top: 1px solid var(--line-soft);
}

.how-col { display: flex; flex-direction: column; gap: 12px; }

.flow { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 11px; }

.flow li { display: flex; gap: 11px; align-items: flex-start; }

.flow-n {
  flex: none;
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border: 1px solid var(--line);
  border-radius: 2px;
  font-size: 10px;
  color: var(--brass);
  margin-top: 2px;
}

.flow-b { display: flex; flex-direction: column; gap: 1px; }
.flow-b strong { font-size: 12.5px; font-weight: 700; letter-spacing: 0.12em; color: var(--paper); }
.flow-b em { font-style: normal; font-size: 11.5px; line-height: 1.7; color: var(--paper-3); }

.notes { margin: 0; padding-left: 16px; display: flex; flex-direction: column; gap: 7px; }
.notes li { font-size: 11.5px; line-height: 1.75; color: var(--paper-3); }
.notes li::marker { color: var(--brass-dim); }

.win {
  margin: 4px 0 0;
  padding-top: 11px;
  border-top: 1px solid var(--line-soft);
  font-size: 11.5px;
  line-height: 1.9;
  color: var(--paper-3);
}
.win span { color: var(--brass-hi); }

@media (max-width: 700px) {
  .cards { grid-template-columns: repeat(2, 1fr); }
  .launch { gap: 12px; }
  .btn-lg { width: 100%; }
}
</style>
