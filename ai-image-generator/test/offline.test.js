'use strict';

/**
 * 离线显影引擎的测试：没有 Key 时出的图必须是一张**真的 PNG**，
 * 否则「历史 / 下载」这条链路在演示里就是假的。
 *
 * 运行：node test/offline.test.js
 */

const zlib = require('node:zlib');
const { eq, ok, not, group, report } = require('./harness.js');
const Offline = require('../lib/offline.js');
const Images = require('../lib/image.js');

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readHeader(buffer) {
  return {
    signature: Array.from(buffer.subarray(0, 8)),
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
    end: buffer.subarray(buffer.length - 8, buffer.length - 4).toString('latin1'),
  };
}

(async function main() {
  console.log('PNG 编码');

  await group('手写的 PNG 结构是对的（签名 / IHDR / IEND）', () => {
    const rgb = Buffer.alloc(2 * 2 * 3, 0);
    rgb[0] = 255;
    const png = Offline.encodePng(2, 2, rgb);
    const head = readHeader(png);
    eq(head.signature, PNG_SIG, 'PNG 签名');
    eq(head.width, 2, '宽写在 IHDR 里');
    eq(head.height, 2, '高写在 IHDR 里');
    eq(head.bitDepth, 8, '8 位深');
    eq(head.colorType, 2, 'truecolor RGB');
    eq(head.end, 'IEND', '以 IEND 收尾');
    eq(Images.sniffImage(png).mime, 'image/png', '自己的嗅探器认得它是 PNG');
    eq(png.toString('latin1').includes('IHDR'), true, '含 IHDR 块');
    eq(png.toString('latin1').includes('IDAT'), true, '含 IDAT 块');
  });

  await group('解出来的像素数据能被 zlib 还原（不是乱塞字节）', () => {
    const rgb = Buffer.alloc(4 * 4 * 3);
    for (let i = 0; i < rgb.length; i += 1) rgb[i] = i % 256;
    const png = Offline.encodePng(4, 4, rgb);
    // 把 IDAT 的内容解出来，核对每个扫描行的过滤字节是 0、像素字节一个不少
    const idatStart = png.indexOf(Buffer.from('IDAT', 'latin1'));
    const length = png.readUInt32BE(idatStart - 4);
    const idat = png.subarray(idatStart + 4, idatStart + 4 + length);
    const raw = zlib.inflateSync(idat);
    eq(raw.length, (4 * 3 + 1) * 4, '每行 1 个过滤字节 + 4×3 像素字节');
    eq(raw[0], 0, '过滤类型 0');
    eq(raw[13], 0, '第二行开头也是过滤类型 0');
    eq(Array.from(raw.subarray(1, 4)), [0, 1, 2], '像素字节按顺序写进去了');
  });

  console.log('画一张');

  await group('画出来的是一张能用的 PNG，尺寸说一是一', () => {
    const out = Offline.render({ prompt: '雨后的老城区，一个人撑着红伞', styleId: 'cinema', size: '1024x768' });
    const head = readHeader(out.buffer);
    eq(head.signature, PNG_SIG, 'PNG 签名');
    eq([head.width, head.height], [1024, 768], '尺寸与请求一致');
    eq(out.mime, 'image/png', 'mime 对');
    eq(out.ext, '.png', '扩展名对');
    eq(out.capped, false, '没有压过');
    ok(out.buffer.length > 10 * 1024, '图片有内容（不是一片纯色占位）');
    eq(out.styleLabel, '电影感', '风格标签带出来');
  });

  await group('同一句描述永远得到同一张图，换一句就换一张', () => {
    const a = Offline.render({ prompt: '一只白猫', styleId: 'photo', size: '512x512' });
    const b = Offline.render({ prompt: '一只白猫', styleId: 'photo', size: '512x512' });
    const c = Offline.render({ prompt: '一只黑猫', styleId: 'photo', size: '512x512' });
    eq(a.buffer.equals(b.buffer), true, '同一输入 → 同一张（可复现）');
    eq(a.buffer.equals(c.buffer), false, '换描述 → 换图');
    const d = Offline.render({ prompt: '一只白猫', styleId: 'pixel', size: '512x512' });
    eq(a.buffer.equals(d.buffer), false, '换风格 → 换配色');
  });

  await group('大尺寸压到上限（离线演示不该让浏览器等十几秒）', () => {
    const out = Offline.render({ prompt: '宽银幕城市', styleId: 'cyberpunk', size: '3840x2160' });
    const head = readHeader(out.buffer);
    eq(Math.max(head.width, head.height), Offline.CAP_MAX_SIDE, '最长边压到 1280');
    eq(head.width / head.height > 1.7 && head.width / head.height < 1.82, true, '长宽比基本保持 16:9');
    eq(out.capped, true, '标记压过');
  });

  await group('尺寸写错也能画（退回 1024×1024）', () => {
    const { width, height } = Offline.sizeFor('不是尺寸');
    eq([width, height], [1024, 1024], '退回方图');
    const big = Offline.sizeFor('4096x1024');
    eq(Math.max(big.width, big.height), Offline.CAP_MAX_SIDE, '超长图也压到上限');
    eq(big.width > big.height, true, '还是横的');
  });

  await group('画得快：1024×1024 在 1 秒内算完', () => {
    const started = Date.now();
    Offline.render({ prompt: '性能测试', styleId: 'oil', size: '1024x1024' });
    const ms = Date.now() - started;
    ok(ms < 1000, `用了 ${ms}ms`);
  });

  report('offline');
})();
