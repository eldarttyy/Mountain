# Generates palette-matched landscape illustrations used as labelled sample imagery.
import math, random, sys, os
OUT = sys.argv[1]
def ridge(w, base, amp, seed, freq=3, rough=0.35, peaks=None):
    r = random.Random(seed); pts = []
    ph = [r.random()*6.28 for _ in range(6)]
    for i in range(0, 161):
        x = w*i/160; t = i/160
        y = 0
        for k in range(1, 6):
            y += math.sin(t*math.pi*freq*k + ph[k]) * amp/(k**(1+rough))
        if peaks:
            for (px, ph_, pw) in peaks:
                y += ph_*math.exp(-((t-px)/pw)**2)
        pts.append((x, base - y))
    return pts
def poly(pts, w, h, fill, op=1):
    d = "M0,%d " % h + " ".join("L%.1f,%.1f" % p for p in pts) + " L%d,%d Z" % (w, h)
    return f'<path d="{d}" fill="{fill}" fill-opacity="{op}"/>'
def snow(pts, line, fill="#FBF9F4", seed=1):
    r = random.Random(seed); top=[]; bot=[]
    for (x,y) in pts:
        sl = line + r.uniform(-14, 14)
        top.append((x, y)); bot.append((x, max(y, sl)))
    d = "M" + " L".join("%.1f,%.1f" % p for p in top) + " L" + " L".join("%.1f,%.1f" % p for p in reversed(bot)) + " Z"
    return f'<path d="{d}" fill="{fill}"/>'
def yurt(x, y, s, door=True):
    g = f'<g transform="translate({x},{y}) scale({s})">'
    g += '<path d="M-40,0 L-40,-26 Q0,-62 40,-26 L40,0 Z" fill="#F7F4ED"/>'
    g += '<path d="M-40,-26 Q0,-62 40,-26" fill="none" stroke="#C9B9A0" stroke-width="3"/>'
    g += '<rect x="-40" y="-22" width="80" height="5" fill="#B5543A" fill-opacity=".7"/>'
    if door: g += '<rect x="-7" y="-18" width="14" height="18" fill="#7A3B2A"/>'
    return g + '</g>'
def fir(x, y, s, c):
    return f'<path d="M{x},{y-40*s} L{x+11*s},{y} L{x-11*s},{y} Z" fill="{c}"/>'
def horse(x, y, s, c="#202925"):
    return (f'<g transform="translate({x},{y}) scale({s})" fill="{c}">'
            '<path d="M-22,-14 Q-4,-20 14,-16 L22,-28 Q26,-30 28,-26 L26,-14 Q24,-10 20,-10 L18,0 L15,0 L14,-8 L-12,-8 L-14,0 L-17,0 L-18,-9 Q-26,-10 -28,-4 L-30,-4 Q-28,-14 -22,-14 Z"/></g>')
def svg(w, h, body, sky_top, sky_bot, sun=None):
    s = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" preserveAspectRatio="xMidYMid slice">'
    s += f'<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{sky_top}"/><stop offset="1" stop-color="{sky_bot}"/></linearGradient></defs>'
    s += f'<rect width="{w}" height="{h}" fill="url(#s)"/>'
    if sun: s += f'<circle cx="{sun[0]}" cy="{sun[1]}" r="{sun[2]}" fill="#EAA777" fill-opacity=".85"/>'
    return s + body + '</svg>'
W,H = 2400,1200
scenes = {}
# Hero: Tian Shan range over a valley
b = ""
far = ridge(W, 560, 120, 1, peaks=[(.3,260,.07),(.62,320,.06),(.82,200,.08)])
b += poly(far, W, H, "#9FBFC4"); b += snow(far, 470, seed=2)
mid = ridge(W, 720, 90, 3, peaks=[(.15,160,.09),(.5,120,.1)])
b += poly(mid, W, H, "#4E7A6C"); b += snow(mid, 600, "#E9EEEA", 4)
b += poly(ridge(W, 880, 50, 5), W, H, "#2C5A4B")
b += poly(ridge(W, 1010, 30, 6, freq=2), W, H, "#173F35")
r = random.Random(9)
for i in range(70):
    x = r.uniform(0, W); y = r.uniform(960, 1180); b += fir(x, y, r.uniform(.7,1.4), "#10302A")
