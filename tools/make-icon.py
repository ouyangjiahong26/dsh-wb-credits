"""生成插件图标 icon.png（256x256）：蓝色圆角底 + 白色胶囊 + 状态点 + 两条数据条。

    python tools/make-icon.py
"""

from PIL import Image, ImageDraw

S = 256
BG = (77, 107, 254, 255)      # #4D6BFE
WHITE = (255, 255, 255, 255)
GREEN = (34, 197, 94, 255)    # #22C55E
INK = (77, 107, 254, 255)

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 圆角底
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=56, fill=BG)

# 胶囊（白色圆角矩形）
cx0, cy0, cx1, cy1 = 44, 80, 212, 176
d.rounded_rectangle([cx0, cy0, cx1, cy1], radius=48, fill=WHITE)

# 状态点
d.ellipse([cx0 + 22, (cy0 + cy1) // 2 - 11, cx0 + 44, (cy0 + cy1) // 2 + 11], fill=GREEN)

# 两条数据条
d.rounded_rectangle([cx0 + 60, 104, cx1 - 26, 118], radius=7, fill=INK)
d.rounded_rectangle([cx0 + 60, 138, cx1 - 58, 152], radius=7, fill=(150, 163, 254, 255))

img.save("icon.png")
print("icon.png", img.size)
