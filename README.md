# Truco para 4

Servidor Node con WebSockets. Cada jugador entra con un link, y el servidor
le manda solo sus cartas.

## Probar en tu compu
    npm install
    npm start
Abrí http://localhost:3000 en varias pestañas.

## Publicarlo gratis en Render
1. Subí esta carpeta a un repositorio nuevo de GitHub (sin la carpeta node_modules).
2. En render.com: New > Blueprint (o Web Service), elegí el repositorio.
3. Si te pregunta: Build `npm install`, Start `npm start`, plan Free.
4. Cuando termine, Render te da una URL https://....onrender.com. Esa es la que compartís.

En el plan gratis el servidor se duerme tras 15 minutos sin uso: la primera
carga puede tardar hasta un minuto. Las mesas viven en memoria, así que si se
reinicia el servidor se pierden y hay que crear una nueva.
