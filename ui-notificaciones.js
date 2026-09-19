/**
 * ui-notificaciones.js
 * ---------------------------------------------------------------------------
 * Reemplazo ligero (sin dependencias) para alert()/confirm() nativos.
 *
 * Por qué existe:
 *  - alert()/confirm() nativos congelan TODA la pestaña mientras están abiertos,
 *    incluyendo los setInterval que refrescan Cocina/Barra/Mesas. En un
 *    restaurante con varias pantallas eso se siente como "el sistema se
 *    trabó", cuando en realidad solo hay un cuadro de diálogo del navegador
 *    esperando que alguien lo cierre.
 *  - Son feos, no combinan con la marca, y en tablets el texto queda diminuto.
 *
 * Uso:
 *    Toast.show("✅ Guardado con éxito");         // notificación flotante, se auto-cierra
 *    Toast.show("Algo falló", "error");            // tipo explícito: success | error | warning | info
 *    const ok = await Toast.confirm("¿Seguro?");    // modal bloqueante-pero-bonito, resuelve true/false
 *
 * Si no se indica el tipo en Toast.show(), se detecta automáticamente por el
 * emoji con el que ya arrancan la mayoría de los mensajes existentes
 * (✅ = success, ⚠️/❌/🔒 = warning/error), para no tener que tocar cada
 * llamada del código existente.
 */
