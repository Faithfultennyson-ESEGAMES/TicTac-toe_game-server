const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();
const { validateEnv } = require('./src/config/validateEnv');

// --- Validate Environment Variables before doing anything else ---
validateEnv();

const sessionManager = require('./src/game/session'); // Import the session manager
const httpRoutes = require('./src/http/routes');
const adminDlqRoutes = require('./src/http/admin_dlq_routes');
const adminSessionRoutes = require('./src/http/admin_session_routes');
const adminServerRoutes = require('./src/http/admin_server_routes'); // Import the new server admin routes
const { initializeSocket } = require('./src/game/socket_handler');
const sessionLogger = require('./src/logging/session_logger');
const webhookDispatcher = require('./src/webhooks/dispatcher');

// --- Initialize services ---
sessionLogger.init();
webhookDispatcher.init();
sessionManager.init(); // Start the stale session cleanup timer

const app = express();
const server = http.createServer(app);

// --- CORS Configuration ---
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
app.use('/admin', adminDlqRoutes);
app.use('/admin', adminSessionRoutes);
app.use('/admin', adminServerRoutes); // Mount the new server admin routes

app.get('/', (req, res) => {
  res.send('Game server is running.');
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`CORS: Allowing connections from origin: ${clientOrigin}`);
});
