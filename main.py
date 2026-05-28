import os
import time
import hashlib
import threading
import webbrowser
from collections import OrderedDict, defaultdict, deque
from urllib.parse import quote_plus

import requests
from flask import Flask, request, jsonify, render_template, Response

app = Flask(__name__, template_folder='templates', static_folder='static')

# --- Configuración ---
MAX_TEXT_LENGTH = 3000          # Límite de caracteres por petición
RATE_LIMIT_REQUESTS = 20        # Peticiones permitidas por IP...
RATE_LIMIT_WINDOW = 60          # ...en esta ventana de segundos
CACHE_MAX_ENTRIES = 128         # Audios cacheados en memoria (LRU)
EXTERNAL_TIMEOUT = 15           # Timeout (s) hacia los servicios de voz

# El ID de editor de AdSense y el correo de contacto se leen del entorno del host.
# El ID de editor NO es secreto (aparece en el HTML de cualquier web con anuncios).
ADSENSE_PUBLISHER_ID = os.environ.get('ADSENSE_PUBLISHER_ID', 'ca-pub-9765854686059650').strip()
CONTACT_EMAIL = os.environ.get('CONTACT_EMAIL', 'gnosixio@gmail.com').strip()
SITE_NAME = 'CreepyVoz'

# IDs de los bloques de anuncio (se obtienen en AdSense DESPUÉS de la aprobación).
# Mientras estén vacíos, no se muestran unidades de anuncio (solo el script de conexión).
AD_SLOT_TOP = os.environ.get('AD_SLOT_TOP', '').strip()
AD_SLOT_BOTTOM = os.environ.get('AD_SLOT_BOTTOM', '').strip()

# Voces oficiales de Loquendo (vía caché de Oddcast) y voces auxiliares (Polly/ttsmp3).
LOQUENDO_VOICES = {'Jorge': 6, 'Leonor': 9, 'Carmen': 1}
POLLY_VOICES = {'Miguel', 'Enrique', 'Conchita', 'Mia', 'Penelope', 'Lupe'}

REQUEST_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
}

# --- Caché LRU en memoria (clave -> bytes de audio) ---
_cache = OrderedDict()
_cache_lock = threading.Lock()


def cache_get(key):
    with _cache_lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
    return None


def cache_put(key, value):
    with _cache_lock:
        _cache[key] = value
        _cache.move_to_end(key)
        while len(_cache) > CACHE_MAX_ENTRIES:
            _cache.popitem(last=False)


# --- Límite de peticiones por IP (ventana deslizante en memoria) ---
_hits = defaultdict(deque)
_hits_lock = threading.Lock()


def is_rate_limited(ip):
    now = time.time()
    with _hits_lock:
        dq = _hits[ip]
        while dq and now - dq[0] > RATE_LIMIT_WINDOW:
            dq.popleft()
        if len(dq) >= RATE_LIMIT_REQUESTS:
            return True
        dq.append(now)
        if len(_hits) > 10000:
            for k in [k for k, v in _hits.items() if not v]:
                del _hits[k]
        return False


def client_ip():
    fwd = request.headers.get('X-Forwarded-For', '')
    if fwd:
        return fwd.split(',')[0].strip()
    return request.remote_addr or 'unknown'


# --- Síntesis de voz ---
def split_text_into_chunks(text, max_chars=280):
    """Divide el texto en fragmentos para no superar el límite de la API de Oddcast."""
    words = text.split()
    chunks = []
    current_chunk = []
    current_length = 0

    for word in words:
        added_length = len(word) + (1 if current_chunk else 0)
        if current_length + added_length > max_chars:
            if current_chunk:
                chunks.append(" ".join(current_chunk))
            current_chunk = [word]
            current_length = len(word)
        else:
            current_chunk.append(word)
            current_length += added_length

    if current_chunk:
        chunks.append(" ".join(current_chunk))

    return chunks


def generate_official_loquendo(text, voice_id):
    """Voz oficial de Loquendo mediante el caché de Oddcast."""
    engine = 2
    language = 2  # Español
    combined_audio = b""

    for chunk in split_text_into_chunks(text, max_chars=280):
        fragments = [
            f"<engineID>{engine}</engineID>",
            f"<voiceID>{voice_id}</voiceID>",
            f"<langID>{language}</langID>",
            "",  # FX vacío
            "<ext>mp3</ext>",
            chunk,
        ]
        h = hashlib.md5(''.join(fragments).encode('utf-8')).hexdigest()
        url = (
            f"http://cache-a.oddcast.com/c_fs/{h}.mp3"
            f"?engine={engine}&language={language}&voice={voice_id}"
            f"&text={quote_plus(chunk)}&useUTF8=1"
        )
        response = requests.get(url, headers=REQUEST_HEADERS, timeout=EXTERNAL_TIMEOUT)
        if response.status_code != 200 or not response.content:
            raise RuntimeError(f"No se pudo sintetizar un fragmento (código {response.status_code}).")
        combined_audio += response.content

    return combined_audio


