async function cargarDatosCategorias() {
    const API = CONFIG.API_URL;
    const resCat = await fetch(`${API}/api/categorias`);
    const categorias = await resCat.json();
    
    const tbody = document.getElementById('lista-categorias-body');
    tbody.innerHTML = '';

    for (const cat of categorias) {
        tbody.innerHTML += `
            <tr class="bg-gray-50">
                <td class="p-4 font-black text-orange-600">${cat.nombre}</td>
                <td class="p-4"><span class="text-[10px] bg-orange-100 px-2 py-1 rounded">PADRE</span></td>
                <td class="p-4 text-center space-x-2">
                    <button onclick="editarCat(${cat.id}, '${cat.nombre}')" class="text-blue-600 text-xs uppercase font-bold">Editar</button>
                    <button onclick="eliminarCat(${cat.id})" class="text-red-600 text-xs uppercase font-bold">Eliminar</button>
                </td>
            </tr>
        `;

        const resSub = await fetch(`${API}/api/subcategorias/${cat.id}`);
        const subs = await resSub.json();
        
        subs.forEach(s => {
            tbody.innerHTML += `
                <tr>
                    <td class="p-4 pl-10 text-gray-600">↳ ${s.nombre}</td>
                    <td class="p-4"><span class="text-[10px] bg-green-100 px-2 py-1 rounded">SUB</span></td>
                    <td class="p-4 text-center space-x-2">
                        <button onclick="editarSub(${s.id}, '${s.nombre}')" class="text-blue-400 text-xs uppercase font-bold">Editar</button>
                        <button onclick="eliminarSub(${s.id})" class="text-red-400 text-xs uppercase font-bold">Eliminar</button>
                    </td>
                </tr>
            `;
        });
    }
}
