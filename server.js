const express = require('express');
const cors = require('cors');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const { Jimp } = require('jimp');

const os = require('os');
const fs = require('fs');
const path = require('path');
const util = require('util');
const { exec } = require('child_process');
const execAsync = util.promisify(exec);

const app = express();
app.use(cors());
app.use(express.json());

// Cache de estáticos: las imágenes/logo/tailwind casi nunca cambian, que el navegador
// no tenga que volver a pedirlos cada segundo (ayuda mucho con WiFi inestable).
// Los .html y config.js se excluyen del cache largo porque sí cambian.
app.use(express.static('.', {
    etag: true,
    setHeaders: (res, rutaArchivo) => {
        const ext = path.extname(rutaArchivo).toLowerCase();
        if (ext === '.html' || rutaArchivo.endsWith('config.js')) {
            res.setHeader('Cache-Control', 'no-cache');
        } else {
            res.setHeader('Cache-Control', 'public, max-age=86400'); // 1 día
        }
    }
}));

let ipLocalReal = 'localhost';
const interfaces = os.networkInterfaces();

const ThermalPrinter = require("node-thermal-printer").printer;
const PrinterTypes = require("node-thermal-printer").types;

// Nombre de la impresora de tickets tal como aparece en Windows (Panel de Control > Impresoras)
const NOMBRE_IMPRESORA_TICKETS = "POS-800";
// Si la impresora no responde en este tiempo (apagada, desconectada, sin papel, offline en
// Windows), se cancela el intento en vez de dejarlo esperando para siempre y trabando la
// fila de impresión para el resto del turno.
const TIMEOUT_IMPRESION_MS = 10000;
const RUTA_LOGO_TICKET = path.join(__dirname, 'resources', 'Tuka-ticket-nava.png');
const IMPRIMIR_LOGO_EN_TICKET = true;

// Tu impresora es de 80mm; la mayoría de estos modelos tienen un cabezal de 576 puntos por
// línea, pero dejamos margen de sobra (384) porque tu logo original venía más ancho de lo
// que el cabezal puede imprimir de un jalón — eso era lo que desincronizaba el comando de
// imagen y hacía que la impresora leyera los bytes de la imagen como si fueran texto.
const ANCHO_MAXIMO_LOGO_PX = 384;

// ---------------------------------------------------------------------------------------
// LOGO DEL TICKET: se re-escala UNA SOLA VEZ al arrancar el servidor, no en cada venta.
//
// Antes, cada ticket volvía a leer y decodificar el PNG original completo desde disco
// (fs.readFileSync + parseo PNG) en el momento de imprimir. Eso pasaba en cada cobro,
// sumado al proceso de PowerShell que ya se abre por ticket (ver enviarBufferAImpresoraRaw),
// y era una de las cosas que hacía sentir lento el sistema durante el servicio. Además,
// como ANCHO_MAXIMO_LOGO_PX nunca se aplicaba realmente sobre la imagen, si el archivo de
// logo era más ancho que el cabezal de la impresora, salía cortado/desalineado en el ticket.
//
// Ahora: al arrancar, se genera UNA copia ya redimensionada al ancho máximo permitido y se
// guarda en una carpeta temporal. Todos los tickets del turno reutilizan ese mismo archivo
// (pequeño y ya validado), así que imprimir es más rápido y el logo siempre entra bien.
// ---------------------------------------------------------------------------------------
const RUTA_LOGO_TICKET_LISTO = path.join(os.tmpdir(), 'tukan_logo_ticket_listo.png');
let rutaLogoParaImprimir = null; // se define tras preparar el logo; null = no imprimir logo

async function prepararLogoTicket() {
    if (!IMPRIMIR_LOGO_EN_TICKET) return;

    if (!fs.existsSync(RUTA_LOGO_TICKET)) {
        console.warn(`⚠️ No se encontró el logo del ticket en ${RUTA_LOGO_TICKET}. Los tickets se imprimirán sin logo.`);
        return;
    }

    try {
        const imagen = await Jimp.read(RUTA_LOGO_TICKET);
        const anchoOriginal = imagen.width;

        if (anchoOriginal > ANCHO_MAXIMO_LOGO_PX) {
            imagen.resize({ w: ANCHO_MAXIMO_LOGO_PX });
            console.log(`🖼️  Logo del ticket redimensionado de ${anchoOriginal}px a ${ANCHO_MAXIMO_LOGO_PX}px de ancho para que quepa en el cabezal de la impresora.`);
        } else {
            console.log(`🖼️  Logo del ticket ya cabe en el cabezal (${anchoOriginal}px de ${ANCHO_MAXIMO_LOGO_PX}px máximo). Se deja igual.`);
        }

        await imagen.write(RUTA_LOGO_TICKET_LISTO);
        rutaLogoParaImprimir = RUTA_LOGO_TICKET_LISTO;
        console.log('✅ Logo del ticket listo y en caché para toda la jornada.');
    } catch (errLogo) {
        console.error('⚠️ No se pudo preparar el logo del ticket, se usará el archivo original sin optimizar:', errLogo.message);
        // Si algo falla al redimensionar, mejor imprimir con el original que quedarse sin logo.
        rutaLogoParaImprimir = RUTA_LOGO_TICKET;
    }
}

// Se prepara una sola vez al levantar el servidor. No bloquea el arranque del resto del
// sistema: para cuando llegue el primer ticket a imprimir (toma minutos, no milisegundos,
// en abrir el restaurante y tomar la primera orden) esto ya habrá terminado sobradamente.
prepararLogoTicket();

const printer = new ThermalPrinter({
    type: PrinterTypes.EPSON, // Usa EPSON para la mayoría de impresoras térmicas genéricas chinas. Cambia a STAR si tu marca es Star Micronics.
    interface: 'POS-800', // No se usa para transportar el ticket (ver imprimirTicketFisico), solo se deja configurado por si luego quieres usar printer.execute() directo.
    characterSet: 'PC858_EURO', // Ayuda con los acentos y la Ñ
    removeSpecialCharacters: false
});

// ---------------------------------------------------------------------------------------
// IMPRESIÓN RAW SIN DEPENDENCIAS NATIVAS
// En vez de un módulo npm que hay que compilar (frágil en Windows sin Visual Studio C++),
// usamos la API de impresión de Windows (winspool.drv: OpenPrinter/StartDocPrinter/
// WritePrinter) directo desde PowerShell con C# embebido (Add-Type). PowerShell y .NET ya
// vienen con Windows, así que no hay nada que instalar ni compilar. WritePrinter manda los
// bytes tal cual, sin que nada los reinterprete como texto — así el logo y los acentos
// llegan intactos. Es el método clásico y más confiable para imprimir tickets ESC/POS.
// ---------------------------------------------------------------------------------------
const RUTA_SCRIPT_IMPRESION = path.join(os.tmpdir(), 'tukan_imprimir_raw.ps1');

