<script setup>
/**
 * 行动坞。
 * 左边是我的手牌（永远看得见自己的身份），右边是当下唯一要做的那件事。
 * 这里的原则是：任何时刻，屏幕上只出现一个明确的问题。
 */

import { ref, computed, watch, onBeforeUnmount } from 'vue'
import RoleCard from './RoleCard.vue'
import { useGame } from '../composables/useGame.js'
import { ROLE, ROLE_META } from '../game/roles.js'

const {
  game, me, pending, paused, speed, muted,
  pick, skip, submitWitch, submitSpeech, submitVote, toggleMute, togglePause, restart,
} = useGame()

const P = (id) => game.value?.players.find((p) => p.id === id)
const label = (id) => {
  const p = P(id)
  return p ? `${p.seat + 1}号${p.isHuman ? '你' : p.name}` : '—'
}
const shortLabel = (id) => {
  const p = P(id)
  return p ? `${p.seat + 1}号` : '—'
}

/* ---------------- 发言编排 ---------------- */

const kind = ref(null)
const targetId = ref(null)
const verdict = ref(ROLE.WOLF)
const text = ref('')

watch(pending, () => {
  kind.value = null
  targetId.value = null
  verdict.value = ROLE.WOLF
  text.value = ''
})

const kinds = computed(() => pending.value?.kinds || [])
const curKind = computed(() => kinds.value.find((k) => k.id === kind.value) || null)

const needsTarget = computed(() => {
  if (!curKind.value) return false
  if (kind.value === 'claim-seer') return me.value?.role !== ROLE.SEER
  return !!curKind.value.needsTarget
})

const canSpeak = computed(() => {
  if (!kind.value) return false
  if (needsTarget.value && targetId.value == null) return false
  return true
})

/* ---------------- 投票倒计时 ---------------- */

const remain = ref(0)
let tick = null

watch(
  () => [pending.value?.id, pending.value?.timeLimit],
  () => {
    clearInterval(tick)
    const lim = pending.value?.timeLimit || 0
    remain.value = lim ? Math.ceil(lim / 1000) : 0
    if (!lim) return
    const deadline = Date.now() + lim
    tick = setInterval(() => {
      const left = Math.max(0, deadline - Date.now())
      remain.value = Math.ceil(left / 1000)
      if (left <= 0) {
        clearInterval(tick)
        if (pending.value?.kind === 'vote') submitVote(null)
      }
    }, 250)
  },
  { immediate: true },
)

onBeforeUnmount(() => clearInterval(tick))

/* ---------------- 女巫 ---------------- */

const witchPoison = ref(null)
watch(pending, () => { witchPoison.value = null })

const headTitle = computed(() => {
  const g = game.value
  if (!g) return '准备'
  const p = pending.value
  if (!p) {
    if (g.phase === 'over') return '本局结束'
    if (g.phase === 'night') return '夜里'
    return '白天'
  }
  return { 'pick-one': '选择目标', vote: '投票放逐', witch: '女巫用药', speak: '发言' }[p.kind] || '行动'
})

const idleText = computed(() => {
  const g = game.value
  if (!g) return ''
  if (g.phase === 'over') return `本局由${g.winner === 'wolf' ? '狼人' : '好人'}阵营获胜。`
  if (g.turn != null) {
    const t = P(g.turn)
    if (t && !t.isHuman) return `等 ${t.seat + 1}号${t.name} 说完。`
  }
  if (g.phase === 'night') return '所有人闭着眼。'
  if (g.phase === 'vote') return '正在收票。'
  return '稍等片刻。'
})

const speedOptions = [
  { v: 0.6, name: '慢' },
  { v: 1, name: '正常' },
  { v: 2.2, name: '快' },
]
</script>

