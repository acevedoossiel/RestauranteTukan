const express = require('express');
const cors = require('cors');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');

const os = require('os');
const fs = require('fs');
const { exec } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

let ipLocalReal = 'localhost'; 
const interfaces = os.networkInterfaces();

for (let devName in interfaces) {
    interfaces[devName].forEach((iface) => {
        // Buscamos una IP IPv4 que no sea interna (127.0.0.1) y que sea de red local común (192.168.x.x o 10.x.x.x)
        if (iface.family === 'IPv4' && !iface.internal && (iface.address.startsWith('192.168.') || iface.address.startsWith('10.'))) {
            ipLocalReal = iface.address;
        }
    });
}

// Sobrescribimos el archivo config.js con la IP fresca del día automáticamente
const contenidoConfig = `const CONFIG = {\n    API_URL: 'http://${ipLocalReal}:3000'\n};`;
fs.writeFileSync('./config.js', contenidoConfig, 'utf8');

console.log("\n=========================================================");
console.log(`✨ IP DETECTADA: ${ipLocalReal}`);
console.log(`📱 MESEROS DEBEN CONECTARSE A: http://${ipLocalReal}:3000/index.html`);
console.log("=========================================================\n");

let db;

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
    `);

    const pinExistente = await db.get("SELECT valor FROM variables_sistema WHERE clave = 'pin_admin'");
    if (!pinExistente) {
        await db.run("INSERT INTO variables_sistema (clave, valor) VALUES ('pin_admin', '1234')");
    }

    // --- NUEVAS CONFIGURACIONES PERSISTENTES DE PANTALLA ---
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
    if (user === "admin" && pass === "123456") {
        res.json({ success: true, token: "TOKEN_" + Math.random().toString(36).substr(2) });
    } else {
        res.status(401).json({ success: false });
    }
});


// app.post('/enviar_comanda', async (req, res) => {
//     const { mesa, items } = req.body;
    
//     // Generamos una semilla de tiempo base
//     let timestampBase = Date.now();
//     let elementosCocina = [];
//     let elementosBarra = [];

//     for (let item of items) {
//         const prod = await db.get('SELECT destino FROM productos WHERE nombre = ?', [item.base]);
//         const destino = prod ? prod.destino : 'cocina';

//         const modsTexto = JSON.stringify(item.modificadores || []);
//         const notaTexto = item.nota || "";

//         await db.run(`
//             INSERT INTO pedidos_activos (mesa, producto, itemBase, modificadores, nota, destino) 
//             VALUES (?, ?, ?, ?, ?, ?)`, 
//             [mesa, item.display, item.base, modsTexto, notaTexto, destino]
//         );

//         const objetoParaPantalla = {
//             producto: item.display,
//             modificadores: item.modificadores || [],
//             nota: notaTexto,
//             completado: false
//         };

//         if (destino === 'barra') {
//             elementosBarra.push(objetoParaPantalla);
//         } else {
//             elementosCocina.push(objetoParaPantalla);
//         }
//     }

//     // --- CORRECCIÓN CLAVE: IDs 100% UNICOS POR DESTINO ---
//     if (elementosCocina.length > 0) {
//         comandasCocinaActivas.push({
//             id: `CMD-${timestampBase}-COC`, // Sufijo único para cocina
//             mesa: mesa,
//             fecha: new Date().toLocaleTimeString(),
//             items: elementosCocina
//         });
//     }

//     if (elementosBarra.length > 0) {
//         comandasBarraActivas.push({
//             id: `CMD-${timestampBase}-BAR`, // Sufijo único para barra
//             mesa: mesa,
//             fecha: new Date().toLocaleTimeString(),
//             items: elementosBarra
//         });
//     }

