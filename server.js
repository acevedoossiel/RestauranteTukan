// const express = require('express');
// const cors = require('cors');
// const { open } = require('sqlite');
// const sqlite3 = require('sqlite3');

// const app = express();
// app.use(cors());
// app.use(express.json());
// app.use(express.static('.'));

// let db;
// let ultimaComandaParaCocina = "Esperando pedido...";

// (async () => {
//     db = await open({ filename: 'restaurante.db', driver: sqlite3.Database });
    
//     await db.exec(`
//         CREATE TABLE IF NOT EXISTS pedidos_activos (
//             id INTEGER PRIMARY KEY AUTOINCREMENT, 
//             mesa INTEGER, 
//             producto TEXT, 
//             itemBase TEXT
//         );
//         CREATE TABLE IF NOT EXISTS historial_ventas (
//             id INTEGER PRIMARY KEY AUTOINCREMENT, 
//             mesa INTEGER, 
//             total REAL, 
//             detalle TEXT, 
//             fecha DATETIME DEFAULT CURRENT_TIMESTAMP
//         );
//         CREATE TABLE IF NOT EXISTS categorias (
//             id INTEGER PRIMARY KEY AUTOINCREMENT, 
//             nombre TEXT UNIQUE
//         );
//         CREATE TABLE IF NOT EXISTS subcategorias (
//             id INTEGER PRIMARY KEY AUTOINCREMENT, 
//             nombre TEXT, 
//             categoria_id INTEGER, 
//             FOREIGN KEY(categoria_id) REFERENCES categorias(id)
//         );
//         CREATE TABLE IF NOT EXISTS productos (
//             id INTEGER PRIMARY KEY AUTOINCREMENT, 
//             nombre TEXT, 
//             precio REAL, 
//             costo REAL, 
//             categoria_id INTEGER, 
//             subcategoria_id INTEGER DEFAULT 0,
//             FOREIGN KEY(categoria_id) REFERENCES categorias(id)
//         );
//         CREATE TABLE IF NOT EXISTS configuracion_mesas (
//             id INTEGER PRIMARY KEY,
//             numero_mesa INTEGER UNIQUE
//         );
//     `);
    
//     console.log("✅ Servidor: Base de datos vinculada y lista.");
// })();

// // --- LOGIN ---
// app.post('/api/login', (req, res) => {
//     const { user, pass } = req.body;
//     if (user === "admin" && pass === "123456") {
//         res.json({ success: true, token: "TOKEN_" + Math.random().toString(36).substr(2) });
//     } else {
//         res.status(401).json({ success: false });
//     }
// });

// // --- COMANDAS Y COCINA ---
// app.post('/enviar_comanda', async (req, res) => {
//     const { mesa, items, textoCocina } = req.body;
//     for (let item of items) {
//         await db.run('INSERT INTO pedidos_activos (mesa, producto, itemBase) VALUES (?, ?, ?)', 
//             [mesa, item.display, item.base]);
//     }
//     ultimaComandaParaCocina = textoCocina;
//     res.json({ status: "ok" });
// });

// app.get('/cocina', (req, res) => {
//     res.json({ comanda: ultimaComandaParaCocina });
// });

// // --- MESAS Y CUENTAS ---
// app.get('/mesas_activas', async (req, res) => {
//     const rows = await db.all('SELECT DISTINCT mesa FROM pedidos_activos');
//     res.json(rows.map(r => r.mesa));
// });

// app.get('/cuenta/:mesa', async (req, res) => {
//     const rows = await db.all('SELECT producto FROM pedidos_activos WHERE mesa = ?', [req.params.mesa]);
//     res.json(rows.map(r => r.producto));
// });


// app.post('/cerrar_cuenta', async (req, res) => {
//     const { mesa } = req.body;
//     const items = await db.all('SELECT producto, itemBase FROM pedidos_activos WHERE mesa = ?', [mesa]);
    
//     if (items.length > 0) {
//         let total = 0;
//         const conteo = {};

//         for (let item of items) {
//             const prodEnDb = await db.get('SELECT precio FROM productos WHERE nombre = ?', [item.itemBase]);
//             const precio = prodEnDb ? prodEnDb.precio : 0;
//             total += precio;
//             if (!conteo[item.producto]) conteo[item.producto] = { c: 0, p: precio };
//             conteo[item.producto].c++;
//         }