<template>
  <div class="dock">
    <RoleCard />

    <section class="action panel">
      <header class="panel-head">
        <span class="panel-title">{{ headTitle }}</span>
        <span class="controls">
          <span class="speeds">
            <button
              v-for="s in speedOptions"
              :key="s.v"
              class="speed"
              :class="{ on: speed === s.v }"
              :title="`节奏：${s.name}`"
              @click="speed = s.v"
            >{{ s.name }}</button>
          </span>
          <button class="ic" :title="paused ? '继续' : '暂停'" @click="togglePause">
            {{ paused ? '▶' : '❚❚' }}
          </button>
          <button class="ic" :title="muted ? '打开音效' : '静音'" @click="toggleMute">
            {{ muted ? '♪̸' : '♪' }}
          </button>
          <button class="ic" title="重开一局" @click="restart">↺</button>
        </span>
      </header>

      <div class="body">
        <!-- ─── 观战：把 AI 正在决定什么摊开给你看 ─── -->
        <div v-if="pending && pending.auto" class="auto">
          <div class="auto-head">
            <span class="auto-tag">AI 托管</span>
            <span class="auto-who">{{ me?.isHuman ? '你的席位' : '' }}正在决定</span>
          </div>
          <p class="auto-title">{{ pending.title }}</p>
          <p v-if="pending.hint" class="auto-hint">{{ pending.hint }}</p>
          <p class="auto-note">
            观战模式下，你的席位交给同一套 AI<template v-if="pending.candidates?.length">，候选 {{ pending.candidates.length }} 人</template>。
            想看它怎么想，就把纪要拉到最下面。
          </p>
        </div>

        <!-- ─── 无待办 ─── -->
        <div v-else-if="!pending" class="idle">
          <div class="idle-line">
            <span class="pulse"></span>
            <span>{{ idleText }}</span>
          </div>
        </div>

        <!-- ─── 选人（狼刀 / 预言家验 / 猎人开枪）─── -->
        <template v-else-if="pending.kind === 'pick-one'">
          <div class="ask">
            <h3 class="ask-title">{{ pending.title }}</h3>
            <p v-if="pending.hint" class="ask-hint">{{ pending.hint }}</p>
            <p v-if="pending.suggestion" class="ask-sug">参考：{{ pending.suggestion }}</p>
          </div>
          <div class="choices">
            <button
              v-for="id in pending.candidates"
              :key="id"
              class="choice"
              @click="pick(id)"
            >
              <span class="choice-seat num">{{ P(id)?.seat + 1 }}</span>
              <span class="choice-name">{{ P(id)?.isHuman ? '你' : P(id)?.name }}</span>
              <span class="choice-ep">{{ P(id)?.persona?.epithet }}</span>
            </button>
          </div>
          <div class="foot">
            <span class="tip">也可以直接点桌上的席位牌</span>
            <button v-if="pending.allowSkip" class="btn btn-ghost btn-sm" @click="skip">
              {{ pending.skipLabel || '跳过' }}
            </button>
          </div>
        </template>

        <!-- ─── 投票 ─── -->
        <template v-else-if="pending.kind === 'vote'">
          <div class="ask">
            <h3 class="ask-title">{{ pending.title }}</h3>
            <p class="ask-hint">{{ pending.hint }}</p>
            <div v-if="remain" class="countdown" :class="{ urgent: remain <= 10 }">
              <span class="num">{{ remain }}</span>
              <span class="cd-label">秒后自动弃票</span>
            </div>
          </div>
          <div class="choices">
            <button v-for="id in pending.candidates" :key="id" class="choice vote" @click="submitVote(id)">
              <span class="choice-seat num">{{ P(id)?.seat + 1 }}</span>
              <span class="choice-name">{{ P(id)?.name }}</span>
            </button>
          </div>
          <div class="foot">
            <span class="tip">多数票出局；平票则本轮无人出局</span>
            <button class="btn btn-ghost btn-sm" @click="submitVote(null)">弃票</button>
          </div>
        </template>

        <!-- ─── 女巫用药 ─── -->
        <template v-else-if="pending.kind === 'witch'">
          <div class="ask">
            <h3 class="ask-title">{{ pending.title }}</h3>
            <p class="ask-hint">{{ pending.hint }}</p>
          </div>

          <div class="chem">
            <div class="chem-row">
              <span class="chem-name">解药</span>
              <span class="chem-state" :class="pending.antidote ? 'ok' : 'used'">
                {{ pending.antidote ? '尚在' : '已用尽' }}
              </span>
              <button
                class="btn btn-sm"
                :class="{ 'btn-primary': pending.canSave && witchPoison == null }"
                :disabled="!pending.canSave || witchPoison != null"
                @click="submitWitch({ save: true, poison: null })"
              >救回 {{ shortLabel(game.nightKill) }}</button>
              <span v-if="pending.saveBlockedReason" class="chem-note">{{ pending.saveBlockedReason }}</span>
            </div>

            <div class="chem-row">
              <span class="chem-name">毒药</span>
              <span class="chem-state" :class="pending.poison ? 'ok' : 'used'">
                {{ pending.poison ? '尚在' : '已用尽' }}
              </span>
              <button
                class="btn btn-sm"
                :class="{ 'btn-danger': witchPoison != null }"
                :disabled="!pending.canPoison"
                @click="witchPoison = witchPoison == null ? -1 : null"
              >{{ witchPoison == null ? '下毒' : '取消' }}</button>
              <span class="chem-note">与解药不可同夜齐发</span>
            </div>
          </div>

          <div v-if="witchPoison != null" class="choices tight">
            <button
              v-for="id in pending.candidates"
              :key="id"
              class="choice"
              :class="{ on: witchPoison === id }"
              @click="witchPoison = id"
            >
              <span class="choice-seat num">{{ P(id)?.seat + 1 }}</span>
              <span class="choice-name">{{ P(id)?.name }}</span>
            </button>
          </div>

          <div class="foot">
            <button class="btn btn-ghost btn-sm" @click="submitWitch({ save: false, poison: null })">今晚不用药</button>
            <button
              class="btn btn-primary btn-sm"
              :disabled="witchPoison == null || witchPoison < 0"
              @click="submitWitch({ save: false, poison: witchPoison })"
            >确认毒杀</button>
          </div>
        </template>

        <!-- ─── 发言 ─── -->
        <template v-else-if="pending.kind === 'speak'">
          <div class="ask">
            <h3 class="ask-title">{{ pending.title }}</h3>
            <p class="ask-hint">{{ pending.hint }}</p>
          </div>

          <div class="kinds">
            <button
              v-for="k in kinds"
              :key="k.id"
              class="kind"
              :class="{ on: kind === k.id, risky: k.risky }"
              @click="kind = kind === k.id ? null : k.id; targetId = null"
            >
              <span class="kind-name">{{ k.name }}</span>
              <span class="kind-blurb">{{ k.blurb }}</span>
            </button>
          </div>

          <div v-if="needsTarget" class="sub">
            <span class="sub-label">{{ kind === 'claim-seer' ? '你要报谁' : '对谁' }}</span>
            <div class="choices tight">
              <button
                v-for="id in pending.targets"
                :key="id"
                class="choice sm"
                :class="{ on: targetId === id }"
                @click="targetId = id"
              >
                <span class="choice-seat num">{{ P(id)?.seat + 1 }}</span>
                <span class="choice-name">{{ P(id)?.name }}</span>
              </button>
            </div>
            <div v-if="kind === 'claim-seer' && me.role !== ROLE.SEER" class="sub">
              <span class="sub-label">报他什么</span>
              <div class="verdicts">
                <button class="vbtn" :class="{ on: verdict === ROLE.WOLF }" @click="verdict = ROLE.WOLF">查杀</button>
                <button class="vbtn good" :class="{ on: verdict === 'good' }" @click="verdict = 'good'">金水</button>
              </div>
            </div>
          </div>

          <div class="free">
            <textarea
              v-model="text"
              class="free-box"
              rows="2"
              maxlength="140"
              :placeholder="pending.lastWords ? '留一句话给活着的人（可留空）' : '也可以自己写一段话，留空则由系统按你的立场组织语言'"
            ></textarea>
            <span class="free-count num">{{ text.length }}/140</span>
          </div>

          <div class="foot">
            <button v-if="pending.allowSkip && !pending.lastWords" class="btn btn-ghost btn-sm" @click="skip()">
              过麦
            </button>
            <button
              class="btn btn-primary btn-sm"
              :disabled="!pending.lastWords && !canSpeak"
              @click="submitSpeech({ kind: kind || 'villager-read', targetId, verdict, text })"
            >
              {{ pending.lastWords ? '留下遗言' : '说出口' }}
            </button>
          </div>
        </template>
      </div>
    </section>
  </div>
