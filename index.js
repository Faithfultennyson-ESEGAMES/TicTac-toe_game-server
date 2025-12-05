const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();
const { validateEnv } = require('./src/config/validateEnv');

// --- Validate Environment Variables before doing anything else ---
validateEnv();

const httpRoutes = require('./src/http/routes');
const adminDlqRoutes = require('./src/http/admin_dlq_routes'); // Import admin routes
const adminSessionRoutes = require('./src/http/admin_session_routes'); // Import session admin routes
const { initializeSocket } = require('./src/game/socket_handler');
const sessionLogger = require('./src/logging/session_logger');
const webhookDispatcher = require('./src/webhooks/dispatcher'); // Import dispatcher

// --- Initialize services ---
sessionLogger.init();
webhookDispatcher.init(); // Initialize the dispatcher and create DLQ directory

const app = express();
const server = http.createServer(app);

// --- CORS Configuration ---
// When deploying, set CLIENT_ORIGIN to your game client's full URL.
// For local development, it defaults to the 'game-client' folder.
const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5500';

const io = new Server(server, {
  cors: {
    origin: clientOrigin,
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// Initialize Socket.IO connection handling
initializeSocket(io);

app.use(express.json());

// Mount routers
app.use(httpRoutes);
app.use('/admin', adminDlqRoutes); // Mount the admin DLQ routes under /admin
app.use('/admin', adminSessionRoutes); // Mount the admin session routes under /admin

app.get('/', (req, res) => {
  res.send('Game server is running.');
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`CORS: Allowing connections from origin: ${clientOrigin}`);
});
