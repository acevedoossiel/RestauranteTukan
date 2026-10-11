const express = require('express');
const cors = require('cors');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');

const os = require('os');
const fs = require('fs');
const { exec } = require('child_process');
const path = require('path');
const ptp = require('pdf-to-printer');
const htmlPdf = require('html-pdf-node');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

let ipLocalReal = 'localhost';
const interfaces = os.networkInterfaces();

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


async function imprimirTicketSilencioso(htmlContent, nombreImpresora) {
    try {
        const idUnico = `${Date.now()}_${Math.random().toString(36).substring(7)}`;
        const htmlTemp = path.join(os.tmpdir(), `ticket_${idUnico}.html`);
        const pdfTemp = path.join(os.tmpdir(), `ticket_${idUnico}.pdf`);

        const htmlFinal = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
    @page { 
        size: 80mm 200mm; 
        margin: 0 !important;; 
    }
    body {
        width: 72mm;
        margin: 0 !important;;
        padding: 4px;
        font-family: monospace;
        font-size: 20px;
        font-weight: bold;
        line-height: 1.3;
        color: black;
        background: white;
    }
    div, p, span {
        color: black !important;
    }
</style>
</head>
<body>
    ${htmlContent}
</body>
</html>`;

        fs.writeFileSync(htmlTemp, htmlFinal, 'utf8');

        const chromePath = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
            ? '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"'
            : '"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"';

        // Genera el PDF forzando fondo blanco y sin encabezados
        const comando = `${chromePath} --headless --disable-gpu --no-pdf-header-footer --print-to-pdf="${pdfTemp}" "${htmlTemp}"`;

        exec(comando, async (error) => {
            if (error) {
                console.error(`❌ Error generando PDF para ${nombreImpresora}:`, error.message);
                return;
            }

            try {
                // Envía el PDF directamente al driver de la impresora térmica
                await ptp.print(pdfTemp, {
                    printer: nombreImpresora
                });
            } catch (errPrint) {
                console.error(`❌ Error enviando a ${nombreImpresora}:`, errPrint.message);
            }

            setTimeout(() => {
                if (fs.existsSync(htmlTemp)) fs.unlinkSync(htmlTemp);
                if (fs.existsSync(pdfTemp)) fs.unlinkSync(pdfTemp);
            }, 10000);
        });
    } catch (err) {
        console.error(`❌ Error general en ${nombreImpresora}:`, err.message);
    }
}

let comandasCocinaActivas = [];
let comandasBarraActivas = [];
let historialComandasCompletadas = [];
let colaRecibosImpresion = [];


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


app.post('/enviar_comanda', async (req, res) => {
    try {
        const { mesa, items } = req.body;
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

        // 🖨️ Impresión Silenciosa por Backend
        const modoCocinaVal = await db.get("SELECT valor FROM variables_sistema WHERE clave = 'modo_pantalla_cocina'");
        const modoBarraVal = await db.get("SELECT valor FROM variables_sistema WHERE clave = 'modo_pantalla_barra'");

        if (elementosCocina.length > 0 && modoCocinaVal && modoCocinaVal.valor === 'impresora') {
            const itemsHtmlCocina = elementosCocina.map(i => {
                const mods = JSON.parse(i.modificadores || '[]');
                let sub = mods.map(m => `  + ${m.nombre}`).join('<br>');
                if (i.nota) sub += (sub ? '<br>' : '') + `  * NOTA: ${i.nota}`;
                return `<div style="font-weight: bold; font-size: 13px; text-transform: uppercase;">x1 ${i.display}</div>` +
                       (sub ? `<div style="font-size: 11px; margin-left: 12px; margin-bottom: 4px;">${sub}</div>` : '');
            }).join('<br>');

            const htmlCocina = `
                <div style="font-family: monospace; text-align: center; color: black; width: 100%;">
                    <p style="font-weight: bold; border-bottom: 1px solid black; padding-bottom: 4px; margin-bottom: 6px;">*** COMANDA COCINA ***</p>
                    <p style="font-size: 18px; font-weight: bold; text-transform: uppercase; margin: 4px 0;">${mesa}</p>
                    <p style="font-size: 14px; margin-bottom: 10px;">${new Date().toLocaleDateString('es-MX')} | ${horaActual}</p>
                    <div style="text-align: left; font-size: 12px; border-bottom: 1px solid black; padding-bottom: 6px; margin-bottom: 6px;">${itemsHtmlCocina}</div>
                    <p style="font-size: 12px; color: #555;">--- SISTEMA TUKAN POS ---</p>
                </div>
            `;
            imprimirTicketSilencioso(htmlCocina, 'COCINA');
        }

        if (elementosBarra.length > 0 && modoBarraVal && modoBarraVal.valor === 'impresora') {
            const itemsHtmlBarra = elementosBarra.map(i => {
                const mods = JSON.parse(i.modificadores || '[]');
                let sub = mods.map(m => `  + ${m.nombre}`).join('<br>');
                if (i.nota) sub += (sub ? '<br>' : '') + `  * NOTA: ${i.nota}`;
                return `<div style="font-weight: bold; font-size: 13px; text-transform: uppercase;">x1 ${i.display}</div>` +
                       (sub ? `<div style="font-size: 11px; margin-left: 12px; margin-bottom: 4px;">${sub}</div>` : '');
            }).join('<br>');

            const htmlBarra = `
                <div style="font-family: monospace; text-align: center; color: black; width: 100%;">
                    <p style="font-weight: bold; border-bottom: 1px solid black; padding-bottom: 4px; margin-bottom: 6px;">*** COMANDA BARRA ***</p>
                    <p style="font-size: 18px; font-weight: bold; text-transform: uppercase; margin: 4px 0;">${mesa}</p>
                    <p style="font-size: 14px; margin-bottom: 10px;">${new Date().toLocaleDateString('es-MX')} | ${horaActual}</p>
                    <div style="text-align: left; font-size: 12px; border-bottom: 1px solid black; padding-bottom: 6px; margin-bottom: 6px;">${itemsHtmlBarra}</div>
                </div>
            `;
            imprimirTicketSilencioso(htmlBarra, 'BARRA');
        }

        res.json({ status: "ok" });
    } catch (e) {
        await db.run('ROLLBACK');
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

app.get('/api/comandas/cocina', async (req, res) => {
    try {
        const comandasHeader = await db.all('SELECT * FROM control_comandas WHERE destino = "cocina" AND estatus = 0 ORDER BY id ASC');

        let resultado = [];
        for (let c of comandasHeader) {
            const dbItems = await db.all('SELECT * FROM items_comanda WHERE comanda_id = ?', [c.id]);
            resultado.push({
                id: c.id,
                mesa: c.mesa,
                fecha: c.fecha,
                items: dbItems.map(i => ({
                    producto: i.producto,
                    modificadores: JSON.parse(i.modificadores || '[]'),
                    nota: i.nota
                }))
            });
        }
        res.json(resultado);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/comandas/barra', async (req, res) => {
    try {
        const comandasHeader = await db.all('SELECT * FROM control_comandas WHERE destino = "barra" AND estatus = 0 ORDER BY id ASC');

        let resultado = [];
        for (let c of comandasHeader) {
            const dbItems = await db.all('SELECT * FROM items_comanda WHERE comanda_id = ?', [c.id]);
            resultado.push({
                id: c.id,
                mesa: c.mesa,
                fecha: c.fecha,
                items: dbItems.map(i => ({
                    producto: i.producto,
                    modificadores: JSON.parse(i.modificadores || '[]'),
                    nota: i.nota
                }))
            });
        }
        res.json(resultado);
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
        const avisoTicket = `
            *** COBRO PARCIAL ***<br>
            MESA: ${mesa}<br>
            FECHA: ${horaCobroParcialReal}<br>
            ----------------------<br>
            ${detalleTicketParcial}<br>
            ----------------------<br>
            TOTAL PERSONA: $${totalParcial.toFixed(2)}<br>
            ¡GRACIAS POR SU VISITA!
        `;

        colaRecibosImpresion.push({
            id: "REC-PAR-" + Date.now(),
            mesa: mesa,
            tipo: "RECIBO PARCIAL",
            html: avisoTicket
        });

        const rutaLogo = path.join(__dirname, 'resources', 'tukan-logo-ticket.png');
        const logoBase64 = fs.existsSync(rutaLogo) ? `data:image/png;base64,${fs.readFileSync(rutaLogo).toString('base64')}` : '';

        // const reciboHtmlImpresion = `
        //     <div style="font-family: monospace; text-align: center; color: black; width: 100%; line-height: 1.2;">
        //         ${logoBase64 ? `<img src="${logoBase64}" style="width: 120px; height: auto; margin-bottom: 4px;">` : ''}
        //         <p style="font-size: 11px; font-weight: bold; border-bottom: 1px solid black; padding-bottom: 2px; margin-bottom: 2px;">Insurgentes número 16, Tamazulapam Oax</p>
        //         <p style="font-size: 11px; font-weight: bold; border-bottom: 1px solid black; padding-bottom: 2px; margin-bottom: 6px;">Tel. 953 131 8564</p>
        //         <div style="text-align: left; border-bottom: 1px solid black; padding-bottom: 6px; margin-bottom: 6px; font-weight: bold; font-size: 11px; text-transform: uppercase;">${avisoTicket}</div>
        //     </div>
        // `;
        const reciboHtmlImpresion = `
            <div style="font-family: monospace; text-align: center; color: black; width: 100%; line-height: 1.2;">
                ${logoBase64 ? `<img src="${logoBase64}" style="width: 170px; height: auto; margin: 0 auto 6px auto; display: block;">` : ''}
                <p style="font-size: 12px; font-weight: bold; border-bottom: 1px solid black; padding-bottom: 2px; margin-bottom: 2px;">Insurgentes número 16, Tamazulapam Oax</p>
                <p style="font-size: 12px; font-weight: bold; border-bottom: 1px solid black; padding-bottom: 2px; margin-bottom: 6px;">Tel. 953 131 8564</p>
                <div style="text-align: left; border-bottom: 1px solid black; padding-bottom: 6px; margin-bottom: 6px; font-weight: bold; font-size: 16px; line-height: 1.3; text-transform: uppercase;">${avisoTicket}</div>
            </div>
        `;
        imprimirTicketSilencioso(reciboHtmlImpresion, 'BARRA');

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
    const { mesa } = req.body;
    const items = await db.all('SELECT * FROM pedidos_activos WHERE mesa = ?', [mesa]);

    if (items.length > 0) {
        let total = 0;
        const productosAgrupados = {};

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

        let lineasDetalle = Object.values(productosAgrupados).map(p => {
            let texto = `• ${p.cantidad}x ${p.producto} ($${p.subtotal.toFixed(2)})`;
            return texto;
        });

        const detalleTicket = lineasDetalle.join("<br>");
        const horaCobroReal = new Date().toLocaleString('es-MX', { hour12: false });

        const ticketHtmlCompleto = `
            *** CUENTA TOTAL ***<br>
            MESA: ${mesa}<br>
            FECHA: ${horaCobroReal}<br>
            ----------------------<br>
            ${detalleTicket}<br>
            ----------------------<br>
            TOTAL: $${total.toFixed(2)}<br>
            ¡GRACIAS POR SU VISITA!
        `;

        colaRecibosImpresion.push({
            id: "REC-TOT-" + Date.now(),
            mesa: mesa,
            tipo: "CUENTA TOTAL",
            html: ticketHtmlCompleto
        });

        const rutaLogo = path.join(__dirname, 'resources', 'tukan-logo-ticket.png');
        const logoBase64 = fs.existsSync(rutaLogo) ? `data:image/png;base64,${fs.readFileSync(rutaLogo).toString('base64')}` : '';

        // const reciboHtmlImpresion = `
        //     <div style="font-family: monospace; text-align: center; color: black; width: 100%; line-height: 1.1;">
        //         ${logoBase64 ? `<img src="${logoBase64}" style="width: 120px; height: auto; margin-bottom: 4px;">` : ''}
        //         <p style="font-size: 11px; font-weight: bold; border-bottom: 1px solid black; padding-bottom: 2px; margin-bottom: 2px;">Insurgentes número 16, Tamazulapam Oax</p>
        //         <p style="font-size: 11px; font-weight: bold; border-bottom: 1px solid black; padding-bottom: 2px; margin-bottom: 6px;">Tel. 953 131 8564</p>
        //         <div style="text-align: left; border-bottom: 1px solid black; padding-bottom: 6px; margin-bottom: 6px; font-weight: bold; font-size: 11px; text-transform: uppercase;">${ticketHtmlCompleto}</div>
        //     </div>
        // `;
        const reciboHtmlImpresion = `
            <div style="font-family: monospace; text-align: center; color: black; width: 100%; line-height: 1.2;">
                ${logoBase64 ? `<img src="${logoBase64}" style="width: 170px; height: auto; margin: 0 auto 6px auto; display: block;">` : ''}
                <p style="font-size: 12px; font-weight: bold; border-bottom: 1px solid black; padding-bottom: 2px; margin-bottom: 2px;">Insurgentes número 16, Tamazulapam Oax</p>
                <p style="font-size: 12px; font-weight: bold; border-bottom: 1px solid black; padding-bottom: 2px; margin-bottom: 6px;">Tel. 953 131 8564</p>
                <div style="text-align: left; border-bottom: 1px solid black; padding-bottom: 6px; margin-bottom: 6px; font-weight: bold; font-size: 16px; line-height: 1.3; text-transform: uppercase;">${ticketHtmlCompleto}</div>
            </div>
        `;
        imprimirTicketSilencioso(reciboHtmlImpresion, 'BARRA');

        await db.run('INSERT INTO historial_ventas (mesa, total, detalle) VALUES (?, ?, ?)', [mesa, total, detalleTicket]);
        await db.run('DELETE FROM pedidos_activos WHERE mesa = ?', [mesa]);
        await db.run('DELETE FROM control_comandas WHERE mesa = ?', [mesa]);

        res.json({ total, detalle: detalleTicket });
    } else {
        res.json({ total: 0 });
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

        let resultado = [];
        for (let c of comandasHeader) {
            const dbItems = await db.all('SELECT * FROM items_comanda WHERE comanda_id = ?', [c.id]);
            resultado.push({
                id: c.id,
                mesa: c.mesa,
                fecha: c.fecha,
                items: dbItems.map(i => ({ producto: i.producto, modificadores: JSON.parse(i.modificadores || '[]'), nota: i.nota }))
            });
        }
        res.json(resultado);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/comandas_sistema/historial', async (req, res) => {
    try {
        const comandasHeader = await db.all('SELECT * FROM control_comandas WHERE estatus = 1 ORDER BY fecha_cierre DESC LIMIT 20');
        let resultado = [];
        for (let c of comandasHeader) {
            const dbItems = await db.all('SELECT * FROM items_comanda WHERE comanda_id = ?', [c.id]);
            resultado.push({
                id: c.id,
                mesa: c.mesa,
                fecha: c.fecha,
                destinoCierre: c.destino,
                fechaCierre: c.fecha_cierre,
                items: dbItems.map(i => ({ producto: i.producto, modificadores: JSON.parse(i.modificadores || '[]'), nota: i.nota }))
            });
        }
        res.json(resultado);
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

app.get('/api/sistema/cola_recibos', (req, res) => {
    res.json(colaRecibosImpresion);
});

app.delete('/api/sistema/cola_recibos/:id', (req, res) => {
    const { id } = req.params;
    colaRecibosImpresion = colaRecibosImpresion.filter(r => r.id !== id);
    res.json({ success: true });
});

app.post('/api/reportes/reimprimir', async (req, res) => {
    try {
        const { id } = req.body;
        if (!id) return res.status(400).json({ error: "Falta el ID de la venta" });

        const venta = await db.get('SELECT * FROM historial_ventas WHERE id = ?', [id]);
        if (!venta) return res.status(404).json({ error: "No se encontró el registro de venta" });

        const fechaTicketOriginal = new Date(venta.fecha + "Z").toLocaleString('es-MX', { hour12: false });

        const avisoTicket = `
            *** REIMPRESIÓN DE TICKET ***<br>
            MESA: ${venta.mesa}<br>
            FECHA: ${fechaTicketOriginal}<br>
            ----------------------<br>
            ${venta.detalle}<br>
            ----------------------<br>
            TOTAL COBRADO: $${venta.total.toFixed(2)}<br>
            ¡GRACIAS POR SU VISITA!
        `;

        colaRecibosImpresion.push({
            id: "REC-REIMP-" + Date.now(),
            mesa: venta.mesa,
            tipo: "REIMPRESION",
            html: avisoTicket
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
