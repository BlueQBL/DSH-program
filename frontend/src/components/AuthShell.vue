<script setup>
/**
 * 认证页双栏外壳：
 *  左 —— 品牌区（眉题/大标题/说明 + 一个“后端直连”小终端）；
 *  右 —— 表单卡片（默认插槽）+ 卡片下方扩展区（panel-footer 插槽）。
 */
defineProps({
  eyebrow: { type: String, required: true },
  title: { type: String, required: true },
  tagline: { type: String, required: true },
  /** 终端内展示的接口示意文本；以 '>' 开头的行为输出行，其余自动加 '$' 提示符 */
  lines: { type: Array, default: () => [] }
})
</script>

<template>
  <div class="auth-page">
    <header class="auth-topbar">
      <div class="brand">
        <span class="brand-caret">›</span>
        <span>dsh/gate</span>
      </div>
      <div class="status-pill" role="status">
        <span class="dot"></span>
        服务在线
      </div>
    </header>

    <main class="auth-shell">
      <!-- 左侧品牌区 -->
      <section class="auth-brand">
        <p class="auth-eyebrow">{{ eyebrow }}</p>
        <h1 class="auth-title">{{ title }}</h1>
        <p class="auth-tagline">{{ tagline }}</p>

        <div class="auth-terminal" aria-hidden="true">
          <div class="term-head">
            <span>POST /api/auth/*</span>
            <span>JWT</span>
          </div>
          <p v-for="(line, i) in lines" :key="i" :class="line.startsWith('>') ? 'out' : 'cmd'">
            <template v-if="!line.startsWith('>')">
              <span class="p">$</span>{{ line }}
            </template>
            <template v-else>{{ line }}</template>
          </p>
        </div>
      </section>

      <!-- 右侧表单区 -->
      <section class="auth-panel">
        <div class="gate-card">
          <slot />
        </div>
        <div class="auth-extra">
          <slot name="panel-footer" />
        </div>
      </section>
    </main>

    <footer class="auth-foot">SPRING BOOT 3 · JWT · VUE 3 · H2 — 演示工程</footer>
  </div>
</template>