const CONTENIDO_SCRIPT_IMPRESION = `param(
    [Parameter(Mandatory=$true)][string]$PrinterName,
    [Parameter(Mandatory=$true)][string]$FilePath
)

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class TukanRawPrinter
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    public class DOCINFOA
    {
        [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
    }

    [DllImport("winspool.Drv", EntryPoint = "OpenPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true)]
    public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);

    [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true, ExactSpelling = true)]
    public static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, DOCINFOA di);

    [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true, ExactSpelling = true)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true, ExactSpelling = true)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true, ExactSpelling = true)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true, ExactSpelling = true)]
    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);

    public static bool SendBytesToPrinter(string szPrinterName, byte[] pBytes)
    {
        IntPtr hPrinter;
        DOCINFOA di = new DOCINFOA();
        di.pDocName = "Ticket Tukan";
        di.pDataType = "RAW";
        bool bSuccess = false;

        if (OpenPrinter(szPrinterName, out hPrinter, IntPtr.Zero))
        {
            if (StartDocPrinter(hPrinter, 1, di))
            {
                if (StartPagePrinter(hPrinter))
                {
                    IntPtr pUnmanagedBytes = Marshal.AllocCoTaskMem(pBytes.Length);
                    Marshal.Copy(pBytes, 0, pUnmanagedBytes, pBytes.Length);
                    int dwWritten;
                    bSuccess = WritePrinter(hPrinter, pUnmanagedBytes, pBytes.Length, out dwWritten);
                    Marshal.FreeCoTaskMem(pUnmanagedBytes);
                    EndPagePrinter(hPrinter);
                }
                EndDocPrinter(hPrinter);
            }
            ClosePrinter(hPrinter);
        }
        return bSuccess;
    }
}
"@

$bytes = [System.IO.File]::ReadAllBytes($FilePath)
$ok = [TukanRawPrinter]::SendBytesToPrinter($PrinterName, $bytes)
if (-not $ok) {
    Write-Error "SendBytesToPrinter devolvió false (revisa el nombre de la impresora y que esté encendida/conectada)."
    exit 1
}
exit 0
`;

// Se escribe una sola vez al arrancar el servidor (igual que config.js).
try {
    fs.writeFileSync(RUTA_SCRIPT_IMPRESION, CONTENIDO_SCRIPT_IMPRESION, 'utf8');
} catch (errScript) {
    console.error("⚠️ No se pudo escribir el script de impresión:", errScript.message);
}

/**
 * Manda el buffer YA GENERADO (texto + comandos ESC/POS + imagen del logo) directo a la
 * impresora usando WritePrinter (Win32). Byte por byte, sin reinterpretación de ningún tipo.
 */
async function enviarBufferAImpresoraRaw(buffer) {
    const archivoTemp = path.join(os.tmpdir(), `ticket_${Date.now()}.bin`);
    fs.writeFileSync(archivoTemp, buffer);
    try {
        // TIMEOUT_IMPRESION_MS: si la impresora está apagada, desconectada, sin papel
        // trabado, o Windows la trae "offline" en el spooler, el script de PowerShell se
        // puede quedar esperando al dispositivo indefinidamente. Sin límite de tiempo,
        // ese `await` nunca termina — y como TODOS los tickets pasan por la misma cola
        // (`colaImpresionPromise`), un solo ticket atorado deja bloqueada la fila para
        // SIEMPRE: ninguna cuenta futura se vuelve a poder cobrar/imprimir hasta reiniciar
        // el servidor a mano. El `timeout` de abajo hace que, si no responde a tiempo,
        // Node mate el proceso y esto falle con un error normal en vez de colgarse — así
        // el ticket en turno se reporta como fallido, pero la cola queda libre para el
        // siguiente.
        await execAsync(
            `powershell -NoProfile -ExecutionPolicy Bypass -File "${RUTA_SCRIPT_IMPRESION}" -PrinterName "${NOMBRE_IMPRESORA_TICKETS}" -FilePath "${archivoTemp}"`,
            { timeout: TIMEOUT_IMPRESION_MS }
        );
    } finally {
        fs.unlink(archivoTemp, () => {});
    }
}

/**
 * Arma un ticket (logo + encabezado + líneas + total) usando la librería de impresión térmica
 * (así los acentos, la Ñ y el logo salen bien) y lo manda a imprimir con el método RAW de arriba.
 */
/**
 * Cola de impresión: garantiza que nunca se armen dos tickets al mismo tiempo sobre el
 * mismo objeto "printer" compartido. Sin esto, si dos cuentas se cobran casi al mismo
 * tiempo (por ejemplo bajo una prueba de carga, o dos meseros cobrando a la vez), sus
 * datos se mezclan en el mismo buffer y la impresora recibe un ticket corrupto — esto es
 * justo lo que causaba impresión interminable con caracteres aleatorios.
 */
let colaImpresionPromise = Promise.resolve();

function imprimirTicketFisico(datos) {
    // Log de verificación: así, viendo la consola del servidor, se puede confirmar que la
    // fecha SÍ se está armando y mandando a imprimir -- si aquí sale bien pero en el papel
    // no aparece, el problema ya no es el código sino la impresora/driver.
    console.log(`🖨️  Imprimiendo ticket [${datos.tipoTicket || '?'}] mesa="${datos.mesa}" fecha="${datos.fecha}"`);

    const trabajo = colaImpresionPromise
        .then(() => _armarYEnviarTicket(datos))
        .then((resultado) => {
            // No dejamos que un fallo al GUARDAR el historial tumbe el resultado real de
            // la impresión — es un registro informativo, no debe volverse otro punto de falla.
            registrarIntentoImpresion(datos, resultado).catch((e) =>
                console.error('No se pudo guardar el historial de impresión:', e.message)
            );
            return resultado;
        });
    // Si este ticket falla, no debe bloquear los que vienen detrás en la cola.
    colaImpresionPromise = trabajo.catch(() => {});
    return trabajo;
}

async function registrarIntentoImpresion(datos, resultado) {
    await db.run(
        `INSERT INTO historial_impresiones (tipo, mesa, exitosa, error, datos_ticket) VALUES (?, ?, ?, ?, ?)`,
        [
            datos.tipoTicket || 'DESCONOCIDO',
            datos.mesa || '',
            resultado.exitosa ? 1 : 0,
            resultado.error || null,
            JSON.stringify(datos)
        ]
    );
}