scenes["hero"] = svg(W,H,b,"#E6EFEF","#F7F4ED",(1780,300,70))
# Song-Kul: yurts on the shore
W2,H2=1600,1000; b=""
f = ridge(W2, 430, 40, 11, freq=2, peaks=[(.7,60,.15)]); b += poly(f, W2, H2, "#A9C5C8"); b += snow(f, 400, seed=12)
b += f'<rect x="0" y="470" width="{W2}" height="120" fill="#77AEB9"/>'
b += f'<rect x="0" y="520" width="{W2}" height="6" fill="#F7F4ED" fill-opacity=".35"/>'
b += poly(ridge(W2, 610, 14, 13, freq=1.5), W2, H2, "#7E9F6A")
b += poly(ridge(W2, 700, 10, 14, freq=1.2), W2, H2, "#5E8455")
for (x,y,s) in [(380,760,1.6),(560,740,1.25),(1100,790,1.9),(1300,750,1.2)]: b += yurt(x,y,s)
for (x,y,s) in [(820,770,1.3),(890,780,1.1)]: b += horse(x,y,s,"#3B2F26")
scenes["songkul"] = svg(W2,H2,b,"#DDEBEE","#F7F4ED",(260,180,46))
# Issyk-Kul: big lake, distant snowy range
b=""
f = ridge(W2, 420, 50, 21, peaks=[(.25,90,.1),(.6,110,.12)]); b += poly(f, W2, H2, "#8FB3BA"); b += snow(f, 360, seed=22)
b += f'<rect x="0" y="480" width="{W2}" height="360" fill="#5E9AA6"/>'
for i in range(9): b += f'<rect x="{120+i*150}" y="{520+i*28}" width="{260-i*12}" height="3" fill="#F7F4ED" fill-opacity=".3"/>'
b += poly(ridge(W2, 880, 16, 23, freq=1.4), W2, H2, "#D8C7A6")
scenes["issykkul"] = svg(W2,H2,b,"#E9F1F1","#F7F4ED",(1240,170,40))
# Karakol: sharp peaks + spruce forest + lake (Ala-Kul)
b=""
f = ridge(W2, 470, 100, 31, freq=4, rough=.2, peaks=[(.45,230,.05),(.72,180,.05)]); b += poly(f, W2, H2, "#8AA9AC"); b += snow(f, 360, seed=32)
b += f'<ellipse cx="800" cy="610" rx="420" ry="46" fill="#5FB0B5"/>'
m = ridge(W2, 700, 50, 33, freq=2); b += poly(m, W2, H2, "#2F5D4F")
r = random.Random(34)
for i in range(110):
    x = r.uniform(0, W2); y = r.uniform(700, 1000); b += fir(x, y, r.uniform(1,2.2), r.choice(["#173F35","#10302A","#21483E"]))
scenes["karakol"] = svg(W2,H2,b,"#E2ECEC","#F7F4ED")
# Ala-Archa: tall peak, valley, river
b=""
f = ridge(W2, 520, 60, 41, freq=3, peaks=[(.5,360,.07),(.2,140,.06)]); b += poly(f, W2, H2, "#9DB8BB"); b += snow(f, 380, seed=42)
b += poly(ridge(W2, 720, 70, 43, freq=2.5), W2, H2, "#3F6D5E")
b += '<path d="M640,1000 C700,900 860,860 820,760 C800,720 760,720 790,700" fill="none" stroke="#9CCBD2" stroke-width="26" stroke-linecap="round"/>'
b += poly(ridge(W2, 900, 40, 44, freq=1.8), W2, H2, "#173F35")
scenes["alaarcha"] = svg(W2,H2,b,"#E3EDEE","#F7F4ED")
# Alay: massive snow peak over steppe
b=""
f = ridge(W2, 560, 30, 51, freq=1.5, peaks=[(.55,330,.16)]); b += poly(f, W2, H2, "#A8C1C3"); b += snow(f, 470, seed=52)
b += poly(ridge(W2, 700, 18, 53, freq=1.2), W2, H2, "#B59E72")
b += poly(ridge(W2, 820, 12, 54, freq=1), W2, H2, "#8C7A52")
b += yurt(1180, 860, 1.1) + yurt(1290, 850, .9)
scenes["alay"] = svg(W2,H2,b,"#E7EEEE","#F7F4ED",(300,200,38))
# Jailoo with horses
b=""
f = ridge(W2, 440, 70, 61, freq=2.5, peaks=[(.3,120,.1)]); b += poly(f, W2, H2, "#9BB9BC"); b += snow(f, 380, seed=62)
b += poly(ridge(W2, 620, 30, 63, freq=1.6), W2, H2, "#6E9360")
b += poly(ridge(W2, 760, 20, 64, freq=1.3), W2, H2, "#557D4C")
for (x,y,s) in [(560,840,2.2),(720,860,2.6),(900,830,1.9),(1100,880,2.8)]: b += horse(x,y,s)
scenes["jailoo"] = svg(W2,H2,b,"#E3EDEC","#F7F4ED",(1320,190,44))
# Felt-pattern tile (ram's horn motif), very low contrast for backgrounds
tile = ('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" viewBox="0 0 120 60">'
  '<g fill="none" stroke="#173F35" stroke-opacity=".08" stroke-width="3" stroke-linecap="round">'
  '<path d="M60,46 L60,30 C60,18 48,12 40,16 C32,20 34,32 42,30 C48,28 46,21 42,22"/>'
  '<path d="M60,30 C60,18 72,12 80,16 C88,20 86,32 78,30 C72,28 74,21 78,22"/>'
  '<path d="M0,46 L0,30 C0,18 12,12 20,16"/><path d="M120,46 L120,30 C120,18 108,12 100,16"/>'
  '</g></svg>')
os.makedirs(OUT, exist_ok=True)
for k,v in scenes.items(): open(f"{OUT}/{k}.svg","w").write(v)
open(f"{OUT}/felt.svg","w").write(tile)
print({k: len(v)//1024 for k,v in scenes.items()})