//     res.json({ status: "ok" });
// });


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

            await db.run(`
                INSERT INTO pedidos_activos (mesa, producto, itemBase, modificadores, nota, destino) 
                VALUES (?, ?, ?, ?, ?, ?)`, 
                [mesa, item.display, item.base, modsTexto, notaTexto, destino]
            );

            const itemFormateado = {
                producto: item.display,
                modificadores: modsTexto,
                nota: notaTexto
            };

            if (destino === 'barra') { elementosBarra.push(itemFormateado); } 
            else { elementosCocina.push(itemFormateado); }
        }

        // Persistencia directa en SQLite para pantallas informativas
        if (elementosCocina.length > 0) {
            const idCocina = `CMD-${timestampBase}-COC`;
            await db.run('INSERT INTO control_comandas (id, mesa, fecha, destino, estatus) VALUES (?, ?, ?, "cocina", 0)', [idCocina, mesa, horaActual]);
            for(let ic of elementosCocina) {
                await db.run('INSERT INTO items_comanda (comanda_id, producto, modificadores, nota) VALUES (?, ?, ?, ?)', [idCocina, ic.producto, ic.modificadores, ic.nota]);
            }
        }

        if (elementosBarra.length > 0) {
            const idBarra = `CMD-${timestampBase}-BAR`;
            await db.run('INSERT INTO control_comandas (id, mesa, fecha, destino, estatus) VALUES (?, ?, ?, "barra", 0)', [idBarra, mesa, horaActual]);
            for(let ib of elementosBarra) {
                await db.run('INSERT INTO items_comanda (comanda_id, producto, modificadores, nota) VALUES (?, ?, ?, ?)', [idBarra, ib.producto, ib.modificadores, ib.nota]);
            }
        }

        res.json({ status: "ok" });
    } catch (e) { res.status(500).json({ error: e.message }); }
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