async function _armarYEnviarTicket({ titulo, mesa, fecha, lineas, totalTexto, piePagina, esComandaCocina }) {
    try {
        printer.clear();
        printer.alignCenter();

        // Los tickets de comanda (tira para cocina/barra de pedidos "para llevar") no son
        // para el cliente: van sin logo y en negritas (letra más "llena", no más alta) para
        // leerse fácil en el pase de cocina sin gastar tanto papel en pedidos largos. El
        // logo solo tiene sentido en los tickets de cobro.
        if (!esComandaCocina && IMPRIMIR_LOGO_EN_TICKET && rutaLogoParaImprimir && fs.existsSync(rutaLogoParaImprimir)) {
            try {
                await printer.printImage(rutaLogoParaImprimir);
            } catch (errLogo) {
                console.error("No se pudo imprimir el logo del ticket:", errLogo.message);
            }
        }

        // La versión anterior (impresa desde el navegador) usaba la misma letra -- gruesa/
        // negrita ("font-black" de Tailwind) -- en TODO el ticket, no solo en el título.
        // Se activa aquí y se deja puesta hasta el pie de página para que el ticket físico
        // se vea igual de "cargado" que antes.
        printer.bold(true);

        if (!esComandaCocina) {
            printer.println('Insurgentes número 16, Tamazulapam Oax');
            printer.println('Tel. 953 212 4618');
            printer.drawLine();
        }

        printer.println(titulo);
        printer.drawLine();

        if (esComandaCocina) {
            // Folio y fecha centrados, en el mismo tamaño de letra normal que el resto del
            // ticket (nada de ancho doble: en esta impresora eso sale borroso/pixeleado
            // porque es la fuente de mapa de bits de la impresora, no una fuente real como
            // la que usaba el navegador antes). Las negritas ya activadas arriba bastan
            // para que se vea igual de "cargado" que en la versión anterior.
            printer.alignCenter();
            printer.println(mesa);
            printer.println(fecha);
        } else {
            printer.alignLeft();
            printer.println(`MESA: ${mesa}`);
            printer.println(`FECHA: ${fecha}`);
        }
        printer.drawLine();

        printer.alignLeft();
        lineas.forEach(linea => printer.println(linea));
        printer.drawLine();

        if (totalTexto) {
            printer.alignRight();
            printer.println(totalTexto);
        }

        // Los tickets de comanda (cocina/barra) no llevan pie de página con "gracias por su
        // visita": no son para el cliente, y cada línea de más es papel de más en un
        // pedido grande. Terminan justo después de la lista de productos.
        if (!esComandaCocina) {
            printer.alignCenter();
            printer.println(piePagina || '¡GRACIAS POR SU VISITA!');
        }
        printer.bold(false);
        printer.newLine();
        printer.cut();

        const buffer = printer.getBuffer();
        await enviarBufferAImpresoraRaw(buffer);
        return { exitosa: true };
    } catch (error) {
        // Si la impresora está apagada/desconectada no debe tumbar la venta: solo lo avisamos en consola
        // (y queda guardado en historial_impresiones para que el mesero lo vea en pantalla).
        console.error("Error al imprimir ticket físico:", error.message);
        return { exitosa: false, error: error.message };
    }
}


for (let devName in interfaces) {
    interfaces[devName].forEach((iface) => {
        if (iface.family === 'IPv4' && !iface.internal && (iface.address.startsWith('192.168.') || iface.address.startsWith('10.'))) {
            ipLocalReal = iface.address;
        }
    });
}

const contenidoConfig = `const CONFIG = {\n    API_URL: 'http://${ipLocalReal}:3000'\n};`;
fs.writeFileSync('./config.js', contenidoConfig, 'utf8');

console.log("\n=========================================================");
console.log(`✨ IP DETECTADA: ${ipLocalReal}`);
console.log(` MESEROS DEBEN CONECTARSE A: http://${ipLocalReal}:3000/index.html`);
console.log(` ADMIN DEBEN CONECTARSE A: http://${ipLocalReal}:3000/admin_panel.html`);
console.log(` COCINA DEBE CONECTARSE A: http://${ipLocalReal}:3000/cocina.html`);
console.log(` BARRA DEBEN CONECTARSE A: http://${ipLocalReal}:3000/barra.html`);
console.log("=========================================================\n");

let db;

let comandasCocinaActivas = [];
let comandasBarraActivas = [];
let historialComandasCompletadas = [];


