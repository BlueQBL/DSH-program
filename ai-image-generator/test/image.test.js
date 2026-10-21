'use strict';

/**
 * 图片落盘前的处理（lib/image.js）：
 * base64 解码、格式嗅探、下载文件名。
 *
 * 这几件小事出错的后果很具体：解不出来 → 上游已经把图生成了、钱也扣了，
 * 界面上却什么都没有；嗅探错 → 存下来的文件浏览器打不开（裂图比报错更难查）。
 *
 * 运行：node test/image.test.js
 */

const { eq, ok, not, has, throws, group, report } = require('./harness.js');
const Images = require('../lib/image.js');
const Offline = require('../lib/offline.js');

const PNG = Offline.encodePng(2, 2, Buffer.alloc(12, 0));
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WEBP'), Buffer.alloc(32, 2)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(32, 3)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>', 'utf8');

(async function main() {
  console.log('base64 解码');

  await group('裸 base64 / data URL / 带换行 / url-safe 都解得开', () => {
    const plain = Images.decodeBase64Image(PNG.toString('base64'));
    eq(plain.buffer.length, PNG.length, '裸 base64 解回来一模一样');
    eq(plain.declaredType, '', '没有前缀就没有声明类型');

    const withPrefix = Images.decodeBase64Image('data:image/png;base64,' + PNG.toString('base64'));
    eq(withPrefix.buffer.equals(PNG), true, 'data: 前缀被剥掉');
    eq(withPrefix.declaredType, 'image/png', '顺手记下声明的类型');

    const wrapped = Images.decodeBase64Image(PNG.toString('base64').replace(/(.{20})/g, '$1\n'));
    eq(wrapped.buffer.equals(PNG), true, '中间夹了换行也认');

    const urlSafe = Buffer.from([0xfb, 0xff, 0xfe, 0x01]).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
    eq(Images.decodeBase64Image(urlSafe).buffer.length, 4, 'base64url 的 - _ 也认');
  });

  await group('空值 / 乱码 / 不是 base64 的文本都明确报错', () => {
    throws(() => Images.decodeBase64Image(''), '空字符串抛错');
    throws(() => Images.decodeBase64Image(null), 'null 抛错');
    throws(() => Images.decodeBase64Image('这不是 base64，里面有中文和标点'), '非 base64 字符抛错');
    has(
      (() => {
        try {
          Images.decodeBase64Image('不是图片');
        } catch (err) {
          return err.message;
        }
        return '';
      })(),
      'base64',
      '报错里说了是 base64 的问题'
    );
  });

  console.log('格式嗅探');

  await group('按魔术字节认格式，不靠扩展名也不靠 content-type', () => {
    eq(Images.sniffImage(PNG).mime, 'image/png', 'PNG');
    eq(Images.sniffImage(PNG).ext, '.png', 'PNG 扩展名');
    eq(Images.sniffImage(JPEG).mime, 'image/jpeg', 'JPEG');
    eq(Images.sniffImage(JPEG).ext, '.jpg', 'JPEG 用 .jpg');
    eq(Images.sniffImage(WEBP).mime, 'image/webp', 'WebP');
    eq(Images.sniffImage(GIF).mime, 'image/gif', 'GIF');
    eq(Images.sniffImage(SVG).mime, 'image/svg+xml', 'SVG');
    eq(Images.sniffImage(Buffer.from('<html>oops</html>')), null, 'HTML 页面认不出（图床挂了就是这个样）');
    eq(Images.sniffImage(Buffer.alloc(0)), null, '空 buffer 认不出');
  });

  await group('认不出魔术字节时，退回看上游声明的 content-type', () => {
    const unknown = Buffer.from('xxxxnot-a-real-image');
    eq(Images.sniffImage(unknown, 'image/png').mime, 'image/png', '声明 png 就用 png');
    eq(Images.sniffImage(unknown, 'image/jpeg').ext, '.jpg', '声明 jpeg 就用 .jpg');
    eq(Images.sniffImage(unknown, 'text/html'), null, '声明 html 照样不认（宁可报错也不存裂图）');
  });

  await group('toStoredImage：认得出才存，认不出就报错', () => {
    eq(Images.toStoredImage(PNG).ext, '.png', 'PNG 能存');
    eq(Images.toStoredImage(JPEG, { contentType: 'image/jpeg' }).mime, 'image/jpeg', 'JPEG 能存');
    throws(() => Images.toStoredImage(Buffer.from('<html>image expired</html>')), 'HTML 存不了');
    has(
      (() => {
        try {
          Images.toStoredImage(Buffer.from('<html>image expired</html>'));
        } catch (err) {
          return err.message;
        }
        return '';
      })(),
      '图片格式',
      '报错说清是格式问题'
    );
  });

  console.log('下载文件名');

  await group('文件名带描述、去非法字符、留够信息', () => {
    const name = Images.downloadName({
      id: 'img_mabc123_xy12',
      prompt: '雨后的老城区 / 红伞: 走过积水?',
      file: 'img_mabc123_xy12.png',
    });
    has(name, 'lan-shai-', '有前缀');
    has(name, '雨后', '带上了描述');
    ok(!/[\\/:*?"<>|]/.test(name.replace('lan-shai-', '')), '不含 Windows 非法字符');
    has(name, '.png', '扩展名跟着文件走');
    ok(name.length < 80, '长度收口');

    eq(Images.downloadName({ id: 'img_x', prompt: '', file: 'img_x.png' }), 'lan-shai-image-img_x.png', '没有描述时用 image 兜底，id 尾巴照样带着');
    eq(Images.downloadName({ id: 'img_y_zzzz', prompt: 'x', file: 'img_y_zzzz.jpg' }).endsWith('.jpg'), true, '跟着文件扩展名');
    not(Images.downloadName({}).includes('undefined'), '空记录也不炸');
  });

  report('image');
})();