</template>

<style scoped>
.dock {
  display: flex;
  align-items: stretch;
  gap: var(--gap-4);
  padding: 0 var(--gap-4) var(--gap-4);
}

.action {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.controls { display: flex; align-items: center; gap: var(--gap-3); }

.speeds { display: flex; border: 1px solid var(--line-soft); border-radius: 2px; overflow: hidden; }

.speed {
  padding: 3px 9px;
  font-size: 10.5px;
  letter-spacing: 0.1em;
  color: var(--paper-4);
  transition: color 0.16s var(--ease), background 0.16s var(--ease);
}
.speed:hover { color: var(--paper-2); }
.speed.on { color: #17120a; background: var(--brass); }

.ic {
  width: 24px; height: 22px;
  display: grid; place-items: center;
  border: 1px solid var(--line-soft);
  border-radius: 2px;
  color: var(--paper-3);
  font-size: 10px;
}
.ic:hover { color: var(--brass-hi); border-color: var(--line); }

.body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 13px 14px 12px;
  overflow-y: auto;
}

/* ─── 空闲 ─── */

.idle { display: flex; align-items: center; height: 100%; }

/* ─── 观战 ─── */

.auto { display: flex; flex-direction: column; gap: 3px; }

.auto-head { display: flex; align-items: center; gap: 8px; margin-bottom: 3px; }

.auto-tag {
  padding: 1px 7px;
  border: 1px solid var(--brass-dim);
  border-radius: 2px;
  font-size: 9.5px;
  letter-spacing: 0.18em;
  color: var(--brass-hi);
  background: rgba(201, 162, 39, 0.1);
}

.auto-who { font-size: 10.5px; letter-spacing: 0.14em; color: var(--paper-4); }

.auto-title {
  margin: 0;
  font-family: var(--font-serif);
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--paper);
}