//         // FORMATO CORREGIDO: Incluimos el "•" y el "(" para que el reporte pueda calcular costos/ganancias
//         const detalleTicket = Object.entries(conteo)
//             .map(([nom, d]) => `• ${d.c}x ${nom} ($${(d.c * d.p).toFixed(2)})`)
//             .join("<br>");

//         ultimaComandaParaCocina = `
//             *** CUENTA CERRADA ***<br>
//             MESA ${mesa}<br>
//             ----------------------<br>
//             ${detalleTicket.replace(/<br>/g, '\n')}<br>
//             ----------------------<br>
//             TOTAL: $${total.toFixed(2)}<br>
//             ¡GRACIAS POR SU COMPRA!
//         `;

//         // Guardamos con el formato que el reporte sí entiende
//         await db.run('INSERT INTO historial_ventas (mesa, total, detalle) VALUES (?, ?, ?)', [mesa, total, detalleTicket]);
//         await db.run('DELETE FROM pedidos_activos WHERE mesa = ?', [mesa]);
        
//         res.json({ total });
//     } else {
//         res.json({ total: 0 });
//     }
// });

// // --- ADMINISTRACIÓN DEL MENÚ ---
// app.get('/api/categorias', async (req, res) => {
//     res.json(await db.all('SELECT * FROM categorias'));
// });

// app.post('/api/categorias', async (req, res) => {
//     await db.run('INSERT INTO categorias (nombre) VALUES (?)', [req.body.nombre]);
//     res.json({ success: true });
// });

// app.get('/api/subcategorias/:catId', async (req, res) => {
//     res.json(await db.all('SELECT * FROM subcategorias WHERE categoria_id = ?', [req.params.catId]));
// });

// app.post('/api/subcategorias', async (req, res) => {
//     await db.run('INSERT INTO subcategorias (nombre, categoria_id) VALUES (?, ?)', [req.body.nombre, req.body.categoria_id]);
//     res.json({ success: true });
// });

// app.delete('/api/categorias/:id', async (req, res) => {
//     // IMPORTANTE: Al borrar categoría padre, borramos sus subcategorías tmb
//     await db.run('DELETE FROM subcategorias WHERE categoria_id = ?', [req.params.id]);
//     await db.run('DELETE FROM categorias WHERE id = ?', [req.params.id]);
//     res.json({ success: true });
// });

// app.delete('/api/subcategorias/:id', async (req, res) => {
//     await db.run('DELETE FROM subcategorias WHERE id = ?', [req.params.id]);
//     res.json({ success: true });
// });

// // ESTA ES LA RUTA DE PRODUCTOS BUENA (UNA SOLA)
// app.post('/api/productos', async (req, res) => {
//     const { nombre, precio, costo, categoria_id, subcategoria_id } = req.body;
//     const finalSubId = subcategoria_id ? subcategoria_id : 0;
//     await db.run(
//         'INSERT INTO productos (nombre, precio, costo, categoria_id, subcategoria_id) VALUES (?, ?, ?, ?, ?)', 
//         [nombre, precio, costo, categoria_id, finalSubId]
//     );
//     res.json({ success: true });
// });

// // ELIMINAR PRODUCTO
// app.delete('/api/productos/:id', async (req, res) => {
//     await db.run('DELETE FROM productos WHERE id = ?', [req.params.id]);
//     res.json({ success: true });
// });

// // ACTUALIZAR PRODUCTO (EDITAR)
// app.put('/api/productos/:id', async (req, res) => {
//     const { nombre, precio, costo, categoria_id, subcategoria_id } = req.body;
//     await db.run(
//         `UPDATE productos SET nombre=?, precio=?, costo=?, categoria_id=?, subcategoria_id=? WHERE id=?`,
//         [nombre, precio, costo, categoria_id, subcategoria_id, req.params.id]
//     );
//     res.json({ success: true });
// });

// // ACTUALIZAR MENU_ADMIN (Para que traiga el nombre de la subcategoría también)
// app.get('/api/menu_admin', async (req, res) => {
//     res.json(await db.all(`
//         SELECT p.*, c.nombre as cat_nombre, IFNULL(s.nombre, 'Sin Sub') as sub_nombre 
//         FROM productos p 
//         JOIN categorias c ON p.categoria_id = c.id
//         LEFT JOIN subcategorias s ON p.subcategoria_id = s.id
//     `));
// });