def generate_polly_voice(text, voice_name):
    """Voz auxiliar (Amazon Polly) mediante ttsmp3.com."""
    payload = {"msg": text, "lang": voice_name, "source": "ttsmp3"}
    response = requests.post(
        "https://ttsmp3.com/makemp3.php", data=payload, timeout=EXTERNAL_TIMEOUT
    )
    if response.status_code != 200:
        raise RuntimeError(f"Error en ttsmp3.com (código {response.status_code}).")

    result = response.json()
    if result.get("Error") != 0 or result.get("success") != 1:
        raise RuntimeError(result.get("description", "Error desconocido de ttsmp3.com."))

    mp3_url = result.get("URL")
    audio_response = requests.get(mp3_url, headers=REQUEST_HEADERS, timeout=EXTERNAL_TIMEOUT)
    if audio_response.status_code != 200 or not audio_response.content:
        raise RuntimeError("No se pudo descargar el audio de ttsmp3.com.")

    return audio_response.content


# --- Contexto compartido con las plantillas ---
@app.context_processor
def inject_globals():
    return {
        "adsense_id": ADSENSE_PUBLISHER_ID,
        "ad_slot_top": AD_SLOT_TOP,
        "ad_slot_bottom": AD_SLOT_BOTTOM,
        "contact_email": CONTACT_EMAIL,
        "site_name": SITE_NAME,
        "max_text_length": MAX_TEXT_LENGTH,
    }


# --- Rutas ---
@app.route('/')
def index():
    return render_template('index.html')


@app.route('/privacidad')
def privacy():
    return render_template('privacy.html')


@app.route('/api/tts', methods=['POST'])
def tts_handler():
    if is_rate_limited(client_ip()):
        return jsonify({
            "success": False,
            "error": "Has hecho demasiadas peticiones. Espera unos segundos e inténtalo de nuevo."
        }), 429

    data = request.get_json(silent=True)
    if not data:
        return jsonify({"success": False, "error": "Faltan datos en la petición."}), 400

    text = (data.get('text') or '').strip()
    voice = (data.get('voice') or 'Jorge').strip()

    if not text:
        return jsonify({"success": False, "error": "El texto está vacío."}), 400
    if len(text) > MAX_TEXT_LENGTH:
        return jsonify({
            "success": False,
            "error": f"El texto supera el límite de {MAX_TEXT_LENGTH} caracteres."
        }), 400
    if voice not in LOQUENDO_VOICES and voice not in POLLY_VOICES:
        return jsonify({"success": False, "error": "La voz seleccionada no es válida."}), 400

    key = hashlib.md5((voice + '|' + text).encode('utf-8')).hexdigest()
    audio = cache_get(key)

    if audio is None:
        try:
            if voice in LOQUENDO_VOICES:
                audio = generate_official_loquendo(text, LOQUENDO_VOICES[voice])
            else:
                audio = generate_polly_voice(text, voice)
        except requests.RequestException:
            return jsonify({
                "success": False,
                "error": "El servicio de voz no responde ahora mismo. Inténtalo de nuevo en un momento."
            }), 502
        except Exception as e:
            return jsonify({"success": False, "error": f"No se pudo generar el audio: {e}"}), 500

        if not audio:
            return jsonify({"success": False, "error": "El servicio de voz devolvió un audio vacío."}), 502

        cache_put(key, audio)

    download_name = f"loquendo_{voice}_{key[:8]}.mp3"
    return Response(audio, mimetype='audio/mpeg', headers={
        'Content-Disposition': f'inline; filename="{download_name}"',
        'X-Audio-Filename': download_name,
        'Cache-Control': 'public, max-age=86400',
    })


@app.route('/health')
def health():
    return "ok", 200


@app.route('/ads.txt')
def ads_txt():
    if ADSENSE_PUBLISHER_ID:
        pub = ADSENSE_PUBLISHER_ID.replace('ca-pub-', 'pub-')
        if not pub.startswith('pub-'):
            pub = f"pub-{pub}"
        content = f"google.com, {pub}, DIRECT, f08c47fec0942fa0\n"
    else:
        content = "# Define ADSENSE_PUBLISHER_ID en el host para activar ads.txt de Google AdSense.\n"
    return Response(content, mimetype='text/plain')


@app.route('/robots.txt')
def robots_txt():
    content = (
        "User-agent: *\n"
        "Allow: /\n"
        f"Sitemap: {request.url_root}sitemap.xml\n"
    )
    return Response(content, mimetype='text/plain')


@app.route('/sitemap.xml')
def sitemap_xml():
    base = request.url_root.rstrip('/')
    content = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        f'  <url><loc>{base}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>\n'
        f'  <url><loc>{base}/privacidad</loc><changefreq>yearly</changefreq><priority>0.3</priority></url>\n'
        '</urlset>\n'
    )
    return Response(content, mimetype='application/xml')


def open_browser():
    time.sleep(1.5)
    webbrowser.open("http://127.0.0.1:5000")


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    host = os.environ.get('HOST', '127.0.0.1')

    if host == '127.0.0.1':
        threading.Thread(target=open_browser, daemon=True).start()

    print("*" * 60)
    print(f"  Iniciando {SITE_NAME} - Sintetizador Loquendo TTS")
    print(f"  Ejecutándose en: http://{host}:{port}")
    print("*" * 60)

    app.run(host=host, port=port, debug=False)
