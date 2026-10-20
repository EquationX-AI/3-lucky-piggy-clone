# 比对两次全量测试每条预设的结束画面：裁出盘面+底栏区域（避开随机待机动作的角色），算平均像素差，并拼成对照图
# 用法：python3 tools/compare-shots.py rewrite-3 original-3
import sys, json, os
from PIL import Image, ImageChops, ImageStat, ImageDraw
A, B = sys.argv[1], sys.argv[2]
presets = json.load(open('prize-control/presets.json'))
rows = []; thumbs = []
for p in presets:
    fa = f'.run/presets/{A}/{p["id"]}/zz-end.jpg'; fb = f'.run/presets/{B}/{p["id"]}/zz-end.jpg'
    if not (os.path.exists(fa) and os.path.exists(fb)): rows.append((p['id'], None)); continue
    ia, ib = Image.open(fa).convert('RGB'), Image.open(fb).convert('RGB')
    W, H = ia.size
    box = (int(W*0.07), int(H*0.12), int(W*0.70), int(H*0.95))   # 盘面 + 倍率列 + 底栏左中部
    da = ImageChops.difference(ia.crop(box), ib.crop(box))
    m = sum(ImageStat.Stat(da).mean) / 3
    rows.append((p['id'], round(m, 2)))
    t = Image.new('RGB', (1200, 300), 'black')
    t.paste(ia.resize((600, 292)), (0, 0)); t.paste(ib.resize((600, 292)), (600, 0))
    ImageDraw.Draw(t).text((8, 4), f'{p["id"]}  diff={m:.2f}  (左 重写版 / 右 原版)', fill=(255, 255, 0))
    thumbs.append(t)
for i in range(0, len(thumbs), 8):
    sheet = Image.new('RGB', (1200, 300 * len(thumbs[i:i+8])))
    for k, t in enumerate(thumbs[i:i+8]): sheet.paste(t, (0, 300 * k))
    sheet.save(f'docs/对照-结束画面-{i//8+1}.jpg', quality=80)
json.dump(rows, open(f'.run/presets/shot-diff-{A}-{B}.json', 'w'))
for r in sorted(rows, key=lambda x: -(x[1] or 0)): print(r)
