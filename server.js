const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Configure Socket.IO for Render deployment
const io = socketIO(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['polling', 'websocket'],
    allowUpgrades: true,
    pingTimeout: 120000,
    pingInterval: 25000,
    connectTimeout: 45000,
    path: '/socket.io/',
    serveClient: false
});

const PORT = process.env.PORT || 3000;

console.log('=================================');
console.log('Starting Flappy Bird Multiplayer Server...');
console.log('Environment:', process.env.NODE_ENV || 'development');
console.log('Port:', PORT);
console.log('=================================');

// IMPORTANT: Trust proxy for Render
app.set('trust proxy', 1);

// Serve static files
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'OK',
        activeGames: games.size,
        waitingPlayers: waitingPlayers.length,
        timestamp: new Date().toISOString()
    });
});

// Game state
const games = new Map(); // roomId -> game state
const waitingPlayers = []; // Players waiting for match
const playerRooms = new Map(); // socketId -> roomId

class Game {
    constructor(player1Id, player2Id) {
        this.id = `game_${Date.now()}_${Math.random()}`;
        this.players = {
            [player1Id]: {
                id: player1Id,
                position: { x: 80, y: 250 },
                velocity: 0,
                rotation: 0,
                score: 0,
                alive: true,
                ready: false
            },
            [player2Id]: {
                id: player2Id,
                position: { x: 80, y: 250 },
                velocity: 0,
                rotation: 0,
                score: 0,
                alive: true,
                ready: false
            }
        };
        this.pipes = [];
        this.gameStarted = false;
        this.gameOver = false;
        this.pipeCounter = 0;
        this.lastPipeTime = Date.now();
    }

    allPlayersReady() {
        return Object.values(this.players).every(p => p.ready);
    }

    updatePlayer(playerId, data) {
        if (this.players[playerId] && this.players[playerId].alive) {
            Object.assign(this.players[playerId], data);
        }
    }

    playerDied(playerId) {
        if (this.players[playerId]) {
            this.players[playerId].alive = false;
            
            // Check if game over
            const alivePlayers = Object.values(this.players).filter(p => p.alive);
            if (alivePlayers.length <= 1) {
                this.gameOver = true;
                return this.getWinner();
            }
        }
        return null;
    }

    getWinner() {
        const players = Object.values(this.players);
        const alivePlayer = players.find(p => p.alive);
        
        if (alivePlayer) {
            return alivePlayer.id;
        }
        
        // Both died, highest score wins
        return players.reduce((a, b) => a.score > b.score ? a : b).id;
    }

    updatePipes(pipes) {
        this.pipes = pipes;
    }

