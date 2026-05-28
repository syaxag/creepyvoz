document.addEventListener('DOMContentLoaded', () => {
    // Referencias de elementos DOM
    const textInput = document.getElementById('text-input');
    const charCount = document.getElementById('char-count');
    const btnClear = document.getElementById('btn-clear');
    
    const btnDictate = document.getElementById('btn-dictate');
    const dictationStatus = document.getElementById('dictation-status');
    const voiceSelect = document.getElementById('voice-select');
    
    const btnSynthesize = document.getElementById('btn-synthesize');
    
    const playerContainer = document.getElementById('player-container');
    const playingVoiceInfo = document.getElementById('playing-voice-info');
    const btnDownload = document.getElementById('btn-download');
    const waveContainer = document.querySelector('.wave-container');
    
    const btnPlayPause = document.getElementById('btn-play-pause');
    const progressBar = document.getElementById('progress-bar');
    const progressFill = document.getElementById('progress-fill');
    const currentTimeEl = document.getElementById('current-time');
    const durationTimeEl = document.getElementById('duration-time');
    const audioElement = document.getElementById('audio-element');

    // Límite de caracteres (debe coincidir con MAX_TEXT_LENGTH del backend)
    const MAX_TEXT_LENGTH = 3000;

    // Variables de estado
    let recognition = null;
    let isRecording = false;      // ¿El usuario quiere estar dictando ahora mismo?
    let manualStop = false;       // ¿La parada la pidió el usuario (no una pausa)?
    let baseText = '';            // Texto que había en la caja antes de empezar a dictar
    let finalText = '';           // Texto ya confirmado durante esta sesión de dictado
    let currentObjectUrl = null;
    let currentDownloadName = 'loquendo.mp3';
    let isPlaying = false;

    // --- 1. RECONOCIMIENTO DE VOZ (Speech-to-Text) ---
    const setDictationUI = (recording) => {
        btnDictate.classList.toggle('recording', recording);
        dictationStatus.classList.toggle('active', recording);
        dictationStatus.textContent = recording
            ? 'Escuchando... Háblale al micrófono'
            : 'Micrófono inactivo';
    };

    const initSpeechRecognition = () => {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            dictationStatus.textContent = 'Dictado no soportado por tu navegador (usa Chrome)';
            btnDictate.disabled = true;
            btnDictate.title = 'El dictado por voz requiere Google Chrome o Microsoft Edge';
            return false;
        }

        recognition = new SpeechRecognition();
        recognition.lang = 'es-ES'; // Español
        recognition.continuous = true; // Seguir escuchando entre frases
        recognition.interimResults = true; // Mostrar resultados parciales en vivo

        recognition.onstart = () => {
            setDictationUI(true);
        };

        // Chrome corta el reconocimiento tras una pausa de silencio aunque
        // continuous=true. Si el usuario no ha pulsado "parar", reanudamos
        // automáticamente para que el dictado se sienta ininterrumpido.
        recognition.onend = () => {
            if (manualStop || !isRecording) {
                isRecording = false;
                setDictationUI(false);
                return;
            }
            try {
                recognition.start();
            } catch (e) {
                // Si falla el reinicio inmediato, reintenta una vez tras un instante.
                setTimeout(() => {
                    if (isRecording && !manualStop) {
                        try { recognition.start(); } catch (_) { /* se ignora */ }
                    }
                }, 250);
            }
        };

        recognition.onerror = (event) => {
            console.error('Error de reconocimiento:', event.error);
            // Errores que terminan definitivamente la sesión
            if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
                manualStop = true;
                isRecording = false;
                dictationStatus.textContent = 'Permiso de micrófono denegado. Actívalo en el navegador.';
                dictationStatus.classList.remove('active');
                btnDictate.classList.remove('recording');
                return;
            }
            // 'no-speech', 'aborted', 'network' son recuperables: onend reanudará.
        };

        recognition.onresult = (event) => {
            let interim = '';
            for (let i = event.resultIndex; i < event.results.length; ++i) {
                const transcript = event.results[i][0].transcript;
                if (event.results[i].isFinal) {
                    finalText += transcript.trim() + ' ';
                } else {
                    interim += transcript;
                }
            }

            const dictated = (finalText + interim).replace(/\s+/g, ' ').trim();
            const separator = baseText && dictated ? ' ' : '';
            textInput.value = baseText + separator + dictated;
            updateCharCount();
        };

        btnDictate.addEventListener('click', () => {
            if (isRecording) {
                // El usuario para el dictado
                manualStop = true;
                isRecording = false;
                recognition.stop();
                setDictationUI(false);
            } else {
                // El usuario empieza a dictar: arranca desde el texto actual
                manualStop = false;
                isRecording = true;
                baseText = textInput.value.trim();
                finalText = '';
                try {
                    recognition.start();
                } catch (e) {
                    // Si ya estaba activo por una parada lenta, lo reiniciamos limpio.
                    recognition.stop();
                    setTimeout(() => { try { recognition.start(); } catch (_) {} }, 250);
                }
            }
        });

        return true;
    };

    const hasRecognition = initSpeechRecognition();

    // --- 2. MANEJO DE TEXTO ---
    const updateCharCount = () => {
        if (textInput.value.length > MAX_TEXT_LENGTH) {
            textInput.value = textInput.value.slice(0, MAX_TEXT_LENGTH);
        }
        const count = textInput.value.length;
        charCount.textContent = count;
        charCount.parentElement.classList.toggle('limit-reached', count >= MAX_TEXT_LENGTH);
    };

    textInput.setAttribute('maxlength', String(MAX_TEXT_LENGTH));
    textInput.addEventListener('input', updateCharCount);

    btnClear.addEventListener('click', () => {
        textInput.value = '';
        updateCharCount();
        textInput.focus();
    });

    // --- 3. SÍNTESIS DE VOZ (Text-to-Speech) ---
    btnSynthesize.addEventListener('click', async () => {
        const text = textInput.value.trim();
        const voice = voiceSelect.value;

        if (!text) {
            alert('Por favor, escribe o dicta algún texto primero.');
            return;
        }

        // Mostrar estado cargando en el botón
        btnSynthesize.disabled = true;
        const originalContent = btnSynthesize.innerHTML;
        btnSynthesize.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sintetizando...';

        try {
            const response = await fetch('/api/tts', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ text, voice })
            });

            const contentType = response.headers.get('Content-Type') || '';

            // En caso de error el backend responde JSON; en éxito responde audio/mpeg.
            if (!response.ok || !contentType.includes('audio')) {
                let message = 'Error al sintetizar el audio.';
                try {
                    const errdata = await response.json();
                    message = errdata.error || message;
                } catch (e) { /* respuesta no-JSON */ }
                throw new Error(message);
            }

            // Recibir el audio como blob y crear una URL en memoria
            const blob = await response.blob();
            if (currentObjectUrl) {
                URL.revokeObjectURL(currentObjectUrl);
            }
            currentObjectUrl = URL.createObjectURL(blob);
            currentDownloadName = response.headers.get('X-Audio-Filename') || 'loquendo.mp3';

            // Cargar en el elemento de audio
            audioElement.src = currentObjectUrl;
            audioElement.load();

            // Mostrar el reproductor
            playerContainer.classList.remove('disabled');
            playingVoiceInfo.textContent = `Voz: ${voice}`;
            btnDownload.disabled = false;

            // Auto-reproducir
            playAudio();

        } catch (error) {
            console.error(error);
            alert(`Error: ${error.message}`);
        } finally {
            // Restaurar botón de síntesis
            btnSynthesize.disabled = false;
            btnSynthesize.innerHTML = originalContent;
        }
    });

    // --- 4. REPRODUCTOR DE AUDIO ---
    const playAudio = () => {
        audioElement.play()
            .then(() => {
                isPlaying = true;
                btnPlayPause.innerHTML = '<i class="fa-solid fa-pause"></i>';
                waveContainer.classList.add('playing');
                animateWaves();
            })
            .catch(error => {
                console.error('Error al reproducir audio:', error);
            });
    };

    const pauseAudio = () => {
        audioElement.pause();
        isPlaying = false;
        btnPlayPause.innerHTML = '<i class="fa-solid fa-play"></i>';
        waveContainer.classList.remove('playing');
        resetWaves();
    };

    btnPlayPause.addEventListener('click', () => {
        if (isPlaying) {
            pauseAudio();
        } else {
            if (audioElement.src) {
                playAudio();
            }
        }
    });

    // Actualizar progreso
    audioElement.addEventListener('timeupdate', () => {
        if (audioElement.duration) {
            const percentage = (audioElement.currentTime / audioElement.duration) * 100;
            progressFill.style.width = `${percentage}%`;
            
            currentTimeEl.textContent = formatTime(audioElement.currentTime);
            durationTimeEl.textContent = formatTime(audioElement.duration);
        }
    });

    // Cargar metadatos
    audioElement.addEventListener('loadedmetadata', () => {
        durationTimeEl.textContent = formatTime(audioElement.duration);
        currentTimeEl.textContent = formatTime(0);
        progressFill.style.width = '0%';
    });

    // Cuando termina el audio
    audioElement.addEventListener('ended', () => {
        pauseAudio();
        progressFill.style.width = '100%';
        currentTimeEl.textContent = formatTime(audioElement.duration);
    });

    // Barra de progreso interactiva (Scrubbing)
    progressBar.addEventListener('click', (e) => {
        if (!audioElement.src || !audioElement.duration) return;
        
        const rect = progressBar.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const width = rect.width;
        
        const clickPercentage = clickX / width;
        const newTime = clickPercentage * audioElement.duration;
        
        audioElement.currentTime = newTime;
    });

    // Formateador de tiempo (MM:SS)
    const formatTime = (timeInSeconds) => {
        if (isNaN(timeInSeconds)) return '00:00';
        const minutes = Math.floor(timeInSeconds / 60);
        const seconds = Math.floor(timeInSeconds % 60);
        return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    };

    // --- 5. ANIMACIÓN DE ONDAS ---
    const waveBars = document.querySelectorAll('.wave-bar');
    
    const animateWaves = () => {
        if (!isPlaying) return;
        
        waveBars.forEach(bar => {
            const randomHeight = Math.floor(Math.random() * 32) + 10;
            bar.style.height = `${randomHeight}px`;
        });
        
        setTimeout(animateWaves, 100);
    };

    const resetWaves = () => {
        waveBars.forEach(bar => {
            bar.style.height = '10px';
        });
    };

    // --- 6. GESTIÓN DE DESCARGAS ---
    btnDownload.addEventListener('click', () => {
        if (!currentObjectUrl) return;

        const link = document.createElement('a');
        link.href = currentObjectUrl;
        link.download = currentDownloadName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    });
});
