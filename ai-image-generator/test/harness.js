'use strict';

/**
 * 一个极小的测试工具：不用框架，跑 `node test/xxx.test.js` 就能看结果。
 * 断言失败不抛异常（抛了后面的检查就全跳过了），先记下来，最后一起报。
 */

let pass = 0;
const failures = [];

function fmt(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function eq(actual, expected, label) {
  const a = fmt(actual);
  const b = fmt(expected);
  if (a === b) {
    pass += 1;
    return true;
  }
  failures.push(`${label}\n    期望 ${b}\n    实际 ${a}`);
  return false;
}

function ok(value, label) {
  return eq(Boolean(value), true, label);
}

function not(value, label) {
  return eq(Boolean(value), false, label);
}

/** 字符串包含（大小写不敏感） */
function has(text, part, label) {
  return ok(String(text == null ? '' : text).toLowerCase().includes(String(part).toLowerCase()), label);
}

function throws(fn, label) {
  try {
    fn();
  } catch {
    pass += 1;
    return true;
  }
  failures.push(`${label}\n    期望抛异常，实际没有`);
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function group(name, fn) {
  const before = failures.length;
  try {
    await fn();
  } catch (err) {
    failures.push(`${name} 抛异常：${(err && err.stack) || err}`);
  }
  console.log(`  ${failures.length === before ? '✓' : '✗'} ${name}`);
}

function report(title) {
  const total = pass + failures.length;
  console.log(`\n${title ? title + '：' : ''}通过 ${pass}/${total}`);
  if (failures.length) {
    console.log('\n失败项：');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    process.exitCode = 1;
  }
  return failures.length === 0;
}

module.exports = { eq, ok, not, has, throws, group, report, sleep, fmt };