(async () => {
    db = await open({ filename: 'restaurante.db', driver: sqlite3.Database });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS pedidos_activos (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            mesa TEXT, /* Cambiado a TEXT para soportar folios como L-01 */
            producto TEXT, 
            itemBase TEXT,
            modificadores TEXT, /* JSON en texto con los extras elegidos */
            nota TEXT, /* Notas para clientes especiales */
            destino TEXT /* 'cocina' o 'barra' para saber dónde se produjo */
        );
        CREATE TABLE IF NOT EXISTS historial_ventas (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            mesa TEXT, 
            total REAL, 
            detalle TEXT, 
            fecha DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS categorias (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            nombre TEXT UNIQUE
        );
        CREATE TABLE IF NOT EXISTS subcategorias (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            nombre TEXT, 
            categoria_id INTEGER, 
            FOREIGN KEY(categoria_id) REFERENCES categorias(id)
        );
        CREATE TABLE IF NOT EXISTS productos (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            nombre TEXT, 
            precio REAL, 
            costo REAL, 
            categoria_id INTEGER, 
            subcategoria_id INTEGER DEFAULT 0,
            destino TEXT DEFAULT 'cocina', /* 'cocina' o 'barra' */
            FOREIGN KEY(categoria_id) REFERENCES categorias(id)
        );
        
        /* NUEVA TABLA: Modificadores Frecuentes ligados a un producto */
        CREATE TABLE IF NOT EXISTS modificadores_productos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            producto_id INTEGER,
            nombre TEXT,
            precio_extra REAL, /* Puede ser positivo (10), neutro (0) o negativo (-15) */
            FOREIGN KEY(producto_id) REFERENCES productos(id)
        );

        CREATE TABLE IF NOT EXISTS control_comandas (
            id TEXT PRIMARY KEY, /* ID Único como CMD-12345-COC */
            mesa TEXT,
            fecha TEXT,
            destino TEXT, /* 'cocina' o 'barra' */
            estatus INTEGER DEFAULT 0, /* 0 = Activo (En Monitor), 1 = Completado (Historial) */
            fecha_cierre TEXT
        );

        CREATE TABLE IF NOT EXISTS items_comanda (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            comanda_id TEXT,
            producto TEXT,
            modificadores TEXT, /* JSON de modificadores */
            nota TEXT,
            FOREIGN KEY(comanda_id) REFERENCES control_comandas(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS configuracion_mesas (
            id INTEGER PRIMARY KEY,
            numero_mesa INTEGER UNIQUE
        );

        CREATE TABLE IF NOT EXISTS variables_sistema (
            clave TEXT PRIMARY KEY,
            valor TEXT
        );

        CREATE TABLE IF NOT EXISTS cortes_caja (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fecha_corte DATETIME DEFAULT CURRENT_TIMESTAMP,
            fecha_primer_ticket TEXT,
            fecha_ultimo_ticket TEXT,
            ingresos REAL DEFAULT 0,
            gastos REAL DEFAULT 0,
            ganancia REAL DEFAULT 0,
            detalle_ventas TEXT
        );

        /* Registro de cada intento de impresión física (para llevar, cobros, reimpresiones).
           Sirve para que el mesero pueda ver si algún ticket no salió (impresora apagada,
           sin papel, etc.) y volver a mandarlo sin tener que recrear el pedido a mano. */
        CREATE TABLE IF NOT EXISTS historial_impresiones (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tipo TEXT,               /* PARA_LLEVAR | COBRO_TOTAL | COBRO_PARCIAL | REIMPRESION */
            mesa TEXT,
            fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
            exitosa INTEGER,         /* 1 = se imprimió bien, 0 = falló */
            error TEXT,              /* mensaje de error si falló */
            datos_ticket TEXT        /* JSON con todo lo necesario para reimprimir después */
        );
    `);

    try {
        await db.run("ALTER TABLE historial_ventas ADD COLUMN corte_id INTEGER DEFAULT 0");
    } catch (e) {
    }

    const pinExistente = await db.get("SELECT valor FROM variables_sistema WHERE clave = 'pin_admin'");
    if (!pinExistente) {
        await db.run("INSERT INTO variables_sistema (clave, valor) VALUES ('pin_admin', '1234')");
    }

    const modoCocina = await db.get("SELECT valor FROM variables_sistema WHERE clave = 'modo_pantalla_cocina'");
    if (!modoCocina) {
        await db.run("INSERT INTO variables_sistema (clave, valor) VALUES ('modo_pantalla_cocina', 'tablet')");
    }

    const modoBarra = await db.get("SELECT valor FROM variables_sistema WHERE clave = 'modo_pantalla_barra'");
    if (!modoBarra) {
        await db.run("INSERT INTO variables_sistema (clave, valor) VALUES ('modo_pantalla_barra', 'tablet')");
    }

    console.log("✅ Servidor Tukan: Estructura de Base de Datos lista.");
})();

app.post('/api/login', (req, res) => {
    const { user, pass } = req.body;
    if (user === "admin" && pass === "12141618") {
        res.json({ success: true, token: "TOKEN_" + Math.random().toString(36).substr(2) });
    } else {
        res.status(401).json({ success: false });
    }
});


// ---------------------------------------------------------------------------------------
// COLA DE ESCRITURA PARA COMANDAS
//
// La conexión a la base de datos (`db`, más abajo) es UNA sola, compartida por todas las
// peticiones que le llegan al servidor. Si dos POST a /enviar_comanda se procesan casi al
// mismo tiempo — dos toques rápidos en "Enviar" por la lentitud de la tablet, o dos
// meseros mandando comanda a la misma mesa — las dos empiezan a usar esa misma conexión al
// mismo tiempo:
//
//   1. La petición A hace BEGIN TRANSACTION y empieza a insertar sus artículos.
//   2. Antes de que A termine, la petición B también intenta BEGIN TRANSACTION en la misma
//      conexión. SQLite no permite transacciones anidadas, así que ese BEGIN de B falla.
//   3. B entra a su catch y hace ROLLBACK — pero como es la misma conexión, ese ROLLBACK
//      cancela la transacción de A (¡no la de B, que nunca llegó a abrir una!).
//   4. Cuando A sigue con sus propios INSERT/COMMIT, ya no hay transacción activa: también
//      falla, entra a su catch, intenta hacer ROLLBACK... y ese ROLLBACK también falla
//      porque ya no hay nada que revertir. Como esta segunda falla no estaba controlada,
//      la petición A se queda sin poder responder nunca — el mesero ve "Enviando
//      comanda..." para siempre y ni recargar el navegador lo arregla, porque el problema
//      quedó del lado del servidor.
//
// La solución: en vez de dejar que las peticiones se atropellen, se ponen en una fila y se
// procesan de una en una (mismo patrón que ya se usa para la cola de impresión más arriba).
// Así nunca hay dos transacciones abiertas al mismo tiempo sobre la misma conexión.
// ---------------------------------------------------------------------------------------
let colaEscrituraComandas = Promise.resolve();

function encolarEscrituraComanda(tarea) {
    const trabajo = colaEscrituraComandas.then(tarea);
    // Si esta tarea falla, no debe tumbar a las que vienen detrás en la cola.
    colaEscrituraComandas = trabajo.catch(() => {});
    return trabajo;
}

// Arma las líneas legibles de un artículo YA AGRUPADO para el ticket de comanda (sin
// precios: esto es un vale de cocina/barra para armar el pedido, no un recibo de cobro).
function formatearLineaComandaParaTicket(item) {
    let linea = `X${item.cantidad} ${item.display}`;
    try {
        const mods = JSON.parse(item.modificadores || '[]');
        if (mods.length) linea += `\n   - ${mods.map(m => m.nombre).join(', ')}`;
    } catch (_) { /* modificadores mal formados: se ignoran, no debe tumbar la impresión */ }
    if (item.nota) linea += `\n   * Nota: ${item.nota}`;
    return linea;
}

// Junta productos idénticos (mismo nombre + mismos modificadores + misma nota) en una sola
// línea con cantidad ("X3 Producto") en vez de repetir la línea una vez por unidad. Los
// items llegan aquí ya "desenrollados" uno por uno (así los maneja el resto del sistema:
// cancelación individual, armado de pedidos_activos, etc.), así que agrupar es solo para
// que el TICKET IMPRESO se vea compacto — no cambia nada de cómo se guardan en la base.
function agruparItemsParaTicket(items) {
    const grupos = new Map();
    for (const item of items) {
        const llave = `${item.display}|${item.modificadores}|${item.nota}`;
        if (grupos.has(llave)) {
            grupos.get(llave).cantidad++;
        } else {
            grupos.set(llave, { ...item, cantidad: 1 });
        }
    }
    return Array.from(grupos.values());
}

async function procesarEnvioComanda({ mesa, items }) {
    let timestampBase = Date.now();
    let horaActual = new Date().toLocaleTimeString();

    let elementosCocina = [];
    let elementosBarra = [];

    for (let item of items) {
        const prod = await db.get('SELECT destino FROM productos WHERE nombre = ?', [item.base]);
        const destino = prod ? prod.destino : 'cocina';

        const modsTexto = JSON.stringify(item.modificadores || []);
        const notaTexto = item.nota || "";

        const itemFormateado = {
            display: item.display,
            base: item.base,
            modificadores: modsTexto,
            nota: notaTexto,
            destino: destino
        };

        if (destino === 'barra') { elementosBarra.push(itemFormateado); }
        else { elementosCocina.push(itemFormateado); }
    }

    try {
        await db.run('BEGIN TRANSACTION');

        for (let item of items) {
            const prod = await db.get('SELECT destino FROM productos WHERE nombre = ?', [item.base]);
            const destino = prod ? prod.destino : 'cocina';
            const modsTexto = JSON.stringify(item.modificadores || []);
            const notaTexto = item.nota || "";

            await db.run(`
                INSERT INTO pedidos_activos (mesa, producto, itemBase, modificadores, nota, destino) 
                VALUES (?, ?, ?, ?, ?, ?)`,
                [mesa, item.display, item.base, modsTexto, notaTexto, destino]
            );
        }

        if (elementosCocina.length > 0) {
            const idCocina = `CMD-${timestampBase}-COC`;
            for (let ic of elementosCocina) {
                await db.run('INSERT INTO items_comanda (comanda_id, producto, modificadores, nota) VALUES (?, ?, ?, ?)', [idCocina, ic.display, ic.modificadores, ic.nota]);
            }
            await db.run('INSERT INTO control_comandas (id, mesa, fecha, destino, estatus) VALUES (?, ?, ?, "cocina", 0)', [idCocina, mesa, horaActual]);
        }

        if (elementosBarra.length > 0) {
            const idBarra = `CMD-${timestampBase}-BAR`;
            for (let ib of elementosBarra) {
                await db.run('INSERT INTO items_comanda (comanda_id, producto, modificadores, nota) VALUES (?, ?, ?, ?)', [idBarra, ib.display, ib.modificadores, ib.nota]);
            }
            await db.run('INSERT INTO control_comandas (id, mesa, fecha, destino, estatus) VALUES (?, ?, ?, "barra", 0)', [idBarra, mesa, horaActual]);
        }

        if (mesa.startsWith('PARA LLEVAR #')) {
            const numeroActual = parseInt(mesa.split('#')[1]);
            if (!isNaN(numeroActual)) {
                await db.run("INSERT OR REPLACE INTO variables_sistema (clave, valor) VALUES ('consecutivo_llevar', ?)", [numeroActual.toString()]);
            }
        }

        await db.run('COMMIT');

        // Pedidos para llevar: además de mandarse a Cocina/Barra en pantalla, se imprimen
        // tickets físicos de la comanda (sin precios) — UNO POR ESTACIÓN, cada uno se corta
        // aparte, para poder repartirlos por separado (uno a cocina, otro a barra). Las
        // mesas normales NO imprimen nada aquí — para esas, Cocina/Barra siguen viéndolo
        // solo en pantalla, como ya funcionaba.
        let ticketsParaLlevar = [];
        if (mesa.startsWith('PARA LLEVAR')) {
            const fechaTicket = `${new Date().toLocaleDateString('es-MX')} | ${horaActual}`;

            if (elementosCocina.length > 0) {
                ticketsParaLlevar.push({
                    titulo: '*** COMANDA COCINA ***',
                    mesa,
                    fecha: fechaTicket,
                    lineas: agruparItemsParaTicket(elementosCocina).map(formatearLineaComandaParaTicket),
                    esComandaCocina: true,
                    tipoTicket: 'PARA_LLEVAR'
                });
            }

            if (elementosBarra.length > 0) {
                ticketsParaLlevar.push({
                    titulo: '*** COMANDA BARRA ***',
                    mesa,
                    fecha: fechaTicket,
                    lineas: agruparItemsParaTicket(elementosBarra).map(formatearLineaComandaParaTicket),
                    esComandaCocina: true,
                    tipoTicket: 'PARA_LLEVAR'
                });
            }
        }

        return { status: "ok", ticketsParaLlevar };
    } catch (e) {
        // Importante: este ROLLBACK va en su propio try/catch. Si llega a fallar (por
        // ejemplo porque ya no hay transacción activa que revertir), NO debe impedir que
        // la petición reciba una respuesta — eso era justo lo que dejaba al mesero
        // esperando para siempre.
        try {
            await db.run('ROLLBACK');
        } catch (errRollback) {
            console.error('No había transacción que revertir al fallar el envío de comanda:', errRollback.message);
        }
        throw e;
    }
}

app.post('/enviar_comanda', async (req, res) => {
    try {
        const resultado = await encolarEscrituraComanda(() => procesarEnvioComanda(req.body));
        res.json({ status: resultado.status });

        // La impresión se dispara DESPUÉS de responder y fuera de la cola de escritura: así
        // el mesero no tiene que esperar a que salga el ticket para poder tomar el
        // siguiente pedido, y si la impresora está lenta/desconectada (ver
        // TIMEOUT_IMPRESION_MS más arriba) no retrasa ni bloquea las comandas que siguen.
        // Si hay tickets de cocina Y barra, se mandan los dos: la cola de impresión
        // (colaImpresionPromise) ya se encarga de imprimirlos uno después del otro, nunca
        // al mismo tiempo.
        if (resultado.ticketsParaLlevar && resultado.ticketsParaLlevar.length > 0) {
            resultado.ticketsParaLlevar.forEach((ticket) => {
                imprimirTicketFisico(ticket).catch((errImpresion) => {
                    console.error(`No se pudo imprimir el ticket de pedido para llevar (${ticket.titulo}):`, errImpresion.message);
                });
            });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Historial de impresiones para que el mesero vea, desde su propia pantalla, si algún
// ticket (para llevar, cobro total, cobro parcial) no llegó a salir de la impresora —
// por ejemplo porque estaba apagada — y pueda reimprimirlo sin tener que rehacer nada.
app.get('/api/historial_impresiones', async (req, res) => {
    try {
        const limite = Math.min(parseInt(req.query.limite) || 40, 200);
        const filas = await db.all(
            'SELECT id, tipo, mesa, fecha, exitosa, error FROM historial_impresiones ORDER BY id DESC LIMIT ?',
            [limite]
        );
        res.json(filas);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/historial_impresiones/:id/reimprimir', async (req, res) => {
    try {
        const fila = await db.get('SELECT * FROM historial_impresiones WHERE id = ?', [req.params.id]);
        if (!fila) return res.status(404).json({ error: 'No se encontró ese registro de impresión.' });

        const datosTicket = JSON.parse(fila.datos_ticket);
        const resultado = await imprimirTicketFisico(datosTicket);

        if (resultado.exitosa) {
            res.json({ success: true });
        } else {
            res.status(502).json({ error: resultado.error || 'La impresora no respondió.' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});



app.delete('/api/categorias/:id', async (req, res) => {
    try {
        const catId = req.params.id;

        await db.run(`
            DELETE FROM modificadores_productos 
            WHERE producto_id IN (
                SELECT id FROM productos WHERE categoria_id = ?
            )
        `, [catId]);

        await db.run('DELETE FROM productos WHERE categoria_id = ?', [catId]);

        await db.run('DELETE FROM subcategorias WHERE categoria_id = ?', [catId]);

        await db.run('DELETE FROM categorias WHERE id = ?', [catId]);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/subcategorias/:id', async (req, res) => {
    try {
        const subId = req.params.id;

        await db.run(`
            DELETE FROM modificadores_productos 
            WHERE producto_id IN (
                SELECT id FROM productos WHERE subcategoria_id = ?
            )
        `, [subId]);

        await db.run('DELETE FROM productos WHERE subcategoria_id = ?', [subId]);

        await db.run('DELETE FROM subcategorias WHERE id = ?', [subId]);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Trae las comandas activas (o un lote de headers ya cerrados) y sus items EN 2 CONSULTAS TOTALES,
// sin importar cuántas comandas haya (antes se hacía 1 consulta extra por cada comanda = N+1).
async function armarComandasConItems(comandasHeader) {
    if (comandasHeader.length === 0) return [];

    const ids = comandasHeader.map(c => c.id);
    const placeholders = ids.map(() => '?').join(',');
    const todosLosItems = await db.all(
        `SELECT * FROM items_comanda WHERE comanda_id IN (${placeholders})`,
        ids
    );

    const itemsPorComanda = {};
    todosLosItems.forEach(i => {
        if (!itemsPorComanda[i.comanda_id]) itemsPorComanda[i.comanda_id] = [];
        itemsPorComanda[i.comanda_id].push({
            producto: i.producto,
            modificadores: JSON.parse(i.modificadores || '[]'),
            nota: i.nota
        });
    });

    return comandasHeader.map(c => ({
        id: c.id,
        mesa: c.mesa,
        fecha: c.fecha,
        destinoCierre: c.destino,
        fechaCierre: c.fecha_cierre,
        items: itemsPorComanda[c.id] || []
    }));
}

app.get('/api/comandas/cocina', async (req, res) => {
    try {
        const comandasHeader = await db.all('SELECT * FROM control_comandas WHERE destino = "cocina" AND estatus = 0 ORDER BY id ASC');
        res.json(await armarComandasConItems(comandasHeader));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/comandas/barra', async (req, res) => {
    try {
        const comandasHeader = await db.all('SELECT * FROM control_comandas WHERE destino = "barra" AND estatus = 0 ORDER BY id ASC');
        res.json(await armarComandasConItems(comandasHeader));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/comandas/historial', (req, res) => res.json(historialComandasCompletadas));


app.get('/mesas_activas', async (req, res) => {
    const rows = await db.all('SELECT DISTINCT mesa FROM pedidos_activos');
    res.json(rows.map(r => r.mesa));
});

app.get('/cuenta/:mesa', async (req, res) => {
    const rows = await db.all('SELECT * FROM pedidos_activos WHERE mesa = ?', [req.params.mesa]);
    res.json(rows);
});

app.delete('/api/mesas/:numero', async (req, res) => {
    try {
        const numero = req.params.numero;

        const ocupada = await db.get('SELECT 1 FROM pedidos_activos WHERE mesa = ? OR mesa = ? LIMIT 1', [numero, numero.toString()]);

        if (ocupada) {
            return res.status(400).json({ error: "No puedes quitar una mesa que tiene cuenta abierta" });
        }

        await db.run('DELETE FROM configuracion_mesas WHERE numero_mesa = ?', [numero]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/cobrar_parcial', async (req, res) => {
    const { mesa, itemsACobrar } = req.body;

    if (!itemsACobrar || itemsACobrar.length === 0) {
        return res.status(400).json({ error: "No se seleccionaron elementos para cobrar" });
    }

    try {
        let totalParcial = 0;
        let idsParaEliminar = [];

        const productosAgrupados = {};

        for (let item of itemsACobrar) {
            const prodEnDb = await db.get('SELECT precio FROM productos WHERE nombre = ?', [item.itemBase]);
            let precioBase = prodEnDb ? prodEnDb.precio : 0;

            let precioModificadores = 0;
            const mods = JSON.parse(item.modificadores || '[]');
            mods.forEach(m => precioModificadores += parseFloat(m.precio_extra || 0));

            let precioFinalItem = precioBase + precioModificadores;
            totalParcial += precioFinalItem;
            idsParaEliminar.push(item.id);

            const listaModsTexto = mods.map(m => m.nombre).sort().join(', ');
            const llaveUnica = `${item.producto}|${listaModsTexto}|${precioFinalItem}`;

            if (productosAgrupados[llaveUnica]) {
                productosAgrupados[llaveUnica].cantidad++;
                productosAgrupados[llaveUnica].subtotal += precioFinalItem;
            } else {
                productosAgrupados[llaveUnica] = {
                    producto: item.producto,
                    precioFinalItem: precioFinalItem,
                    subtotal: precioFinalItem,
                    detalleMods: listaModsTexto,
                    cantidad: 1
                };
            }
        }

        let lineasDetalle = Object.values(productosAgrupados).map(p => {
            let texto = `• ${p.cantidad}x ${p.producto} ($${p.subtotal.toFixed(2)})`;
            return texto;
        });

        const detalleTicketParcial = lineasDetalle.join("<br>");
        const horaCobroParcialReal = new Date().toLocaleString('es-MX', { hour12: false });

        const lineasTicketParcial = Object.values(productosAgrupados).map(p =>
            `${p.cantidad}x ${p.producto}  $${p.subtotal.toFixed(2)}`
        );

        await imprimirTicketFisico({
            titulo: '*** COBRO PARCIAL ***',
            mesa,
            fecha: horaCobroParcialReal,
            lineas: lineasTicketParcial,
            totalTexto: `TOTAL PERSONA: $${totalParcial.toFixed(2)}`,
            tipoTicket: 'COBRO_PARCIAL'
        });

        await db.run('INSERT INTO historial_ventas (mesa, total, detalle) VALUES (?, ?, ?)',
            [`${mesa} (PARCIAL)`, totalParcial, detalleTicketParcial]
        );

        const placeholders = idsParaEliminar.map(() => '?').join(',');
        await db.run(`DELETE FROM pedidos_activos WHERE id IN (${placeholders})`, idsParaEliminar);

        res.json({ success: true, total: totalParcial });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/cerrar_cuenta', async (req, res) => {
    try {
        const { mesa } = req.body;

        // 1. Obtenemos todos los elementos activos de esa mesa
        const items = await db.all('SELECT * FROM pedidos_activos WHERE mesa = ?', [mesa]);

        if (items.length === 0) {
            return res.json({ total: 0, error: "No hay cuentas pendientes para esta mesa." });
        }

        let total = 0;
        const productosAgrupados = {};

        // 2. Procesamos cada item usando tu lógica original de precios y modificadores
        for (let item of items) {
            const prodEnDb = await db.get('SELECT precio FROM productos WHERE nombre = ?', [item.itemBase]);
            let precioBase = prodEnDb ? prodEnDb.precio : 0;

            let precioModificadores = 0;
            const mods = JSON.parse(item.modificadores || '[]');
            mods.forEach(m => precioModificadores += parseFloat(m.precio_extra || 0));

            let precioFinalItem = precioBase + precioModificadores;
            total += precioFinalItem;

            const listaModsTexto = mods.map(m => m.nombre).sort().join(', ');
            const llaveUnica = `${item.producto}|${listaModsTexto}|${item.nota || ''}|${precioFinalItem}`;

            if (productosAgrupados[llaveUnica]) {
                productosAgrupados[llaveUnica].cantidad++;
                productosAgrupados[llaveUnica].subtotal += precioFinalItem;
            } else {
                productosAgrupados[llaveUnica] = {
                    producto: item.producto,
                    precioFinalItem: precioFinalItem,
                    subtotal: precioFinalItem,
                    detalleMods: listaModsTexto,
                    nota: item.nota,
                    cantidad: 1
                };
            }
        }

        const horaCobroReal = new Date().toLocaleString('es-MX', { hour12: false });

        // Preparamos el texto para guardar en el historial (formato limpio para texto/HTML)
        let lineasDetalle = Object.values(productosAgrupados).map(p => {
            let texto = `${p.cantidad}x ${p.producto} ($${p.subtotal.toFixed(2)})`;
            if (p.detalleMods) texto += ` [${p.detalleMods}]`;
            return texto;
        });
        const detalleTicketHistorial = lineasDetalle.join("<br>");

        // 3. Impresión física del ticket (logo + encabezado + detalle, con acentos y Ñ correctos)
        const lineasTicket = Object.values(productosAgrupados).map(p => {
            let l = `${p.cantidad}x ${p.producto}  $${p.subtotal.toFixed(2)}`;
            if (p.detalleMods) l += `\n   - ${p.detalleMods}`;
            if (p.nota) l += `\n   * Nota: ${p.nota}`;
            return l;
        });

        await imprimirTicketFisico({
            titulo: '*** CUENTA TOTAL ***',
            mesa,
            fecha: horaCobroReal,
            lineas: lineasTicket,
            totalTexto: `TOTAL: $${total.toFixed(2)}`,
            tipoTicket: 'COBRO_TOTAL'
        });

        // 4. Limpieza de base de datos (igual que tu versión anterior)
        await db.run('INSERT INTO historial_ventas (mesa, total, detalle) VALUES (?, ?, ?)', [mesa, total, detalleTicketHistorial]);
        await db.run('DELETE FROM pedidos_activos WHERE mesa = ?', [mesa]);
        await db.run('DELETE FROM control_comandas WHERE mesa = ?', [mesa]);

        // 5. Respondemos al cliente con el total y detalle
        res.json({ total, detalle: detalleTicketHistorial, exito: true });

    } catch (e) {
        console.error("Error al cerrar cuenta:", e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/menu_admin', async (req, res) => {
    const productos = await db.all(`
        SELECT p.*, c.nombre as cat_nombre, IFNULL(s.nombre, 'Sin Sub') as sub_nombre 
        FROM productos p 
        JOIN categorias c ON p.categoria_id = c.id
        LEFT JOIN subcategorias s ON p.subcategoria_id = s.id
    `);

    for (let p of productos) {
        p.modificadores = await db.all('SELECT * FROM modificadores_productos WHERE producto_id = ?', [p.id]);
    }
    res.json(productos);
});

app.post('/api/productos', async (req, res) => {
    const { nombre, precio, costo, categoria_id, subcategoria_id, destino, modificadores } = req.body;
    const finalSubId = subcategoria_id ? subcategoria_id : 0;
    const finalDestino = destino ? destino : 'cocina';

    const result = await db.run(
        'INSERT INTO productos (nombre, precio, costo, categoria_id, subcategoria_id, destino) VALUES (?, ?, ?, ?, ?, ?)',
        [nombre, precio, costo, categoria_id, finalSubId, finalDestino]
    );

    const productoId = result.lastID;

    if (modificadores && Array.isArray(modificadores)) {
        for (let m of modificadores) {
            await db.run(
                'INSERT INTO modificadores_productos (producto_id, nombre, precio_extra) VALUES (?, ?, ?)',
                [productoId, m.nombre, m.precio_extra]
            );
        }
    }
    res.json({ success: true });
});

app.put('/api/productos/:id', async (req, res) => {
    const { nombre, precio, costo, categoria_id, subcategoria_id, destino, modificadores } = req.body;
    const prodId = req.params.id;

    await db.run(
        `UPDATE productos SET nombre=?, precio=?, costo=?, categoria_id=?, subcategoria_id=?, destino=? WHERE id=?`,
        [nombre, precio, costo, categoria_id, subcategoria_id, destino, prodId]
    );

    await db.run('DELETE FROM modificadores_productos WHERE producto_id = ?', [prodId]);
    if (modificadores && Array.isArray(modificadores)) {
        for (let m of modificadores) {
            await db.run(
                'INSERT INTO modificadores_productos (producto_id, nombre, precio_extra) VALUES (?, ?, ?)',
                [prodId, m.nombre, m.precio_extra]
            );
        }
    }
    res.json({ success: true });
});

app.delete('/api/productos/:id', async (req, res) => {
    await db.run('DELETE FROM modificadores_productos WHERE producto_id = ?', [req.params.id]);
    await db.run('DELETE FROM productos WHERE id = ?', [req.params.id]);
    res.json({ success: true });
});

app.get('/api/categorias', async (req, res) => res.json(await db.all('SELECT * FROM categorias')));
app.post('/api/categorias', async (req, res) => {
    await db.run('INSERT INTO categorias (nombre) VALUES (?)', [req.body.nombre]);
    res.json({ success: true });
});
app.get('/api/subcategorias/:catId', async (req, res) => res.json(await db.all('SELECT * FROM subcategorias WHERE categoria_id = ?', [req.params.catId])));
app.post('/api/subcategorias', async (req, res) => {
    await db.run('INSERT INTO subcategorias (nombre, categoria_id) VALUES (?, ?)', [req.body.nombre, req.body.categoria_id]);
    res.json({ success: true });
});
app.get('/api/mesas', async (req, res) => res.json((await db.all('SELECT numero_mesa FROM configuracion_mesas ORDER BY numero_mesa ASC')).map(r => r.numero_mesa)));
app.post('/api/mesas', async (req, res) => {
    try {
        await db.run('INSERT INTO configuracion_mesas (numero_mesa) VALUES (?)', [req.body.numero]);
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: "Mesa ya existe" }); }
});


app.get('/api/comandas/:destino', async (req, res) => {
    try {
        const { destino } = req.params;

        const comandasHeader = await db.all('SELECT * FROM control_comandas WHERE destino = ? AND estatus = 0 ORDER BY id ASC', [destino]);
        res.json(await armarComandasConItems(comandasHeader));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/comandas_sistema/historial', async (req, res) => {
    try {
        const comandasHeader = await db.all('SELECT * FROM control_comandas WHERE estatus = 1 ORDER BY fecha_cierre DESC LIMIT 20');
        res.json(await armarComandasConItems(comandasHeader));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/comandas/completar', async (req, res) => {
    try {
        const { id } = req.body;
        let horaCierre = new Date().toLocaleTimeString();
        await db.run('UPDATE control_comandas SET estatus = 1, fecha_cierre = ? WHERE id = ?', [horaCierre, id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/comandas/reabrir', async (req, res) => {
    try {
        const { id } = req.body;
        await db.run('UPDATE control_comandas SET estatus = 0, fecha_cierre = NULL WHERE id = ?', [id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/comandas_sistema/purgar_historial', async (req, res) => {
    try {
        await db.run('DELETE FROM control_comandas WHERE estatus = 1');
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reportes', async (req, res) => {
    try {
        const { inicio, fin } = req.query;
        let queryHistorial = 'SELECT * FROM historial_ventas';
        let params = [];

        if (inicio && fin) {
            queryHistorial += ' WHERE date(fecha, "localtime") BETWEEN ? AND ?';
            params = [inicio, fin];
        }
        queryHistorial += ' ORDER BY fecha DESC';

        const ventas = await db.all(queryHistorial, params);
        const productosDb = await db.all('SELECT nombre, costo FROM productos');
        const costosMap = {};
        productosDb.forEach(p => costosMap[p.nombre] = p.costo);

        let ingresos = 0, gastos = 0;
        const resumenProd = {};

        ventas.forEach(v => {
            ingresos += v.total;
            const lineas = v.detalle.split('<br>');
            lineas.forEach(linea => {
                const match = linea.match(/• (\d+)x (.*?) \(/);
                if (match) {
                    const cant = parseInt(match[1]);
                    const nombre = match[2].trim();
                    resumenProd[nombre] = (resumenProd[nombre] || 0) + cant;
                    gastos += ((costosMap[nombre] || 0) * cant);
                }
            });
        });

        res.json({
            ventas,
            metricas: { ingresos, gastos, ganancia: ingresos - gastos },
            resumenProductos: Object.entries(resumenProd)
                .map(([nombre, cantidad]) => ({ nombre, cantidad }))
                .sort((a, b) => b.cantidad - a.cantidad)
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/sistema/pin', async (req, res) => {
    try {
        const row = await db.get("SELECT valor FROM variables_sistema WHERE clave = 'pin_admin'");
        res.json({ pin: row ? row.valor : '1234' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/sistema/pin', async (req, res) => {
    try {
        const { nuevoPin } = req.body;
        if (!nuevoPin || nuevoPin.trim().length === 0) return res.status(400).json({ error: "PIN inválido" });
        await db.run("UPDATE variables_sistema SET valor = ? WHERE clave = 'pin_admin'", [nuevoPin.trim()]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sistema/verificar_pin', async (req, res) => {
    try {
        const { pin } = req.body;
        const row = await db.get("SELECT valor FROM variables_sistema WHERE clave = 'pin_admin'");
        if (row && row.valor === pin.toString().trim()) {
            return res.json({ valido: true });
        }
        res.json({ valido: false });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pedidos/cancelar_item', async (req, res) => {
    try {
        const { id, mesa, producto, modificadores, nota } = req.body;

        const result = await db.run('DELETE FROM pedidos_activos WHERE id = ? AND mesa = ?', [id, mesa]);

        if (result.changes > 0) {
            const modsTextoPlano = typeof modificadores === 'string'
                ? modificadores
                : JSON.stringify(modificadores || []);

            const comandaHeader = await db.all('SELECT id FROM control_comandas WHERE mesa = ? AND estatus = 0', [mesa]);

            for (let c of comandaHeader) {
                await db.run(`
                    DELETE FROM items_comanda 
                    WHERE id IN (
                        SELECT id FROM items_comanda 
                        WHERE comanda_id = ? AND producto = ? AND modificadores = ? AND nota = ? 
                        LIMIT 1
                    )
                `, [c.id, producto, modsTextoPlano, nota]);

                const restantes = await db.get('SELECT COUNT(*) as cuenta FROM items_comanda WHERE comanda_id = ?', [c.id]);
                if (restantes && restantes.cuenta === 0) {
                    await db.run('DELETE FROM control_comandas WHERE id = ?', [c.id]);
                }
            }
            return res.json({ success: true });
        }
        res.status(404).json({ success: false, error: "No se encontró el artículo a cancelar" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sistema/modos_pantalla', async (req, res) => {
    try {
        const cocina = await db.get("SELECT valor FROM variables_sistema WHERE clave = 'modo_pantalla_cocina'");
        const barra = await db.get("SELECT valor FROM variables_sistema WHERE clave = 'modo_pantalla_barra'");
        res.json({
            cocina: cocina ? cocina.valor : 'tablet',
            barra: barra ? barra.valor : 'tablet'
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/sistema/modos_pantalla', async (req, res) => {
    try {
        const { cocina, barra } = req.body;
        if (cocina) await db.run("UPDATE variables_sistema SET valor = ? WHERE clave = 'modo_pantalla_cocina'", [cocina]);
        if (barra) await db.run("UPDATE variables_sistema SET valor = ? WHERE clave = 'modo_pantalla_barra'", [barra]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/reportes/reimprimir', async (req, res) => {
    try {
        const { id } = req.body;
        if (!id) return res.status(400).json({ error: "Falta el ID de la venta" });

        const venta = await db.get('SELECT * FROM historial_ventas WHERE id = ?', [id]);
        if (!venta) return res.status(404).json({ error: "No se encontró el registro de venta" });

        const fechaTicketOriginal = new Date(venta.fecha + "Z").toLocaleString('es-MX', { hour12: false });
        const lineasReimpresion = venta.detalle.split('<br>').map(l => l.replace(/^•\s*/, ''));

        await imprimirTicketFisico({
            titulo: '*** REIMPRESIÓN DE TICKET ***',
            mesa: venta.mesa,
            fecha: fechaTicketOriginal,
            lineas: lineasReimpresion,
            totalTexto: `TOTAL COBRADO: $${venta.total.toFixed(2)}`,
            tipoTicket: 'REIMPRESION'
        });

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/categorias/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { nombre } = req.body;
        if (!nombre || nombre.trim().length === 0) {
            return res.status(400).json({ error: "El nombre no puede estar vacío" });
        }
        await db.run('UPDATE categorias SET nombre = ? WHERE id = ?', [nombre.trim(), id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/subcategorias/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { nombre } = req.body;
        if (!nombre || nombre.trim().length === 0) {
            return res.status(400).json({ error: "El nombre no puede estar vacío" });
        }
        await db.run('UPDATE subcategorias SET nombre = ? WHERE id = ?', [nombre.trim(), id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/sistema/siguiente_llevar', async (req, res) => {
    try {
        const row = await db.get("SELECT valor FROM variables_sistema WHERE clave = 'consecutivo_llevar'");
        let actual = row ? parseInt(row.valor) : 0;
        let siguiente = actual + 1;
        res.json({ numero: siguiente });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/sistema/ejecutar_corte', async (req, res) => {
    try {
        const ventasJornada = await db.all('SELECT * FROM historial_ventas WHERE corte_id = 0 ORDER BY fecha ASC');

        if (ventasJornada.length === 0) {
            return res.status(400).json({ error: "No hay ventas registradas en esta jornada para realizar un corte." });
        }

        const formatearLocal = (fechaUtc) => {
            return new Date(fechaUtc + "Z").toLocaleString('es-MX', {
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit',
                hour12: false
            });
        };

        const fechaPrimerTicket = formatearLocal(ventasJornada[0].fecha);
        const fechaUltimoTicket = formatearLocal(ventasJornada[ventasJornada.length - 1].fecha);

        const productosDb = await db.all('SELECT nombre, costo FROM productos');
        const costosMap = {};
        productosDb.forEach(p => costosMap[p.nombre] = p.costo);

        let ingresos = 0, gastos = 0;
        const resumenProd = {};

        ventasJornada.forEach(v => {
            ingresos += v.total;
            const lineas = v.detalle.split('<br>');
            lineas.forEach(linea => {
                const match = linea.match(/• (\d+)x (.*)/);
                if (match) {
                    const cant = parseInt(match[1]);
                    const nombre = match[2].split('($')[0].trim();
                    resumenProd[nombre] = (resumenProd[nombre] || 0) + cant;
                    gastos += ((costosMap[nombre] || 0) * cant);
                }
            });
        });

        const ganancia = ingresos - gastos;
        const detalleVentasJson = JSON.stringify(Object.entries(resumenProd).map(([nombre, cantidad]) => ({ nombre, cantidad })));

        const fechaCorteLocal = new Date().toISOString();

        const resultadoCorte = await db.run(`
            INSERT INTO cortes_caja (fecha_corte, fecha_primer_ticket, fecha_ultimo_ticket, ingresos, gastos, ganancia, detalle_ventas)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [fechaCorteLocal, fechaPrimerTicket, fechaUltimoTicket, ingresos, gastos, ganancia, detalleVentasJson]);

        const nuevoCorteId = resultadoCorte.lastID;

        await db.run('UPDATE historial_ventas SET corte_id = ? WHERE corte_id = 0', [nuevoCorteId]);

        await db.run("UPDATE variables_sistema SET valor = '0' WHERE clave = 'consecutivo_llevar'");

        res.json({ success: true, corte_id: nuevoCorteId, total: ingresos });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/sistema/historial_cortes', async (req, res) => {
    try {
        const cortes = await db.all('SELECT * FROM cortes_caja ORDER BY id DESC');
        res.json(cortes);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/sistema/ventas_corte/:corte_id', async (req, res) => {
    try {
        const { corte_id } = req.params;
        const ventas = await db.all('SELECT * FROM historial_ventas WHERE corte_id = ? ORDER BY fecha DESC', [corte_id]);
        res.json(ventas);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(3000, '0.0.0.0', () => console.log("🚀 Servidor Tukan activo en puerto 3000"));