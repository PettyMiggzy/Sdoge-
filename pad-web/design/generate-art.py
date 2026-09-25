"""Regenerates the SDOGE Launchpad site art from the owner's mockup with Venice.

The owner's mockup (mockup-home.jpg) is the design spec. Each art region is
cropped out of it and redrawn clean at 2K by Venice's image-edit API
(gpt-image-2-edit), same style, with the mockup's text and buttons removed.
The results are converted to the web files in ../public/brand/.

    VENICE_API_KEY=... python3 design/generate-art.py            # everything
    VENICE_API_KEY=... python3 design/generate-art.py hero logo  # some of it

The key is read from the environment only. Never commit it.
Needs Pillow. Raw 2K outputs land in design/out/ (gitignored).
"""
import base64, io, json, os, sys, threading, time, urllib.error, urllib.request
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
BRAND = os.path.join(HERE, '..', 'public', 'brand')
KEY = os.environ.get('VENICE_API_KEY', '')

STYLE = ("Keep the exact same art style as the reference: glossy, detailed 3D-cartoon key art, "
         "deep navy and electric-blue palette with violet glows, cinematic lighting. Sharp, crisp details, "
         "no blur, no watermark, no signature.")

# (crop box in mockup pixels, output aspect ratio, prompt)
JOBS = {
    'hero': ((0, 58, 1024, 512), '21:9',
             "Recreate this image as a clean, high-resolution website hero background. Keep the composition: "
             "on the right, the Shiba Inu doge astronaut (white-and-blue space suit with the Arc logo, blue cap "
             "with a white USDC dollar-sign logo, blue sunglasses, giving a thumbs up) lounging on grey moon rocks "
             "and holding a dark blue flag that reads 'SDOGE LAUNCHPAD' with the Arc logo; the huge blue planet in "
             "the sky; the rocket and the futuristic blue city with glowing violet arches; the words 'GOOD PROJECTS "
             "ONLY' painted on the rock at the lower right. REMOVE all website text and interface elements on the "
             "left half (the big 'SDOGE LAUNCHPAD ON ARC' title, the headline, the paragraph and both buttons) and "
             "repaint that area as a natural continuation of the scene: starry space, the planet's curve, the "
             "distant city skyline and moon rocks, slightly darker so white text placed there stays readable. "
             "No other text anywhere. " + STYLE),
    'logo': ((28, 78, 470, 300), '16:9',
             "Recreate only this logo as a crisp, high-resolution graphic, centered on a plain, flat, solid pure "
             "black background with nothing else in the image. Top line: the word 'SDOGE' in bold glossy "
             "white-and-silver 3D letters with a thick dark navy outline and a blue edge glow, where the letter O "
             "is a round badge showing a Shiba Inu doge face wearing a blue cap with a white USDC dollar-sign logo "
             "and dark sunglasses. Second line: the word 'LAUNCHPAD' in bold glossy gold 3D letters with a dark "
             "brown outline. Spell both words exactly. Leave out the 'ON ARC' line. " + STYLE),
    'launch': ((282, 618, 648, 918), '3:2',
               "Recreate this artwork as a clean, high-resolution illustration: a white-and-blue rocket with the "
               "Arc logo and a round porthole showing a Shiba Inu doge in a blue cap and sunglasses, lifting off "
               "with bright orange fire and smoke from a launch pad; glowing blue-violet arches, a futuristic blue "
               "city at night and a starry sky behind it. Widen the scene to fill a 3:2 frame by extending the city, "
               "arches and sky on both sides. No text, no interface, no card borders. " + STYLE),
    'relax': ((684, 1176, 1024, 1392), '3:2',
              "Recreate this artwork as a clean, high-resolution illustration: a Shiba Inu doge in a blue cap with "
              "a white USDC dollar-sign logo and blue sunglasses, in a blue-and-white outfit, relaxing in a folding "
              "lawn chair on grey moon rocks and holding a blue drink can; next to him a dark signboard with glowing "
              "blue edges that reads exactly 'SAME VIBES. MORE STABLE PROJECTS.' in bold white hand lettering; a "
              "small moon and a planet in the starry sky. Widen the scene to fill a 3:2 frame. No other text, no "
              "interface. " + STYLE),
    'footer': ((0, 1388, 1024, 1536), '21:9',
               "Recreate this scene as a clean, high-resolution ultra-wide banner: grey moon rocks and metal cargo "
               "crates marked 'ARC' in the foreground, a futuristic blue city with glowing violet arches and rockets "
               "in the middle, a large blue planet rising behind the city and a starry sky. REMOVE the words 'GOOD "
               "PROJECTS. STRONGER TOGETHER.' on the left and the 'Create a Launch' button on the right, and repaint "
               "those areas as more of the same scene. Extend the sky upward and the moon ground downward to fill the "
               "frame. No text except the small ARC labels on the crates. " + STYLE),
}


