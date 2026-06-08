const express = require('express');
const cors = require('cors');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

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
    `);
    
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
        const numero = parseInt(req.params.numero);
        
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
        let lineasDetalle = [];
        let idsParaEliminar = [];

        for (let item of itemsACobrar) {
            const prodEnDb = await db.get('SELECT precio FROM productos WHERE nombre = ?', [item.itemBase]);
            let precioBase = prodEnDb ? prodEnDb.precio : 0;
            
            let precioModificadores = 0;
            const mods = JSON.parse(item.modificadores || '[]');
            mods.forEach(m => precioModificadores += parseFloat(m.precio_extra || 0));

            let precioFinalItem = precioBase + precioModificadores;
            totalParcial += precioFinalItem;
            idsParaEliminar.push(item.id);

            let textoItem = `• 1x ${item.producto} ($${precioFinalItem.toFixed(2)})`;
            if (mods.length > 0) textoItem += ` [Mod: ${mods.map(m=>m.nombre).join(', ')}]`;
            lineasDetalle.push(textoItem);
        }

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

        ultimaComandaParaCocina = avisoTicket;
        ultimaComandaParaBarra = avisoTicket;

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
        let lineasDetalle = [];

        for (let item of items) {
            const prodEnDb = await db.get('SELECT precio FROM productos WHERE nombre = ?', [item.itemBase]);
            let precioBase = prodEnDb ? prodEnDb.precio : 0;
            
            let precioModificadores = 0;
            const mods = JSON.parse(item.modificadores || '[]');
            mods.forEach(m => precioModificadores += parseFloat(m.precio_extra || 0));

            let precioFinalItem = precioBase + precioModificadores;
            total += precioFinalItem;

            let textoItem = `• 1x ${item.producto} ($${precioFinalItem.toFixed(2)})`;
            if (mods.length > 0) textoItem += ` [Mod: ${mods.map(m=>m.nombre).join(', ')}]`;
            if (item.nota) textoItem += ` *Nota: ${item.nota}`;
            
            lineasDetalle.push(textoItem);
        }

        const detalleTicket = lineasDetalle.join("<br>");

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

app.listen(3000, '0.0.0.0', () => console.log("🚀 Servidor Tukan activo en puerto 3000"));