(function () {
    'use strict';

    const ESTILOS = `
        #tk-toast-stack {
            position: fixed;
            top: 0.75rem;
            left: 50%;
            transform: translateX(-50%);
            z-index: 300;
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
            width: min(92vw, 420px);
            pointer-events: none;
        }
        .tk-toast {
            pointer-events: auto;
            display: flex;
            align-items: flex-start;
            gap: 0.65rem;
            background: rgba(255,255,255,0.98);
            backdrop-filter: blur(6px);
            border-radius: 1rem;
            box-shadow: 0 10px 30px -8px rgba(0,0,0,0.35), 0 2px 6px rgba(0,0,0,0.08);
            padding: 0.9rem 1rem;
            border-left: 6px solid #10b981;
            animation: tk-toast-in 0.22s cubic-bezier(.2,.9,.3,1.2);
            cursor: pointer;
        }
        .tk-toast.tk-leaving { animation: tk-toast-out 0.18s ease-in forwards; }
        .tk-toast[data-tipo="error"]   { border-left-color: #dc2626; }
        .tk-toast[data-tipo="warning"] { border-left-color: #f59e0b; }
        .tk-toast[data-tipo="info"]    { border-left-color: #0e7490; }
        .tk-toast[data-tipo="success"] { border-left-color: #10b981; }
        .tk-toast-icono {
            font-size: 1.35rem;
            line-height: 1;
            flex-shrink: 0;
            margin-top: 0.1rem;
        }
        .tk-toast-texto {
            font-size: 0.8rem;
            font-weight: 700;
            color: #1f2937;
            white-space: pre-line;
            line-height: 1.35;
        }
        .tk-toast-cerrar {
            margin-left: auto;
            flex-shrink: 0;
            color: #9ca3af;
            font-weight: 900;
            font-size: 0.9rem;
            padding: 0 0.15rem;
        }
        @keyframes tk-toast-in {
            from { opacity: 0; transform: translateY(-14px) scale(0.97); }
            to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes tk-toast-out {
            from { opacity: 1; transform: translateY(0) scale(1); max-height: 200px; margin-bottom: 0; }
            to   { opacity: 0; transform: translateY(-8px) scale(0.97); max-height: 0; margin-bottom: -0.5rem; }
        }

        #tk-confirm-overlay {
            position: fixed;
            inset: 0;
            z-index: 310;
            background: rgba(15, 23, 42, 0.55);
            backdrop-filter: blur(2px);
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 1.25rem;
            animation: tk-fade-in 0.15s ease-out;
        }
        @keyframes tk-fade-in { from { opacity: 0; } to { opacity: 1; } }
        .tk-confirm-box {
            width: 100%;
            max-width: 380px;
            background: white;
            border-radius: 1.5rem;
            box-shadow: 0 25px 50px -12px rgba(0,0,0,0.4);
            overflow: hidden;
            border-top: 6px solid #f97316;
            animation: tk-pop-in 0.2s cubic-bezier(.2,.9,.3,1.2);
        }
        .tk-confirm-box[data-tono="peligro"] { border-top-color: #dc2626; }
        @keyframes tk-pop-in {
            from { opacity: 0; transform: scale(0.92) translateY(8px); }
            to   { opacity: 1; transform: scale(1) translateY(0); }
        }
        .tk-confirm-icono {
            font-size: 2rem;
            text-align: center;
            padding-top: 1.4rem;
        }
        .tk-confirm-texto {
            padding: 0.5rem 1.5rem 1.5rem;
            text-align: center;
            font-size: 0.85rem;
            font-weight: 700;
            color: #1f2937;
            white-space: pre-line;
            line-height: 1.45;
        }
        .tk-confirm-botones {
            display: flex;
            border-top: 1px solid #e5e7eb;
        }
        .tk-confirm-btn {
            flex: 1;
            padding: 1.1rem 0.5rem;
            font-size: 0.75rem;
            font-weight: 900;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            border: none;
            background: white;
            transition: background-color 0.15s;
        }
        .tk-confirm-btn:active { transform: scale(0.97); }
        .tk-confirm-btn-cancelar {
            color: #64748b;
            border-right: 1px solid #e5e7eb;
        }
        .tk-confirm-btn-cancelar:hover { background: #f8fafc; }
        .tk-confirm-btn-aceptar {
            color: #fff;
            background: #f97316;
        }
        .tk-confirm-btn-aceptar:hover { background: #ea580c; }
        .tk-confirm-box[data-tono="peligro"] .tk-confirm-btn-aceptar {
            background: #dc2626;
        }
        .tk-confirm-box[data-tono="peligro"] .tk-confirm-btn-aceptar:hover {
            background: #b91c1c;
        }

        .tk-prompt-input {
            display: block;
            width: calc(100% - 3rem);
            margin: 0 auto 0.25rem;
            padding: 0.9rem 1rem;
            border-radius: 0.85rem;
            border: 2px solid #e5e7eb;
            font-size: 1rem;
            font-weight: 800;
            color: #1f2937;
            text-align: center;
            outline: none;
            letter-spacing: 0.02em;
        }
        .tk-prompt-input:focus { border-color: #f97316; }

        .tk-choice-botones {
            display: flex;
            flex-direction: column;
            gap: 0.6rem;
            padding: 0.25rem 1.5rem 1.25rem;
        }
        .tk-choice-btn {
            width: 100%;
            padding: 1rem 0.75rem;
            border-radius: 1rem;
            border: none;
            font-size: 0.8rem;
            font-weight: 900;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            color: white;
            background: #0e7490;
            transition: filter 0.15s;
        }
        .tk-choice-btn:active { transform: scale(0.97); }
        .tk-choice-btn:hover { filter: brightness(1.08); }
        .tk-choice-btn[data-tono="principal"] { background: #f97316; }
        .tk-choice-btn[data-tono="peligro"] { background: #dc2626; }
        .tk-choice-cancelar {
            display: block;
            width: 100%;
            padding: 0.9rem;
            border: none;
            border-top: 1px solid #e5e7eb;
            background: white;
            color: #64748b;
            font-weight: 900;
            font-size: 0.72rem;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }
        .tk-choice-cancelar:hover { background: #f8fafc; }
    `;

    function inyectarEstilosYContenedor() {
        if (document.getElementById('tk-toast-styles')) return;
        const style = document.createElement('style');
        style.id = 'tk-toast-styles';
        style.textContent = ESTILOS;
        document.head.appendChild(style);

        const stack = document.createElement('div');
        stack.id = 'tk-toast-stack';
        document.body.appendChild(stack);
    }

    function detectarTipo(mensaje) {
        const m = (mensaje || '').trim();
        if (m.startsWith('✅')) return 'success';
        if (m.startsWith('❌') || m.startsWith('⚠️') || m.startsWith('🔒')) return 'warning';
        if (/error|fallo|falló|no se pudo|rechazad/i.test(m)) return 'error';
        if (/éxito|exitosamente|con éxito|correctamente|actualizado|guardad/i.test(m)) return 'success';
        return 'info';
    }

    const ICONOS = {
        success: '✅',
        error: '⛔',
        warning: '⚠️',
        info: 'ℹ️'
    };

    const DURACION = {
        success: 3200,
        info: 3800,
        warning: 5500,
        error: 6500
    };

    function show(mensaje, tipo) {
        inyectarEstilosYContenedor();
        const tipoFinal = tipo || detectarTipo(mensaje);
        const stack = document.getElementById('tk-toast-stack');

        const toast = document.createElement('div');
        toast.className = 'tk-toast';
        toast.dataset.tipo = tipoFinal;
        toast.innerHTML = `
            <span class="tk-toast-icono">${ICONOS[tipoFinal] || ICONOS.info}</span>
            <span class="tk-toast-texto"></span>
            <span class="tk-toast-cerrar">✕</span>
        `;
        toast.querySelector('.tk-toast-texto').textContent = mensaje;

        const cerrar = () => {
            if (toast.dataset.cerrando) return;
            toast.dataset.cerrando = '1';
            toast.classList.add('tk-leaving');
            setTimeout(() => toast.remove(), 180);
        };
        toast.addEventListener('click', cerrar);

        stack.appendChild(toast);
        setTimeout(cerrar, DURACION[tipoFinal] || 4000);
        return toast;
    }

    function confirmar(mensaje, opciones) {
        opciones = opciones || {};
        inyectarEstilosYContenedor();

        const esPeligro = opciones.peligro !== undefined
            ? opciones.peligro
            : /⚠️|❌|eliminar|borrar|liberad|vaciar|cerrar la jornada|purgar/i.test(mensaje);

        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.id = 'tk-confirm-overlay';
            overlay.innerHTML = `
                <div class="tk-confirm-box" data-tono="${esPeligro ? 'peligro' : 'normal'}">
                    <div class="tk-confirm-icono">${esPeligro ? '⚠️' : '🤔'}</div>
                    <div class="tk-confirm-texto"></div>
                    <div class="tk-confirm-botones">
                        <button class="tk-confirm-btn tk-confirm-btn-cancelar" type="button">${opciones.textoCancelar || 'Cancelar'}</button>
                        <button class="tk-confirm-btn tk-confirm-btn-aceptar" type="button">${opciones.textoAceptar || 'Confirmar'}</button>
                    </div>
                </div>
            `;
            overlay.querySelector('.tk-confirm-texto').textContent = mensaje;

            const finalizar = (resultado) => {
                overlay.remove();
                resolve(resultado);
            };

            overlay.querySelector('.tk-confirm-btn-cancelar').addEventListener('click', () => finalizar(false));
            overlay.querySelector('.tk-confirm-btn-aceptar').addEventListener('click', () => finalizar(true));

            document.body.appendChild(overlay);
        });
    }

    function promptTexto(mensaje, opciones) {
        opciones = opciones || {};
        inyectarEstilosYContenedor();

        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.id = 'tk-confirm-overlay';
            overlay.innerHTML = `
                <div class="tk-confirm-box" data-tono="normal">
                    <div class="tk-confirm-icono">${opciones.icono || '✏️'}</div>
                    <div class="tk-confirm-texto"></div>
                    <input class="tk-prompt-input" type="${opciones.tipo || 'text'}"
                        ${opciones.numerico ? 'inputmode="numeric" pattern="[0-9]*"' : ''}
                        placeholder="${(opciones.placeholder || '').replace(/"/g, '&quot;')}">
                    <div class="tk-confirm-botones">
                        <button class="tk-confirm-btn tk-confirm-btn-cancelar" type="button">${opciones.textoCancelar || 'Cancelar'}</button>
                        <button class="tk-confirm-btn tk-confirm-btn-aceptar" type="button">${opciones.textoAceptar || 'Aceptar'}</button>
                    </div>
                </div>
            `;
            overlay.querySelector('.tk-confirm-texto').textContent = mensaje;

            const input = overlay.querySelector('.tk-prompt-input');
            input.value = opciones.valorPorDefecto || '';

            const finalizar = (resultado) => {
                overlay.remove();
                resolve(resultado);
            };

            overlay.querySelector('.tk-confirm-btn-cancelar').addEventListener('click', () => finalizar(null));
            overlay.querySelector('.tk-confirm-btn-aceptar').addEventListener('click', () => finalizar(input.value));
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); finalizar(input.value); }
                if (e.key === 'Escape') finalizar(null);
            });

            document.body.appendChild(overlay);
            setTimeout(() => { input.focus(); input.select(); }, 60);
        });
    }

    function elegir(mensaje, botones) {
        inyectarEstilosYContenedor();

        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.id = 'tk-confirm-overlay';

            const botonesHtml = botones.map((b, idx) =>
                `<button class="tk-choice-btn" data-idx="${idx}" data-tono="${b.tono || 'normal'}"></button>`
            ).join('');

            overlay.innerHTML = `
                <div class="tk-confirm-box" data-tono="normal">
                    <div class="tk-confirm-icono">🗂️</div>
                    <div class="tk-confirm-texto"></div>
                    <div class="tk-choice-botones">${botonesHtml}</div>
                    <button class="tk-choice-cancelar" type="button">Cancelar</button>
                </div>
            `;
            overlay.querySelector('.tk-confirm-texto').textContent = mensaje;

            const finalizar = (resultado) => {
                overlay.remove();
                resolve(resultado);
            };

            overlay.querySelectorAll('.tk-choice-btn').forEach((btnEl, idx) => {
                btnEl.textContent = botones[idx].texto;
                btnEl.addEventListener('click', () => finalizar(botones[idx].valor));
            });
            overlay.querySelector('.tk-choice-cancelar').addEventListener('click', () => finalizar(null));

            document.body.appendChild(overlay);
        });
    }

    window.Toast = { show, confirm: confirmar, prompt: promptTexto, choice: elegir };
})();