def post(path, body):
    req = urllib.request.Request(
        f'https://api.venice.ai/api/v1/{path}', data=json.dumps(body).encode(),
        headers={'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json', 'User-Agent': 'curl/8.5.0'},
        method='POST')
    with urllib.request.urlopen(req, timeout=300) as r:
        ctype, data = r.headers.get('content-type', ''), r.read()
    if 'json' in ctype:  # some models answer with base64 JSON instead of raw PNG
        j = json.loads(data)
        return base64.b64decode((j.get('images') or [None])[0] or j['image'])
    return data


def png_b64(im):
    buf = io.BytesIO(); im.save(buf, 'PNG')
    return base64.b64encode(buf.getvalue()).decode()


def generate(name, mockup):
    box, aspect, prompt = JOBS[name]
    t = time.time()
    try:
        img = post('image/edit', {'model': 'gpt-image-2-edit', 'image': png_b64(mockup.crop(box)),
                                  'prompt': prompt, 'aspect_ratio': aspect, 'resolution': '2K'})
        if name == 'logo':  # transparent background for the logo
            img = post('image/background-remove', {'image': base64.b64encode(img).decode()})
        open(os.path.join(OUT, f'{name}.png'), 'wb').write(img)
        print(f'{name}: ok in {time.time() - t:.0f}s', flush=True)
    except urllib.error.HTTPError as e:
        print(f'{name}: HTTP {e.code} {e.read().decode()[:300]}', flush=True)


def webp(im, name, q):
    im.save(os.path.join(BRAND, name), 'WEBP', quality=q, method=6)


def convert(names):
    """2K PNGs -> the web files the site loads."""
    def fit(im, w):
        return im.resize((w, round(w * im.height / im.width)), Image.LANCZOS)
    src = lambda n: Image.open(os.path.join(OUT, f'{n}.png'))  # noqa: E731
    if 'hero' in names:
        webp(fit(src('hero').convert('RGB'), 2000), 'hero.webp', 78)
    if 'logo' in names:
        logo = src('logo').convert('RGBA')
        webp(fit(logo.crop(logo.split()[3].getbbox()), 1100), 'logo-launchpad.webp', 90)
    if 'launch' in names:
        webp(src('launch').convert('RGB').resize((1200, 800), Image.LANCZOS), 'launch-rocket.webp', 80)
    if 'relax' in names:
        webp(src('relax').convert('RGB').resize((1200, 800), Image.LANCZOS), 'relax.webp', 80)
    if 'footer' in names:
        f = src('footer').convert('RGB')
        webp(fit(f.crop((0, int(f.height * 0.18), f.width, int(f.height * 0.80))), 2000), 'footer-banner.webp', 78)
    if 'hero' in names or 'logo' in names:  # social preview: hero art with the logo on the left
        hero = src('hero').convert('RGB')
        hero = hero.resize((round(hero.width * 630 / hero.height), 630), Image.LANCZOS)
        og = hero.crop((hero.width - 1200, 0, hero.width, 630)).convert('RGBA')
        shade = Image.new('RGBA', (1200, 630)); d = ImageDraw.Draw(shade)
        for x in range(600):
            d.line([(x, 0), (x, 630)], fill=(4, 10, 24, int(210 * (1 - x / 600))))
        og.alpha_composite(shade)
        logo = Image.open(os.path.join(BRAND, 'logo-launchpad.webp')).convert('RGBA'); logo.thumbnail((560, 400))
        og.alpha_composite(logo, (40, (630 - logo.height) // 2 - 20))
        og.convert('RGB').save(os.path.join(BRAND, 'social-share.jpg'), quality=85)


if __name__ == '__main__':
    if not KEY:
        sys.exit('set VENICE_API_KEY')
    names = sys.argv[1:] or list(JOBS)
    os.makedirs(OUT, exist_ok=True)
    mockup = Image.open(os.path.join(HERE, 'mockup-home.jpg')).convert('RGB')
    threads = [threading.Thread(target=generate, args=(n, mockup)) for n in names]
    for th in threads: th.start()
    for th in threads: th.join()
    convert([n for n in names if os.path.exists(os.path.join(OUT, f'{n}.png'))])
    print('done; check the files in public/brand/ before committing')