.auto-hint { margin: 0; font-size: 11.5px; color: var(--paper-3); }

.auto-note {
  margin: 8px 0 0;
  padding-top: 8px;
  border-top: 1px solid var(--line-soft);
  font-size: 10.5px;
  line-height: 1.7;
  color: var(--paper-4);
}

.idle-line {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 13px;
  color: var(--paper-3);
}

.pulse {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--brass);
  animation: pulse-soft 1.4s infinite;
  flex: none;
}

/* ─── 提问 ─── */

.ask { display: flex; flex-direction: column; gap: 2px; }

.ask-title {
  margin: 0;
  font-family: var(--font-serif);
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--paper);
}

.ask-hint { margin: 0; font-size: 11.5px; color: var(--paper-3); line-height: 1.6; }
.ask-sug { margin: 0; font-size: 11px; color: var(--brass); }

.countdown { display: inline-flex; align-items: baseline; gap: 5px; margin-top: 3px; }
.countdown .num { font-size: 17px; color: var(--brass-hi); }
.countdown.urgent .num { color: var(--blood-hi); }
.cd-label { font-size: 10px; letter-spacing: 0.12em; color: var(--paper-4); }

/* ─── 选项 ─── */

.choices {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.choices.tight { gap: 4px; }

.choice {
  display: flex;
  align-items: baseline;
  gap: 5px;
  padding: 5px 10px;
  border: 1px solid var(--line);
  border-radius: 2px;
  background: rgba(32, 49, 63, 0.28);
  color: var(--paper-2);
  transition: all 0.16s var(--ease);
}
.choice:hover { border-color: var(--brass-hi); color: var(--paper); background: rgba(201, 162, 39, 0.12); transform: translateY(-1px); }
.choice.on { border-color: var(--brass); background: rgba(201, 162, 39, 0.2); color: var(--paper); }
.choice.vote:hover { border-color: var(--blood-hi); background: rgba(155, 34, 38, 0.2); }
.choice.sm { padding: 3px 8px; }

.choice-seat { font-size: 13px; color: var(--brass); font-weight: 700; }
.choice-name { font-size: 12px; }
.choice-ep { font-size: 9.5px; color: var(--paper-4); }

/* ─── 底部 ─── */

.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--gap-3);
  margin-top: auto;
  padding-top: 8px;
  border-top: 1px solid var(--line-soft);
}