// // ACTUALIZAR CATEGORÍA PADRE
// app.put('/api/categorias/:id', async (req, res) => {
//     try {
//         const { nombre } = req.body;
//         await db.run('UPDATE categorias SET nombre = ? WHERE id = ?', [nombre, req.params.id]);
//         res.json({ success: true });
//     } catch (err) {
//         res.status(500).json({ error: err.message });
//     }
// });

// // ACTUALIZAR SUBCATEGORÍA
// app.put('/api/subcategorias/:id', async (req, res) => {
//     try {
//         const { nombre } = req.body;
//         await db.run('UPDATE subcategorias SET nombre = ? WHERE id = ?', [nombre, req.params.id]);
//         res.json({ success: true });
//     } catch (err) {
//         res.status(500).json({ error: err.message });
//     }
// });

// // Ruta para obtener todas las mesas
// app.get('/api/mesas', async (req, res) => {
//     const rows = await db.all('SELECT numero_mesa FROM configuracion_mesas ORDER BY numero_mesa ASC');
//     res.json(rows.map(r => r.numero_mesa));
// });

// // Ruta para agregar una mesa
// app.post('/api/mesas', async (req, res) => {
//     try {
//         const { numero } = req.body;
//         await db.run('INSERT INTO configuracion_mesas (numero_mesa) VALUES (?)', [numero]);
//         res.json({ success: true });
//     } catch (e) { res.status(400).json({ error: "Esa mesa ya existe" }); }
// });

// // Ruta para eliminar una mesa (CON VALIDACIÓN DE CUENTA ABIERTA)
// app.delete('/api/mesas/:numero', async (req, res) => {
//     const { numero } = req.params;
//     const ocupada = await db.get('SELECT 1 FROM pedidos_activos WHERE mesa = ? LIMIT 1', [numero]);
//     if (ocupada) {
//         return res.status(400).json({ error: "No puedes quitar una mesa que tiene cuenta abierta" });
//     }
//     await db.run('DELETE FROM configuracion_mesas WHERE numero_mesa = ?', [numero]);
//     res.json({ success: true });
// });

// app.get('/api/reportes', async (req, res) => {
//     try {
//         const { inicio, fin } = req.query;
//         let queryHistorial = 'SELECT * FROM historial_ventas';
//         let params = [];

//         if (inicio && fin) {
//             queryHistorial += ' WHERE date(fecha, "localtime") BETWEEN ? AND ?';
//             params = [inicio, fin];
//         }
//         queryHistorial += ' ORDER BY fecha DESC';

//         const ventas = await db.all(queryHistorial, params);
//         const productosDb = await db.all('SELECT nombre, costo FROM productos');
//         const costosMap = {};
//         productosDb.forEach(p => costosMap[p.nombre] = p.costo);

//         let ingresos = 0, gastos = 0;
//         const resumenProd = {};

//         ventas.forEach(v => {
//             ingresos += v.total;
//             const lineas = v.detalle.split('<br>');
//             lineas.forEach(linea => {
//                 const match = linea.match(/• (\d+)x (.*?) \(/);
//                 if (match) {
//                     const cant = parseInt(match[1]);
//                     const nombre = match[2].trim();
//                     resumenProd[nombre] = (resumenProd[nombre] || 0) + cant;
//                     gastos += ((costosMap[nombre] || 0) * cant);
//                 }
//             });
//         });

//         res.json({
//             ventas,
//             metricas: { ingresos, gastos, ganancia: ingresos - gastos },
//             resumenProductos: Object.entries(resumenProd)
//         .map(([nombre, cantidad]) => ({ nombre, cantidad }))
//         .sort((a, b) => b.cantidad - a.cantidad)
//         });
//     } catch (err) { res.status(500).json({ error: err.message }); }
// });

// app.listen(3000, '0.0.0.0', () => console.log("🚀 Servidor en puerto 3000"));




const express = require('express');
const cors = require('cors');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

let db;

