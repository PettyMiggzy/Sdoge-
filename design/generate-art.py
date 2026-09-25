"""Makes the main site's page art from the owner's mockups with Venice.

The mockups in ui-reference/ are the design spec. Each art region is cropped
out of a mockup and redrawn clean at 2K by Venice's image-edit API
(gpt-image-2-edit), same style, with the mockup's text and buttons removed.
The results are converted to the web files in ../assets/img/.

    VENICE_API_KEY=... python3 design/generate-art.py                 # everything
    VENICE_API_KEY=... python3 design/generate-art.py staking-hero    # some of it

The key is read from the environment only. Never commit it.
Needs Pillow. Raw 2K outputs land in design/out/ (gitignored).
"""
import base64, io, json, os, sys, threading, time, urllib.error, urllib.request
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
IMG = os.path.join(HERE, '..', 'assets', 'img')
KEY = os.environ.get('VENICE_API_KEY', '')

STYLE = ("Keep the exact same art style as the reference: glossy, detailed 3D-cartoon key art, "
         "deep navy and electric-blue palette with violet glows, cinematic lighting. Sharp, crisp details, "
         "no blur, no watermark, no signature.")

# name: (mockup, crop box in mockup pixels, output aspect ratio, prompt)
JOBS = {
    'staking-hero': ('staking-page-mockup.jpg', (0, 58, 1024, 488), '21:9',
                     "Recreate this image as a clean, high-resolution website hero background. Keep the composition: "
                     "on the right, the Shiba Inu doge astronaut (white-and-blue space suit with the Arc logo on the "
                     "chest, blue cap with a white USDC dollar-sign logo, blue mirrored sunglasses) lying back relaxed "
                     "with his hands behind his head and one boot raised, on a big pile of glossy blue USDC coins on "
                     "grey moon rocks; beside him a dark blue flag on a pole that reads 'SDOGE STAKING'; metal crates "
                     "marked 'ARC'; the big blue planet, the glowing violet Arc arch, the rocket flying up and the "
                     "starry sky. REMOVE all website text and interface elements on the left (the big 'SDOGE STAKING' "
                     "title, the slogan, the paragraph and both buttons) and repaint that area as a natural "
                     "continuation of the scene: starry space, the planet's curve and moon rocks, slightly darker so "
                     "white text placed there stays readable. No other text anywhere except 'SDOGE STAKING' on the "
                     "flag and 'ARC' on the crates. " + STYLE),
    'staking-logo': ('staking-page-mockup.jpg', (28, 88, 470, 282), '16:9',
                     "Recreate only this logo as a crisp, high-resolution graphic, centered on a plain, flat, solid "
                     "pure black background with nothing else in the image. Top line: the word 'SDOGE' in bold glossy "
                     "white-and-silver 3D letters with a thick dark navy outline and a blue edge glow, where the "
                     "letter O is a round badge showing a Shiba Inu doge face wearing a blue cap with a white USDC "
                     "dollar-sign logo and dark sunglasses. Second line: the word 'STAKING' in bold glossy gold 3D "
                     "letters with a dark brown outline. Spell both words exactly. Leave a clear gap between the two "
                     "lines. " + STYLE),
    'staking-chill': ('staking-page-mockup.jpg', (0, 1180, 1024, 1536), '21:9',
                      "Recreate this scene as a clean, high-resolution ultra-wide banner. Keep: on the left, the Shiba "
                      "Inu doge in a blue cap with a white USDC dollar-sign logo and blue sunglasses, hugging a big "
                      "glossy blue USDC coin, next to an open wooden treasure chest overflowing with blue USDC coins "
                      "and a dark wooden sign that reads exactly 'STAKE EARN CHILL' in white hand lettering; piles of "
                      "blue USDC coins; on the right, the big blue planet with the glowing violet-and-white Arc arch "
                      "rising from the moon ground and metal crates marked 'ARC'. REMOVE the 'FREQUENTLY ASKED "
                      "QUESTIONS' heading and all the question boxes in the middle and on the right, and repaint that "
                      "area as dark starry space above grey moon ground, dark enough for white text on top. No other "
                      "text anywhere. " + STYLE),
    'nft-hero': ('nft-page-mockup.jpg', (0, 58, 1024, 505), '21:9',
                 "Recreate this image as a clean, high-resolution website hero background. Keep the composition: on "
                 "the right, the big Shiba Inu doge (blue cap with a white USDC dollar-sign logo, small gold hoop "
                 "earring, glowing pixel-art sunglasses in blue, violet and pink, a toothpick in his grinning mouth, "
                 "a black crossbody bag with a pink strap and a white USDC logo) sitting in a huge pile of glossy "
                 "blue USDC coins; behind him on the far right a dark blue flag on a pole that reads 'SDOGE NFT' with "
                 "small crown doodles; the glowing violet Arc arch on the moon's surface; the full moon, palm trees "
                 "and night city silhouettes at the top, and the starry sky. REMOVE all website text and interface "
                 "elements on the left (the big 'SDOGE NFT' title, the slogan, the paragraph and both buttons) and "
                 "repaint that area as a natural continuation of the scene: starry night sky above moon rocks and "
                 "craters, slightly darker so white text placed there stays readable. No other text anywhere except "
                 "'SDOGE NFT' on the flag. " + STYLE),
    'nft-logo': ('nft-page-mockup.jpg', (28, 88, 420, 288), '16:9',
                 "Recreate only this logo as a crisp, high-resolution graphic, centered on a plain, flat, solid pure "
                 "black background with nothing else in the image. Top line: the word 'SDOGE' in bold glossy "
                 "white-and-silver 3D letters with a thick dark navy outline and a blue edge glow, where the letter O "
                 "is a round badge showing a Shiba Inu doge face wearing a blue cap with a white USDC dollar-sign "
                 "logo. Second line: the word 'NFT' in big bold glossy gold 3D letters with a dark brown outline. "
                 "Spell both words exactly. Leave a clear gap between the two lines. " + STYLE),
    'nft-rewards': ('nft-page-mockup.jpg', (0, 1255, 1024, 1536), '21:9',
                    "Recreate this scene as a clean, high-resolution ultra-wide banner. Keep: on the left, the Shiba "
                    "Inu doge in a blue cap with a white USDC dollar-sign logo and blue sunglasses, black hoodie with a "
                    "USDC logo, black cargo pants and white-and-blue sneakers, lounging back in a big glossy blue bean "
                    "bag chair with his feet up, holding a glowing blue USDC coin in one paw, a laptop with a USDC logo "
                    "on his lap; stacks of glossy blue USDC coins around him; behind him a night city with warm windows "
                    "and palm trees. REMOVE the 'HOLD COLLECT GET REWARDS' lettering, the crown, the four perk icons "
                    "and their texts and both buttons on the right, and repaint that area as a natural continuation of "
                    "the scene: dark night sky and dark city walls with a few coin stacks on the ground, dark enough "
                    "for white text on top. No text anywhere. " + STYLE),
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


def generate(name):
    mockup, box, aspect, prompt = JOBS[name]
    src = Image.open(os.path.join(HERE, 'ui-reference', mockup)).convert('RGB')
    t = time.time()
    try:
        img = post('image/edit', {'model': 'gpt-image-2-edit', 'image': png_b64(src.crop(box)),
                                  'prompt': prompt, 'aspect_ratio': aspect, 'resolution': '2K'})
        if name.endswith('-logo'):  # transparent background for logos
            img = post('image/background-remove', {'image': base64.b64encode(img).decode()})
        open(os.path.join(OUT, f'{name}.png'), 'wb').write(img)
        print(f'{name}: ok in {time.time() - t:.0f}s', flush=True)
    except urllib.error.HTTPError as e:
        print(f'{name}: HTTP {e.code} {e.read().decode()[:300]}', flush=True)


def webp(im, rel, q):
    path = os.path.join(IMG, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im.save(path, 'WEBP', quality=q, method=6)


def fit(im, w):
    return im.resize((w, round(w * im.height / im.width)), Image.LANCZOS)


def split_lines(logo):
    """The two lines of a two-line logo, split at the emptiest row near the middle."""
    alpha = logo.split()[3]
    w, h = logo.size
    rows = [sum(1 for x in range(0, w, 4) if alpha.getpixel((x, y)) > 40) for y in range(h)]
    lo, hi = int(h * 0.3), int(h * 0.7)
    cut = min(range(lo, hi), key=lambda y: rows[y])
    top, bottom = logo.crop((0, 0, w, cut)), logo.crop((0, cut, w, h))
    return top.crop(top.split()[3].getbbox()), bottom.crop(bottom.split()[3].getbbox())


def social_share(hero_png, logo_rel, out_rel):
    """Link preview (1200x630): the hero art's right side, with the page's logo on the left."""
    hero = Image.open(os.path.join(OUT, hero_png)).convert('RGB')
    hero = hero.resize((round(hero.width * 630 / hero.height), 630), Image.LANCZOS)
    og = hero.crop((hero.width - 1200, 0, hero.width, 630)).convert('RGBA')
    shade = Image.new('RGBA', (1200, 630)); d = ImageDraw.Draw(shade)
    for x in range(600):
        d.line([(x, 0), (x, 630)], fill=(4, 10, 24, int(210 * (1 - x / 600))))
    og.alpha_composite(shade)
    logo = Image.open(os.path.join(IMG, logo_rel)).convert('RGBA'); logo.thumbnail((560, 400))
    og.alpha_composite(logo, (40, (630 - logo.height) // 2 - 20))
    og.convert('RGB').save(os.path.join(IMG, out_rel), quality=85)


def convert(names):
    """2K PNGs -> the web files the pages load."""
    src = lambda n: Image.open(os.path.join(OUT, f'{n}.png'))  # noqa: E731
    if 'staking-hero' in names:
        webp(fit(src('staking-hero').convert('RGB'), 2000), 'staking/hero.webp', 78)
    if 'staking-logo' in names:
        logo = src('staking-logo').convert('RGBA')
        logo = logo.crop(logo.split()[3].getbbox())
        webp(fit(logo, 1100), 'staking/logo-staking.webp', 90)
        wordmark, _ = split_lines(logo)
        webp(fit(wordmark, 480), 'wordmark.webp', 90)  # the nav's SDOGE wordmark
    if 'staking-chill' in names:
        webp(fit(src('staking-chill').convert('RGB'), 2000), 'staking/chill.webp', 78)
    if 'staking-hero' in names or 'staking-logo' in names:
        social_share('staking-hero.png', 'staking/logo-staking.webp', 'staking/social-share.jpg')
    if 'nft-hero' in names:
        webp(fit(src('nft-hero').convert('RGB'), 2000), 'nft/hero.webp', 78)
    if 'nft-logo' in names:
        logo = src('nft-logo').convert('RGBA')
        webp(fit(logo.crop(logo.split()[3].getbbox()), 900), 'nft/logo-nft.webp', 90)
    if 'nft-rewards' in names:
        webp(fit(src('nft-rewards').convert('RGB'), 2000), 'nft/rewards.webp', 78)
    if 'nft-hero' in names or 'nft-logo' in names:
        social_share('nft-hero.png', 'nft/logo-nft.webp', 'nft/social-share.jpg')


if __name__ == '__main__':
    names = sys.argv[1:] or list(JOBS)
    if os.environ.get('CONVERT_ONLY') != '1':
        if not KEY:
            sys.exit('set VENICE_API_KEY')
        os.makedirs(OUT, exist_ok=True)
        threads = [threading.Thread(target=generate, args=(n,)) for n in names]
        for th in threads: th.start()
        for th in threads: th.join()
    convert([n for n in names if os.path.exists(os.path.join(OUT, f'{n}.png'))])
    print('done; check the files in assets/img/ before committing')