// app.get('/api/comandas/cocina', (req, res) => res.json(comandasCocinaActivas));
// app.get('/api/comandas/barra', (req, res) => res.json(comandasBarraActivas));
// --- ENDPOINT ESPECÍFICO PARA MONITOR DE COCINA (LEE DESDE SQLITE) ---
app.get('/api/comandas/cocina', async (req, res) => {
    try {
        // Trae las comandas informativas de cocina que estén activas (estatus = 0)
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
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// --- ENDPOINT ESPECÍFICO PARA MONITOR DE BARRA (LEE DESDE SQLITE) ---
app.get('/api/comandas/barra', async (req, res) => {
    try {
        // Trae las comandas informativas de barra que estén activas (estatus = 0)
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
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/comandas/historial', (req, res) => res.json(historialComandasCompletadas));


// app.post('/api/comandas/completar', (req, res) => {
//     const { id, destino } = req.body;
//     let lista = destino === 'barra' ? comandasBarraActivas : comandasCocinaActivas;
    
//     const index = lista.findIndex(c => c.id === id);
//     if (index > -1) {
//         const [comanda] = lista.splice(index, 1);
//         comanda.destinoCierre = destino;
//         comanda.fechaCierre = new Date().toLocaleTimeString();
        
//         // Evitamos duplicar en el historial si por alguna razón la comanda ya existía con el mismo ID
//         const yaExisteEnHistorial = historialComandasCompletadas.some(h => h.id === comanda.id);
//         if (!yaExisteEnHistorial) {
//             historialComandasCompletadas.push(comanda);
//         }
//     }
//     res.json({ success: true });
// });

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

// app.post('/api/cobrar_parcial', async (req, res) => {
//     const { mesa, itemsACobrar } = req.body; 
    
//     if (!itemsACobrar || itemsACobrar.length === 0) {
//         return res.status(400).json({ error: "No se seleccionaron elementos para cobrar" });
//     }

//     try {
//         let totalParcial = 0;
//         let lineasDetalle = [];
//         let idsParaEliminar = [];

//         for (let item of itemsACobrar) {
//             const prodEnDb = await db.get('SELECT precio FROM productos WHERE nombre = ?', [item.itemBase]);
//             let precioBase = prodEnDb ? prodEnDb.precio : 0;
            
//             let precioModificadores = 0;
//             const mods = JSON.parse(item.modificadores || '[]');
//             mods.forEach(m => precioModificadores += parseFloat(m.precio_extra || 0));

//             let precioFinalItem = precioBase + precioModificadores;
//             totalParcial += precioFinalItem;
//             idsParaEliminar.push(item.id);

//             let textoItem = `• 1x ${item.producto} ($${precioFinalItem.toFixed(2)})`;
//             if (mods.length > 0) textoItem += ` [${mods.map(m=>m.nombre).join(', ')}]`;
//             lineasDetalle.push(textoItem);
//         }

//         // const detalleTicketParcial = lineasDetalle.join("<br>");
//         // const avisoTicket = `
//         //     *** COBRO PARCIAL ***<br>
//         //     MESA/FOLIO: ${mesa}<br>
//         //     ----------------------<br>
//         //     ${detalleTicketParcial}<br>
//         //     ----------------------<br>
//         //     TOTAL PERSONA: $${totalParcial.toFixed(2)}<br>
//         //     ¡GRACIAS POR SU VISITA!
//         // `;

//         // ultimaComandaParaCocina = avisoTicket;
//         // ultimaComandaParaBarra = avisoTicket;

//         // await db.run('INSERT INTO historial_ventas (mesa, total, detalle) VALUES (?, ?, ?)', 
//         //     [`${mesa} (PARCIAL)`, totalParcial, detalleTicketParcial]
//         // );

//         // const placeholders = idsParaEliminar.map(() => '?').join(',');
//         // await db.run(`DELETE FROM pedidos_activos WHERE id IN (${placeholders})`, idsParaEliminar);

//         // res.json({ success: true, total: totalParcial });
//         const detalleTicketParcial = lineasDetalle.join("<br>");
//         const avisoTicket = `
//             *** COBRO PARCIAL ***<br>
//             MESA/FOLIO: ${mesa}<br>
//             ----------------------<br>
//             ${detalleTicketParcial}<br>
//             ----------------------<br>
//             TOTAL PERSONA: $${totalParcial.toFixed(2)}<br>
//             ¡GRACIAS POR SU VISITA!
//         `;

//         // Inyectamos a la cola síncrona
//         colaRecibosImpresion.push({
//             id: "REC-PAR-" + Date.now(),
//             mesa: mesa,
//             tipo: "RECIBO PARCIAL",
//             html: avisoTicket
//         });

//         await db.run('INSERT INTO historial_ventas (mesa, total, detalle) VALUES (?, ?, ?)', 
//             [`${mesa} (PARCIAL)`, totalParcial, detalleTicketParcial]
//         );

//         const placeholders = idsParaEliminar.map(() => '?').join(',');
//         await db.run(`DELETE FROM pedidos_activos WHERE id IN (${placeholders})`, idsParaEliminar);

//         res.json({ success: true, total: totalParcial });

//     } catch (err) {
//         res.status(500).json({ error: err.message });
//     }
// });

app.post('/api/cobrar_parcial', async (req, res) => {
    const { mesa, itemsACobrar } = req.body; 
    
    if (!itemsACobrar || itemsACobrar.length === 0) {
        return res.status(400).json({ error: "No se seleccionaron elementos para cobrar" });
    }

    try {
        let totalParcial = 0;
        let idsParaEliminar = [];
        
        // Objeto intermedio para agrupar en tiempo real
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

            // Generamos una llave única combinando el producto y sus modificadores
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

        // Construimos las líneas del ticket con el formato x2, x3 agrupado
        let lineasDetalle = Object.values(productosAgrupados).map(p => {
            let texto = `• ${p.cantidad}x ${p.producto} ($${p.subtotal.toFixed(2)})`;
            if (p.detalleMods) texto += ` [${p.detalleMods}]`;
            return texto;
        });

        const detalleTicketParcial = lineasDetalle.join("<br>");
        const avisoTicket = `
            *** COBRO PARCIAL ***<br>
            MESA/FOLIO: ${mesa}<br>
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

// app.post('/cerrar_cuenta', async (req, res) => {
//     const { mesa } = req.body;
//     const items = await db.all('SELECT * FROM pedidos_activos WHERE mesa = ?', [mesa]);
    
//     if (items.length > 0) {
//         let total = 0;
//         let lineasDetalle = [];

//         for (let item of items) {
//             const prodEnDb = await db.get('SELECT precio FROM productos WHERE nombre = ?', [item.itemBase]);
//             let precioBase = prodEnDb ? prodEnDb.precio : 0;
            
//             let precioModificadores = 0;
//             const mods = JSON.parse(item.modificadores || '[]');
//             mods.forEach(m => precioModificadores += parseFloat(m.precio_extra || 0));

//             let precioFinalItem = precioBase + precioModificadores;
//             total += precioFinalItem;

//             let textoItem = `• 1x ${item.producto} ($${precioFinalItem.toFixed(2)})`;
//             if (mods.length > 0) textoItem += ` [${mods.map(m=>m.nombre).join(', ')}]`;
//             if (item.nota) textoItem += ` *Nota: ${item.nota}`;
            
//             lineasDetalle.push(textoItem);
//         }

//         // const detalleTicket = lineasDetalle.join("<br>");

//         // await db.run('INSERT INTO historial_ventas (mesa, total, detalle) VALUES (?, ?, ?)', [mesa, total, detalleTicket]);
//         // await db.run('DELETE FROM pedidos_activos WHERE mesa = ?', [mesa]);
//         // await db.run('DELETE FROM control_comandas WHERE mesa = ?', [mesa]);
        
//         // res.json({ total, detalle: detalleTicket });
//         const detalleTicket = lineasDetalle.join("<br>");

//         const ticketHtmlCompleto = `
//             *** CUENTA TOTAL ***<br>
//             MESA/FOLIO: ${mesa}<br>
//             ----------------------<br>
//             ${detalleTicket}<br>
//             ----------------------<br>
//             TOTAL GENERAL: $${total.toFixed(2)}<br>
//             ¡GRACIAS POR SU VISITA!
//         `;

//         colaRecibosImpresion.push({
//             id: "REC-TOT-" + Date.now(),
//             mesa: mesa,
//             tipo: "CUENTA TOTAL",
//             html: ticketHtmlCompleto
//         });

//         await db.run('INSERT INTO historial_ventas (mesa, total, detalle) VALUES (?, ?, ?)', [mesa, total, detalleTicket]);
//         await db.run('DELETE FROM pedidos_activos WHERE mesa = ?', [mesa]);
//         await db.run('DELETE FROM control_comandas WHERE mesa = ?', [mesa]);
        
//         res.json({ total, detalle: detalleTicket });
//     } else {
//         res.json({ total: 0 });
//     }
// });

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
            // Agregamos la nota a la llave para que si una hamburguesa lleva nota y otra no, salgan en renglones separados
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
            if (p.detalleMods) texto += ` [${p.detalleMods}]`;
            if (p.nota) texto += ` *Nota: ${p.nota}`;
            return texto;
        });

        const detalleTicket = lineasDetalle.join("<br>");

        const ticketHtmlCompleto = `
            *** CUENTA TOTAL ***<br>
            MESA/FOLIO: ${mesa}<br>
            ----------------------<br>
            ${detalleTicket}<br>
            ----------------------<br>
            TOTAL GENERAL: $${total.toFixed(2)}<br>
            ¡GRACIAS POR SU VISITA!
        `;

        colaRecibosImpresion.push({
            id: "REC-TOT-" + Date.now(),
            mesa: mesa,
            tipo: "CUENTA TOTAL",
            html: ticketHtmlCompleto
        });

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
    
    for(let p of productos) {
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
    } catch(e) { res.status(400).json({ error: "Mesa ya existe" }); }
});

// app.post('/api/comandas/reabrir', async (req, res) => {
//     const { mesa, items, destinoOrigen } = req.body;
    
//     let timestampBase = Date.now();
//     let elementosFiltrados = [];

//     for (let item of items) {
//         const modsTexto = JSON.stringify(item.modificadores || []);
//         const notaTexto = item.nota || "";

//         await db.run(`
//             INSERT INTO pedidos_activos (mesa, producto, itemBase, modificadores, nota, destino) 
//             VALUES (?, ?, ?, ?, ?, ?)`, 
//             [mesa, item.display, item.base, modsTexto, notaTexto, destinoOrigen]
//         );

//         elementosFiltrados.push({
//             producto: item.display,
//             modificadores: item.modificadores || [],
//             nota: notaTexto,
//             completado: false
//         });
//     }

//     if (destinoOrigen === 'barra') {
//         comandasBarraActivas.push({
//             id: `CMD-${timestampBase}-BAR`,
//             mesa: mesa,
//             fecha: new Date().toLocaleTimeString(),
//             items: elementosFiltrados
//         });
//     } else {
//         comandasCocinaActivas.push({
//             id: `CMD-${timestampBase}-COC`,
//             mesa: mesa,
//             fecha: new Date().toLocaleTimeString(),
//             items: elementosFiltrados
//         });
//     }

//     res.json({ success: true });
// });


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
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// --- NUEVA RUTA PARA EL HISTORIAL DESDE DB (LIMITADO A LAS ÚLTIMAS 20) ---
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
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// --- COMPLETAR COMANDA (CAMBIA ESTATUS A 1) ---
app.post('/api/comandas/completar', async (req, res) => {
    try {
        const { id } = req.body;
        let horaCierre = new Date().toLocaleTimeString();
        await db.run('UPDATE control_comandas SET estatus = 1, fecha_cierre = ? WHERE id = ?', [horaCierre, id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});


// app.post('/api/comandas/reabrir', async (req, res) => {
//     const { mesa, items, destinoOrigen } = req.body;
    
//     let timestampBase = Date.now();
//     let elementosFiltrados = [];

//     // NOTA DE BLINDAJE: Eliminamos el INSERT INTO pedidos_activos para no alterar JAMÁS la cuenta del cliente.
//     for (let item of items) {
//         elementosFiltrados.push({
//             producto: item.display,
//             modificadores: item.modificadores || [],
//             nota: item.nota || "",
//             completado: false
//         });
//     }

//     // Retorna los productos de manera única a la memoria RAM de su respectiva pantalla
//     if (destinoOrigen === 'barra') {
//         comandasBarraActivas.push({
//             id: `CMD-${timestampBase}-BAR`,
//             mesa: mesa,
//             fecha: new Date().toLocaleTimeString(),
//             items: elementosFiltrados
//         });
//     } else {
//         comandasCocinaActivas.push({
//             id: `CMD-${timestampBase}-COC`,
//             mesa: mesa,
//             fecha: new Date().toLocaleTimeString(),
//             items: elementosFiltrados
//         });
//     }

//     res.json({ success: true });
// });

app.post('/api/comandas/reabrir', async (req, res) => {
    try {
        const { id } = req.body;
        await db.run('UPDATE control_comandas SET estatus = 0, fecha_cierre = NULL WHERE id = ?', [id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/comandas_sistema/purgar_historial', async (req, res) => {
    try {
        await db.run('DELETE FROM control_comandas WHERE estatus = 1');
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
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

// --- OBTENER PIN ACTUAL ---
app.get('/api/sistema/pin', async (req, res) => {
    try {
        const row = await db.get("SELECT valor FROM variables_sistema WHERE clave = 'pin_admin'");
        res.json({ pin: row ? row.valor : '1234' });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// --- ACTUALIZAR PIN ---
app.put('/api/sistema/pin', async (req, res) => {
    try {
        const { nuevoPin } = req.body;
        if (!nuevoPin || nuevoPin.trim().length === 0) return res.status(400).json({ error: "PIN inválido" });
        await db.run("UPDATE variables_sistema SET valor = ? WHERE clave = 'pin_admin'", [nuevoPin.trim()]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// --- VERIFICAR PIN ---
app.post('/api/sistema/verificar_pin', async (req, res) => {
    try {
        const { pin } = req.body;
        const row = await db.get("SELECT valor FROM variables_sistema WHERE clave = 'pin_admin'");
        if (row && row.valor === pin.toString().trim()) {
            return res.json({ valido: true });
        }
        res.json({ valido: false });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// --- ELIMINAR ARTÍCULO YA ENVIADO (CON AUTORIZACIÓN DE PIN) ---
// app.post('/api/pedidos/cancelar_item', async (req, res) => {
//     try {
//         const { id, mesa, producto, modificadores, nota } = req.body;

//         // 1. Eliminamos estrictamente UN solo ítem que coincida con ese ID único de la cuenta de la mesa
//         const result = await db.run('DELETE FROM pedidos_activos WHERE id = ? AND mesa = ?', [id, mesa]);
        
//         if (result.changes > 0) {
//             // 2. Buscamos en las comandas informativas activas (estatus = 0) de la mesa si hay registros de ese producto
//             // para limpiarlo de la pantalla de barra/cocina si aún no se ha completado.
//             const comandaHeader = await db.all('SELECT id FROM control_comandas WHERE mesa = ? AND estatus = 0', [mesa]);
            
//             for (let c of comandaHeader) {
//                 // Borramos un elemento coincidente de los items de la comanda en disco
//                 await db.run(`
//                     DELETE FROM items_comanda 
//                     WHERE id IN (
//                         SELECT id FROM items_comanda 
//                         WHERE comanda_id = ? AND producto = ? AND modificadores = ? AND nota = ? 
//                         LIMIT 1
//                     )
//                 `, [c.id, producto, modificadores, nota]);

//                 // Si por consecuencia la comanda se quedó sin ningún platillo adentro, la borramos por completo
//                 const restantes = await db.get('SELECT COUNT(*) as cuenta FROM items_comanda WHERE comanda_id = ?', [c.id]);
//                 if (restantes && restantes.cuenta === 0) {
//                     await db.run('DELETE FROM control_comandas WHERE id = ?', [c.id]);
//                 }
//             }
//             return res.json({ success: true });
//         }
//         res.status(404).json({ success: false, error: "No se encontró el artículo a cancelar" });
//     } catch(e) { res.status(500).json({ error: e.message }); }
// });

// --- ELIMINAR ARTÍCULO YA ENVIADO (CON AUTORIZACIÓN DE PIN SANITIZADO) ---
app.post('/api/pedidos/cancelar_item', async (req, res) => {
    try {
        const { id, mesa, producto, modificadores, nota } = req.body;

        // 1. Eliminamos estrictamente UN solo ítem que coincida con ese ID único de la cuenta de la mesa
        const result = await db.run('DELETE FROM pedidos_activos WHERE id = ? AND mesa = ?', [id, mesa]);
        
        if (result.changes > 0) {
            // CORRECCIÓN EN SERVER: Si los modificadores llegan como objeto/arreglo, los convertimos a String plano de JSON
            const modsTextoPlano = typeof modificadores === 'string' 
                ? modificadores 
                : JSON.stringify(modificadores || []);

            // 2. Buscamos en las comandas informativas activas (estatus = 0) de la mesa si hay registros de ese producto
            // para limpiarlo de la pantalla de barra/cocina si aún no se ha completado.
            const comandaHeader = await db.all('SELECT id FROM control_comandas WHERE mesa = ? AND estatus = 0', [mesa]);
            
            for (let c of comandaHeader) {
                // Borramos un elemento coincidente de los items de la comanda en disco usando el string plano
                await db.run(`
                    DELETE FROM items_comanda 
                    WHERE id IN (
                        SELECT id FROM items_comanda 
                        WHERE comanda_id = ? AND producto = ? AND modificadores = ? AND nota = ? 
                        LIMIT 1
                    )
                `, [c.id, producto, modsTextoPlano, nota]);

                // Si por consecuencia la comanda se quedó sin ningún platillo adentro, la borramos por completo
                const restantes = await db.get('SELECT COUNT(*) as cuenta FROM items_comanda WHERE comanda_id = ?', [c.id]);
                if (restantes && restantes.cuenta === 0) {
                    await db.run('DELETE FROM control_comandas WHERE id = ?', [c.id]);
                }
            }
            return res.json({ success: true });
        }
        res.status(404).json({ success: false, error: "No se encontró el artículo a cancelar" });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// --- OBTENER CONFIGURACIÓN DE MODOS DE PRODUCCIÓN ---
app.get('/api/sistema/modos_pantalla', async (req, res) => {
    try {
        const cocina = await db.get("SELECT valor FROM variables_sistema WHERE clave = 'modo_pantalla_cocina'");
        const barra = await db.get("SELECT valor FROM variables_sistema WHERE clave = 'modo_pantalla_barra'");
        res.json({
            cocina: cocina ? cocina.valor : 'tablet',
            barra: barra ? barra.valor : 'tablet'
        });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// --- ACTUALIZAR CONFIGURACIÓN DE MODOS DE PRODUCCIÓN ---
app.put('/api/sistema/modos_pantalla', async (req, res) => {
    try {
        const { cocina, barra } = req.body;
        if (cocina) await db.run("UPDATE variables_sistema SET valor = ? WHERE clave = 'modo_pantalla_cocina'", [cocina]);
        if (barra) await db.run("UPDATE variables_sistema SET valor = ? WHERE clave = 'modo_pantalla_barra'", [barra]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sistema/cola_recibos', (req, res) => {
    res.json(colaRecibosImpresion);
});

app.delete('/api/sistema/cola_recibos/:id', (req, res) => {
    const { id } = req.params;
    colaRecibosImpresion = colaRecibosImpresion.filter(r => r.id !== id);
    res.json({ success: true });
});

// --- ENDPOINT PARA REIMPRIMIR UN TICKET DESDE EL HISTORIAL DE VENTAS ---
app.post('/api/reportes/reimprimir', async (req, res) => {
    try {
        const { id } = req.body;
        if (!id) return res.status(400).json({ error: "Falta el ID de la venta" });

        // Buscamos la venta original grabada de forma permanente en disco
        const venta = await db.get('SELECT * FROM historial_ventas WHERE id = ?', [id]);
        if (!venta) return res.status(404).json({ error: "No se encontró el registro de venta" });

        // Reconstruimos el diseño exacto corporativo de El Tukan
        const avisoTicket = `
            *** REIMPRESIÓN DE TICKET ***<br>
            MESA/FOLIO: ${venta.mesa}<br>
            ----------------------<br>
            ${venta.detalle}<br>
            ----------------------<br>
            TOTAL COBRADO: $${venta.total.toFixed(2)}<br>
            ¡GRACIAS POR SU VISITA!
        `;

        // Empujamos el ticket a la cola de impresión síncrona de la barra
        colaRecibosImpresion.push({
            id: "REC-REIMP-" + Date.now(),
            mesa: venta.mesa,
            tipo: "REIMPRESION",
            html: avisoTicket
        });

        res.json({ success: true });
    } catch(e) { 
        res.status(500).json({ error: e.message }); 
    }
});

// --- ACTUALIZAR NOMBRE DE UNA CATEGORÍA PADRE ---
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

// --- ACTUALIZAR NOMBRE DE UNA SUBCATEGORÍA ---
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

app.listen(3000, '0.0.0.0', () => console.log("🚀 Servidor Tukan activo en puerto 3000"));