// Estructura en memoria para los monitores en tiempo real
let comandasCocinaActivas = [];
let comandasBarraActivas = [];
let historialComandasCompletadas = []; // Almacén de seguridad por si pican la palomita por error

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

        CREATE TABLE IF NOT EXISTS configuracion_mesas (
            id INTEGER PRIMARY KEY,
            numero_mesa INTEGER UNIQUE
        );
    `);
    
    console.log("✅ Servidor Tukan: Estructura de Base de Datos lista.");
})();

// --- LOGIN ---
app.post('/api/login', (req, res) => {
    const { user, pass } = req.body;
    if (user === "admin" && pass === "123456") {
        res.json({ success: true, token: "TOKEN_" + Math.random().toString(36).substr(2) });
    } else {
        res.status(401).json({ success: false });
    }
});

// --- ENVIAR COMANDAS (DIVISIÓN INTELIGENTE) ---
app.post('/enviar_comanda', async (req, res) => {
    const { mesa, items } = req.body; // items ahora incluye: [{ base, display, modificadores: [], nota: "" }]
    
    let idComandaUnico = "CMD-" + Date.now();
    let elementosCocina = [];
    let elementosBarra = [];

    for (let item of items) {
        // Buscamos el destino directo en el producto
        const prod = await db.get('SELECT destino FROM productos WHERE nombre = ?', [item.base]);
        const destino = prod ? prod.destino : 'cocina';

        // Estructura de los modificadores para guardarlos en la orden activa
        const modsTexto = JSON.stringify(item.modificadores || []);
        const notaTexto = item.nota || "";

        await db.run(`
            INSERT INTO pedidos_activos (mesa, producto, itemBase, modificadores, nota, destino) 
            VALUES (?, ?, ?, ?, ?, ?)`, 
            [mesa, item.display, item.base, modsTexto, notaTexto, destino]
        );

        const objetoParaPantalla = {
            producto: item.display,
            modificadores: item.modificadores || [],
            nota: notaTexto,
            completado: false
        };

        if (destino === 'barra') {
            elementosBarra.push(objetoParaPantalla);
        } else {
            elementosCocina.push(objetoParaPantalla);
        }
    }

    // Insertar en la cola de Cocina si tiene alimentos
    if (elementosCocina.length > 0) {
        comandasCocinaActivas.push({
            id: idComandaUnico,
            mesa: mesa,
            fecha: new Date().toLocaleTimeString(),
            items: elementosCocina
        });
    }

    // Insertar en la cola de Barra si tiene bebidas/postres
    if (elementosBarra.length > 0) {
        comandasBarraActivas.push({
            id: idComandaUnico,
            mesa: mesa,
            fecha: new Date().toLocaleTimeString(),
            items: elementosBarra
        });
    }

    res.json({ status: "ok", idComanda: idComandaUnico });
});


// --- ELIMINAR CATEGORÍA PADRE (CORREGIDO) ---
app.delete('/api/categorias/:id', async (req, res) => {
    try {
        const catId = req.params.id;
        
        // 1. Primero borramos los modificadores de los productos que pertenecen a las subcategorías de esta categoría
        await db.run(`
            DELETE FROM modificadores_productos 
            WHERE producto_id IN (
                SELECT id FROM productos WHERE categoria_id = ?
            )
        `, [catId]);

        // 2. Borramos los productos ligados a esta categoría o sus subcategorías
        await db.run('DELETE FROM productos WHERE categoria_id = ?', [catId]);

        // 3. Borramos las subcategorías que dependen de este padre
        await db.run('DELETE FROM subcategorias WHERE categoria_id = ?', [catId]);
        
        // 4. Finalmente borramos la categoría padre
        await db.run('DELETE FROM categorias WHERE id = ?', [catId]);
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- ELIMINAR SUBCATEGORÍA (CORREGIDO) ---
app.delete('/api/subcategorias/:id', async (req, res) => {
    try {
        const subId = req.params.id;

        // 1. Borramos modificadores de los productos de esta subcategoría
        await db.run(`
            DELETE FROM modificadores_productos 
            WHERE producto_id IN (
                SELECT id FROM productos WHERE subcategoria_id = ?
            )
        `, [subId]);

        // 2. Borramos los productos de esta subcategoría
        await db.run('DELETE FROM productos WHERE subcategoria_id = ?', [subId]);

        // 3. Borramos la subcategoría
        await db.run('DELETE FROM subcategorias WHERE id = ?', [subId]);
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- PANTALLAS EN TIEMPO REAL (COCINA Y BARRA) ---
app.get('/api/comandas/cocina', (req, res) => res.json(comandasCocinaActivas));
app.get('/api/comandas/barra', (req, res) => res.json(comandasBarraActivas));
app.get('/api/comandas/historial', (req, res) => res.json(historialComandasCompletadas));

// Marcar comanda completa (Palomita)
app.post('/api/comandas/completar', (req, res) => {
    const { id, destino } = req.body;
    let lista = destino === 'barra' ? comandasBarraActivas : comandasCocinaActivas;
    
    const index = lista.findIndex(c => c.id === id);
    if (index > -1) {
        const [comanda] = lista.splice(index, 1);
        comanda.destinoCierre = destino;
        comanda.fechaCierre = new Date().toLocaleTimeString();
        historialComandasCompletadas.push(comanda);
    }
    res.json({ success: true });
});

// --- CUENTAS Y COBROS ---
app.get('/mesas_activas', async (req, res) => {
    const rows = await db.all('SELECT DISTINCT mesa FROM pedidos_activos');
    res.json(rows.map(r => r.mesa));
});

app.get('/cuenta/:mesa', async (req, res) => {
    const rows = await db.all('SELECT * FROM pedidos_activos WHERE mesa = ?', [req.params.mesa]);
    res.json(rows);
});

// Ruta para eliminar una mesa (CON VALIDACIÓN CORREGIDA)
app.delete('/api/mesas/:numero', async (req, res) => {
    try {
        const numero = parseInt(req.params.numero); // Aseguramos tipo entero en el backend
        
        // Convertimos a string en la búsqueda por si en pedidos_activos se guardó como texto (ej: "1")
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

// --- NUEVO ENDPOINT: COBRO PARCIAL (CUENTAS DIVIDIDAS POR CONSUMO) ---
app.post('/api/cobrar_parcial', async (req, res) => {
    const { mesa, itemsACobrar } = req.body; // itemsACobrar es un array de IDs de la tabla pedidos_activos [ { id: 45, producto: "...", itemBase: "...", modificadores: "[]" } ]
    
    if (!itemsACobrar || itemsACobrar.length === 0) {
        return res.status(400).json({ error: "No se seleccionaron elementos para cobrar" });
    }

    try {
        let totalParcial = 0;
        let lineasDetalle = [];
        let idsParaEliminar = [];

        for (let item of itemsACobrar) {
            // Buscamos el precio en la DB
            const prodEnDb = await db.get('SELECT precio FROM productos WHERE nombre = ?', [item.itemBase]);
            let precioBase = prodEnDb ? prodEnDb.precio : 0;
            
            // Calcular modificadores si existen
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

        // Mandamos a los monitores/impresoras el ticket de esta persona de forma independiente
        ultimaComandaParaCocina = avisoTicket;
        ultimaComandaParaBarra = avisoTicket;

        // 1. Registramos este pago parcial en el historial de ventas para que cuadre la caja del día
        await db.run('INSERT INTO historial_ventas (mesa, total, detalle) VALUES (?, ?, ?)', 
            [`${mesa} (PARCIAL)`, totalParcial, detalleTicketParcial]
        );

        // 2. BORRAMOS DE LA MESA ÚNICAMENTE LO QUE YA PAGÓ ESTA PERSONA
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
            
            // Sumar o restar el valor de los modificadores
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
        
        res.json({ total, detalle: detalleTicket });
    } else {
        res.json({ total: 0 });
    }
});

// --- GESTIÓN DE PRODUCTOS Y MODIFICADORES ---
app.get('/api/menu_admin', async (req, res) => {
    const productos = await db.all(`
        SELECT p.*, c.nombre as cat_nombre, IFNULL(s.nombre, 'Sin Sub') as sub_nombre 
        FROM productos p 
        JOIN categorias c ON p.categoria_id = c.id
        LEFT JOIN subcategorias s ON p.subcategoria_id = s.id
    `);
    
    // Inyectar los modificadores correspondientes a cada producto
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

    // Si vienen modificadores desde el formulario, guardarlos en su tabla correspondiente
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

    // Actualizar modificadores borrando los anteriores e insertando los nuevos editados
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

// --- RUTAS AUXILIARES DEL MENÚ Y MESAS ---
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

// --- REPORTES FINANCIEROS (Actualizado con Match Flexible de Modificadores) ---
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
