// tools/inject-skins-assets.mjs — 将 08-skins.json 的 174 款皮肤资产注入到 data/assets.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESEARCH_PATH = path.join(ROOT, 'docs', 'research', '08-skins.json');
const ASSETS_PATH = path.join(ROOT, 'data', 'assets.json');

const research = JSON.parse(fs.readFileSync(RESEARCH_PATH, 'utf8'));
const assets = JSON.parse(fs.readFileSync(ASSETS_PATH, 'utf8'));

if (!assets.chars) {
  console.error('✘ assets.json 缺少 chars 字段');
  process.exit(1);
}

let injectedCount = 0;
let charsCount = 0;

for (const [charId, skinList] of Object.entries(research.skins || {})) {
  const charRec = assets.chars[charId];
  if (!charRec) continue;

  charRec.skins = charRec.skins || {};
  charsCount++;

  for (const s of skinList) {
    const skinId = s.skinId;
    const stem = s.stem;

    // 提取 avatar：优先使用本地离线内置头像路径
    const localAvatar = path.join(ROOT, 'public', 'assets', 'char', 'skin_avatar', `${stem}.png`);
    const avatarUrl = fs.existsSync(localAvatar)
      ? `/assets/char/skin_avatar/${stem}.png`
      : (s.avatar?.url || null);

    const skinEntry = {
      name: s.name,
      group: s.group || '',
      avatar: avatarUrl,
    };

    // 战斗 Spine 由 tools/install-skin-spines.mjs 下载并解析（anims 取自皮肤自己的骨骼，不能照抄原皮）：这里只保留已有的条目。
    const prevSpine = charRec.skins[skinId]?.spine;
    if (prevSpine) skinEntry.spine = prevSpine;

    charRec.skins[skinId] = skinEntry;
    injectedCount++;
  }
}

// 更新 stats
assets.stats = assets.stats || {};
assets.stats.skins = injectedCount;
assets.stats.charsWithSkins = charsCount;

// 安全写入，保持原有排版
fs.writeFileSync(ASSETS_PATH, JSON.stringify(assets), 'utf8');
console.log(`✔ 成功向 data/assets.json 注入 ${charsCount} 名干员的共 ${injectedCount} 套皮肤资产条目。`);