.tip { font-size: 10.5px; color: var(--paper-4); }

/* ─── 女巫 ─── */

.chem { display: flex; flex-direction: column; gap: 5px; }

.chem-row {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
  font-size: 12px;
}

.chem-name { font-family: var(--font-serif); font-weight: 700; letter-spacing: 0.12em; color: var(--paper-2); min-width: 34px; }
.chem-state { font-size: 10px; letter-spacing: 0.1em; min-width: 46px; }
.chem-state.ok { color: var(--moss-hi); }
.chem-state.used { color: var(--paper-4); }
.chem-note { font-size: 10px; color: var(--paper-4); }

/* ─── 发言 ─── */

.kinds { display: flex; flex-wrap: wrap; gap: 5px; }

.kind {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 5px 10px;
  border: 1px solid var(--line-soft);
  border-radius: 2px;
  text-align: left;
  transition: all 0.16s var(--ease);
}
.kind:hover { border-color: var(--line); background: rgba(201, 162, 39, 0.07); }
.kind.on { border-color: var(--brass); background: rgba(201, 162, 39, 0.16); }
.kind.risky .kind-name { color: var(--blood-hi); }

.kind-name { font-size: 12px; color: var(--paper-2); letter-spacing: 0.06em; }
.kind.on .kind-name { color: var(--paper); }
.kind-blurb { font-size: 9.5px; color: var(--paper-4); }

.sub { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sub-label { font-size: 10px; letter-spacing: 0.14em; color: var(--paper-4); flex: none; }

.verdicts { display: flex; gap: 4px; }
.vbtn {
  padding: 3px 10px;
  border: 1px solid var(--line);
  border-radius: 2px;
  font-size: 11px;
  color: var(--paper-3);
}
.vbtn.on { border-color: var(--blood-hi); color: var(--blood-hi); background: rgba(155, 34, 38, 0.18); }
.vbtn.good.on { border-color: var(--moss-hi); color: var(--moss-hi); background: rgba(79, 122, 91, 0.18); }

.free { position: relative; }

.free-box {
  width: 100%;
  resize: none;
  padding: 7px 9px;
  border: 1px solid var(--line-soft);
  border-radius: 2px;
  background: rgba(6, 11, 18, 0.6);
  color: var(--paper);
  font-size: 12px;
  line-height: 1.6;
  transition: border-color 0.16s var(--ease);
}
.free-box:focus { outline: none; border-color: var(--brass); }
.free-box::placeholder { color: var(--paper-4); }

.free-count {
  position: absolute;
  right: 8px;
  bottom: 5px;
  font-size: 9.5px;
  color: var(--paper-4);
}

@media (max-width: 1080px) {
  .dock { flex-direction: row; gap: var(--gap-2); padding: 0 var(--gap-2) var(--gap-2); }
  .body { padding: 10px; }
  .ask-title { font-size: 14px; }
}
</style>
