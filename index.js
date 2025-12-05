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
const io = new Server(server, {
  cors: { // In a real-world scenario, you'd want to lock this down
    origin: "*",
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
});