    incrementScore(playerId) {
        if (this.players[playerId]) {
            this.players[playerId].score++;
        }
    }
}

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log(`[${new Date().toISOString()}] ✓ Player connected: ${socket.id}`);

    // Send waiting status
    socket.emit('connected', { playerId: socket.id });

    // Player wants to find a match
    socket.on('findMatch', () => {
        console.log(`[${new Date().toISOString()}] 🔍 Player ${socket.id} searching for match...`);
        
        // Check if already in queue
        if (waitingPlayers.includes(socket.id)) {
            console.log(`[${new Date().toISOString()}] ⚠️  Player ${socket.id} already in queue`);
            return;
        }

        // Add to waiting queue
        waitingPlayers.push(socket.id);
        socket.emit('searching');
        console.log(`[${new Date().toISOString()}] 📋 Queue size: ${waitingPlayers.length}`);

        // Try to match with another player
        if (waitingPlayers.length >= 2) {
            const player1Id = waitingPlayers.shift();
            const player2Id = waitingPlayers.shift();

            // Create new game
            const game = new Game(player1Id, player2Id);
            games.set(game.id, game);
            
            // Associate players with room
            playerRooms.set(player1Id, game.id);
            playerRooms.set(player2Id, game.id);

            // Join both players to the room
            const player1Socket = io.sockets.sockets.get(player1Id);
            const player2Socket = io.sockets.sockets.get(player2Id);

            if (player1Socket && player2Socket) {
                player1Socket.join(game.id);
                player2Socket.join(game.id);

                // Notify both players
                io.to(game.id).emit('matchFound', {
                    roomId: game.id,
                    players: {
                        [player1Id]: { position: 1 },
                        [player2Id]: { position: 2 }
                    }
                });

                console.log(`[${new Date().toISOString()}] 🎮 Match created: ${game.id}`);
                console.log(`[${new Date().toISOString()}] 👥 Players: ${player1Id.substring(0,8)} vs ${player2Id.substring(0,8)}`);
            }
        }
    });

    // Player is ready to start
    socket.on('playerReady', () => {
        const roomId = playerRooms.get(socket.id);
        if (roomId) {
            const game = games.get(roomId);
            if (game && game.players[socket.id]) {
                game.players[socket.id].ready = true;

                // Check if all players ready
                if (game.allPlayersReady() && !game.gameStarted) {
                    game.gameStarted = true;
                    io.to(roomId).emit('gameStart', {
                        timestamp: Date.now()
                    });
                    console.log(`[${new Date().toISOString()}] 🚀 Game started: ${roomId}`);
                }
            }
        }
    });

    // Player movement update (bird flap/position)
    socket.on('playerUpdate', (data) => {
        const roomId = playerRooms.get(socket.id);
        if (roomId) {
            const game = games.get(roomId);
            if (game && game.gameStarted && !game.gameOver) {
                game.updatePlayer(socket.id, data);
                
                // Broadcast to other player in room
                socket.to(roomId).emit('opponentUpdate', {
                    playerId: socket.id,
                    ...data
                });
            }
        }
    });

    // Player scored (passed a pipe)
    socket.on('playerScored', () => {
        const roomId = playerRooms.get(socket.id);
        if (roomId) {
            const game = games.get(roomId);
            if (game && game.gameStarted && !game.gameOver) {
                game.incrementScore(socket.id);
                
                // Broadcast score update
                io.to(roomId).emit('scoreUpdate', {
                    playerId: socket.id,
                    score: game.players[socket.id].score
                });
            }
        }
    });

    // Pipe synchronization (host sends, others receive)
    socket.on('pipeUpdate', (pipes) => {
        const roomId = playerRooms.get(socket.id);
        if (roomId) {
            const game = games.get(roomId);
            if (game) {
                game.updatePipes(pipes);
                // Broadcast to other player
                socket.to(roomId).emit('pipesSync', pipes);
            }
        }
    });

    // Player died
    socket.on('playerDied', () => {
        const roomId = playerRooms.get(socket.id);
        if (roomId) {
            const game = games.get(roomId);
            if (game && !game.gameOver) {
                const winnerId = game.playerDied(socket.id);
                
                if (winnerId) {
                    // Game over, announce winner
                    io.to(roomId).emit('gameOver', {
                        winnerId: winnerId,
                        scores: Object.fromEntries(
                            Object.entries(game.players).map(([id, p]) => [id, p.score])
                        )
                    });
                    console.log(`[${new Date().toISOString()}] 🏁 Game over: ${roomId}, Winner: ${winnerId.substring(0,8)}`);
                }
            }
        }
    });

    // Handle disconnect
    socket.on('disconnect', () => {
        console.log(`[${new Date().toISOString()}] ✗ Player disconnected: ${socket.id}`);
        
        // Remove from waiting queue
        const waitingIndex = waitingPlayers.indexOf(socket.id);
        if (waitingIndex > -1) {
            waitingPlayers.splice(waitingIndex, 1);
        }

        // Handle game disconnection
        const roomId = playerRooms.get(socket.id);
        if (roomId) {
            const game = games.get(roomId);
            if (game && !game.gameOver) {
                // Notify other player
                socket.to(roomId).emit('opponentDisconnected');
                
                // End the game
                game.gameOver = true;
                games.delete(roomId);
            }
            playerRooms.delete(socket.id);
        }
    });

    // Request rematch
    socket.on('rematch', () => {
        const roomId = playerRooms.get(socket.id);
        if (roomId) {
            socket.to(roomId).emit('rematchRequest', { playerId: socket.id });
        }
    });
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
    console.log('=================================');
    console.log(`✓ Server running on port ${PORT}`);
    console.log(`✓ Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`✓ Time: ${new Date().toISOString()}`);
    console.log('=================================');
});

// Error handling
server.on('error', (error) => {
    console.error('✗ Server error:', error);
});

io.on('error', (error) => {
    console.error('✗ Socket.IO error:', error);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
    });
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Cleanup old games periodically
setInterval(() => {
    const now = Date.now();
    for (const [roomId, game] of games.entries()) {
        if (game.gameOver && (now - game.lastPipeTime) > 300000) { // 5 minutes
            games.delete(roomId);
            console.log(`Cleaned up old game: ${roomId}`);
        }
    }
}, 60000); // Check every minute
